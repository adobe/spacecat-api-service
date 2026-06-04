# SerenityExperiment — Design Spec

**Author:** Ashutosh Shroti
**Date:** 2026-06-04
**Status:** Draft — for Semrush migration discussion
**Context:** Replaces DRS experiment schedules with Serenity/Semrush AIO as the prompt execution backend for the Impact Validation Engine (IVE). Runs alongside the existing `GeoExperiment` / DRS flow during the migration period — zero changes to that path.

---

## Problem

The IVE (Impact Validation Engine) currently uses DRS (Data Retrieval Service) to orchestrate experiment prompt execution:

1. SpaceCat calls `drsClient.createExperimentSchedule()` → DRS creates a cron schedule (hourly)
2. DRS runs prompts on each tick, stores results in `brand_presence_executions_active`
3. SpaceCat polls PostgREST to read results

This couples the IVE to DRS's execution pipeline. Semrush AIO (via Serenity) can replace DRS as the execution backend, but Semrush runs prompts on their own cadence — SpaceCat cannot control timing. The solution is **snapshot-on-demand**: SpaceCat calls the AI Visibility API at chosen moments and persists the responses, giving the same pre/post isolation DRS provided via cron.

---

## Decision: Approach C — Standalone SerenityExperiment Entity

`GeoExperiment` (DRS-backed) and `SerenityExperiment` (Serenity-backed) coexist during migration. Zero changes to `suggestions.js`, `drsClient`, or `GeoExperiment` model. Teams migrate experiment-by-experiment.

| DRS | SerenityExperiment |
|-----|-------------------|
| `createExperimentSchedule()` | `POST /serenity/experiments` (creates Serenity market) |
| Hourly cron execution | `POST /snapshots` — caller controls timing |
| `experiments/{scheduleId}/` S3 path | `serenity-experiments/{experimentId}/{phase}/` S3 path |
| `brand_presence_executions_active` | DynamoDB snapshot index |
| `EXPERIMENT_PHASES.PRE / POST` | `phase: "pre" \| "post"` |
| schedule `expires_at` | experiment `closeAt` |

---

## Lifecycle

```
CREATED
  └─ POST /serenity/experiments
       Creates Serenity market for (geoTargetId, languageCode)
       Adds tracked prompts to market
       Writes experiment record to DynamoDB

PRE_ACTIVE
  └─ POST /serenity/experiments/:id/snapshots  { phase: "pre" }
       Fan-out: AI Visibility API calls for all tracked prompts (parallel)
       Writes DynamoDB index rows (lightweight, queryable)
       Writes S3 payload per prompt (full Markdown response + citations)
       Sets status → PRE_COMPLETE when done

PRE_COMPLETE → POST_ACTIVE
  └─ POST /serenity/experiments/:id/snapshots  { phase: "post" }
       Same as PRE, different timestamp
       Sets status → POST_COMPLETE

POST_COMPLETE → COMPARED
  └─ GET /serenity/experiments/:id/comparison
       Loads pre + post DynamoDB rows
       Loads S3 payloads for full response diff
       Calls snapshot-compare.js (pure function)
       Writes comparison.json.gz to S3
       Returns delta report

CLOSED
  └─ DELETE /serenity/experiments/:id
       Tears down Serenity market (DELETE /serenity/markets/:geoTargetId/:languageCode)
       Marks experiment CLOSED
```

---

## Components & Files

### New files

```
src/support/serenity/
  experiment-service.js          Core orchestrator — init, takeSnapshot, compare, close
  snapshot-compare.js            Pure function: pre[] + post[] + brandDomain → delta report
  drs-provider-mapping.js        DRS provider/platform → Semrush engine mapping
  handlers/
    experiments.js               Route handlers for experiment CRUD (thin, delegates to service)
    snapshots.js                 Route handlers for snapshot take + retrieve

src/dto/
  serenity-experiment.js         DTO mirroring geo-experiment.js pattern
```

### Modified files

```
src/controllers/serenity.js      Add 6 new route bindings only — no logic changes
src/routes/index.js              Register 6 new routes
src/routes/required-capabilities.js  Add capabilities for new routes
src/index.js                     Wire new controller handlers
```

