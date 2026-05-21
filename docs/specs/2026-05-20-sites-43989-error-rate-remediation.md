# SITES-43989 Error-Rate Remediation - Inline Fixes

- **Date:** 2026-05-20
- **Author:** Dominique Jaeggi
- **Status:** Proposed
- **Jira:** [SITES-43989](https://jira.corp.adobe.com/browse/SITES-43989)
- **Target repo:** `adobe/spacecat-api-service`

## Context

On 2026-05-04 the Sev1 "API Gateway Error Rate High" alert (SKYSI-76262) fired 3 times for
AEM Sites Optimizer. The alert monitors **total** error rate (4xx + 5xx combined). Two
independent sources pushed the rate over threshold:

1. LLM-hallucinated garbage URLs from a producer hammering the scrape `by-url` API with
   400s (the headline cause).
2. A steady background of 4xx from LLMO query endpoints returning `400` for sites whose
   data was not yet provisioned (~253 errors / 20 min), plus ~94k/20min warn-level log
   noise from a missing webhook env var.

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
removes it from the alert. We adopt a **hybrid reclassification policy**:

- Reclassify the genuinely-expected "no data yet" LLMO condition (upstream 404) to an
  empty `200`.
- Map genuine upstream failures to honest status codes instead of today's blanket 400:
  upstream **5xx -> 502**, **timeout -> 504**, non-404 4xx **passed through**, auth
  (401/403) unchanged.
- Leave the scrape API's `400` for malformed input unchanged (it is correct, and the
  producer already filters those URLs).

This policy is **LLMO-only** for now. The service has other upstream-proxy paths;
generalizing "upstream-404 -> empty success" into a service-wide pattern is explicitly out
of scope until a second use case justifies it.

## Implementation phasing

Several contracts must be pinned before code is written, so implementation is split:

**Phase 0 - pin contracts (complete before Phase 1):**

1. **Capture empty-response fixtures.** `curl` the elmo-ui-data source for a known-empty
   folder for each of the three response shapes (single-file, multi-sheet, files-array)
   using the real `LLMO_HLX_API_KEY`, and commit the captured JSON as test fixtures. These
   fixtures ARE the empty-200 contract; the synthesized payloads must byte-match them.
2. **Audit and decide fetch unification** (see Fix 2). Test the largest current sheet-data
   payloads against a 15s timeout in dev and confirm none legitimately exceed it before
   adopting the timeout everywhere.
3. **Confirm metric ingestion.** Verify the chosen log level for the not-provisioned event
   reaches Coralogix ingestion and author the `events2metrics` rule.

**Phase 1 - implement** the three fixes against the pinned contracts.

---

## Fix 1 - Eliminate per-request `MYSTICAT_WORKSPACE_REPOS` warning

### Problem

`src/index.js:262` eagerly instantiates **every** controller on **every** request, before
routing. `WebhooksController`'s factory calls `getWorkspaceRepos(env, log)` in its
constructor body (`src/controllers/webhooks.js:67`), which emits:

```
log.warn('MYSTICAT_WORKSPACE_REPOS not set, using built-in defaults', { defaults })
```

when the env var is unset. Because the controller is built on every request, this warn
fires on all traffic - ~94,116 warns / 20 min in prod (99.99% of all warn-level logs). The
resolved `workspaceRepos` value is only ever **used** inside `processGitHubWebhook`
(`webhooks.js:159`), not in the constructor.

### Change

1. **Move the call site.** Move `getWorkspaceRepos(env, log)` out of the `WebhooksController`
   constructor and into `processGitHubWebhook`, computed once **per webhook request**
   (consistent with the per-request controller model; no global/cross-request caching is
   intended or needed). The constructor becomes side-effect-free. The warn then fires only
   on genuine webhook deliveries (rare), not on all traffic: ~94k/20min -> near zero.
2. **Reclassify the warn.** Unset-using-defaults is the confirmed-intended steady state (see
   Non-goal), so warning on it is noise nobody should act on. Emit the warn **only** when
   `MYSTICAT_WORKSPACE_REPOS` is present-but-invalid (the genuinely actionable case); for the
   unset -> defaults branch, drop to `debug`. The validation/fallback logic is otherwise
   unchanged.

> **Forward note (out of scope here):** the root enabler is that `src/index.js:262`
> instantiates every controller per request before routing, so any factory-level side
> effect (logging, I/O) runs on all traffic. New controllers should keep their factory pure
> and defer side effects to the handler.

### Non-goal: do not set the env var

Coralogix confirms (2026-05-20) that **dev and prod both run on the built-in defaults
today** (the warn is present in both), and the built-in defaults
(`adobe/mysticat-architecture`, `adobe/mysticat-ai-native-guidelines`,
`Adobe-AEM-Sites/aem-sites-architecture`) are the intended set. So defaults remain
authoritative and no Vault/secret/deploy change is needed. With the warn reclassified
(change 2 above), the unset-using-defaults state is now silent - matching its intentional
status - and only a present-but-invalid value warns. Setting the env var is left as an
optional future explicitness improvement, out of scope here.

