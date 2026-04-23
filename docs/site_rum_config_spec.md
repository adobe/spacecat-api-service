# Design Spec: Surface RUM availability on the Site object

**Owner:** Sugandh Goyal
**Reviewers:** @kanishka, @hchung, @oorobei
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
  verifiedAt: string,         // ISO timestamp of last successful check
  lastCheckedAt: string,      // ISO timestamp of last check attempt (success or failure)
}
```

- `hasDomainKey` is the flag the UI reads.
- `verifiedAt` / `lastCheckedAt` let us detect staleness and add a refresh job later without a second schema change.
- Absent `rumConfig` is treated as "unknown" by the UI until backfill runs — safe default is to show nothing.

### 2.2 Joi schema addition

In `spacecat-shared/packages/spacecat-shared-data-access/src/models/site/config.js` (`configSchema`):

```js
rumConfig: Joi.object({
  hasDomainKey: Joi.boolean().required(),
  verifiedAt: Joi.string().isoDate().optional(),
  lastCheckedAt: Joi.string().isoDate().required(),
}).optional(),
```

### 2.3 Accessor methods

On the `Config()` factory in `spacecat-shared/packages/spacecat-shared-data-access/src/models/site/config.js`:

```js
self.getRumConfig = () => state?.rumConfig;
self.hasRumDomainKey = () => state?.rumConfig?.hasDomainKey === true;
self.updateRumConfig = (hasDomainKey) => {
  const now = new Date().toISOString();
  state.rumConfig = {
    hasDomainKey,
    verifiedAt: hasDomainKey ? now : state?.rumConfig?.verifiedAt,
    lastCheckedAt: now,
  };
};
```

## 3. Touchpoints

### 3.1 Write paths (where the flag gets set)

| Site lifecycle moment | Change | Owner file |
|---|---|---|
| **PLG onboarding** | After `rumApiClient.retrieveDomainkey(domain)` try/catch, call `site.getConfig().updateRumConfig(steps.rumVerified)` then `site.save()`. | [plg-onboarding.js:755-782](../src/controllers/plg/plg-onboarding.js#L755-L782) |
| **Existing sites (backfill)** | One-time Lambda/script: iterate all sites, call `RUMAPIClient.retrieveDomainkey(domain)`, write result to config. Skip sites that already have `rumConfig`. | New script under `spacecat-api-service/scripts/` |
| **Periodic refresh (future, out of scope v1)** | Cron or scheduled audit that re-checks all sites where `lastCheckedAt` is older than N days. | Future ticket |

### 3.2 Read path (API surface)

`rumConfig` is already exposed automatically via [dto/site.js:50](../src/dto/site.js#L50) (`ConfigDto.toJSON(site.getConfig())`). No controller changes needed — any endpoint that returns Site already carries `config.rumConfig` after backfill.

Specifically the UI will read it from:
- `GET /sites/{siteId}` → `response.config.rumConfig.hasDomainKey`

No change needed to `/latest-metrics`.

### 3.3 Event-driven updates (optional, v1.1)

If Spacecat ever fires an internal event when a customer configures RUM post-onboarding, add a handler that flips `hasDomainKey` to `true`. Not required for v1; backfill + onboarding coverage is sufficient.

## 4. Backfill plan

1. Write `scripts/backfill-rum-config.mjs` in `spacecat-api-service`.
2. Paginate `Site` collection, for each site without `rumConfig`:
   - Call `RUMAPIClient.retrieveDomainkey(domain)`.
   - Write `config.rumConfig` via the new accessor.
   - Log result, rate-limit to avoid hammering the RUM API.
3. Run in dev → stage → prod, with manual review between environments.
4. Idempotent: safe to re-run.

## 5. Scope check — is it only CWV that depends on RUM?

Kanishka flagged uncertainty here post-ahref removal. As part of this ticket, confirm the audits list:

- Current RUM-dependent audits per `spacecat-shared/packages/spacecat-shared-data-access/src/models/site/config.js` (`sources` field): CWV, HIGH_ORGANIC_LOW_CTR, ALT_TEXT, INVALID_OR_MISSING_METADATA, BROKEN_INTERNAL_LINKS, AD_INTENT_MISMATCH list `'rum'` in their `sources`.
- Action: confirm with audit-worker owner whether these all still meaningfully require RUM, or if some now have fallbacks. Capture the answer in this spec before UI starts filtering.

## 6. Testing

- **Unit**: `Config.updateRumConfig` sets/updates the three fields correctly; `hasRumDomainKey()` returns expected boolean; Joi validation accepts/rejects bad shapes.
- **Integration (PLG)**: onboarding a new site writes `rumConfig` when RUM check succeeds AND when it fails.
- **Backfill script**: dry-run mode that reports counts without writing; wet-run idempotency.
- **API contract**: `GET /sites/{id}` response includes `config.rumConfig` after update.

## 7. Rollout

1. **PR 1** (spacecat-shared): add Joi schema + `Config` accessors + unit tests.
2. **PR 2** (spacecat-api-service): wire PLG onboarding to call `updateRumConfig` + tests.
3. **PR 3** (spacecat-api-service): backfill script + dry-run + docs.
4. Backfill run (stage → prod).
5. **PR 4** (experience-success-studio-ui): consume the flag — dialog + banner + CWV card state.

PRs 1–3 are independent of the UI work and can land first. UI work (PR 4) is gated on backfill completion in prod.

## 8. Open questions

- [ ] Confirm full list of RUM-dependent audits post-ahref removal (owner: audit-worker team).
- [ ] Should `rumConfig` be editable via an admin API for manual overrides? (default: no, v1)
- [ ] Do we want a periodic refresh cron in v1, or defer? (recommended: defer)
