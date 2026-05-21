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

## Decision
Replace both endpoint pairs with three site-scoped REST endpoints:

| Method | Path | Description |
|--------|------|-------------|
| POST | /sites/:siteId/preflights | Creates a new preflight job for a single URL |
| GET | /sites/:siteId/preflights | Gets all preflight jobs for a site |
| GET | /sites/:siteId/preflights/:preflightId | Gets a preflight job by ID |

The `/preflight/beta/jobs` endpoints had no external consumers and are removed outright as part
of this change — they were always an internal development path, never a durable API. The
queue-based `/preflight/jobs` endpoints have external consumers and are deprecated in parallel
until those consumers have migrated:

| Endpoint | Action |
|----------|--------|
| POST /preflight/beta/jobs | **Removed** — internal only; replaced by this redesign |
| GET /preflight/beta/jobs/:jobId | **Removed** — internal only; replaced by this redesign |
| POST /preflight/jobs | **Deprecated** — queue-based; migration timeline to be coordinated with consumers |
| GET /preflight/jobs/:jobId | **Deprecated** — queue-based; migration timeline to be coordinated with consumers |

### POST /sites/:siteId/preflights

**Request body** (`application/json`):
```json
{
  "url": "https://main--site--org.hlx.page/some-path"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string (URI) | Yes | The single page URL to analyze — must belong to the site identified by `:siteId` |

The controller validates that the `url` hostname matches one of the site's known hostnames
(base URL, preview URL, or live URL). A URL that is structurally valid but belongs to a
different site returns `PREFLIGHT_INVALID_REQUEST`. This replaces the implicit validation
previously provided by `findByPreviewURL`.

`promiseToken` is passed via cookie for authenticated CMS pages (CS/CS_CW/AMS sites); it is not part of the request body.

`createdBy` is derived server-side from the caller's IMS profile and is never supplied by the client. It is an object containing the IMS user email (`profile.email`) and a display name composed from `profile.first_name` and `profile.last_name` (falling back to `profile.name`). Both fields are stored in async job metadata at creation time. No additional IMS lookup is required — both are available on the authenticated profile.

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
  "createdBy": {
    "email": "ABC123@techacct.adobe.com",
    "displayName": "John Doe"
  }
}
```

**Error responses:**

| Status | `errorCode` | Condition |
|--------|-------------|-----------|
| `400 Bad Request` | `PREFLIGHT_INVALID_REQUEST` | `url` is missing, not a valid URI, or does not belong to the site identified by `:siteId` |
| `403 Forbidden` | `PREFLIGHT_ACCESS_DENIED` | Caller does not have access to the site |
| `403 Forbidden` | `PREFLIGHT_NOT_ENABLED` | Preflight is not enabled for the site |
| `404 Not Found` | `PREFLIGHT_SITE_NOT_FOUND` | `siteId` does not exist |
| `502 Bad Gateway` | `PREFLIGHT_UPSTREAM_ERROR` | Mysticat returned a 5xx response |
| `500 Internal Server Error` | `PREFLIGHT_INTERNAL_ERROR` | Unexpected error within this service |

Error response body:
```json
{
  "errorCode": "PREFLIGHT_NOT_ENABLED",
  "message": "Preflight is not enabled for this site"
}
```

`errorCode` gives consumers a stable machine-readable contract; `message` is a human-readable hint and should not be parsed by clients.

No job record is created for `400`, `403`, or `404` responses. The current `/preflight/beta/jobs`
behavior of creating a job and immediately setting it to `CANCELLED` when preflight is disabled
is not carried forward — a `403` is returned immediately, keeping the job store clean.

---

### GET /sites/:siteId/preflights

**Query parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string (URI, URL-encoded) | No | When present, filters results to preflights for this specific page URL only |

