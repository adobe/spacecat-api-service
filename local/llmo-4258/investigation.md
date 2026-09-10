# LLMO-4650 Investigation: DRS `prompt_generation_base_url` Permanent Failures (RESOLVED)

**Date:** 2026-05-11
**Status:** Stuck jobs unblocked via manual data fix; durable DRS-side fix outstanding.
**Org:** AEM Showcase (`296fefc8-1e54-46dd-aee4-a0f94621deaf`)
**IMS org:** `38931D6666E3ECDA0A495E80@AdobeOrg`
**Failing sites:**
- radissonhotels.com — site_id `69847518-1efb-42a0-945a-d9ec37832620`
- bottle-stop.com.au — site_id `738d9ce9-3879-4640-a345-25b5ae8bb92a`
- paramountliquor.com.au — site_id `74ebfcef-70e0-4537-afdc-6e61176c362b`

**DRS endpoint:** `https://m3n8vf1ud9.execute-api.us-east-1.amazonaws.com/prod/jobs`

---

## TL;DR

Three V1-mode onboardings submitted `prompt_generation_base_url` jobs that DRS failed permanently with `BrandResolverDriftError: No brand matching site … in org …`. Root cause: DRS's strict brand resolver runs on V1 jobs but V1 onboarding by design does not create a brand row. Manual data fix (insert brand + `brand_sites` per site) + re-submit unblocked all 3. Durable fix must land in DRS: gate the strict resolver on V2 (`onboarding_mode` metadata) so V1 jobs fall back to legacy resolution.

---

## Confirmed facts (from SQL queries 2026-05-11)

| Query | Result |
|-------|--------|
| Brand rows created on/after 2026-05-08 for org `296fefc8` | **0 rows** — `upsertBrand` was never called for the 3 sites |
| `brandalf` flag for org `296fefc8` | `false`, last updated **2026-04-02** by `legacy-user`. No `brandalf_migration` flag present. |
| Sites for the 3 failing UUIDs | All exist, correct `organization_id`, canonical base_urls (no www): `https://radissonhotels.com`, `https://bottle-stop.com.au`, `https://paramountliquor.com.au` |
| `brand_sites` rows for those site_ids (pre-fix) | 0 |
| Existing brands for org (pre-fix) | 16 rows, all `origin=human`, `created_by=system`, `created_at=2026-04-01`, `owned_urls={}`. Demo/catalog brands. None linked via `brand_sites`. |

---

## Why V1 mode was used

Decision matrix outcome with `brandalf=false`:
1. The brandalf-enabled block (rows 1, 3, 5, 7) doesn't fire.
2. No `brandalf_migration` → no V2 short-circuit.
3. Falls through to either kill-switch (`LLMO_ONBOARDING_DEFAULT_VERSION=v1` → V1, rows 2/4) or pre-cutoff sites check (org has sites before 2026-04-01 cutoff → V1, row 6).

Either path → V1. The earlier hypothesis that **Row 1** fired (`brandalf=true` + kill-switch + pre-cutoff → V1 + revert flag) was wrong; the flag was already false before the failures, set manually by `legacy-user` on 2026-04-02. Whether Row 2/4 or Row 6 fired doesn't change the outcome and is not blocking.

---

## Failure mechanism

1. V1 onboarding runs `performLlmoOnboarding`. The V1 branch (post-LLMO-4534, commit `cf9631e5`) submits a DRS `prompt_generation_base_url` job directly via `submitPromptGenerationJob`. It deliberately does **not** call `upsertBrand` and does **not** include `onboarding_mode` in the DRS metadata (LLMO-4129 / LLMO-4561 V1 contract — adding `onboarding_mode` would cross-pollute the v2 customer-config store).
2. DRS receives the job. Its strict brand resolver (`find_brand_for_site_strict()`) runs unconditionally — it does **not** check whether the job came from V1 or V2 onboarding.
3. The resolver looks for a `brand_sites` row matching the requesting `site_id`. None exists (correctly, for V1).
4. Resolver throws `BrandResolverDriftError: No brand matching site {siteId} in org {orgId}`.
5. DRS marks the job `PERMANENT_FAILED`.

