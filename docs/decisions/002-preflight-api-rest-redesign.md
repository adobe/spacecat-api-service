# ADR-002: Preflight API Redesigned as Site-Scoped REST Resource

## Status
Proposed

## Context
The preflight feature was initially shipped with two endpoint pairs that do not follow the
site-scoped REST conventions used by other resources in this service (opportunities, audits,
url-store, etc.):

- `POST /preflight/jobs` — creates a preflight job from an array of URLs (queue-based)
- `GET /preflight/jobs/:jobId` — retrieves job status and result
- `POST /preflight/beta/jobs` — creates a preflight job from a single URL (direct Mysticat proxy)
- `GET /preflight/beta/jobs/:jobId` — retrieves beta job status and result

Several problems with this design:

1. **Non-standard path structure.** All other site-scoped resources live under
   `/sites/:siteId/...`. The flat `/preflight/...` paths are inconsistent and harder to
   discover.

2. **URL(s) in the request body drive site resolution.** The server accepts a URL, reverse-
   resolves it to a `siteId`, then proceeds. This is a server-side convenience that compensates
   for the caller not being required to identify the site upfront. By the time a user triggers
   a preflight from the MFE, the `siteId` is already in the application state — the MFE has
   navigated to a specific site in Sites Optimizer. Making the caller supply it explicitly is
   more honest and removes a resolution step that can fail.

3. **`jobId` leaks the async-job abstraction.** The returned identifier is named `jobId`,
   exposing the underlying `AsyncJob` model to consumers. A preflight is a domain concept;
   its identifier should reflect that.

4. **No list endpoint.** There is no way to retrieve the history of preflights for a site.

5. **Beta qualifier in the path.** `/preflight/beta/jobs` signals immaturity via the URL,
   which is an anti-pattern. Versioning and feature graduation should not be expressed in
   path segments.

## Decision
Replace both endpoint pairs with three site-scoped REST endpoints:

| Method | Path | Description |
|--------|------|-------------|
| POST | /sites/:siteId/preflights | Creates a new preflight job for a single URL |
| GET | /sites/:siteId/preflights | Gets all preflight jobs for a site |
| GET | /sites/:siteId/preflights/:preflightId | Gets a preflight job by ID |

### POST /sites/:siteId/preflights

