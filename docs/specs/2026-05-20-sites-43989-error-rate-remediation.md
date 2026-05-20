# SITES-43989 Error-Rate Remediation - Inline Fixes

Status: proposed
Last verified: 2026-05-20
Jira: [SITES-43989](https://jira.corp.adobe.com/browse/SITES-43989)

## Context

On 2026-05-04 the Sev1 "API Gateway Error Rate High" alert fired 3 times for AEM Sites
Optimizer. The alert monitors **total** error rate (4xx + 5xx combined). Two independent
sources pushed the rate over threshold:

1. LLM-hallucinated garbage URLs from a producer hammering the scrape `by-url` API with
   400s (the headline cause).
2. A steady background of 4xx from LLMO query endpoints returning `400` for sites whose
   data was not yet provisioned, plus ~94k/20min warn-level log noise from a missing
   webhook env var.

This spec covers only the **inline** subset of the SITES-43989 remediation - the small,
self-contained `spacecat-api-service` changes. Each fix stands on its own merit as
defense-in-depth; none depends on the others.

### Related work (NOT in this spec)

| Item | Where it lives |
|------|----------------|
| Producer emitting hallucinated URLs (root cause) | SITES-45110 (Mystique, Serhii) |
| Consumer-side URL guard (already merged) | mystique PR #1777 |
| `x-error` header sanitization (already merged) | spacecat-api-service PR #2331 |
| Scrape job-status routing bug (`jobId:"b"`) | SITES-45112 (Jan Hoffmann) |
| Fastly per-key rate limiting + backend health checks | Deferred |
| LLMO data backfill + onboarding provisioning hardening | Separate (Mystique onboarding) |
| SKYSI alert tuning (exclude expected 4xx) | External, SKYSI-owned |

## Guiding decision

The error-rate alert counts **all** 4xx+5xx, so changing a code to be "more correct"
(e.g. 400 -> 404) does not reduce the count; only reclassifying a condition to a **2xx**
removes it from the alert. We adopt a **hybrid** policy:

- Reclassify the genuinely-expected "no data yet" LLMO condition to an empty `200`.
- Leave the scrape API's `400` for malformed input unchanged (it is correct, and the
  producer already filters those URLs).
- Preserve real error semantics everywhere else (5xx, timeouts, auth).

---

## Fix 1 - Eliminate per-request `MYSTICAT_WORKSPACE_REPOS` warning

### Problem

`src/index.js:262` eagerly instantiates **every** controller on **every** request,
before routing. `WebhooksController`'s factory calls `getWorkspaceRepos(env, log)` in its
constructor body (`src/controllers/webhooks.js:67`), which emits:

```
log.warn('MYSTICAT_WORKSPACE_REPOS not set, using built-in defaults', { defaults })
```

when the env var is unset. Because the controller is built on every request, this warn
fires on all traffic - ~94,116 warns / 20 min in prod (99.99% of all warn-level logs).
The resolved `workspaceRepos` value is only ever **used** inside `processGitHubWebhook`
(`webhooks.js:159`), not in the constructor.

### Change

Move the `getWorkspaceRepos(env, log)` call out of the `WebhooksController` constructor and
into `processGitHubWebhook`, computed once when an actual GitHub webhook is processed. The
constructor becomes side-effect-free.

- Result: the warn only fires on genuine webhook deliveries (rare), not on every request.
  Expected reduction: ~94k/20min -> near zero.
- The `getWorkspaceRepos` logic (validation, defaults fallback) is unchanged - only its
  call site moves.

### Non-goal: do not set the env var

Coralogix confirms (2026-05-20) that **dev and prod both run on the built-in defaults
today** (the warn is present in both), and the built-in defaults
(`adobe/mysticat-architecture`, `adobe/mysticat-ai-native-guidelines`,
`Adobe-AEM-Sites/aem-sites-architecture`) are the intended set. So defaults remain
authoritative and no Vault/secret/deploy change is needed. Setting the env var is left as
an optional future explicitness improvement, out of scope here.

### Tests

- Update `test/controllers/webhooks.test.js`: the "logs warning when not set" assertion
  moves to the webhook-processing path (the warn no longer fires at construction).
- Add: constructing `WebhooksController` does not emit the warn.
- Existing tests for `getWorkspaceRepos` behavior (valid entries, invalid entries,
  empty -> defaults) still pass unchanged.

### Validation gate

```bash
npx mocha test/controllers/webhooks.test.js   # all green
npm run lint
```

---

## Fix 2 - LLMO upstream-404 returns empty success

### Problem

LLMO read endpoints proxy data from the elmo-ui-data source
(`https://main--project-elmo-ui-data--adobe.aem.live/{dataFolder}/...`). When a site is
LLMO-enabled (`config.llmo.dataFolder` set) but its data is not yet provisioned, the source
returns `404`. The current code treats any non-OK response as a hard failure:

```js
if (!response.ok) {
  throw new Error(`External API returned ${response.status}: ${response.statusText}`);
}
```

The throw propagates to the controller's catch, which returns
`badRequest(cleanupHeaderValue(error.message))` (a **400**) plus a `log.error`. This pattern
is duplicated across at least four endpoints:

| Endpoint | Controller fn | Current fetch/throw |
|----------|---------------|---------------------|
| `GET /sites/:siteId/llmo/data/.../:dataSource` (cached query) | `queryFiles` (llmo.js:1129) via `queryLlmoFiles` | llmo-query-handler.js:125-128 |
| `GET/POST /sites/:siteId/llmo/sheet-data/...` | `getLlmoSheetData` / `queryLlmoSheetData` | llmo.js ~239, ~342 |
| `GET /sites/:siteId/llmo/global-sheet-data/:configName` | `getLlmoGlobalSheetData` | llmo.js ~470 |

