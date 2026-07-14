# ADR-003: Dedicated Preflight Entity Design

## Status
Accepted

## Context
The REST redesign in [ADR-002](002-preflight-api-rest-redesign.md) introduced three site-scoped
endpoints for the Preflight feature. A backing data model decision was required: continue using
the generic `AsyncJob` model (extended with preflight-specific attributes), or introduce a
dedicated `Preflight` entity in `spacecat-shared-data-access`.

The current `AsyncJob`-backed implementation has several problems:

- **No schema enforcement.** Preflight-specific fields — `siteId`, `url`, `createdBy` — live
  in the `metadata` JSON blob with no type guarantees. Consumers must introspect the blob
  directly rather than relying on a typed contract.
- **Type discrimination via metadata.** Querying preflights for a site requires filtering on
  `metadata.jobType === "preflight"` alongside `metadata.siteId`, neither of which is indexed.
  Promoting them to top-level attributes works around the indexing problem but still leaves the
  domain model generic.
- **Coupling to an implementation detail.** `AsyncJob` is an execution primitive; `Preflight`
  is a domain concept. Exposing the same model for both leaks the execution abstraction to
  callers and makes the API contract brittle as `AsyncJob` evolves.
- **Query inefficiency at scale.** Even with `siteId` promoted to an indexed column on
  `async_jobs`, a query of `WHERE site_id = $siteId` would scan across all job types for that
  site (site-detection, pr-review, preflight, preflight-beta). Isolating preflight records
  requires a compound filter on `(site_id, job_type)`, a composite index, or an in-memory
  post-filter pass. A dedicated `preflights` table makes every row in the index a preflight by
  definition, keeping the index small and the query clean with no cross-workflow contamination.

This decision was aligned with @ekdogan (SITES-44675) before implementation began.

## Decision
Introduce a **dedicated `Preflight` entity in `spacecat-shared-data-access`** rather than
extending `AsyncJob`. The `Preflight` entity owns the domain record and holds a 1-to-1 FK
reference to an `AsyncJob` via `asyncJobId` for execution lifecycle tracking. The `asyncJobId`
is never exposed to API consumers.

### Entity schema

**`Preflight` — first-class fields:**

| Field | Type | Description |
|-------|------|-------------|
| `preflightId` | UUID | Primary key |
| `siteId` | UUID (indexed) | The site this preflight belongs to |
| `url` | string | The page URL that was analyzed; `(site_id, url)` composite index deferred — `url` filter applied in-memory (see collection methods) |
| `asyncJobId` | UUID (FK to `async_jobs`, 1-to-1) | Backing AsyncJob for execution lifecycle; never exposed to API consumers |
| `status` | enum | `IN_PROGRESS` \| `COMPLETED` \| `FAILED` \| `CANCELLED` |
| `createdBy` | object | `{ email, displayName }` from IMS profile at creation time |
| `createdAt` | ISO 8601 | Creation timestamp |
| `updatedAt` | ISO 8601 | Last update timestamp |
| `startedAt` | ISO 8601 | When the request was dispatched to the analyze service (set at record creation, before the upstream call completes) |
| `endedAt` | ISO 8601 | When processing completed |
| `result` | object \| null | Audit result payload; `null` until completed. Exact shape to be strongly typed during implementation. |
| `error` | object \| null | `{ code, message }` on failure |

`createdBy` is derived from the caller's IMS profile at creation time: `email` is
`profile.email` (the IMS user identifier); `displayName` is composed from
`profile.first_name + ' ' + profile.last_name` (falling back to `profile.name`). It is never
supplied by the client.

### Collection methods

- `allBySiteIdAndUrl(siteId, url?)` — returns all preflights for a site, sorted by `createdAt`
  descending; when `url` is provided, filters in-memory after the indexed `siteId` query. This
  is safe given the 7-day TTL and human-triggered volume — per-site result sets are small and
  the payload is lightweight (no `AsyncJob` result blob in the list response).
- `findById(preflightId)` — loads a single preflight by primary key; the caller verifies
  `siteId` matches the path parameter to prevent cross-site probing.

### Creation flow

The controller creates the `AsyncJob` first, receives the `asyncJobId`, then immediately creates
the `Preflight` entity with `asyncJobId` as the FK. This ordering ensures the execution
primitive exists before the domain record that references it.

### Expiry

Expiry is handled implicitly via `ON DELETE CASCADE` on `async_job_id`. When the backing
`AsyncJob` is cleaned up, its associated `Preflight` row is deleted with it. There is no
separate TTL column on `preflights` — the `withRecordExpiry` SchemaBuilder helper is a
DynamoDB-era mechanism marked `postgrestIgnore` in the v3 PostgreSQL layer and does not write
to the database.

### Dual-store boundary

The new `/sites/:siteId/preflights` endpoints write exclusively to the `Preflight` entity.
The legacy `/preflight/jobs` endpoint continues writing to `AsyncJob` unchanged — those records
are **not** surfaced through the new GET endpoints. This is intentional: the two backing stores
are independent and consumers of the new API see only `Preflight`-native records. The legacy
`AsyncJob` records expire naturally via TTL without any migration step.

## Consequences
- Preflight records have a typed, indexed, domain-specific schema — no metadata blob introspection.
- `GET /sites/:siteId/preflights` queries a dedicated table; every row is a preflight by
  definition, with no cross-workflow contamination from other `AsyncJob` types.
- The `asyncJobId` FK is an internal implementation detail and never appears in API responses.
- Legacy `/preflight/jobs` consumers are unaffected — their `AsyncJob` records continue to be
  written and read by the existing endpoint pair until migration is complete.

---

