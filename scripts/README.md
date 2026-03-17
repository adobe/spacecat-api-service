# PLG Preonboarding Scripts

## Prerequisites

- Node.js >= 24 (`nvm use 24`)
- Access to the stage/prod PostgREST instance
- AWS credentials configured (`AWS_REGION`, and either env vars or AWS profile)

---

## 1. `plg-preonboard.js` — Preonboard domains

Creates the org, site, enables audits + summit-plg, creates ASO entitlement,
and sets the `PlgOnboarding` record to `PRE_ONBOARDING`.

When the customer later calls `POST /plg/onboard`, the fast-track path picks
up the existing record and moves it straight to `ONBOARDED`.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `POSTGREST_URL` | ✅ | PostgREST base URL |
| `POSTGREST_API_KEY` | ✅ | PostgREST writer JWT |
| `AWS_REGION` | ✅ | AWS region (e.g. `us-east-1`) |
| `SPACECAT_API_BASE_URL` | ✅ | SpaceCat API base URL |
| `ADMIN_API_KEY` | ✅ | Admin API key for SpaceCat API |
| `RUM_ADMIN_KEY` | ⬜ | RUM admin key (used to auto-resolve author URL) |
| `DEFAULT_ORGANIZATION_ID` | ⬜ | Default org ID (used for ownership checks) |
| `S3_CONFIG_BUCKET` | ⬜ | S3 bucket for config (if applicable) |

### Input format

Create a JSON file with the domains to preonboard:

```json
[
  { "domain": "example.com", "imsOrgId": "ABC123@AdobeOrg" },
  { "domain": "another.com", "imsOrgId": "DEF456@AdobeOrg" }
]
```

### Usage

```bash
# Copy and fill in your env vars
cp .env.example .env

nvm use 24
node scripts/plg-preonboard.js scripts/input.json
```

A CSV report is written to `scripts/input-report.csv` on completion.

### What it does per domain

1. Skips if already `PRE_ONBOARDING` or `ONBOARDED`
2. Creates or finds the organization by IMS Org ID
3. Checks site ownership (waitlists if owned by another org)
4. Detects bot blocker (saves as `WAITING_FOR_IP_ALLOWLISTING` if blocked)
5. Creates the site (or reassigns existing)
6. Resolves canonical URL (`overrideBaseURL`) — used as the RUM lookup domain
7. Auto-resolves author URL from RUM bundles (sets `deliveryConfig`)
8. Sets EDS code config and `hlxConfig` if site is on AEM Edge Delivery
9. Enables audits: `alt-text`, `cwv`, `broken-backlinks`, `scrape-top-pages`
10. Enrolls site in `summit-plg`
11. Creates ASO entitlement (org-level, free trial)
12. Sets status → `PRE_ONBOARDING`

---

## 2. `plg-backfill-delivery-config.js` — Backfill author URL

For already-preonboarded sites where the initial RUM lookup failed (e.g. the
bare domain had no RUM domainkey but `www.domain.com` does), this script
re-runs the RUM lookup using the canonical hostname from `overrideBaseURL`
and saves `deliveryConfig` (authorURL, programId, environmentId).

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `POSTGREST_URL` | ✅ | PostgREST base URL |
| `POSTGREST_API_KEY` | ✅ | PostgREST writer JWT |
| `AWS_REGION` | ✅ | AWS region |
| `RUM_ADMIN_KEY` | ✅ | RUM admin key |
| `S3_CONFIG_BUCKET` | ⬜ | S3 bucket for config (if applicable) |

### Usage

```bash
nvm use 24
node scripts/plg-backfill-delivery-config.js scripts/input.json
```

Uses the same input JSON format as `plg-preonboard.js`.

Skips sites that already have `authorURL` set in `deliveryConfig`.

---

## 3. `plg-rollback.js` — Rollback a preonboarding

Reverses what `plg-preonboard.js` created, using the `steps` recorded on the
`PlgOnboarding` record to determine what is safe to remove. Safe to re-run —
already-removed resources are skipped gracefully.

### What gets rolled back (in reverse order)

1. Disables audits (`alt-text`, `cwv`, `broken-backlinks`, `scrape-top-pages`) + `summit-plg` via API
2. Deletes ASO entitlement (only if `entitlementCreated` step is set)
3. Deletes the site (only if `siteCreated` step is set — pre-existing sites are left alone)
4. Deletes the org (only if it has no remaining sites)
5. Deletes the `PlgOnboarding` record

### Environment variables

Same as `plg-preonboard.js` (no `RUM_ADMIN_KEY` needed).

### Usage

```bash
nvm use 24
node scripts/plg-rollback.js scripts/input.json
```

Uses the same input JSON format as `plg-preonboard.js`.
