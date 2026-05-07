# LLMO onboarding: HTTP API, Slack command, and `temp-onboarding`

This document summarizes **`POST /llmo/onboard`**, the Slack **`onboard-llmo`** command, shared onboarding steps, and the optional **`temp-onboarding`** behavior (skip **`helix-query.yaml`** / **`updateIndexConfig`**).

---

## `POST /llmo/onboard` (high level)

- **Route:** `src/routes/index.js` → `llmoController.onboardCustomer` in `src/controllers/llmo/llmo.js`.
- **Access:** LLMO administrator only (`accessControlUtil.isLLMOAdministrator()`).
- **Body:** Object with required **`domain`** and **`brandName`**. Optional **`imsOrgId`** (Adobe IMS format); if omitted, org is taken from JWT (`profile.tenants[0].id@AdobeOrg`).
- **Optional:** **`"temp-onboarding": true`** — see [Feature: `temp-onboarding`](#feature-temp-onboarding).
- **Flow:**
  1. Resolve **`baseURL`** / **`dataFolder`**.
  2. **`validateSiteNotOnboarded`** (SharePoint folder + SpaceCat site/org checks).
  3. **`performLlmoOnboarding`** (see below).
  4. HTTP path: **`triggerBrandProfileAgent`** (best-effort; failures logged, response still 200 when onboarding succeeded).

---

## Slack: `onboard-llmo` command

- **Command:** `src/support/slack/commands/llmo-onboard.js` (phrase: **`onboard-llmo`**).
- **Usage:** `onboard-llmo <site url> [--skip-helix-query | --temp-onboarding]`
  - **`--skip-helix-query`** and **`--temp-onboarding`** are equivalent: both set the same internal **`tempOnboarding`** flag as HTTP **`"temp-onboarding": true`**.
  - Flags can appear before or after the URL; URL tokens are the remaining non-flag arguments joined with spaces.
- **Flow:**
  1. User runs the command → bot posts a **Start Onboarding** button (or alternate actions if the site is already onboarded with LLMO brand).
  2. **Start Onboarding** → action **`start_llmo_onboarding`** → `src/support/slack/actions/onboard-llmo-modal.js` → **`startLLMOOnboarding`**.
  3. Modal opens (**`fullOnboardingModal`** for a net-new SpaceCat site, **`elmoOnboardingModal`** if a site already exists). **`private_metadata`** includes **`brandURL`** and, when applicable, **`tempOnboarding: true`**.
  4. On submit → **`onboardLLMOModal`** → **`onboardSite`** → **`performLlmoOnboarding`** with **`tempOnboarding`** when set.
- **Button `value`:** JSON **`{ "brandURL": "<url>", "tempOnboarding": true }`** when skipping helix-query; otherwise **`{ "brandURL": "<url>" }`**. **`parseStartLlmoOnboardingButtonValue`** in **`onboard-llmo-modal.js`** also accepts legacy **plain URL** strings (no JSON) for older messages; those default to full **`helix-query.yaml`** update.

---

## Key steps inside `performLlmoOnboarding`

| Step | What it does |
|------|----------------|
| Org / site | **`createOrFindOrganization`**, **`resolveLlmoOnboardingMode`**, **`createOrFindSite`**, **`createEntitlementAndEnrollment`**. |
| SharePoint | **`copyFilesToSharepoint`**: creates **`/sites/elmo-ui-data/{dataFolder}/`** if needed; copies **`template/query-index.xlsx`** → **`{dataFolder}/query-index.xlsx`**. |
| Publish trigger | **`enqueueLlmoOnboardingPublish`**: SQS message **`trigger:llmo-onboarding-publish`** with **`siteId`** + **`auditContext.dataFolder`**. Audit worker calls **`publishToAdminHlx`** for **`{dataFolder}/query-index.json`** on Helix admin preview + live (`project-elmo-ui-data`). Enqueue failure is logged only. |
| Helix query config | **`updateIndexConfig`**: commits an entry to **`helix-query.yaml`** in **`adobe/project-elmo-ui-data`** (`main` in prod, **`onboarding-bot-dev`** otherwise). **Skipped when `params.tempOnboarding` is true.** |
| Rest | Enable audits/imports, LLMO brand + data folder on site config, optional **`overrideBaseURL`**, v2 customer config / Brandalf / DRS jobs as applicable, **`triggerAudits`**, DRS prompt generation, etc. |

Offboarding and other paths reuse **`validateSiteNotOnboarded`** / **`performLlmoOnboarding`** patterns (e.g. Slack modal) where noted in code.

---

## Feature: `temp-onboarding`

**Purpose:** Skip the **`updateIndexConfig`** step (no GitHub change to **`helix-query.yaml`**) for temporary or test onboarding — available from **HTTP** and **Slack**.

### HTTP request

- Optional boolean field: **`"temp-onboarding": true`** in the JSON body.
- Only strict **`true`** is honored (`=== true`). Omitted, `false`, or non-boolean values run the normal path (step runs).

### Slack request

- Append **`--skip-helix-query`** or **`--temp-onboarding`** to the **`onboard-llmo`** command (see [Slack: `onboard-llmo` command](#slack-onboard-llmo-command)).
- The flag is carried through the button **`value`**, modal **`private_metadata`**, and **`onboardSite`** into **`performLlmoOnboarding`**.

### Implementation (shared)

- **`src/controllers/llmo/llmo.js` (HTTP):** Reads `data['temp-onboarding']`, passes **`tempOnboarding`** into **`performLlmoOnboarding`**.

- **`src/controllers/llmo/llmo-onboarding.js`:** If **`params.tempOnboarding`**:
  - Logs that **`helix-query.yaml`** update is skipped.
  - Calls **`say`** with an informational line when **`say`** is provided (HTTP does not use **`say`**; Slack **`onboardSite`** does).
  - Does **not** call **`updateIndexConfig`**.

- **`src/support/slack/commands/llmo-onboard.js`:** Parses flags, encodes **`brandURL`** / **`tempOnboarding`** on the **Start Onboarding** button **`value`**.

- **`src/support/slack/actions/onboard-llmo-modal.js`:** **`parseStartLlmoOnboardingButtonValue`**, **`startLLMOOnboarding`**, modals’ **`private_metadata`**, **`onboardLLMOModal`**, **`onboardSite`** → **`performLlmoOnboarding`**.

### API spec

- **`docs/openapi/llmo-api.yaml`:** `POST` onboard request body documents optional **`temp-onboarding`**.

### Tests

- **`test/controllers/llmo/llmo.test.js`:** Asserts **`performLlmoOnboarding`** receives **`tempOnboarding: true`** when body includes **`'temp-onboarding': true`**.
- **`test/controllers/llmo/llmo-onboarding.test.js`:** When **`tempOnboarding: true`**, GitHub **`createOrUpdateFileContents`** is not used and skip is logged.
- **`test/support/slack/commands/llmo-onboard.test.js`:** Command usage, JSON button **`value`**, **`--skip-helix-query`** encoding.
- **`test/support/slack/actions/onboard-llmo-modal.test.js`:** **`parseStartLlmoOnboardingButtonValue`**, **`startLLMOOnboarding`** / **`private_metadata`**, **`onboardSite`** with **`tempOnboarding: true`** (no Octokit / **`helix-query.yaml`** update).

### Lint

- ESLint: multi-line object for **`performLlmoOnboarding`** call where applicable; JSDoc line length for **`tempOnboarding`** param.

### Example HTTP body

```json
{
  "domain": "example.com",
  "brandName": "Example",
  "temp-onboarding": true
}
```

### Example Slack invocation

```text
onboard-llmo https://example.com --skip-helix-query
```

---

## References in repo

- HTTP controller: `src/controllers/llmo/llmo.js` (`onboardCustomer`).
- Onboarding logic: `src/controllers/llmo/llmo-onboarding.js` (`performLlmoOnboarding`, `updateIndexConfig`, `copyFilesToSharepoint`, `enqueueLlmoOnboardingPublish`).
- Slack command: `src/support/slack/commands/llmo-onboard.js`.
- Slack modal / **`onboardSite`**: `src/support/slack/actions/onboard-llmo-modal.js`.
- Audit worker handler: `spacecat-audit-worker` → `trigger:llmo-onboarding-publish` → `publishToAdminHlx`.
