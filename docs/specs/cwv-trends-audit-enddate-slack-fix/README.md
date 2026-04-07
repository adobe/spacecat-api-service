# CWV Trends Audit endDate Fix — spacecat-api-service

**Status:** Completed
**Branch:** `cwv-trends-audit-enddate-slack-fix`

---

## What Was Changed

### `src/controllers/trigger/cwv-trends.js` *(new file)*

A dedicated trigger controller for `cwv-trends-audit` that:
- Reads an optional `endDate` query param (`YYYY-MM-DD`)
- Validates it with a regex + `Date` round-trip, returning `400` on invalid input
- Forwards a valid `endDate` directly into `auditContext` so the audit worker runner receives it at the expected level

### `src/controllers/trigger.js`

Registered `cwv-trends-audit` in the `AUDITS` map:

```js
import cwvTrends from './trigger/cwv-trends.js';

const AUDITS = {
  // ...existing entries...
  'cwv-trends-audit': cwvTrends,
};
```

### `docs/openapi/schemas.yaml`

Added `cwv-trends-audit` and `organic-traffic` to the `AuditType` enum (both were already supported by registered trigger controllers but missing from the schema).

### `docs/openapi/trigger-api.yaml`

- Updated the supported audit types list to reflect all currently registered types
- Added the optional `endDate` query parameter with schema (`YYYY-MM-DD` pattern) and description

### `test/controllers/trigger/cwv-trends.test.js` *(new file)*

Tests covering:
- Trigger without `endDate` → `auditContext` is empty
- Trigger with valid `endDate` → forwarded into `auditContext`
- Trigger with wrong format `endDate` → `400`
- Trigger with invalid calendar date → `400`
- Handler disabled for site → no SQS message sent
- Site not found → `404`

---

## Why

The `GET /trigger` endpoint had no registration for `cwv-trends-audit`, meaning there was no HTTP path to trigger it at all. Adding this controller enables:

```
GET /trigger?type=cwv-trends-audit&url={site}&endDate=2026-04-05
```

The `endDate` is placed directly into `auditContext` (not `message.data`), which is the level the audit worker runner reads natively — avoiding the gap that exists on the Slack bot path.

Validation was added to reject malformed dates at the API boundary rather than silently falling back to today inside the worker, which would produce unexpected results without any error signal.

---

## Testing

```bash
npx mocha test/controllers/trigger/cwv-trends.test.js
# 6 passing
```

---

## Related

- Paired with `spacecat-audit-worker` change that adds `messageData.endDate` fallback in `cwvTrendsRunner`
- [Workspace spec](../../../../../docs/specs/cwv-trends-audit-enddate-slack-fix/spec.md)