The www-variant `base_url` in the failed job metadata (`https://www.radissonhotels.com`) came from `siteConfig.getFetchConfig().overrideBaseURL` per the LLMO-4534 fix. It's a metadata-consistency wart but **not the failure cause** — the resolver matches by `site_id`, not URL.

### What was NOT the cause (earlier wrong hypotheses)

- ❌ **V2 mode + `syncBrandSites` silent failure**: Issue #2373's premise that the org was "manually upgraded to V2" is contradicted by the `brandalf=false` data. No brand record was ever created on 2026-05-08.
- ❌ **16 demo brands as the tripwire**: The strict resolver matches by `site_id` via `brand_sites`, not by org-level brand existence. The 16 demo brands have no `brand_sites` rows and are not involved.
- ❌ **URL normalization (`composeBaseURL`)**: Irrelevant — `syncBrandSites` was never called.

---

## Remediation applied (2026-05-11)

### 1. SQL data fix

Inserted one brand row + one `brand_sites` row per failing site, keyed off `site_id` with `type='base'`. All three transactions committed. Verification queries confirmed each site now resolves to exactly one brand via `brand_sites`.

```sql
-- Per-site pattern (run for each of the 3 sites)
INSERT INTO brands (id, site_id, name, organization_id, status, origin,
                    owned_urls, regions, created_by, updated_by)
VALUES (gen_random_uuid(), '<site_id>', '<brand_name>',
        '296fefc8-1e54-46dd-aee4-a0f94621deaf', 'active', 'ai',
        ARRAY['<canonical_base_url>'], ARRAY['<region>']::text[],
        'manual-remediation-llmo-4650', 'manual-remediation-llmo-4650');

INSERT INTO brand_sites (organization_id, brand_id, site_id, paths, type, updated_by)
VALUES ('296fefc8-1e54-46dd-aee4-a0f94621deaf', '<new_brand_id>', '<site_id>',
        ARRAY['/']::text[], 'base', 'manual-remediation-llmo-4650');
```

Concrete values:

| Site | Brand name | Region | Canonical URL |
|------|-----------|--------|---------------|
| radissonhotels.com | Radisson Hotels | US | `https://radissonhotels.com` |
| bottle-stop.com.au | Bottle Stop | AU | `https://bottle-stop.com.au` |
| paramountliquor.com.au | Paramount Liquor | AU | `https://paramountliquor.com.au` |

### 2. DRS job re-submission

Submitted 3 `prompt_generation_base_url` jobs with `source=onboarding` (no `onboarding_mode`, preserving V1 contract). All COMPLETED:

| Site | New job ID | Status | Runtime | S3 result key |
|------|-----------|--------|---------|---------------|
| radisson | `6bf7b25e-7424-44bd-b294-3c62772d6370` | COMPLETED | 156s | `.../radissonhotels/.../...json` |
| bottle-stop | `b34c787d-a3d0-445c-a870-d15fc377ecf6` | COMPLETED | 146s | `.../bottlestop/.../...json` |
| paramount | `61b6f308-233b-4cfa-9cf6-c4462c5ff961` | COMPLETED | 103s | `.../paramountliquor/.../...json` |

Bucket: `s3://drs-v2-prod-results/38931d6666e3ecda0a495e80adobeorg/`

### 3. Downstream pipeline

DRS completion → audit-worker `drs-prompt-generation` handler → legacy LLMO config write (V1 path, since `onboarding_mode` absent) → `llmo-customer-analysis` audit. Prompts should land in each site's LLMO config within ~5 min of DRS completion.

---

## Durable fix (NOT YET LANDED)