### Reused as-is (no changes)

```
src/support/serenity/handlers/markets.js    experiment-service calls these directly
src/support/serenity/handlers/prompts.js    experiment-service calls these directly
src/support/serenity/rest-transport.js      unchanged
src/support/serenity/workspace-resolver.js  unchanged
```

---

## API Routes

All routes require IMS Bearer token. UUID brand IDs only. Base: `/v2/orgs/:spaceCatId/brands/:brandId/serenity/experiments`

### POST `/serenity/experiments` — Create experiment

**Request:**
```json
{
  "name": "Homepage rewrite Q2",
  "geoTargetId": 2840,
  "languageCode": "en",
  "promptHashes": ["11181371408343195898", "4348889967516410678"],
  "engine": "chatgpt",
  "closeAt": "2026-06-30T00:00:00Z"
}
```

**Response 201:**
```json
{
  "experimentId": "a1b2c3d4-...",
  "status": "PRE_ACTIVE",
  "serenityMarket": { "geoTargetId": 2840, "languageCode": "en" },
  "promptsTracked": 2,
  "closeAt": "2026-06-30T00:00:00Z"
}
```

Creates Serenity market via existing `handleCreateMarket`. Adds prompts via existing `handleCreatePrompts`. Writes experiment record to `serenity-experiments` DynamoDB table.

### GET `/serenity/experiments/:experimentId` — Get status

**Response 200:**
```json
{
  "experimentId": "a1b2c3d4-...",
  "name": "Homepage rewrite Q2",
  "status": "PRE_COMPLETE",
  "promptsTracked": 2,
  "preSnapshotId": "snap-uuid-pre",
  "postSnapshotId": null,
  "closeAt": "2026-06-30T00:00:00Z"
}
```

### POST `/serenity/experiments/:experimentId/snapshots` — Take snapshot

**Request:**
```json
{ "phase": "pre" }
```

**Response 202:**
```json
{
  "snapshotId": "snap-uuid-pre",
  "phase": "pre",
  "promptsQueued": 2,
  "status": "PRE_ACTIVE"
}
```

Fan-out: calls `GET /llmo/ai-visibility/v1/prompt/prompt-response` for each `promptHash` in parallel via `Promise.allSettled`. Writes DynamoDB index row per prompt. Writes S3 payload per prompt gzipped. Updates experiment status to `PRE_COMPLETE` / `POST_COMPLETE`.

### GET `/serenity/experiments/:experimentId/snapshots/:phase` — Retrieve snapshot

**Response:** `302 → presigned S3 URL` (1-hour TTL, matches fanout-report pattern)

Returns 404 if snapshot not yet taken for that phase.

### GET `/serenity/experiments/:experimentId/comparison` — Delta report

**Response 200:**
```json
{
  "experimentId": "a1b2c3d4-...",
  "preSnapshotAt": "2026-06-01T10:00:00Z",
  "postSnapshotAt": "2026-06-15T10:00:00Z",
  "engine": "chatgpt",
  "summary": {
    "promptsTracked": 2,
    "visibilityImproved": 1,
    "visibilityReduced": 0,
    "unchanged": 1,
    "avgCitedPagesDelta": 1.5
  },
  "perPrompt": [
    {
      "promptHash": "11181371408343195898",
      "prompt": "What are some examples of humble leaders...",
      "pre":  { "citedPages": 14, "targetCited": false, "mentionedBrandsCount": 4 },
      "post": { "citedPages": 16, "targetCited": true,  "mentionedBrandsCount": 3 },
      "delta": { "citedPagesDelta": 2, "targetCitedGained": true }
    }
  ],
  "comparisonKey": "serenity-experiments/a1b2c3d4/comparison.json.gz"
}
```

Requires both PRE_COMPLETE and POST_COMPLETE. Returns 409 if either snapshot missing.

### DELETE `/serenity/experiments/:experimentId` — Close experiment

**Response 200:**
```json
{ "experimentId": "a1b2c3d4-...", "status": "CLOSED", "marketDeleted": true }
```

Calls `handleDeleteMarket` for the experiment's market. Marks experiment CLOSED in DynamoDB. Does not delete snapshot data (retained for audit).