**Response** `200 OK` — a flat list of preflights for the site, sorted by `createdAt` descending. No cap is applied; the 7-day TTL on `AsyncJob` records provides the natural upper bound. Pagination is deferred until there is evidence of consumers needing it.
```json
[
  {
    "preflightId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "status": "COMPLETED",
    "url": "https://main--site--org.hlx.page/some-path",
    "createdAt": "2026-05-11T10:00:00.000Z",
    "updatedAt": "2026-05-11T10:00:05.000Z",
    "createdBy": { "email": "ABC123@techacct.adobe.com", "displayName": "John Doe" }
  },
  {
    "preflightId": "7c9b1e32-1234-4abc-b3fc-9f8a7c6d5e4f",
    "status": "COMPLETED",
    "url": "https://main--site--org.hlx.page/some-path",
    "createdAt": "2026-05-11T10:05:00.000Z",
    "updatedAt": "2026-05-11T10:05:04.000Z",
    "createdBy": { "email": "ABC123@techacct.adobe.com", "displayName": "John Doe" }
  },
  {
    "preflightId": "a1b2c3d4-5678-4def-b3fc-0e1f2a3b4c5d",
    "status": "IN_PROGRESS",
    "url": "https://main--site--org.hlx.page/another-path",
    "createdAt": "2026-05-11T10:10:00.000Z",
    "updatedAt": "2026-05-11T10:10:00.000Z",
    "createdBy": { "email": "ABC123@techacct.adobe.com", "displayName": "John Doe" }
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `preflightId` | UUID | Unique identifier for the preflight |
| `status` | enum: `IN_PROGRESS` \| `COMPLETED` \| `FAILED` \| `CANCELLED` | Current job status |
| `url` | string | The page URL that was analyzed |
| `createdAt` | ISO 8601 | When the preflight was created |
| `updatedAt` | ISO 8601 | When the preflight was last updated |
| `createdBy` | object | Caller identity — `{ email, displayName }` |
| `createdBy.email` | string | IMS user email (`profile.email`) |
| `createdBy.displayName` | string | Full name from IMS profile |

---

### GET /sites/:siteId/preflights/:preflightId

**Response** `200 OK` — full detail:
```json
{
  "preflightId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "COMPLETED",
  "url": "https://main--site--org.hlx.page/some-path",
  "createdAt": "2026-05-11T10:00:00.000Z",
  "createdBy": {
    "email": "ABC123@techacct.adobe.com",
    "displayName": "John Doe"
  },
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
| `url` | string | The page URL that was analyzed |
| `createdAt` | ISO 8601 | When the preflight was created |
| `createdBy` | object | Caller identity — `{ email, displayName }` |
| `createdBy.email` | string | IMS user email (`profile.email`) |
| `createdBy.displayName` | string | Full name from IMS profile |
| `updatedAt` | ISO 8601 | When the preflight was last updated |
| `startedAt` | ISO 8601 | When processing began |
| `endedAt` | ISO 8601 | When processing completed |
| `result` | object \| null | Audit results; always stored inline in `async_jobs.result` — `null` when the job has not yet completed |
| `error` | object \| null | `{ code, message }` if the job failed |

**Ownership validation:** The handler loads the job by `preflightId` then verifies the stored `siteId` matches the path's `:siteId`. A mismatch returns `404 Not Found` — the same response as a non-existent `preflightId` — so callers cannot confirm a preflight exists by probing with a different site path.

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
- **`step` is removed.** Mysticat's agent always performs both identify and suggest as a single
  flow, making the field redundant. `promiseToken` (cookie) is retained unchanged. The existing
  `step` branching in `src/preflight/links.js:102` and `src/preflight/metatags.js:103` is dead
  code that will be removed as part of this implementation.
- **`createdBy`** is captured server-side as `{ email, displayName }` from the caller's IMS
  profile and stored in async job metadata at creation time. It surfaces in all three endpoint
  responses for audit purposes. `email` is `profile.email` (the IMS user identifier — not
  always a human-readable address for technical accounts). `displayName` is composed from
  `profile.first_name + ' ' + profile.last_name` (falling back to `profile.name`). No
  additional IMS lookup required — both fields are on the authenticated profile.
- **No phantom jobs for rejected requests.** If the site is not found, the caller lacks access,
  or preflight is not enabled for the site, the endpoint returns an error immediately without
  creating a job record. The previous behavior of creating a `CANCELLED` job in these cases
  is removed.
- **No `organizationId` in the path.** `siteId` is a globally unique UUID, consistent with
  all other site-scoped resources in this service.

The `/preflight/beta/jobs` endpoints are removed, not deprecated — they were internal only and
this redesign is their replacement. The `/preflight/jobs` endpoints are deprecated and remain
functional until external consumers have migrated. Deprecation notices should be added to their
OpenAPI spec entries and response headers (`Deprecation: true`, `Sunset: <date>`). The Sunset
date will be set by PM at the time this ADR moves to Accepted, with a minimum of 90 days from
MFE migration start.

## Data Model: Dedicated Preflight Entity

The current implementation backs preflights with the generic `AsyncJob` model. `AsyncJob` is
not exclusive to preflight — it is a shared backing store used by site-detection, PR review,
and both legacy preflight variants (`preflight` and `preflight-beta`), each distinguished only
by a `jobType` string buried in the `metadata` blob. Using it as the preflight backing store
creates several problems:

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
  post-filter pass. Preflight jobs represent a fraction of total `AsyncJob` volume; a dedicated
  `preflights` table makes every row in the index a preflight by definition, keeping the index
  small and the query clean with no cross-workflow contamination.

The decision is to **introduce a dedicated `Preflight` entity in `spacecat-shared-data-access`**
rather than extending `AsyncJob`. The `Preflight` entity owns the domain record and holds a
1-to-1 FK reference to an `AsyncJob` via `asyncJobId` for execution lifecycle tracking (status
polling, result storage). The `asyncJobId` is never exposed to API consumers.

**`Preflight` entity — first-class fields:**

| Field | Type | Description |
|-------|------|-------------|
| `preflightId` | UUID | Primary key |
| `siteId` | UUID (indexed) | The site this preflight belongs to |
| `url` | string | The page URL that was analyzed; `(site_id, url)` composite index deferred — `url` filter is applied in-memory (see collection methods) |
| `asyncJobId` | UUID (FK to `async_jobs`, 1-to-1) | Backing AsyncJob reference for execution lifecycle tracking; never exposed to API consumers |
| `status` | enum | `IN_PROGRESS` \| `COMPLETED` \| `FAILED` \| `CANCELLED` |
| `createdBy` | object | `{ email, displayName }` from IMS profile at creation time |
| `createdAt` | ISO 8601 | Creation timestamp |
| `updatedAt` | ISO 8601 | Last update timestamp |
| `startedAt` | ISO 8601 | When processing began |
| `endedAt` | ISO 8601 | When processing completed |
| `result` | object \| null | Audit result payload; null until completed |
| `error` | object \| null | `{ code, message }` on failure |

**`PreflightCollection` — methods:**

- `allBySiteId(siteId)` — returns all preflights for a site, sorted by `createdAt` descending;
  `url` filter applied in-memory when `?url=` query parameter is present
- `findById(preflightId)` — loads a single preflight; caller verifies `siteId` matches path

**Creation flow:** The controller creates the `AsyncJob` first, receives the `asyncJobId`, then
immediately creates the `Preflight` entity with `asyncJobId` as the FK. This ordering ensures
the execution primitive exists before the domain record that references it.

**TTL** is configured on the `Preflight` table/collection at the same 7-day window as
`AsyncJob`. The TTL column approach matches the `async_jobs` mechanism — verify the exact
column name in `mysticat-data-service` before writing the migration. Given the 1-to-1
relationship, the two records expire together: when the `AsyncJob` TTLs, the associated
`Preflight` record is also obsolete.

`createdBy` is derived from the caller's IMS profile at job creation time: `email` is
`profile.email` (the IMS user identifier); `displayName` is composed from
`profile.first_name + ' ' + profile.last_name` (falling back to `profile.name`). It is
never supplied by the client.

`/preflight/beta/jobs` is removed outright as part of this work — it is replaced by the new
endpoints, not deprecated. `/preflight/jobs` is the only legacy endpoint; it continues writing
to `AsyncJob` unchanged until external consumers have migrated. The new
`/sites/:siteId/preflights` endpoints write exclusively to the `Preflight` entity.

Alignment with @ekdogan is complete (SITES-44675). Agreed decisions: 1-to-1 FK relationship
via `asyncJobId`; TTL column at 7 days matching `async_jobs`; `url` index deferred —
in-memory filter is sufficient given 7-day TTL bounds per-site volume; `allBySiteId` uses
the standard `BaseCollection.all()` pattern; `/preflight/beta/jobs` removed (replaced by new
endpoints), `/preflight/jobs` deprecated in parallel until external consumers migrate.

**This change is scoped to `spacecat-shared-data-access` and is a prerequisite that must land
before the controller work in this repo.** See SITES-44675 for the tracking ticket.

## Consequences
- API shape is consistent with the rest of the service; new consumers can discover preflight
  endpoints without special-casing.
- Server-side URL-to-site resolution is eliminated, reducing a class of failure.
- Bulk preflight from the MFE is supported via multiple parallel requests — no API change
  needed as the feature grows.
- `/preflight/beta/jobs` is removed outright — it was an internal development path and this
  redesign is its replacement. No external consumer coordination required.
- Existing consumers of `/preflight/jobs` are unaffected for now; migration timeline to be
  coordinated separately.
- Job records are only created for requests that pass validation and access checks, keeping the
  job store clean. Callers that previously relied on polling a `CANCELLED` job to detect a
  disabled-preflight condition must handle `403` instead.