**Request body** (`application/json`):
```json
{
  "url": "https://main--site--org.hlx.page/some-path",
  "step": "identify",
  "mystiqueUrl": "optional-ephemeral-host.stage.cloud.adobe.io"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string (URI) | Yes | The single page URL to analyze |
| `step` | enum: `identify` \| `suggest` | Yes | Audit step to perform |
| `mystiqueUrl` | string | No | Dev-only override for the Mysticat service URL |

`promiseToken` is passed via cookie for authenticated CMS pages (CS/CS_CW/AMS sites); it is not part of the request body.

**Response** `202 Accepted`:
```json
{
  "preflightId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "IN_PROGRESS",
  "createdAt": "2026-05-11T10:00:00.000Z",
  "pollUrl": "https://spacecat.experiencecloud.live/api/v1/sites/{siteId}/preflights/{preflightId}"
}
```

---

### GET /sites/:siteId/preflights

**Response** `200 OK` — grouped by URL, with a nested array of preflights per page. A site can have preflights for multiple URLs:
```json
[
  {
    "url": "https://main--site--org.hlx.page/some-path",
    "preflights": [
      {
        "preflightId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "status": "COMPLETED",
        "step": "identify",
        "createdAt": "2026-05-11T10:00:00.000Z"
      },
      {
        "preflightId": "7c9b1e32-1234-4abc-b3fc-9f8a7c6d5e4f",
        "status": "COMPLETED",
        "step": "suggest",
        "createdAt": "2026-05-11T10:05:00.000Z"
      }
    ]
  },
  {
    "url": "https://main--site--org.hlx.page/another-path",
    "preflights": [
      {
        "preflightId": "a1b2c3d4-5678-4def-b3fc-0e1f2a3b4c5d",
        "status": "IN_PROGRESS",
        "step": "identify",
        "createdAt": "2026-05-11T10:10:00.000Z"
      }
    ]
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | The page URL that was analyzed |
| `preflights` | array | Preflights run against this URL |
| `preflights[].preflightId` | UUID | Unique identifier for the preflight |
| `preflights[].status` | enum: `IN_PROGRESS` \| `COMPLETED` \| `FAILED` \| `CANCELLED` | Current job status |
| `preflights[].step` | enum: `identify` \| `suggest` | Audit step that was performed |
| `preflights[].createdAt` | ISO 8601 | When the preflight was created |

---

### GET /sites/:siteId/preflights/:preflightId

**Response** `200 OK` — full detail:
```json
{
  "preflightId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "COMPLETED",
  "step": "identify",
  "url": "https://main--site--org.hlx.page/some-path",
  "createdAt": "2026-05-11T10:00:00.000Z",
  "updatedAt": "2026-05-11T10:00:05.000Z",
  "startedAt": "2026-05-11T10:00:01.000Z",
  "endedAt": "2026-05-11T10:00:05.000Z",
  "result": {},
  "error": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `preflightId` | UUID | Unique identifier for the preflight |
| `status` | enum | `IN_PROGRESS` \| `COMPLETED` \| `FAILED` \| `CANCELLED` |
| `step` | enum | `identify` \| `suggest` |
| `url` | string | The page URL that was analyzed |
| `createdAt` | ISO 8601 | When the preflight was created |
| `updatedAt` | ISO 8601 | When the preflight was last updated |
| `startedAt` | ISO 8601 | When processing began |
| `endedAt` | ISO 8601 | When processing completed |
| `result` | object \| null | Audit results written back by Mysticat |
| `error` | object \| null | `{ code, message }` if the job failed |

---

Key changes:

- **`siteId` moves to the path.** URL-to-site resolution logic is removed from the controller.
- **One URL per request.** If the MFE supports bulk analysis in the future, the client issues
  one `POST /sites/:siteId/preflights` per URL. Each gets its own independent `preflightId`,
  status, result, and lifecycle. There is no batch endpoint — this keeps each preflight as a
  clean, independently pollable resource and avoids partial-failure complexity.
- **`jobId` renamed to `preflightId`** in all responses.
- **`pollUrl`** updated to point to `/sites/{siteId}/preflights/{preflightId}`.
- **`step`**, `mystiqueUrl` (dev-only), and `promiseToken` (cookie) are retained in the
  request body unchanged.
- **No `organizationId` in the path.** `siteId` is a globally unique UUID, consistent with
  all other site-scoped resources in this service.

**`/preflight/beta/jobs` is replaced** by the new endpoints and removed as part of this work.

**`/preflight/jobs` is deprecated**, not removed. It will remain functional until a future
deletion milestone is agreed upon with consumers. A deprecation notice should be added to its
OpenAPI spec entry and response headers.

## Open Question: Data Model for GET /sites/:siteId/preflights

The current implementation backs preflights with the generic `AsyncJob` model. `AsyncJob` has
no top-level `siteId` field — `siteId` is buried inside the `metadata` JSON blob. The
`AsyncJobCollection` exposes only `findById`; there is no `allBySiteId` or equivalent, and
no DB index exists on `metadata->>'siteId'`.

Supporting an efficient list endpoint requires one of the following approaches — **this is an
open decision for the team to resolve before implementation begins**:

**Option A — Extend `AsyncJob` in `spacecat-shared-data-access`**
Add `siteId` as a top-level indexed attribute on `AsyncJob` and add an
`allBySiteIdAndJobType(siteId, jobType)` collection method. Low friction, preserves the
existing backing store, but adds preflight-specific concerns to a generic model.

**Option B — New `Preflight` entity in `spacecat-shared-data-access`**
Introduce a purpose-built `Preflight` model with `siteId`, `url`, `step`, `status`,
timestamps, and `result` as first-class fields — indexed for efficient lookup by `siteId`.
More work upfront but the cleanest fit with the new REST design: if preflights are a
first-class API resource, a first-class data model is the natural companion. The internal
`AsyncJob` could remain as the execution mechanism, with `Preflight` as the queryable
projection layer.

**Option C — Raw metadata JSON query (not recommended)**
Filter on `metadata->>'siteId'` and `metadata->>'jobType'` directly. No schema change
required, but no index — equivalent to a full table scan as volume grows. Not viable for
production use.

**Recommendation**: Option B is preferred if the preflight resource is expected to grow
(history, pagination, filtering by step or status). Option A is sufficient if the list
endpoint is lightweight and low-volume.

## Consequences
- API shape is consistent with the rest of the service; new consumers can discover preflight
  endpoints without special-casing.
- Server-side URL-to-site resolution is eliminated, reducing a class of failure.
- Bulk preflight from the MFE is supported via multiple parallel requests — no API change
  needed as the feature grows.
- Existing consumers of `/preflight/beta/jobs` require migration to the new endpoints.
- Existing consumers of `/preflight/jobs` are unaffected for now; migration timeline to be
  coordinated separately.
- The `AsyncJob` model remains the backing store; `preflightId` maps to the underlying job ID
  internally.