---

## Storage Schema

### DynamoDB — `serenity-experiments` table

```
PK: experimentId (string)
SK: "metadata"   (literal)

Attributes:
  name            string
  siteId          string
  brandId         string
  geoTargetId     number
  languageCode    string
  engine          string
  status          string  PRE_ACTIVE | PRE_COMPLETE | POST_ACTIVE | POST_COMPLETE | COMPARED | CLOSED
  promptHashes    list<string>
  preSnapshotId   string  (nullable)
  postSnapshotId  string  (nullable)
  comparisonKey   string  (nullable) S3 key
  closeAt         string  ISO 8601
  createdAt       string
  updatedAt       string
```

### DynamoDB — `serenity-experiment-snapshots` table

```
PK: experimentId            (string)
SK: phase#promptHash        (string)  e.g. "pre#11181371408343195898"

Attributes:
  snapshotId       string   UUID for the snapshot batch
  serpId           string
  topicId          string
  engine           string
  country          string
  takenAt          string   ISO 8601
  s3Key            string   Full S3 key for prompt payload
  targetCited      boolean  brand domain in citedPages?
  targetMentioned  boolean  brand in mentionedBrands?
  citedPagesCount  number
  mentionedBrands  list<string>  brand names only (lightweight)
```

### S3 — `spacecat-{env}-importer` bucket (existing)

```
Key structure:
  serenity-experiments/{experimentId}/pre/{promptHash}.json.gz
  serenity-experiments/{experimentId}/post/{promptHash}.json.gz
  serenity-experiments/{experimentId}/comparison.json.gz

Per-prompt payload (gzipped JSON):
  {
    "promptHash":      "11181371408343195898",
    "prompt":          "What are some examples of humble leaders...",
    "takenAt":         "2026-06-01T10:00:00Z",
    "engine":          "chatgpt",
    "country":         "US",
    "response":        "Full Markdown LLM response...",
    "citedPages":      [ { "url": "...", "title": "..." } ],
    "mentionedBrands": [ { "label": "Adobe", "domain": "adobe.com" } ],
    "isoDate":         "2026-06-01"
  }
```

**Why this split:** DynamoDB rows are small and fast for per-prompt queries (comparison, `targetCited` flag checks). S3 holds full Markdown responses (2–10 KB each) loaded only when building the full report. Mirrors the existing `fanout-report.js` pattern.

---

## DRS Provider Mapping

`src/support/serenity/drs-provider-mapping.js` — migration bridge showing equivalence:

```
DRS provider + platform          →  Semrush engine
─────────────────────────────────────────────────────
brightdata + chatgpt_free        →  chatgpt
brightdata + perplexity          →  perplexity
brightdata + gemini              →  gemini
brightdata + copilot             →  copilot
openai_web_search                →  chatgpt
google_ai_overviews              →  googleAiOverview
```

---

## Environment Variables

```
SERENITY_EXPERIMENT_TABLE=serenity-experiments          (new)
SERENITY_SNAPSHOT_TABLE=serenity-experiment-snapshots   (new)
S3_BUCKET_NAME                                          (existing, reused)
```

---

## What Is NOT In Scope

- `spacecat-shared-data-access` model changes — `SerenityExperiment` uses direct DynamoDB client in-service for this demo. A follow-up PR in shared-data-access would promote it to a proper model.
- IMS token refresh / forwarding changes — reuses existing Serenity auth middleware.
- UI/MFE changes — API only.
- Async job queue for snapshot fan-out — synchronous `Promise.allSettled` is sufficient for the demo (up to ~50 prompts per experiment). Queue-based approach is a follow-up for scale.
- Automated post-phase trigger — caller decides when to take the post snapshot.

---

## Open Questions for Semrush Discussion

1. Can Semrush provide a webhook or push notification when prompt execution results are available for a market? This would make the snapshot timing more precise.
2. Is there a rate limit on the `Relations/Prompt` gRPC endpoint that affects snapshot fan-out concurrency?
3. Should Semrush expose a "point-in-time" snapshot API natively (vs. SpaceCat polling and storing)?
