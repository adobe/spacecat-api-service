# Opportunity Workspace Email Notifications

Triggered by `PUT /sites/:siteId/llmo/strategy` (see `src/controllers/llmo/llmo.js` `saveStrategy`). Diffs prev vs next strategy data and sends per-recipient emails via Adobe Post Office.

## Change Detection (`detectStatusChanges` in `src/support/opportunity-workspace-notifications.js`)

| Type | Trigger | Template | Recipients |
|------|---------|----------|------------|
| `strategy` | Strategy status changed (not on initial creation) | `llmo_strategy_update` | All opp assignees + `createdBy` |
| `opportunity` | Opportunity status changed | `llmo_opportunity_status_update` | Opp assignee + `createdBy` |
| `assignment` | Assignee set or changed (not removed) | `llmo_opportunity_status_update` | Opp assignee only |

- **First save** (prevData null): emits `opportunity` only for opps with an assignee (assignee is the sole recipient). No strategy-level email is sent on initial creation.
- A single save can emit both `opportunity` and `assignment` for the same opp.
- Recipients are deduplicated and validated (`isValidEmail`); invalid emails are logged and skipped.

## Opportunity Name Resolution

Fallback chain: `strategyOpportunity.name` -> library lookup (`nextData.opportunities` keyed by `id`) -> `opportunityId`. Library opportunities (no `link` field) typically lack `name` on the strategy ref; the canonical name lives in the library.

## Template Data

**`llmo_opportunity_status_update`**: `recipient_name`, `recipient_email`, `assignee_name`, `assignee_email`, `strategy_owner_name`, `strategy_owner_email`, `opportunity_name`, `opportunity_status`, `strategy_name`, `strategy_url`

**`llmo_strategy_update`**: `recipient_name`, `recipient_email`, `strategy_name`, `strategy_status`, `strategy_url`, `strategy_owner_name`, `strategy_owner_email`, `opportunity_list` (array)

- Names resolved via `TrialUser.findByEmailId`; falls back to raw email.
- Missing `createdBy`: `strategy_owner_name` and `strategy_owner_email` set to `'-'`.

## Email Service (`src/support/email-service.js`)

- Auth: IMS token via `LLMO_EMAIL_IMS_CLIENT_*` env vars, `authorization_code` grant.
- Token caching: `sendStatusChangeNotifications` acquires the token once via `getEmailServiceToken` and passes it to each `sendEmail` call to avoid N IMS round-trips per request.
- Request: `POST {ADOBE_POSTOFFICE_ENDPOINT}/po-server/message?templateName={name}&locale={locale}`
- Headers: `Content-Type: application/json`, `Accept: application/json`, `Authorization: IMS {token}`
- Body: `{ "toList": "email1,email2", "templateData": { ... } }`
- Default locale: `en_US`. Never throws; returns `{ success, statusCode, error?, templateUsed }`.
