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

`createdBy` is derived server-side from the caller's IMS profile (`authInfo.getProfile().email`) and is never supplied by the client.

**Response** `202 Accepted`:

Headers:
```
Location: https://spacecat.experiencecloud.live/api/v1/sites/{siteId}/preflights/{preflightId}
```

Body:
```json
{
  "preflightId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "IN_PROGRESS",
  "createdAt": "2026-05-11T10:00:00.000Z",
  "createdBy": "user@example.com"
}
```

**Error responses:**

| Status | Condition |
|--------|-----------|
| `400 Bad Request` | `url` or `step` is missing or invalid |
| `403 Forbidden` | Caller does not have access to the site, or preflight is not enabled / no preflight audits are enabled for the site |
| `404 Not Found` | `siteId` does not exist |
| `500 Internal Server Error` | Mysticat call failed or unexpected error |

No job record is created for `400`, `403`, or `404` responses. The current `/preflight/beta/jobs`
behavior of creating a job and immediately setting it to `CANCELLED` when preflight is disabled
is not carried forward — a `403` is returned immediately, keeping the job store clean.

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
        "createdAt": "2026-05-11T10:00:00.000Z",
        "createdBy": "user@example.com"
      },
      {
        "preflightId": "7c9b1e32-1234-4abc-b3fc-9f8a7c6d5e4f",
        "status": "COMPLETED",
        "step": "suggest",
        "createdAt": "2026-05-11T10:05:00.000Z",
        "createdBy": "user@example.com"
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
        "createdAt": "2026-05-11T10:10:00.000Z",
        "createdBy": "user@example.com"
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
| `preflights[].createdBy` | string | IMS email of the user who triggered the preflight |

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
  "createdBy": "user@example.com",
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
| `createdBy` | string | IMS email of the user who triggered the preflight |
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
- **`pollUrl` removed from the response body.** Per RFC 7231 §6.3.3, the URL of the created
  resource is communicated via the `Location` response header. Clients that need to poll for
  completion read `Location` rather than a body field.
- **`step`**, `mystiqueUrl` (dev-only), and `promiseToken` (cookie) are retained in the
  request body unchanged.
- **`createdBy`** is captured server-side from the caller's IMS profile and stored in job
  metadata. It surfaces in all three endpoint responses for audit purposes.
- **No phantom jobs for rejected requests.** If the site is not found, the caller lacks access,
  or preflight is not enabled for the site, the endpoint returns an error immediately without
  creating a job record. The previous behavior of creating a `CANCELLED` job in these cases
  is removed.
- **No `organizationId` in the path.** `siteId` is a globally unique UUID, consistent with
  all other site-scoped resources in this service.

**`/preflight/beta/jobs` is replaced** by the new endpoints and removed as part of this work.

**`/preflight/jobs` is deprecated**, not removed. It will remain functional until a future
deletion milestone is agreed upon with consumers. A deprecation notice should be added to its
OpenAPI spec entry and response headers.

## Data Model: Extending AsyncJob for Efficient siteId Queries

The current implementation backs preflights with the generic `AsyncJob` model. `AsyncJob` has
no top-level `siteId` field — `siteId` is buried inside the `metadata` JSON blob with no
index. The `AsyncJobCollection` exposes only `findById`; there is no `allBySiteId` method.

The decision is to **extend `AsyncJob` in `spacecat-shared-data-access`**:

- Add `siteId` as an **optional** top-level indexed attribute on the `AsyncJob` schema
- Add an `allBySiteIdAndJobType(siteId, jobType)` method to `AsyncJobCollection`

`siteId` must be optional so that existing job creation paths (including the deprecated
`/preflight/jobs` queue-based flow) continue to work unchanged — those jobs do not supply a
top-level `siteId` today and must not be required to. The new endpoints populate `siteId` at
job creation time and use the new collection method for list queries. Both workflows operate
in parallel without interference.

This is the right approach because `AsyncJob` records are TTL-based and short-lived (~7 days).
A purpose-built `Preflight` entity would require its own TTL and cleanup strategy, adding
complexity for no real gain given the inherently transient nature of the data. Extending
`AsyncJob` is low-friction and sufficient.

The `GET /sites/:siteId/preflights` controller will query by `siteId` and filter to
`jobType: "preflight"` jobs only, then group results by `url` from the metadata.

`createdBy` is stored as a top-level metadata field at job creation time, derived from
`authInfo.getProfile().email` (the IMS email of the authenticated caller). It is never
supplied by the client. This enables lightweight audit trails without a separate audit log.

Note: the `spacecat-shared-data-access` change is a prerequisite and must land before the
controller work in this repo.

## Consequences
- API shape is consistent with the rest of the service; new consumers can discover preflight
  endpoints without special-casing.
- Server-side URL-to-site resolution is eliminated, reducing a class of failure.
- Bulk preflight from the MFE is supported via multiple parallel requests — no API change
  needed as the feature grows.
- `/preflight/beta/jobs` was used exclusively by the internal team and has no external consumers,
  so its removal carries no migration burden.
- Existing consumers of `/preflight/jobs` are unaffected for now; migration timeline to be
  coordinated separately.
- The `AsyncJob` model remains the backing store; `preflightId` maps to the underlying job ID
  internally.
- Job records are only created for requests that pass validation and access checks, keeping the
  job store clean. Callers that previously relied on polling a `CANCELLED` job to detect a
  disabled-preflight condition must handle `403` instead.
