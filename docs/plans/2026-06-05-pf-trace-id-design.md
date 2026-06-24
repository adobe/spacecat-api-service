# Preflight Trace-ID — SpaceCat Design (`spacecat-api-service`)

Two remaining items for full trace-ID observability in `src/controllers/preflight.js`:

1. **Structured logging** — add `[Preflight]` key=value `log.info` calls at key points in `createPreflight` so Coralogix searches by `siteId`, `siteName`, `jobId` work across the preflight pipeline.
2. **Header forwarding** — pass `x-trace-id` to Mystique on the outbound `callMysticatAnalyze` fetch using the existing `addTraceIdHeader` helper from `@adobe/spacecat-shared-utils`.

## Structured logging (`createPreflight`)

Add `log.info` calls at key points following the existing pattern in the controller:

```js
log.info(`[Preflight] created job jobId=${asyncJob.getId()}, siteId=${site.getId()}, orgId=${site.getOrganizationId()}, url=${url}`);
```

## Header forwarding (`callMysticatAnalyze`)

Add `context` as the last parameter and wrap the headers object with `addTraceIdHeader`:

```js
import { addTraceIdHeader } from '@adobe/spacecat-shared-utils';

async function callMysticatAnalyze(
  mysticatBaseUrl,
  scanId,
  siteId,
  url,
  authorizationHeader,
  context,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const baseHeaders = {
    'Content-Type': 'application/json',
    ...(hasText(authorizationHeader) && { Authorization: authorizationHeader }),
  };
  let response;
  try {
    response = await fetch(`${mysticatBaseUrl}/v1/preflight/analyze`, {
      method: 'POST',
      signal: controller.signal,
      headers: addTraceIdHeader(baseHeaders, context),
      body: JSON.stringify({ site_id: siteId, url, scan_id: scanId, persist: true }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Mysticat returned ${response.status}: ${text}`);
  }
}
```

Pass `context` at the call site:

```js
await callMysticatAnalyze(
  env.MYSTIQUE_API_BASE_URL,
  asyncJob.getId(),
  siteId,
  url,
  authorizationHeader,
  context,
);
```
