# CWV Trends Audit endDate Fix — spacecat-api-service

**Created:** 2026-04-06
**Status:** Completed

---

## Feature Overview

The `cwv-trends-audit` supports a custom `endDate` so operators can process historical CWV data. Currently, the `GET /trigger` HTTP endpoint does not register `cwv-trends-audit` at all, meaning there is no HTTP/curl path to trigger it with a custom `endDate`. This change adds a dedicated trigger controller for `cwv-trends-audit` and registers it in the existing trigger routing, wiring the `endDate` query param directly into `auditContext` so the audit worker runner receives it correctly.

### Why

Without this change, the only way to pass `endDate` directly into `auditContext` (the shape the runner expects natively) is to send an SQS message manually via the AWS CLI. Adding the HTTP trigger path provides a proper operator-facing mechanism.

### Success Criteria

- [ ] `GET /trigger?type=cwv-trends-audit&url={site}&endDate=2026-04-05` triggers the audit with `auditContext.endDate = '2026-04-05'`
- [ ] `GET /trigger?type=cwv-trends-audit&url={site}` (no endDate) triggers the audit with an empty `auditContext` — runner defaults to today
- [ ] Unit tests cover both cases

---

## What This Repo Does

1. Create a new trigger controller `src/controllers/trigger/cwv-trends.js` that reads `endDate` from query params and sets it on `auditContext`
2. Register `'cwv-trends-audit'` in the `AUDITS` map in `src/controllers/trigger.js`

---

## Requirements

1. **Register cwv-trends-audit in GET /trigger**
   - Acceptance criteria: `GET /trigger?type=cwv-trends-audit&url=...` returns a non-404 response and queues an audit job

2. **Forward endDate query param into auditContext**
   - Acceptance criteria: SQS message contains `auditContext.endDate` matching the query param value

3. **Optional endDate**
   - Acceptance criteria: Omitting `endDate` results in an empty `auditContext`; the audit worker runner defaults to today

---

## Data Flow

```
GET /trigger?type=cwv-trends-audit&url=https://www.example.com&endDate=2026-04-05
  → trigger.js routes to cwv-trends.js controller
    → auditContext = { endDate: '2026-04-05' }
      → triggerFromData(context, config, auditContext)
        → sendAuditMessages → SQS audit-jobs:
            { type: 'cwv-trends-audit', siteId: '...', auditContext: { endDate: '2026-04-05' } }
              → audit-worker: buildRunnerAuditContext → auditContext.endDate = '2026-04-05' ✓
                → cwvTrendsRunner: parseEndDate(auditContext.endDate) ✓
```

---

## Implementation Tasks

### Task 2.1: Create cwv-trends trigger controller

- **Description:** Create `src/controllers/trigger/cwv-trends.js`. Model it after the existing `src/controllers/trigger/cwv.js`. Read `endDate` from `context.data` and conditionally set it on `auditContext`.
- **Files:** `src/controllers/trigger/cwv-trends.js` — new file
- **Dependencies:** None

**Implementation:**
```javascript
import { triggerFromData } from './common/trigger.js';

export default async function triggerAudit(context) {
  const { type, url, endDate } = context.data;

  const auditContext = {};
  if (endDate) {
    auditContext.endDate = endDate;
  }

  const config = {
    url,
    auditTypes: [type],
  };

  return triggerFromData(context, config, auditContext);
}
```

Note: No `deliveryType` filter is applied (unlike the `cwv.js` controller which restricts to `AEM_EDGE`) — `cwv-trends-audit` is not delivery-type restricted.

### Task 2.2: Register in trigger.js AUDITS map

- **Description:** Import the new controller and add it to the `AUDITS` map
- **Files:** `src/controllers/trigger.js`
- **Dependencies:** Task 2.1

**Change:**
```javascript
// add import
import cwvTrends from './trigger/cwv-trends.js';

// add to AUDITS map
const AUDITS = {
  apex,
  cwv,
  canonical,
  sitemap,
  'broken-backlinks': backlinks,
  'organic-traffic': organictraffic,
  'cwv-trends-audit': cwvTrends,   // ← new
};
```

### Task 2.3: Unit tests

- **Description:** Add tests for the new `cwv-trends.js` trigger controller
- **Files:** `test/controllers/trigger/cwv-trends.test.js` — new file
- **Dependencies:** Task 2.2
- **Testing:** `npx mocha test/controllers/trigger/cwv-trends.test.js`

Test scenarios:
1. `context.data = { type: 'cwv-trends-audit', url: 'https://example.com', endDate: '2026-04-05' }` → `triggerFromData` called with `auditContext = { endDate: '2026-04-05' }`
2. `context.data = { type: 'cwv-trends-audit', url: 'https://example.com' }` → `triggerFromData` called with `auditContext = {}`

---

## Code Patterns

Follow the existing trigger controller pattern. All trigger controllers in `src/controllers/trigger/` are thin functions that build `config` and `auditContext`, then delegate to `triggerFromData`. See `src/controllers/trigger/cwv.js` as the closest reference.

---

## Testing Requirements

- `npm test` must pass
- Run specific test: `npx mocha test/controllers/trigger/cwv-trends.test.js`
- Mock `triggerFromData` in unit tests (do not hit real SQS)

---

## Dependencies on Other Repos

- `spacecat-audit-worker` must also be deployed with the `messageData` fallback fix for the Slack bot path to work end-to-end
- This change is independently deployable — the HTTP trigger path works regardless of the audit worker change

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Invalid `endDate` format passed via query param | Low | `parseEndDate` in the audit worker handles validation and falls back to today |
| No `deliveryType` filter on the new trigger | Low | Consistent with how `cwv-trends-audit` is configured — not delivery-type restricted |
