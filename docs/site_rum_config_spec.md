# Design Spec: Surface RUM availability on the Site object

**Owner:** Sugandh Goyal
**Reviewers:** @kanishka, @absarasw, @sandsinh
**Status:** Proposal
**Related:** Non-blocking "No RUM" dialog + banner (ASO UI), post-Summit delivery

---

## 1. Motivation

The ASO UI needs a **deterministic, site-level signal** for "does this site have RUM data available?" to drive a non-blocking warning (dialog + persistent banner) and to make CWV opportunities correctly render a "data unavailable" state.

Current options in the backend are insufficient:

- **`PlgOnboarding.steps.rumVerified`** ([plg-onboarding.js:759](../src/controllers/plg/plg-onboarding.js#L759)) — only exists for PLG-onboarded sites, set once at onboarding, never refreshed. Excludes all existing non-PLG customers.
- **`GET /sites/{siteId}/latest-metrics`** ([sites.js:863](../src/controllers/sites.js#L863)) — returns zeroed values for three indistinguishable cases: no RUM domain key, RUM API error, or legitimately zero traffic. UI cannot tell them apart.

## 2. Proposal

Add a `rumConfig` key to the Site `config` object (in `spacecat-shared-data-access`, `models/site/config.js`). Follows the existing pattern of scoped sub-configs (`fetchConfig`, `brandConfig`, etc.) — no ElectroDB schema migration needed, since `config` is typed `any` and validated by Joi.

### 2.1 Shape

```js
rumConfig: {
  hasDomainKey: boolean,      // true if RUMAPIClient.retrieveDomainkey(domain) succeeded
  lastCheckedAt: string,      // ISO timestamp of last check attempt (success or failure)
}
```

- `hasDomainKey` is the flag the UI reads.
- `lastCheckedAt` lets a future refresh job detect staleness without a schema change.
- Absent `rumConfig` is treated as "unknown" by the UI until backfill runs — safe default is to show nothing.

### 2.2 Joi schema addition

In `spacecat-shared/packages/spacecat-shared-data-access/src/models/site/config.js` (`configSchema`):

```js
rumConfig: Joi.object({
  hasDomainKey: Joi.boolean().required(),
  lastCheckedAt: Joi.string().isoDate().required(),
}).optional(),
```

### 2.3 Accessor methods

On the `Config()` factory in `spacecat-shared/packages/spacecat-shared-data-access/src/models/site/config.js`:

```js
self.getRumConfig = () => state?.rumConfig;
self.hasRumDomainKey = () => state?.rumConfig?.hasDomainKey === true;
self.updateRumConfig = (hasDomainKey) => {
  state.rumConfig = {
    hasDomainKey,
    lastCheckedAt: new Date().toISOString(),
  };
};
```

## 3. Touchpoints

### 3.1 Shared service

All write paths go through a single helper to avoid duplicating the RUM check + save logic:

```js
// src/support/rum-config-service.js
export const updateRumConfig = async (site, context, log) => {
  const domain = site.getBaseURL();
  const rumApiClient = RUMAPIClient.createFrom(context);
  let hasDomainKey = false;
  try {
    await rumApiClient.retrieveDomainkey(domain);
    hasDomainKey = true;
  } catch (e) {
    log.warn(`RUM check failed for ${domain}: ${e.message}`);
  }
  site.getConfig().updateRumConfig(hasDomainKey);
  await site.save();
  return hasDomainKey;
};
```

Follows the precedent of `updateCodeConfig` in `src/support/utils.js`.

### 3.2 Write paths (where the flag gets set)

All six site creation / onboarding paths call `updateRumConfig(site, context, log)` from the shared service above.

| Site lifecycle moment | Owner file |
|---|---|
| **PLG onboarding** | [plg-onboarding.js:755-782](../src/controllers/plg/plg-onboarding.js#L755-L782) |
| **Admin `POST /sites`** | [sites.js:305](../src/controllers/sites.js#L305) |
| **Slack approve-site-candidate** | [slack/actions/approve-site-candidate.js:64](../src/support/slack/actions/approve-site-candidate.js#L64) |
| **Slack `add-site` command** | [slack/commands/add-site.js:83](../src/support/slack/commands/add-site.js#L83) |
| **LLMO onboarding** | [llmo/llmo-onboarding.js:983](../src/controllers/llmo/llmo-onboarding.js#L983) |
| **`onboardSingleSite` util** | [support/utils.js:1053](../src/support/utils.js#L1053) |
| **Backfill (one-time)** | New script under `spacecat-api-service/scripts/` |
| **Periodic refresh (v1 — see §6)** | New audit-worker cron |

### 3.3 Read path (API surface)

`rumConfig` is already exposed automatically via [dto/site.js:50](../src/dto/site.js#L50) (`ConfigDto.toJSON(site.getConfig())`). No controller changes needed — any endpoint that returns Site already carries `config.rumConfig` after backfill.

Specifically the UI will read it from:
- `GET /sites/{siteId}` → `response.config.rumConfig.hasDomainKey`

No change needed to `/latest-metrics`.

### 3.4 Event-driven updates (optional, v1.1)

If Spacecat ever fires an internal event when a customer configures RUM post-onboarding, add a handler that flips `hasDomainKey` to `true`. Not required for v1; backfill + onboarding coverage is sufficient.

## 4. Backfill plan

Targets **all sites without `rumConfig`** — regardless of PLG status. This covers:
- All non-PLG sites (admin, Slack, LLMO onboarding paths).
- PLG sites onboarded before PR 2 ships (they never had `updateRumConfig` called on them).

1. Write `scripts/backfill-rum-config.mjs` in `spacecat-api-service`.
2. Paginate `Site` collection, for each site without `rumConfig`:
   - Skip sites where `isLive = false` or org is in `ASO_PLG_EXCLUDED_ORGS`.
   - Call `updateRumConfig(site, context, log)` from the shared service.
   - Log result, rate-limit to avoid hammering the RUM API.
3. Run in dev → stage → prod, with manual review between environments.
4. Idempotent: safe to re-run.

## 5. Testing

- **Unit**: `Config.updateRumConfig` sets both fields correctly; `hasRumDomainKey()` returns expected boolean; Joi validation accepts/rejects bad shapes.
- **Integration (PLG)**: onboarding a new site writes `rumConfig` when RUM check succeeds AND when it fails.
- **Backfill script**: dry-run mode that reports counts without writing; wet-run idempotency.
- **API contract**: `GET /sites/{id}` response includes `config.rumConfig` after update.

## 6. Rollout

1. **PR 1** (spacecat-shared): add Joi schema + `Config` accessors + unit tests.
2. **PR 2** (spacecat-api-service): create `rum-config-service.js` shared helper; wire all six site creation paths + tests.
3. **PR 3** (spacecat-api-service): backfill script + dry-run + docs.
4. **PR 4** (spacecat-audit-worker): periodic refresh cron — daily re-check of sites where `lastCheckedAt` is older than N days, using the same shared service.
5. Backfill run (stage → prod).
6. **PR 5** (experience-success-studio-ui): consume the flag — dialog + banner.

PRs 1–4 are independent of the UI work and can land first. UI work (PR 5) is gated on backfill completion in prod.

## 7. Open questions

- [ ] Should `rumConfig` be editable via an admin API for manual overrides? (default: no, v1)
- [ ] Periodic refresh cron: promoted to first-class (PR 4, audit-worker). Frequency TBD — 7-day staleness threshold is a reasonable starting point.
