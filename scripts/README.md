# PLG Preonboarding Scripts

One-time operational scripts for PLG (Product-Led Growth) ASO preonboarding.
These scripts prepare sites in SpaceCat **before** the customer calls `POST /plg/onboard`.

## Overview

The typical workflow is:

1. **Preonboard** domains with `plg-preonboard.js` (creates sites, enables audits, sets `PRE_ONBOARDING`)
2. **Review** the CSV report for bot blockers, validation mismatches, missing data
3. **Backfill** anything that failed with the targeted fix-up scripts
4. Customer calls `POST /plg/onboard` → fast-track path picks up the `PRE_ONBOARDING` record → `ONBOARDED`

If something goes wrong, use `plg-rollback.js` to reverse the preonboarding.

## Prerequisites

- Node.js >= 24 (`nvm use 24`)
- Access to the stage/prod PostgREST instance
- AWS credentials configured (`AWS_REGION`, and either env vars or AWS profile)
- A `.env` file in the project root (see Environment Variables below)

## Environment Variables

All scripts read from `.env` via `dotenv`. Common variables:

| Variable | Description |
|---|---|
| `POSTGREST_URL` | PostgREST base URL |
| `POSTGREST_API_KEY` | PostgREST writer JWT |
| `AWS_REGION` | AWS region (e.g. `us-east-1`) |
| `SPACECAT_API_BASE_URL` | SpaceCat API base URL (e.g. `https://xxx.cloudfront.net`) |
| `ADMIN_API_KEY` | Admin API key for SpaceCat API |
| `DEFAULT_ORGANIZATION_ID` | Default org ID (used for ownership checks) |
| `RUM_ADMIN_KEY` | RUM admin key (used to auto-resolve author URL) |
| `S3_CONFIG_BUCKET` | S3 bucket for config (if applicable) |
| `AUDIT_JOBS_QUEUE_URL` | SQS audit queue URL (for update-redirects) |

Not every script needs all of these — see per-script sections below.

---

## Core Scripts

### 1. `plg-preonboard.js` — Preonboard domains (main script)

The primary script. Creates org, site, enables audits, creates ASO entitlement,
and sets `PlgOnboarding` → `PRE_ONBOARDING`.

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`, `AWS_REGION`, `SPACECAT_API_BASE_URL`, `ADMIN_API_KEY`, `DEFAULT_ORGANIZATION_ID`. Optional: `RUM_ADMIN_KEY`, `S3_CONFIG_BUCKET`, `AUDIT_JOBS_QUEUE_URL`.

**Input:** JSON file

```json
[
  { "domain": "example.com", "imsOrgId": "ABC123@AdobeOrg" },
  { "domain": "another.com", "imsOrgId": "DEF456@AdobeOrg" }
]
```

**Usage:**

```bash
nvm use 24
node scripts/plg-preonboard.js scripts/input.json
```

**Output:** CSV report (`input-report-<timestamp>.csv`) + log file.

**What it does per domain:**

1. Skips if already `PRE_ONBOARDING` or `ONBOARDED`
2. Resolves organization (existing site's org, or demo org)
3. Detects bot blocker → saves as `WAITING_FOR_IP_ALLOWLISTING` if blocked
4. Creates the site (or uses existing)
5. Resolves canonical URL (`overrideBaseURL`)
6. Auto-resolves author URL from RUM bundles (`deliveryConfig`)
7. Sets EDS code config and `hlxConfig` if site is on AEM Edge Delivery
8. Enables imports (`organic-traffic`, `top-pages`, `all-traffic`)
9. Detects locale (language/region)
10. Creates/assigns project
11. Queues `update-redirects` for AEM CS/CW sites
12. Enables audit handlers via SpaceCat API
13. Creates ASO entitlement + site enrollment (new sites only)
14. Sets status → `PRE_ONBOARDING`

**Validation columns in CSV:**

For existing sites, resolved values are compared against current values. New CSV columns:

| Column | Values |
|---|---|
| `v_deliveryType` | `absent_added`, `correct`, `wrong:actual=X\|expected=Y` |
| `v_overrideBaseURL` | `absent_added`, `correct`, `wrong:actual=X\|expected=Y` |
| `v_authorURL` | `absent_added`, `correct`, `wrong:actual=X\|expected=Y` |
| `v_code` | `absent_added`, `correct`, `wrong:actual=X\|expected=Y` |
| `v_hlxConfig` | `absent_added`, `correct`, `wrong:actual=X\|expected=Y` |

Absent fields are filled in. Present fields are validated but **never overwritten**.

---

### 2. `plg-rollback.js` — Rollback a preonboarding

Reverses what `plg-preonboard.js` created, using the `steps` recorded on the
`PlgOnboarding` record. Safe to re-run.

**Env vars:** Same as `plg-preonboard.js` (no `RUM_ADMIN_KEY` needed).

**Input:** Same JSON format as `plg-preonboard.js`.

```bash
node scripts/plg-rollback.js scripts/input.json
```

**What gets rolled back (in reverse order):**

1. Disables audit handlers via API
2. Deletes ASO entitlement (only if `entitlementCreated` step is set)
3. Site deletion — **not supported** (logs site ID for manual removal)
4. Deletes the org (only if it has no remaining sites)
5. Deletes the `PlgOnboarding` record

---

## Backfill / Fix-up Scripts

Use these when specific steps failed during preonboarding.

### 3. `plg-backfill-delivery-config.js` — Backfill author URL

Re-runs the RUM lookup using the canonical hostname from `overrideBaseURL`
and saves `deliveryConfig` (authorURL, programId, environmentId).

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`, `AWS_REGION`, `RUM_ADMIN_KEY`.

