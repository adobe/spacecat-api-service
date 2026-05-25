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

~20-line middleware. Reads the `x-preflight-request-id` header from the request, validates it is a UUID v4, and attaches the value to `context.preflightRequestId`. If the header is absent or fails validation, `context.preflightRequestId` is left undefined — downstream code handles that gracefully (the value is omitted from log fields and not forwarded to Mystique).

**Validation:** use `isValidUUID` from `@adobe/spacecat-shared-utils` (the in-repo convention, already used in `src/controllers/opportunities.js`, `src/controllers/url-store.js`, etc.). It wraps the `uuid` package's `validate()` and pins to v4. Equivalent direct call: `uuid.validate(value) && uuid.version(value) === 4`.

**Why strict validation matters:** `preflightRequestId` is written into structured log records and forwarded as the outbound `x-preflight-request-id` header to Mystique. Accepting an unvalidated caller-supplied string opens a log-injection / header-injection / response-splitting vector (e.g. embedded newlines, control characters, or oversized payloads). A UUID v4 check restricts the value to a fixed-length, fixed-charset token before it ever reaches a logger or an outbound `fetch`.

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
    // profile.email holds the IMS User ID
    imsUserId: context.attributes?.authInfo?.getProfile?.()?.email,
    ...extra,
  };
}
```

#### Updated log call sites (beta path only)

Every existing `log.error` and `log.info` call in `createBetaPreflightJob` and `getBetaPreflightJobStatusAndResult` is converted from an inline template literal to a structured object via `preflightLogFields`. Where a `site` object has already been resolved, the call site passes `siteName: site.getName()` alongside `siteId`. Where the error path runs before site lookup (e.g. validation failures, unresolved site), only `siteId` from `data.siteId` is available.

**Function-scoped variables (timing + request fields).** Move the timing capture **and** the request-field destructure to the **first statements** of `createBetaPreflightJob` (and likewise for `getBetaPreflightJobStatusAndResult`), before the early `badRequest` validation branches:

```js
const t0 = Date.now();
const { data = {} } = context;
const { url, siteId } = data;
const step = data.step?.toLowerCase();
```

Today in `src/controllers/preflight.js`, `step` is normalized to lowercase only *after* the step-validation `badRequest` branch, so a log call in any pre-validation branch would have to fall back to raw `data.step` and the same field would carry two different values (raw vs. lowercased) depending on which branch fired. Moving the declaration to the top normalizes that: `step` is `undefined` for a malformed request and lowercased otherwise, but it's the **same variable** at every call site. The existing step-validation check then simplifies to `if (![AUDIT_STEP_IDENTIFY, AUDIT_STEP_SUGGEST].includes(step))`. This also guarantees `durationMs: Date.now() - t0` is well-defined on every log line — success, validation failure, or thrown error — without per-call-site guards.

```js
// Before
log.error(`Failed to create beta preflight job: ${error.message}`);

// After (pre-lookup error — siteName not yet available)
log.error('preflight.create.error', preflightLogFields(context, {
  siteId,
  url,
  step,
  errorMessage: error.message,
  durationMs: Date.now() - t0,
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

Note that the success-path `siteId: site.getId()` deliberately overrides the function-scoped `siteId` — when a site has been resolved, the resolved id is the source of truth (the request may have arrived without `data.siteId`, in which case the site was looked up by preview URL instead).

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

**Legacy path (intentional non-coverage).** `preflightRequestId` is not propagated on the legacy path — it's slated for deletion, the MFE never sets the header on legacy requests, and forwarding via SQS would require a worker-side change.

## Identity Fields

`imsOrgId` comes from the `x-gw-ims-org-id` gateway header automatically added by the Adobe API Gateway. `imsUserId` comes from `authInfo.getProfile().email` (despite the field name).  Both are naturally available in the SpaceCat request context and require no additional auth calls.

**Header accessor (`context.pathInfo.headers`).** All request headers in this service are read via `context.pathInfo.headers` — populated by the `enrichPathInfo` middleware in the global wrapper chain (`src/index.js`). This is the existing convention in `src/controllers/preflight.js` itself (`resolvePromiseToken` reads `x-promise-token` from `context.pathInfo.headers`, case-insensitively) and across every other controller (`sites.js`, `organizations.js`, `webhooks.js`, `import.js`, `consumers.js`, `llmo/llmo.js`, …). Reading `imsOrgId` via the same accessor keeps the controller consistent and avoids the helix-universal trap where some routes surface headers under `context.invocation.event.headers` instead. (The new `preflightRequestIdWrapper` itself runs *before* `enrichPathInfo` and therefore reads from `request.headers` directly — see the snippet above.)

These fields are logged at the SpaceCat layer only. Mystique uses Okta OIDC for its own service-to-service auth and does not receive IMS identity. Cross-org queries that span both services are answered with a two-step join via `preflightRequestId`.

## Deployment Order

The CORS change (`src/index.js`) should be merged and deployed before the MFE change ships to production. Without it, browsers block the OPTIONS preflight and no POST reaches the server. The middleware and logging changes can be merged in the same PR or separately — they have no ordering constraint relative to each other.

## Pre-Cutover Checklist

**Coralogix indexing for `preflightRequestId`.** Before relying on cross-service tracing (SpaceCat ↔ Mystique), confirm with the observability owner that `preflightRequestId` is registered as an **indexed structured field** in Coralogix — not just emitted in the JSON log body. The whole point of a structured request-ID field is that you can `preflightRequestId:"<uuid>"` it across both services' log streams; if the field lands in an unindexed JSON blob, that join becomes a full-text scan and the value of threading the ID through is largely lost. The same check applies to `imsOrgId`, `imsUserId`, `siteId`, and `jobId` if cross-service searches by those fields are expected.
