# Preflight Request-ID — SpaceCat Design (`spacecat-api-service`)

## Context

`spacecat-api-service` is the Node.js (helix-universal) API layer that sits between the Preflight MFE and Mystique. It receives POST requests from the MFE and via API to create and poll preflight jobs, then calls Mystique's `POST /v1/preflight/analyze` endpoint.

The service has two preflight paths:
- **Legacy path** — `createPreflightJob` / `getPreflightJobStatusAndResult`, dispatches via SQS to `spacecat-audit-worker`. Slated for deletion eventually.
- **Beta path** — `createBetaPreflightJob` / `getBetaPreflightJobStatusAndResult`, calls Mystique directly over HTTP.

SpaceCat's role in this initiative is multiple:

1. **CORS gate** — add `x-preflight-request-id` to the allowed-headers list so browsers don't block the MFE's requests before they arrive.
2. **Middleware extraction** — pull the request ID from the incoming header, validate it, and attach it to `context` for downstream use.
3. **Structured logging** — replace unstructured template literals in the beta preflight controller with named key-value log records that include `preflightRequestId`, `imsOrgId`, `imsUserId`, `siteId`, `siteName`, `jobId`, `step`, and `durationMs`.
4. **Header forwarding** — pass `x-preflight-request-id` to Mystique so the ID threads through to the Mystique service.

## Files Changed

### `src/index.js` — CORS

Add `x-preflight-request-id` to the hardcoded `access-control-allow-headers` string in the `OPTIONS` early-return block. This is a one-line change and must land first — it unblocks MFE testing.

```js
'access-control-allow-headers': 'x-api-key, authorization, origin, x-requested-with, content-type, accept, x-import-api-key, x-client-type, x-trigger-audits, x-view-as-trial, x-promise-token, x-preflight-request-id',
```

### New file: `src/support/preflight-request-id-wrapper.js`

~20-line middleware. Reads the `x-preflight-request-id` header from the request, validates it as a UUID (regex or `crypto.randomUUID` round-trip), and attaches the value to `context.preflightRequestId`. If the header is absent or invalid, `context.preflightRequestId` is left undefined — downstream code handles that gracefully.

Register the wrapper on `main` in `src/index.js`, between `traceIdResponseWrapper` and `logWrapper`:

```js
import { preflightRequestIdWrapper } from './support/preflight-request-id-wrapper.js';

export const main = wrappedMain
  .with(localCORSWrapper)
  .with(traceIdResponseWrapper)
  .with(preflightRequestIdWrapper)   // <-- new
  .with(logWrapper)
  // ...
```

### `src/controllers/preflight.js` — structured logging

#### `preflightLogFields` helper

Add a small helper that assembles the common structured fields for every log call in this controller:

```js
function preflightLogFields(context, extra = {}) {
  return {
    preflightRequestId: context.preflightRequestId,
    imsOrgId: context.pathInfo?.headers?.['x-gw-ims-org-id'],
    imsUserId: context.attributes?.authInfo?.getProfile?.()?.user_id,
    ...extra,
  };
}
```

#### Updated log call sites (beta path only)

Every existing `log.error` and `log.info` call in `createBetaPreflightJob` and `getBetaPreflightJobStatusAndResult` is converted from an inline template literal to a structured object via `preflightLogFields`. Where a `site` object has already been resolved, the call site passes `siteName: site.getName()` alongside `siteId`. Where the error path runs before site lookup (e.g. validation failures, unresolved site), only `siteId` from `data.siteId` is available.

```js
// Before
log.error(`Failed to create beta preflight job: ${error.message}`);

// After (pre-lookup error — siteName not yet available)
log.error('preflight.create.error', preflightLogFields(context, {
  siteId: data.siteId,
  url: data.url,
  step: data.step,
  errorMessage: error.message,
}));
```

Success paths that are currently silent get new `log.info` entries:

```js
// After (site object in scope — include siteName)
log.info('preflight.create.success', preflightLogFields(context, {
  jobId,
  siteId: site.getId(),
  siteName: site.getName(),
  url,
  step,
  durationMs: Date.now() - t0,
}));
```

#### `callMysticatAnalyze` — forward the header

The function gains a `preflightRequestId` parameter and conditionally includes it in the outbound fetch headers:

```js
async function callMysticatAnalyze(
  mysticatBaseUrl, scanId, siteId, url, step, authorizationHeader, audits, preflightRequestId,
) {
  const response = await fetch(`${mysticatBaseUrl}/v1/preflight/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(hasText(authorizationHeader) && { Authorization: authorizationHeader }),
      ...(hasText(preflightRequestId) && { 'x-preflight-request-id': preflightRequestId }),
    },
    body: JSON.stringify({
      site_id: siteId, url, mode: step, scan_id: scanId, persist: true,
      ...(audits !== undefined && { audits }),
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Mysticat returned ${response.status}: ${text}`);
  }
}
```

The single caller of `callMysticatAnalyze` inside `createBetaPreflightJob` is updated to pass `context.preflightRequestId` as the new final argument.

## Identity Fields

`imsOrgId` comes from the `x-gw-ims-org-id` gateway header automatically added by the Adobe API Gateway. `imsUserId` comes from `authInfo.getProfile().user_id`. Both are naturally available in the SpaceCat request context and require no additional auth calls.

These fields are logged at the SpaceCat layer only. Mystique uses Okta OIDC for its own service-to-service auth and does not receive IMS identity. Cross-org queries that span both services are answered with a two-step join via `preflightRequestId`.

## Deployment Order

The CORS change (`src/index.js`) should be merged and deployed before the MFE change ships to production. Without it, browsers block the OPTIONS preflight and no POST reaches the server. The middleware and logging changes can be merged in the same PR or separately — they have no ordering constraint relative to each other.