## Amendment (SITES-47254) — Source-of-truth shift to AsyncJob for lifecycle fields

**Status:** Accepted (2026-06-26).
**Driven by:** [SITES-47254](https://jira.corp.adobe.com/browse/SITES-47254), uncovered while
verifying [SITES-47173](https://jira.corp.adobe.com/browse/SITES-47173) end-to-end.

The original schema (above) duplicated lifecycle fields — `startedAt`, `endedAt`, `result`,
`error` — on both the `Preflight` entity and the joined `AsyncJob`. Keeping them in sync
required the projector to write to both rows non-atomically. The inconsistency window was the
root cause of [SITES-47253](https://jira.corp.adobe.com/browse/SITES-47253) (NOT NULL violation
on the second of two writes, silent `IN_PROGRESS` for failed scans).

### Revised field placement

| Field | Storage | Truth read | Cache read |
|---|---|---|---|
| `id`, `siteId`, `asyncJobId`, `url`, `createdBy`, `createdAt`, `updatedAt` | `Preflight` | `Preflight` | n/a — preflight-native |
| `status` | both | `AsyncJob` (detail) | `Preflight` (list) |
| `endedAt` | both | `AsyncJob` (detail) | `Preflight` (list) |
| `startedAt`, `result`, `error` | `AsyncJob` only | `AsyncJob` (detail) | n/a — not on list |

`status` and `endedAt` are denormalized onto the `Preflight` row solely as a
list-view cache (the projector keeps them in sync). The detail view sources
them from the joined `AsyncJob` instead, eliminating the split-brain window
where `Preflight.status` could lag `AsyncJob.result` between the projector's
two writes (terminal `async_jobs` row + cache update) — a polling client
keying off `status` would otherwise spin indefinitely on a scan that's
actually done.

### Wire contract (three DTOs)

The previous single-DTO surface (`toJSON` / `toDetailJSON`) is split into three shapes so each
endpoint returns only fields meaningful at that point in the lifecycle:

- **`PreflightCreated`** — `POST 202` body. Identity + state only:
  `{ preflightId, siteId, status, url, createdAt, createdBy }`. Omits `updatedAt` / `endedAt`
  because they carry no information at creation time (`updatedAt === createdAt`;
  `endedAt === null`).
- **`PreflightListItem`** — `GET /sites/:siteId/preflights` per-row. Adds `updatedAt`,
  `endedAt`. All fields sourced from the `Preflight` row directly; the list path stays
  index-only (no join).
- **`PreflightDetail`** — `GET /sites/:siteId/preflights/:preflightId`. Adds `result` and
  `error`, both sourced from the joined `AsyncJob`. `startedAt` is removed from the wire
  entirely — it's an AsyncJob concern, not a Preflight attribute; consumers that need scan
  timing read it out of `result`.

Internal fields `asyncJobId`, `scanId`, `startedAt`, `resultType`, `resultLocation`,
`metadata` are never on the wire.

### Read path

- List — no change in shape of the underlying query; new fields all live on `Preflight`.
- Detail — `getPreflightById` calls `preflight.getAsyncJob()` after the access checks and
  passes the joined row into the DTO. A thrown fetch (PostgREST 5xx / transport failure)
  returns **503 `PREFLIGHT_LIFECYCLE_UNAVAILABLE`** rather than 200 with `result: null` —
  a 200 with null lifecycle is indistinguishable on the wire from a legitimately empty
  completed scan, and a polling client would cache the wrong terminal answer. A null
  AsyncJob (no row yet — legitimate transitional / legacy flow) is not a failure: lifecycle
  fields fall back to the `Preflight` cache and `result`/`error` surface as `null`.

### Write path

- `createPreflight` creates the `AsyncJob` first, then the `Preflight` (unchanged ordering).
  The `Preflight.create` call no longer carries `startedAt` — `async_jobs.started_at` is set
  by the entity's default.
- On `callMysticatAnalyze` failure both rows are flipped to `FAILED`:
  `asyncJob.setStatus(FAILED) + setError(...) + setEndedAt(...)` (truth) and
  `preflight.setStatus(FAILED) + setEndedAt(...)` (cache). Error data lives only on the
  AsyncJob.
- The projector's completion handler PATCHes `preflights` with `{ status, ended_at }` only
  (SITES-47253); `result` / `error` / `result_type` are upserted on `async_jobs`.

### Storage migrations

- [mysticat-data-service#746](https://github.com/adobe/mysticat-data-service/pull/746) —
  drops `started_at` / `result` / `error` columns from the `preflights` table.
- [spacecat-shared#1740](https://github.com/adobe/spacecat-shared/pull/1740) — removes the
  corresponding schema attributes from `Preflight` (`feat!` — major bump).
- [mysticat-projector-service#216](https://github.com/adobe/mysticat-projector-service/pull/216)
  (SITES-47253) — PATCH-style write to `preflights` with `{ status, ended_at }`; AsyncJob upsert
  still carries `result` / `error`.

### Deploy ordering

1. spacecat-api-service (this PR) — API reads `result`/`error` from `async_jobs`; create-path
   catch sets both rows.
2. mysticat-projector-service#216 — projector stops writing `result`/`error` to `preflights`.
3. mysticat-data-service#746 + spacecat-shared#1740 — column drops on the table and schema
   model.

### Open follow-ups

[SITES-47180](https://jira.corp.adobe.com/browse/SITES-47180) — strongly-typed response models
for the Preflight GET endpoints, including `result` content shape and OpenAPI alignment. The
JSDoc `@typedef`s + response-shape pin tests added in this amendment are the interim contract;
the OpenAPI spec is deliberately not yet updated under SITES-47180's umbrella.