**Owner:** DRS team (Andrei).
**Change:** Strict brand resolver should gate on `metadata.onboarding_mode === 'v2'`. When the job is V1 (no `onboarding_mode`) **or** has `source=onboarding` without v2 metadata, fall back to non-strict resolution or skip brand resolution entirely.

Without this fix, any new V1-mode onboarding for any org will reproduce the failure. The manual data workaround is not a long-term solution because:
- It creates v2-shaped brand records for V1-mode customers, which may confuse downstream Brandalf assumptions.
- It doesn't scale to new V1 onboardings (every fresh one would need manual SQL).

**PR #2300 does NOT fix this.** Its LLMO-4621 Pattern A fallback only runs inside `syncBrandSites`, which V1 mode never calls.

**Andrei's PR #2374 is CLOSED**, not merged — different scope (canonical baseURL + diagnostics).

---

## Recommended follow-ups

1. **File a DRS-side ticket** for the strict resolver V1 bypass. Title suggestion: "Gate strict brand resolver on `onboarding_mode=v2`; V1 jobs should skip resolution".
2. **Coralogix alert** on `BrandResolverDriftError` in `/aws/lambda/drs-v2-prod-ProcessJobFunction` to catch repeats before customers notice. DataPrime sketch:
   ```
   source logs
   | filter $l.applicationname == 'drs-v2-prod'
       && $l.subsystemname == 'ProcessJobFunction'
       && $m == /BrandResolverDriftError/
   ```
3. **Close Issue #2373** — its V2-mode root cause analysis is incorrect; the actual issue is V1 resolver gating. Replace with a pointer to the DRS-side ticket.
4. **Update LLMO-4650 ticket** with the resolution and link to this file.

---

## Relevant code (origin/main)

| File | What |
|------|------|
| `src/support/llmo-onboarding-mode.js` | Decision matrix (`resolveLlmoOnboardingMode`, `hasPreBrandalfSites`, `resolveBrandalfCutoffMs`). brandalf=false → falls through to kill switch / pre-cutoff / default. |
| `src/controllers/llmo/llmo-onboarding.js:1415-1450` (approx) | V1 fallback `submitPromptGenerationJob` call. Does NOT set `onboarding_mode`. Uses `overrideBaseURL || baseURL`. |
| `src/support/brands-storage.js:170-244` (approx) | `syncBrandSites` — not called in V1 mode. |
| `packages/spacecat-shared-drs-client/src/index.js:164-197` | `submitPromptGenerationJob` payload shape — `provider_id`, `parameters.base_url/brand/audience/region/num_prompts/model`, nested `metadata.{site_id,imsOrgId,...}`. |

## Relevant commits

- `cf9631e5` — LLMO-4534: V1 fallback DRS submission (added the failing code path)
- `ed5363d1` — LLMO-4258 / LLMO-4294: removed direct prompt gen, fixed `type:'base'`
- `977e4e97` — LLMO-4176: decision matrix
- `2048b719` — URL normalization in `syncBrandSites` (irrelevant to this failure)

---

## Lessons / non-obvious takeaways

1. **DRS strict resolver is unconditional.** V1-mode jobs (no brand) still hit it. The `onboarding_mode` metadata exists in SpaceCat's contract but DRS doesn't currently honor it.
2. **`brandalf` flag false ≠ never was true.** The flag could have been auto-reverted (Row 1) or manually flipped. Always check `updated_at` and `updated_by`. In this org, `updated_by=legacy-user` ruled out the auto-revert path.
3. **DrsClient payload shape:** `provider_id` (not `provider`), `brand` (not `brand_name`), required `num_prompts` and `model`, nested `parameters.metadata.{site_id, imsOrgId, ...}`. Issue #2373's manual curl examples used the wrong shape.
4. **CSV query results are bounded** — the user's original 16-brand CSV did not show whether brand rows existed for the failing sites because the failing-site brand rows simply didn't exist. Don't conflate "not in this slice" with "doesn't exist anywhere".
