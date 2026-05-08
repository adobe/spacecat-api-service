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
| POST | /sites/:siteId/preflights | Create a new preflight for a single URL |
| GET | /sites/:siteId/preflights | List preflights for a site |
| GET | /sites/:siteId/preflights/:preflightId | Get a preflight by ID |

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

The old `/preflight/*` routes are removed. Consumer migration is a separate coordination item.

## Consequences
- API shape is consistent with the rest of the service; new consumers can discover preflight
  endpoints without special-casing.
- Server-side URL-to-site resolution is eliminated, reducing a class of failure.
- Bulk preflight from the MFE is supported via multiple parallel requests — no API change
  needed as the feature grows.
- Existing consumers of `/preflight/jobs` and `/preflight/beta/jobs` require migration.
- The `AsyncJob` model remains the backing store; `preflightId` maps to the underlying job ID
  internally.