**Input:** Same JSON format. Skips sites that already have `authorURL` set.

```bash
node scripts/plg-backfill-delivery-config.js scripts/input.json
```

---

### 4. `plg-backfill-site-data.js` — Backfill all missing site data

Backfills missing fields on preonboarded/onboarded sites **without overwriting** existing values.

Fields backfilled: `overrideBaseURL`, `deliveryConfig`, `code`, `hlxConfig`, `language`, `region`, `projectId`.

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`, `AWS_REGION`, `RUM_ADMIN_KEY`.

**Input:** Same JSON format.

```bash
node scripts/plg-backfill-site-data.js scripts/input.json
```

---

### 5. `plg-enable-handlers.js` — Enable audit handlers

Enables all ASO PLG audit handlers for a list of domains via the SpaceCat API.
Use when handler enablement failed during preonboarding (e.g. env mismatch).

**Env vars:** `SPACECAT_API_BASE_URL`, `ADMIN_API_KEY`.

**Input:** JSON file: `[{"domain": "example.com"}, ...]`

```bash
node scripts/plg-enable-handlers.js scripts/input.json
```

---

### 6. `plg-trigger-audits.js` — Trigger audit runs

Triggers immediate audit runs for already-preonboarded domains.
Use when audit triggers failed (e.g. expired AWS credentials).

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`.

**Input:** Same JSON format as `plg-preonboard.js`.

```bash
node scripts/plg-trigger-audits.js scripts/input.json
```

---

## Record Management Scripts

Single-record fix-up scripts for manual corrections.

### 7. `add-aso-entitlement.js` — Add ASO entitlement

Adds an ASO `FREE_TRIAL` entitlement to an organization (by site or org ID). Skips if already exists.

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`, `AWS_REGION`.

```bash
node scripts/add-aso-entitlement.js --site <siteId>
node scripts/add-aso-entitlement.js --org <organizationId>
```

---

### 8. `delete-plg-record.js` — Delete a PLG onboarding record

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`, `AWS_REGION`.

```bash
node scripts/delete-plg-record.js <imsOrgId> <domain>
```

---

### 9. `set-plg-preonboarding.js` — Set status to PRE_ONBOARDING

Manually sets a PLG onboarding record's status to `PRE_ONBOARDING`.

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`, `AWS_REGION`.

```bash
node scripts/set-plg-preonboarding.js <imsOrgId> <domain>
```

---

### 10. `update-plg-imsorgid.js` — Update imsOrgId on PLG record

Updates the `imsOrgId` of a PLG onboarding record.

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`, `AWS_REGION`.

```bash
node scripts/update-plg-imsorgid.js <domain> <oldImsOrgId> <newImsOrgId>
```

---

### 11. `update-plg-orgid.js` — Update organizationId on PLG record

Updates the `organizationId` in the PLG onboarding record.

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`, `AWS_REGION`.

```bash
node scripts/update-plg-orgid.js <imsOrgId> <domain> <newOrganizationId>
```

---

### 12. `update-site-org.js` — Move site to a different org

Changes a site's organization by IMS org ID. Creates the org if it doesn't exist.

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`, `AWS_REGION`.

```bash
node scripts/update-site-org.js <siteId> <imsOrgId>
```

---

## Reporting Scripts

### 13. `plg-pageviews.js` — Fetch RUM pageview counts

Fetches RUM pageview counts for a list of domains.

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`, `AWS_REGION`, `RUM_ADMIN_KEY`.

**Input:** Same JSON format. Optional second arg for interval (days, default 7).

```bash
node scripts/plg-pageviews.js scripts/input.json [interval]
```

---

### 14. `site-opportunities-report.js` — Opportunities CSV report

Generates a CSV report of opportunities and suggestions by type for given sites.

**Env vars:** `POSTGREST_URL`, `POSTGREST_API_KEY`, `AWS_REGION`.

```bash
node scripts/site-opportunities-report.js <siteId> [siteId2 ...]
node scripts/site-opportunities-report.js --file site-ids.txt
```

**Output:** CSV file (`opportunities-report-<timestamp>.csv`).

---

## Troubleshooting

**Script fails with "Missing environment variables"**
Check your `.env` file has all required vars for that script.

**"Demo org not found"**
The demo org IMS ID is hardcoded. Make sure the demo org exists in the target environment.

**Bot blocker detected**
The domain blocks crawlers. The PLG record is saved as `WAITING_FOR_IP_ALLOWLISTING`.
IP allowlisting must be done manually before re-running.

**Validation column shows `wrong:...`**
An existing site field doesn't match what the script resolved. Review manually — the script does **not** overwrite existing values.

**lint-staged fails on commit (gitignored scripts/)**
Use `git add -f scripts/<file>` to force-add files in the gitignored `scripts/` directory.
