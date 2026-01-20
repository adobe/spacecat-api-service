# Copilot PR Review Instructions

## 1. Review Goals and Priorities

Your primary purpose is to identify **behavior-breaking defects**, **security/auth gaps**, and **missing tests for changed behavior**.
When such issues are present, prioritize them above all other considerations (performance, cost, style).

Use **three severities**:

* **Critical** – Bugs, regressions, security issues, missing required validation, or missing tests for changed behavior.
  *Respond with:* “This PR should not be merged until this is fixed.”
* **Major** – Missing documentation, missing but non-blocking tests, realistic performance or cost concerns.
* **Minor** – Stylistic suggestions or optional improvements.
  *Only list Minor issues if no Critical issues exist.*

If you find any Critical issue, list it first and deprioritize all other feedback.

---

## 2. Output Format (Always Required)

Respond using the following structure:

### Summary

1–3 sentences describing the overall health of the PR.

### Issues

#### Critical

* List each issue, quoting relevant code and suggesting a concrete fix.

#### Major

* As above.

#### Minor

* As above. Only include if there are no Critical issues.

### Suggested Tests

* Describe which tests should be added or updated (if applicable). If no test changes are needed, state that clearly.

---

## 3. Core Checks (Apply to Every PR)

### 3.1 Bug & Regression Scan

Look for defects including:

* Missing or incorrect null/undefined checks.
* Incorrect async/await handling.
* Miswired routes or controller mismatches.
* Incorrect DTO usage or leaking internal models.
* Logic changes without corresponding test updates.

**If you see changed behavior without new or updated tests, mark as Critical.**

---

### 3.2 Security & Authorization

For any controller returning tenant-specific data:

**If:**

* The controller does not instantiate `AccessControlUtil.fromContext(ctx)`, **or**
* It does not call `hasAdminAccess()` **or** `hasAccess(entity, subService, productCode)`,

**Then:**
Flag as **Critical (Security)** and state that the PR must not be merged.

Additionally:

* Ensure `x-product` is not misused to bypass entitlement.
* Ensure responses sanitize error messages (use utilities such as `cleanupHeaderValue`).
* Ensure secrets are not returned, logged, or sent to clients.

---

### 3.3 Routing & Middleware

**For any new HTTP endpoint:**

**Require:**

* A route entry in **both** `src/index.js` and `src/routes/index.js`.
* Validation of all UUID parameters (e.g., `isValidUUIDV4`).
* Use of shared HTTP helpers from `@adobe/spacecat-shared-http-utils` (`ok`, `badRequest`, `accepted`, …).

**If a route exists in one file but not the other → Critical.**
**If a route uses `:siteId` without UUID validation → Critical.**

**Canonical reference:**

```js
// src/index.js
const routeHandlers = getRouteHandlers(...);
const routeMatch = matchPath(method, suffix, routeHandlers);
if (params.siteId && !isValidUUIDV4(params.siteId)) {
  return badRequest('Site Id is invalid...');
}
```

```js
// src/routes/index.js
const routeDefinitions = {
  'GET /audits/latest/:auditType': auditsController.getAllLatest,
  'POST /sites/:siteId/brand-profile': sitesController.triggerBrandProfile,
  ...
};
```

---

### 3.4 Use of shared utility functions

Check that utility functions available here: https://github.com/adobe/spacecat-shared/blob/main/packages/spacecat-shared-utils/src/index.js are used where appropriate and instead of self-made checks.

---

### 3.4 Required Tests

For any non-trivial code change:

* Require unit tests under `test/**` using Mocha/Chai/Sinon/esmock.
* Integration tests where relevant.
* Tests must assert behavior, not just shallow coverage.
* Fixtures and helpers must be updated consistently.

**If behavior changes but tests do not → Critical.**

If a PR is documentation-only or comment-only, explicitly mark tests as not required.

---

## 4. Repo-Specific Patterns & Rules

### 4.1 DTOs, Responses, and HTTP Helpers

* All returned data must use DTOs (`SiteDto`, `AuditDto`, …).
* Never return raw database models or internal fields.
* Ensure DTOs and corresponding tests are updated together.

**Leak of internal models → Critical.**

---

### 4.2 SQS Messaging

For any SQS interaction:

* Payload must include a timestamp (added by the helper).
* Queue URL resolution must use internal helpers.
* FIFO queues must set `MessageGroupId`.
* Queue names must be sanitized.
* Logs must avoid PII.

**Canonical reference:**

```js
// src/support/sqs.js
async sendMessage(queueNameOrUrl, message, messageGroupId) {
  const body = { ...message, timestamp: new Date().toISOString() };
  const queueUrl = await this.#toQueueUrl(queueNameOrUrl);
  ...
}
```

---

### 4.3 Slack & External Integrations

For Slack event processing:

* Must ignore retries: `x-slack-retry-reason === 'http_timeout'`.
* Must safely parse event payloads.
* Must require all necessary env vars.
* Commands and actions must be registered in:

  * `src/support/slack/commands.js`
  * `src/support/slack/actions/index.js`

**Canonical reference:**

```js
// src/controllers/slack.js
if (headers['x-slack-retry-reason'] === 'http_timeout') { ... }
const slackBot = initSlackBot(context, SlackApp);
await slackBot.processEvent({ body: payload, ack });
```

---

### 4.4 Validation, Multipart, and Payload Limits

* Use `validateRepoUrl`, `checkBodySize`, and `multipartFormData`.
* Multipart uploads must respect:

  * `MULTIPART_FORM_FILE_COUNT_LIMIT`
  * size limits based on config
* Flag any unbounded buffer handling or unchecked streams.

**Canonical reference:**

```js
// src/support/multipart-form-data.js
if (isMultipartFormData(headers) && !context.multipartFormData) {
  const limits = { files: MULTIPART_FORM_FILE_COUNT_LIMIT, fileSize: maxFileSizeMb * 1024 * 1024 };
  ...
}
```

---

## 5. Performance Scan (Secondary Priority)

Raise **Major** issues for realistic performance risks:

* Repeated DAO calls inside loops.
* Redundant fetches or HTTP calls.
* Blocking or synchronous operations where async or batching exists.
* Unbounded payload handling without streaming.

Do **not** speculate without evidence.

---

## 6. Cost Impact Scan (Secondary Priority)

Flag potential cost increases only when the diff clearly adds:

* New SQS calls, queue consumers, cron jobs.
* Large CSV/JSON generation.
* Long-running processing.
* Removal of rate limits such as `SANDBOX_AUDIT_RATE_LIMIT_HOURS`.

Tie comments to specific code, not general assumptions.

---

## 7. Config, Documentation, and Change Control

For any new:

* Env var
* Queue
* Feature flag
* Controller surface area

Require updates to:

* `config/default.json`
* `README.md`
* OpenAPI/Redoc specs
* `CHANGELOG.md` (semantic-release conventions)

Missing required docs → **Major**.

---

## 8. Final Quality Pass

Once all Critical and Major issues are addressed:

* Ensure DTOs, tests, routing, and docs are consistent.
* Ensure no lint rules are violated.
* Ensure logging is structured and avoids PII.
* Only then offer stylistic suggestions (Minor).