A site with unprovisioned data returns `400` on all of them. Measured contribution during
the incident: ~253 errors / 20 min.

Note: the multi-file path in `queryLlmoFiles` is already graceful (per-file `status: 'error'`
entries, no throw); only the single-file/sheet paths throw.

### Design

Centralize the source fetch into one shared helper and adopt 404-as-empty semantics
consistently (scope decision (i), consistent refactor).

**New helper** (in `llmo-query-handler.js` or a sibling util, exported):

```
fetchLlmoSource(context, url) ->
  - 2xx                     -> { status, data: <parsed json>, headers }
  - 404                     -> { status: 404, notProvisioned: true }   // no throw
  - other non-OK / timeout  -> throw Error   // preserve current error semantics
```

The helper **owns and preserves all existing fetch behavior**: the `LLMO_HLX_API_KEY`
presence check, the `Authorization: token` header, `Accept-Encoding: br`, the internal 15s
`AbortController` timeout, and the `AbortError -> "Request timeout"` mapping. Callers do not
manage the timeout.

**Each endpoint** routes its source fetch through `fetchLlmoSource` and, on
`notProvisioned`, returns its endpoint-appropriate **empty success** payload instead of
throwing. The empty payload must mirror the shape the source itself returns for a
genuinely-empty sheet (capture a real empty response to confirm the exact envelope,
including the `:version` value), e.g.:

```json
{ ":type": "sheet", ":version": <copy from a real empty source response>, "data": [], "total": 0, "offset": 0, "limit": 0 }
```

(Multi-sheet / files-array endpoints return the empty variant matching their normal success
shape.) Implementation must verify the exact envelope against a live empty response rather
than assume these field names.

**Logging:** the 404 / not-provisioned path logs at `info` (e.g. "LLMO data not yet
provisioned for site {siteId}, returning empty") plus a count/metric, so provisioning gaps
remain observable without inflating error logs. Genuine failures (5xx, timeout, auth) keep
`log.error` and their current non-2xx response.

### Behavior matrix

| Upstream condition | Before | After |
|--------------------|--------|-------|
| 2xx with rows | 200 data | 200 data (unchanged) |
| 2xx empty | 200 empty | 200 empty (unchanged) |
| 404 (not provisioned) | 400 + log.error | **200 empty + log.info + metric** |
| 5xx / timeout | 400 + log.error | 4xx/5xx + log.error (unchanged semantics) |
| 401 / 403 | as-is | as-is (unchanged) |

### Tests

- Unit: for each of the four endpoints, stub the source (nock) to return 404 -> assert
  `200` with the empty payload shape and an `info`-level log, not `error`.
- Unit: source returns 500 / aborts -> assert the endpoint still returns an error and logs
  `error` (no silent success).
- Unit: source returns 200 with rows -> unchanged behavior.
- Integration (`test/it/`): add an LLMO query case for a provisioned-but-empty vs
  not-provisioned site if seed data supports it.

### Validation gate

```bash
npx mocha test/controllers/llmo/llmo.test.js
npx mocha test/controllers/llmo/llmo-query-handler.test.js   # if present; else add
npm run lint
npm run docs:lint   # if any OpenAPI response examples change for these endpoints
```

---

## Fix 3 - Scrape API: no change (documented rationale)

Decision (C) deliberately leaves `getScrapeUrlByProcessingType` (`scrapeJob.js:203`)
unchanged. Rationale, recorded so it is not re-litigated:

- The endpoint returns `ok([])` (200) for any **structurally-valid** URL with no scrape yet
  (scrapeJob.js:226-228). It returns `badRequest` (400) **only** for empty or unparseable
  input (lines 207-219).
- Post-#1777, the producer (`get_page_data` in Mystique `suggestion_generator.py:282`)
  validates and **skips** malformed URLs before calling, and `get_from_spacecat` treats a
  404 as "no data". So structurally-valid hallucinated URLs reach the API and get a clean
  `200 ok([])`; malformed ones never leave the producer.
- Net: #1777 already drives this producer's scrape-API 4xx contribution to ~zero. A `400`
  for genuinely malformed input is correct REST and now low-volume - a legitimate signal
  worth keeping.

**Action:** none in `spacecat-api-service`. The producer's existing skip-warn provides
observability. If broader rate protection is wanted later, that is the deferred Fastly
per-key rate-limiting item, not a scrape-controller change.

---

## Risks and trade-offs

- **404 -> 200 hides provisioning gaps from HTTP status.** Mitigated by the `info` log +
  metric; the gap is still queryable. Accepted because the alternative (400s) is both
  alarm-inducing and arguably wrong (the client request was valid; the data just is not
  there yet).
- **Empty-shape compatibility.** The synthesized empty payload must match what clients
  already receive for genuinely-empty sheets, or a client could break. Verified against the
  source's empty-sheet response shape; covered by tests.
- **Refactor surface (scope i).** Centralizing four inline fetches into one helper touches
  more code than fixing only `queryFiles`. Mitigated by preserving exact fetch behavior and
  per-endpoint tests; the consistency payoff is that an unprovisioned site no longer 404s on
  three other endpoints.

## References

- Incident: [SITES-43989](https://jira.corp.adobe.com/browse/SITES-43989)
- Code: `src/controllers/webhooks.js`, `src/index.js:262`,
  `src/controllers/llmo/llmo.js`, `src/controllers/llmo/llmo-query-handler.js`,
  `src/controllers/scrapeJob.js`
- Merged precedents: spacecat-api-service PR #2331 (header sanitization), mystique PR #1777
  (producer URL guard)
- Coralogix evidence (2026-05-20): `MYSTICAT_WORKSPACE_REPOS not set` warn present in both
  `spacecat-services-dev` and `spacecat-services-prod` api-service logs -> both on defaults.