### Tests

- Update `test/controllers/webhooks.test.js`: constructing `WebhooksController` emits no
  warn; the unset -> defaults path no longer warns (now `debug`); a present-but-invalid
  `MYSTICAT_WORKSPACE_REPOS` still warns, on the webhook-processing path.
- Concurrency intent: `getWorkspaceRepos` is computed once per request; no global
  single-compute is intended or asserted.
- Existing valid / invalid / empty -> defaults behavior tests still pass.

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
is duplicated across four endpoints:

| Endpoint | Controller fn | Current fetch/throw |
|----------|---------------|---------------------|
| `GET /sites/:siteId/llmo/data/.../:dataSource` (cached query) | `queryFiles` (llmo.js:1129) via `queryLlmoFiles` | llmo-query-handler.js:125-128 |
| `GET/POST /sites/:siteId/llmo/sheet-data/...` | `getLlmoSheetData` / `queryLlmoSheetData` | llmo.js:239, :342 |
| `GET /sites/:siteId/llmo/global-sheet-data/:configName` | `getLlmoGlobalSheetData` | llmo.js:470 |

A site with unprovisioned data returns `400` on all of them: ~253 errors / 20 min during the
incident (the alert-firing delta this fix removes).

### Fetch behavior is NOT uniform today (must unify)

The four call sites do **not** share fetch behavior in the base code, so "preserve existing
behavior" is undefined. Verified against base:

- `llmo-query-handler.js` (`fetchAndProcessSingleFile`): has the 15s `AbortController`
  timeout, an explicit `if (!env.LLMO_HLX_API_KEY) throw` check, and the
  `AbortError -> "Request timeout"` mapping.
- The three sheet endpoints in `llmo.js` (`getLlmoSheetData` :231, `queryLlmoSheetData` :334,
  `getLlmoGlobalSheetData` :462): have **no** timeout and use
  `env.LLMO_HLX_API_KEY || 'hlx_api_key_missing'` (a bogus token, so the source returns 401
  rather than the controller failing at the boundary).

The shared helper adopts the **stricter** query-handler behavior for all four. This is a
**behavior change** for the three sheet endpoints, not "preserved behavior":

- Gains a 15s timeout where none existed - a fetch that legitimately runs >15s would now
  abort. **Phase 0 step 2** validates the largest current payloads against 15s before
  adopting.
- A missing key now throws at the boundary (server-side error) instead of forwarding a
  bogus token and getting a 401.

Both are net improvements, but they are changes and must be tested as such.

### Design

Centralize the source fetch into one shared module **`src/controllers/llmo/llmo-source.js`**,
imported by both `llmo.js` and `llmo-query-handler.js` (a dedicated module avoids the awkward
import direction of housing it inside the query handler):

```
fetchLlmoSource(context, url) ->
  - 2xx           -> { status, data: <parsed json>, headers }
  - 404           -> { status: 404, noData: true }            // no throw
  - other non-OK  -> throw, with upstream status attached     // caller maps 5xx->502, 4xx passthrough
  - timeout/abort -> throw "Request timeout"                  // caller maps -> 504
```

The contract is intentionally about HTTP semantics: `noData` means "upstream 404"; the
**caller** interprets that as "not provisioned" for LLMO, so the helper stays
backend-agnostic. The helper owns the 15s timeout, the `LLMO_HLX_API_KEY` presence check,
the request headers, and the abort mapping (see unification above).

**On `noData`,** each endpoint returns its **empty success** payload - byte-identical to the
Phase 0 captured fixture for that response shape - plus a discriminator header:

```
x-llmo-data-status: not-provisioned
```

The body stays identical to a genuinely-empty sheet (compatibility requirement), while the
header lets clients/UI distinguish "provisioned-but-empty" (header absent) from
"not-provisioned" (header present). This is the cheap-now / hard-to-retrofit boundary signal
the next requirements ("show 'data being prepared'", "alert on provisioning stuck >72h")
will need.

**Multi-file path consistency:** `queryLlmoFiles` multi-file mode currently returns per-file
`{ status: 'error' }` for any failure including 404. Update it to return
`{ status: 'no_data' }` for upstream 404 (distinct from `'error'` for genuine failures), so
single-file empty-200 and multi-file results report the not-provisioned condition
consistently.

**Logging + metric:** on the not-provisioned (404) branch, emit one **structured** log line,
e.g. `{ event: 'llmo_data_not_provisioned', siteId, dataFolder }`. The durable, queryable
signal is a **Coralogix `events2metrics` rule** keyed on `event = 'llmo_data_not_provisioned'`
(a per-site counter), authored in Phase 0 - not an ad-hoc `log.info`, since `src/` has no
CloudWatch `putMetricData` pattern to lean on. Emit at `debug` to avoid steady-state `info`
volume from dashboard/audit polling, **provided** Phase 0 confirms debug logs reach Coralogix
ingestion; if they do not, use `info` and rely on the events2metrics aggregate rather than
raw-log queries. Genuine failures keep `log.error`.

