# LLMO onboarding: HTTP API and Slack command

This document summarizes **`POST /llmo/onboard`**, the Slack **`onboard-llmo`** command, and the shared onboarding steps.

---

## `POST /llmo/onboard` (high level)

- **Route:** `src/routes/index.js` → `llmoController.onboardCustomer` in `src/controllers/llmo/llmo.js`.
- **Access:** LLMO administrator only (`accessControlUtil.isLLMOAdministrator()`).
- **Body:** Object with required **`domain`** and **`brandName`**. Optional **`imsOrgId`** (Adobe IMS format); if omitted, org is taken from JWT (`profile.tenants[0].id@AdobeOrg`).
- **Flow:**
  1. Resolve **`baseURL`** / **`dataFolder`**.
  2. **`validateSiteNotOnboarded`** (SharePoint folder + SpaceCat site/org checks).
  3. **`performLlmoOnboarding`** (see below).
  4. HTTP path: **`triggerBrandProfileAgent`** (best-effort; failures logged, response still 200 when onboarding succeeded).

---

## Slack: `onboard-llmo` command

- **Command:** `src/support/slack/commands/llmo-onboard.js` (phrase: **`onboard-llmo`**).
- **Usage:** `onboard-llmo <site url>`
- **Flow:**
  1. User runs the command → bot posts a **Start Onboarding** button (or alternate actions if the site is already onboarded with LLMO brand).
  2. **Start Onboarding** → action **`start_llmo_onboarding`** → `src/support/slack/actions/onboard-llmo-modal.js` → **`startLLMOOnboarding`**.
  3. Modal opens (**`fullOnboardingModal`** for a net-new SpaceCat site, **`elmoOnboardingModal`** if a site already exists). **`private_metadata`** includes **`brandURL`**.
  4. On submit → **`onboardLLMOModal`** → **`onboardSite`** → **`performLlmoOnboarding`**.
- **Button `value`:** JSON **`{ "brandURL": "<url>" }`**. **`parseStartLlmoOnboardingButtonValue`** in **`onboard-llmo-modal.js`** also accepts legacy **plain URL** strings (no JSON) for older messages.

---

## Key steps inside `performLlmoOnboarding`

| Step | What it does |
|------|----------------|
| Org / site | **`createOrFindOrganization`**, **`resolveLlmoOnboardingMode`**, **`createOrFindSite`**, **`createEntitlementAndEnrollment`**. |
| SharePoint | **`copyFilesToSharepoint`**: creates **`/sites/elmo-ui-data/{dataFolder}/`** if needed; copies **`template/query-index.xlsx`** → **`{dataFolder}/query-index.xlsx`**. |
| Publish trigger | **`enqueueLlmoOnboardingPublish`**: SQS message **`trigger:llmo-onboarding-publish`** with **`siteId`** + **`auditContext.dataFolder`**. Audit worker calls **`publishToAdminHlx`** for **`{dataFolder}/query-index.json`** on Helix admin preview + live (`project-elmo-ui-data`). Enqueue failure is logged only. |
| Helix query config | **`updateIndexConfig`**: commits an entry to **`helix-query.yaml`** in **`adobe/project-elmo-ui-data`** (`main` in prod, **`onboarding-bot-dev`** otherwise). **Always runs as part of onboarding** (see LLMO-7141 note below). |
| Rest | Enable audits/imports, LLMO brand + data folder on site config, optional **`overrideBaseURL`**, v2 customer config / Brandalf / DRS jobs as applicable, **`triggerAudits`**, DRS prompt generation, etc. |

Offboarding and other paths reuse **`validateSiteNotOnboarded`** / **`performLlmoOnboarding`** patterns (e.g. Slack modal) where noted in code.

---

## History: removal of `temp-onboarding` (LLMO-7141)

Removed as a durable follow-up to LLMO-6320, which has the full incident writeup (root cause,
affected customer sites, and the bug class this flag caused).

LLMO-4024 (PR #2098, 2026-04-01) introduced a **`temp-onboarding`** flag (HTTP body field, and
**`--skip-helix-query`** / **`--temp-onboarding`** Slack flags) that let onboarding skip the
**`updateIndexConfig`** step entirely, leaving a site's dataFolder unregistered in
**`helix-query.yaml`**. It was a workaround for a 2026-03-19 Helix bulk-indexing capacity
incident above ~1,000 index definitions.

That capacity issue was fixed by the Helix team the same day, and Helix confirmed there is no
hard limit — `helix-query.yaml` is now well past 1,783 definitions with no recurrence. The skip
flag turned out to be the root cause of the entire LLMO-6320 bug class: every site onboarded
with the flag never got its index registered and was never reliably backfilled, causing real
customer sites (some paying) to go dark in LLMO dashboards for months.

The flag was removed entirely (LLMO-7141): registration via **`updateIndexConfig`** now always
runs unconditionally as part of **`performLlmoOnboarding`**, for both the HTTP and Slack
onboarding paths. There is no remaining way to skip it.

---

## References in repo

- HTTP controller: `src/controllers/llmo/llmo.js` (`onboardCustomer`).
- Onboarding logic: `src/controllers/llmo/llmo-onboarding.js` (`performLlmoOnboarding`, `updateIndexConfig`, `copyFilesToSharepoint`, `enqueueLlmoOnboardingPublish`).
- Slack command: `src/support/slack/commands/llmo-onboard.js`.
- Slack modal / **`onboardSite`**: `src/support/slack/actions/onboard-llmo-modal.js`.
- Audit worker handler: `spacecat-audit-worker` → `trigger:llmo-onboarding-publish` → `publishToAdminHlx`.
