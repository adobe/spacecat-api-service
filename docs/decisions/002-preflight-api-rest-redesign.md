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

For authenticated CMS pages (CS, CS_CW, AMS), the promise token is sent on the `x-promise-token` request header (obtained from `POST /auth/v2/promise`); it is not part of the request body. The header is **required** for those authoring types; the API does not mint a promise token from the Spacecat session JWT in `Authorization`.

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
| `404 Not Found` | `PREFLIGHT_SITE_NOT_FOUND` | `siteId` does not exist |
| `502 Bad Gateway` | `PREFLIGHT_UPSTREAM_ERROR` | Mysticat returned a 5xx response |
| `500 Internal Server Error` | `PREFLIGHT_INTERNAL_ERROR` | Unexpected error within this service |

Error response body:
```json
{
  "errorCode": "PREFLIGHT_ACCESS_DENIED",
  "message": "Access denied"
}
```

`errorCode` gives consumers a stable machine-readable contract; `message` is a human-readable hint and should not be parsed by clients.

**Eligibility is Mysticat's decision, not SpaceCat's.** This endpoint does not consult `Configuration.handlers.preflight`, `Entitlement`, `SiteEnrollment`, or any product-code gating to decide whether the call should proceed. The only gate SpaceCat enforces is the tenancy boundary (`accessControlUtil.hasAccess(site)` — IMS org membership) plus the basic URL-belongs-to-site sanity check. Past those, the request proceeds to Mysticat unconditionally, and Mysticat's three-gate model (Gate 0 tier features, Gate 1 `enabled_opportunity_types`, Gates 2/3 per-fact + per-site overrides) is the sole source of truth for what runs. A site whose tier disables preflight will return `200` with `audits: []` — not a `403` from SpaceCat. See SITES-46202.

No job record is created for `400`, `403`, or `404` responses **emitted by SpaceCat's own checks** (access, URL validation). Once those pass, the `AsyncJob` + `Preflight` rows are created unconditionally before dispatching to Mysticat; any subsequent Mysticat-side `5xx` flips the rows to `FAILED` with a `502 PREFLIGHT_UPSTREAM_ERROR` response.

---

### GET /sites/:siteId/preflights

**Query parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string (URI, URL-encoded) | No | When present, filters results to preflights for this specific page URL only |

**Response** `200 OK` — a flat list of preflights for the site, sorted by `createdAt` descending. No pagination cap is applied at this stage. This is safe given: (a) results come from a dedicated `Preflight` table indexed on `siteId` — not the shared `AsyncJob` table; (b) preflights are human-triggered from the MFE, not batch-generated; (c) the 7-day TTL bounds per-site volume to a small set; (d) list items are lightweight (no result payload). Pagination will be added if evidence of consumer need emerges.
```json
[
  {
    "preflightId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "status": "COMPLETED",
    "url": "https://main--site--org.hlx.page/some-path",
    "createdAt": "2026-05-11T10:00:00.000Z",
    "createdBy": { "email": "ABC123@techacct.adobe.com", "displayName": "John Doe" }
  },
  {
    "preflightId": "7c9b1e32-1234-4abc-b3fc-9f8a7c6d5e4f",
    "status": "COMPLETED",
    "url": "https://main--site--org.hlx.page/some-path",
    "createdAt": "2026-05-11T10:05:00.000Z",
    "createdBy": { "email": "ABC123@techacct.adobe.com", "displayName": "John Doe" }
  },
  {
    "preflightId": "a1b2c3d4-5678-4def-b3fc-0e1f2a3b4c5d",
    "status": "IN_PROGRESS",
    "url": "https://main--site--org.hlx.page/another-path",
    "createdAt": "2026-05-11T10:10:00.000Z",
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
| `result` | object \| null | Audit results; always stored inline in `async_jobs.result` — `null` when the job has not yet completed. Shape is loosely typed here; the exact structure will be defined and strongly typed during implementation. |
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
  flow, making the field redundant. Promise-token auth via required `x-promise-token` (from `POST /auth/v2/promise`) is retained. The existing
  `step` branching in `src/preflight/links.js:102` and `src/preflight/metatags.js:103` is dead
  code that will be removed as part of this implementation.
- **`createdBy`** is captured server-side as `{ email, displayName }` from the caller's IMS
  profile and stored in async job metadata at creation time. It surfaces in all three endpoint
  responses for audit purposes. `email` is `profile.email` (the IMS user identifier — not
  always a human-readable address for technical accounts). `displayName` is composed from
  `profile.first_name + ' ' + profile.last_name` (falling back to `profile.name`). No
  additional IMS lookup required — both fields are on the authenticated profile.
- **No phantom jobs for SpaceCat-side rejections.** If the site is not found or the caller lacks
  access, the endpoint returns an error immediately without creating a job record. The previous
  behavior of creating a `CANCELLED` job in these cases is removed. Note that preflight-eligibility
  is **not** a SpaceCat-side concern (see Eligibility below) — sites whose tier disables preflight
  pass through to Mysticat and receive a `200` with `audits: []`, not a SpaceCat `403`.
- **No `organizationId` in the path.** `siteId` is a globally unique UUID, consistent with
  all other site-scoped resources in this service.

The `/preflight/beta/jobs` endpoints are removed, not deprecated — they were internal only and
this redesign is their replacement. The `/preflight/jobs` endpoints are deprecated and remain
functional until external consumers have migrated. Deprecation notices should be added to their
OpenAPI spec entries and response headers (`Deprecation: true`, `Sunset: <date>`). The Sunset
date will be set by PM at the time this ADR moves to Accepted, with a minimum of 90 days from
MFE migration start.

## Data Model

The backing entity design — including the rationale for a dedicated `Preflight` entity over
extending `AsyncJob`, the full field schema, collection methods, creation flow, TTL strategy,
and dual-store boundary — is captured in
[ADR-003: Dedicated Preflight Entity Design](003-preflight-entity-design.md).

That decision was aligned with @ekdogan (SITES-44675) before implementation began.

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
  job store clean. Eligibility (which audits run, whether the tier enables preflight at all) is
  delegated to Mysticat — see [SITES-46202](https://jira.corp.adobe.com/browse/SITES-46202). Callers
  that previously relied on polling a `CANCELLED` job to detect a disabled-preflight condition
  must now poll `Preflight.status` and inspect `result.audits` (an empty list signals the tier
  has nothing eligible to run for this site).