### Behavior matrix

| Upstream condition | Before | After |
|--------------------|--------|-------|
| 2xx with rows | 200 data | 200 data (unchanged) |
| 2xx empty | 200 empty | 200 empty (unchanged) |
| 404 (not provisioned) | 400 + log.error | **200 empty + `x-llmo-data-status: not-provisioned` + structured `debug` log + events2metrics** |
| upstream 5xx | 400 + log.error | **502 + log.error** |
| timeout / abort | 400 + log.error | **504 + log.error** |
| upstream non-404 4xx | 400 + log.error | **upstream 4xx passthrough + log.error** |
| 401 / 403 (LLMO access today) | as-is | as-is (unchanged) |

Prose and matrix now agree: only the 404 case becomes 2xx; every other failure maps to an
honest non-2xx.

### Tests

- Per endpoint (nock-stub the source):
  - 404 -> `200`, empty payload **byte-matches the Phase 0 fixture**,
    `x-llmo-data-status: not-provisioned`, structured not-provisioned log, no `error` log.
  - upstream 500 -> `502` + `error`; abort/timeout -> `504` + `error`; non-404 4xx ->
    passthrough; 401/403 -> unchanged.
  - 2xx with rows -> unchanged.
- Multi-file: 404 per file -> `status: 'no_data'`; genuine failure -> `status: 'error'`.
- Integration (`test/it/`): provisioned-but-empty vs not-provisioned site, if seed data
  supports it.

### Validation gate

```bash
# Phase 0 (one-time, before merge): capture and pin the live empty envelope; paste into the PR
curl -sS -H "Authorization: token $LLMO_HLX_API_KEY" \
  "https://main--project-elmo-ui-data--adobe.aem.live/<known-empty-folder>/<sheet>.json" \
  | tee test/fixtures/llmo/empty-<shape>.json
# tests assert the synthesized empty payload equals the captured fixture (not a hand-written stub)

npx mocha test/controllers/llmo/llmo.test.js
npx mocha test/controllers/llmo/llmo-source.test.js
npm run lint
npm run docs:lint   # response headers/examples change for these endpoints
```

### Rollback

The HTTP-semantics change is isolated to `llmo-source.js` and the per-endpoint `noData`
branches. To roll back, revert the helper's 404 branch to re-throw (restoring the prior
400-on-404), which reverts all four endpoints at once. The discriminator header and
structured log are additive and safe to leave in place.

---

## Fix 3 - Scrape API: no change (documented rationale)

The hybrid policy deliberately leaves `getScrapeUrlByProcessingType` (`scrapeJob.js:203`)
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

- **404 -> 200 reduces HTTP-status signal.** Mitigated by the
  `x-llmo-data-status: not-provisioned` header (machine-distinguishable at the boundary) plus
  the events2metrics counter. Accepted because a blanket 400 is both alarm-inducing and wrong
  (valid request; data simply not there yet).
- **Fetch unification changes behavior for the three sheet endpoints** (they gain a 15s
  timeout and a hard missing-key error). Mitigated by the Phase 0 payload-vs-15s check; both
  changes are net improvements.
- **Empty-shape compatibility.** The synthesized empty payload must byte-match what clients
  receive for genuinely-empty sheets. Pinned by Phase 0 fixtures; covered by tests.
- **Refactor surface.** Centralizing four inline fetches into one helper touches more code
  than fixing only `queryFiles`. Mitigated by the shared helper + per-endpoint tests; the
  payoff is an unprovisioned site no longer 404s on three other endpoints.

## Post-merge verification

Re-run the SITES-43989 Coralogix DataPrime queries ~24h after deploy:

- `MYSTICAT_WORKSPACE_REPOS not set` warn rate in `spacecat-services-prod` api-service ->
  expect ~0 (was ~94k/20min).
- LLMO not-provisioned 400s -> expect the ~253/20min contribution gone; confirm via the new
  `llmo_data_not_provisioned` events2metrics counter.
- Overall API Gateway 4xx+5xx rate -> confirm it sits below the SKYSI-76262 threshold with
  margin.

## References

- Incident: [SITES-43989](https://jira.corp.adobe.com/browse/SITES-43989); alert: SKYSI-76262.
- Code: `src/controllers/webhooks.js`, `src/index.js:262`,
  `src/controllers/llmo/llmo.js`, `src/controllers/llmo/llmo-query-handler.js`,
  `src/controllers/scrapeJob.js`
- Merged precedents: spacecat-api-service PR #2331 (header sanitization), mystique PR #1777
  (producer URL guard)
- Coralogix evidence (2026-05-20): `MYSTICAT_WORKSPACE_REPOS not set` warn present in both
  `spacecat-services-dev` and `spacecat-services-prod` api-service logs -> both on defaults.
