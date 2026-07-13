# Semrush Onboarding Notification Endpoint — Design

**Date:** 2026-07-13
**Status:** Approved (pending implementation)

## Summary

A new endpoint that lets an authenticated (IMS) customer trigger "onboarding" for
Semrush. For now it does **not** call any Semrush (SR) API — it simply receives the
request, resolves the customer's identity and Semrush workspace, and sends a Slack
notification (via an incoming webhook) so a human/operator is alerted. In a future
iteration the same seam will call the SR API using Styx authentication.

## Goals

- Provide `POST /v2/orgs/:spaceCatId/onboarding` for IMS users.
- Send a Slack notification containing:
  - the customer's **email** (from the trusted auth identity), and
  - the org's **Semrush workspace ID** ("parent, if possible" — best-effort, may be absent).
- Do it safely: identity and workspace come from trusted sources (validated token +
  DB lookup), never from the request body, because a body-supplied email or workspace
  ID could be forged.

## Non-Goals

- No SR API / Styx call yet. The notifier module is the seam where that lands later.
- No persistence of an onboarding record (no new data-access model).
- No new Slack Web API usage — delivery is via an incoming webhook, because the
  target channel lives in the **Semrush** Slack workspace (not Adobe's), and the
  existing `chat.postMessage` client is scoped to the Adobe workspace.

## Design Decisions (from brainstorming)

1. **Input = org id only, not body-supplied email/workspace.** Both email and
   workspace ID can be forged if taken from the body. Instead:
   - email ← authenticated IMS identity (`authInfo.getProfile()?.email`),
   - workspace ← resolved from the org via the existing `resolveWorkspaceId`.
2. **Path keys on the org id** (`:spaceCatId`), matching the serenity route tree and
   the workspace resolver's input. A site id would only add a site→org indirection.
3. **Slack delivery via incoming webhook** (`SLACK_ONBOARDING_WEBHOOK_URL`), since the
   channel is in the Semrush Slack workspace.
4. **"Parent workspace, if possible"** maps to `resolveWorkspaceId(ctx, orgId)`, which
   returns the org-level (shared/"parent") Semrush workspace ID, or `null` when the org
   has none. `null` is acceptable → notify without it.
5. **Auth = IMS user.**
6. **Webhook failure returns an error** to the caller (not fire-and-forget).
7. **Success returns `200`** with a small confirmation body.
8. **Approach 1 (chosen):** standalone controller + a dedicated webhook-notifier
   support module, keeping the webhook call isolated and testable and leaving
   `serenity.js` untouched.

## Route & Contract

- **`POST /v2/orgs/:spaceCatId/onboarding`**
- Registered in `src/routes/index.js` and wired in `src/index.js`.
- `:spaceCatId` is already listed in `FACS_NON_RESOURCE_PARAMS`
  (`src/routes/facs-capabilities.js`) — **no facs-capabilities change required.**
- UUID validation for `:spaceCatId` uses the existing `isValidUUIDV4` guard in
  `src/index.js`.
- **Request body:** none required. Any body is optional/ignored for now so callers can
  add fields later without a breaking change.
- **Responses:**
  - `200 OK` → `{ "notified": true, "workspaceId": "<id>" | null }`
  - `403 Forbidden` → caller lacks access to the org
  - `404 Not Found` → org does not exist
  - `400 Bad Request` → cannot determine the customer email from the identity
  - `500 Internal Server Error` → `SLACK_ONBOARDING_WEBHOOK_URL` not configured
  - `502 Bad Gateway` → Slack webhook returned a non-2xx / failed

## Access Control

In `OnboardingController.triggerOnboarding(context)`:

1. Fetch the org: `Organization.findById(spaceCatId)` → `notFound` if missing.
2. `const acl = AccessControlUtil.fromContext(context);`
3. `if (!await acl.hasAccess(org)) return forbidden(...)`.

(No admin-only requirement; a customer onboarding themselves is expected.)

## Data Resolution

- **Email:** `context.attributes.authInfo.getProfile()?.email`.
  - Trusted (from the validated IMS token), not forgeable via the body.
  - Caveat to verify in implementation: for IMS, `profile.email` is sometimes the IMS
    user_id alias (e.g. `ABC123@AdobeID`) rather than a human email. The *source* is
    correct; the exact field will be confirmed against the real profile shape. If no
    email-like value is present → `400`.
- **Workspace ID:** `resolveWorkspaceId(context, spaceCatId)` (from
  `src/support/serenity/workspace-resolver.js`). Returns the org-level Semrush
  workspace ID or `null`. `null` is acceptable and is passed through to the
  notification as absent/best-effort.

## Components (Approach 1)

### `src/controllers/onboarding.js`

`OnboardingController(context, log, env)` factory returning `{ triggerOnboarding }`.

Orchestration:
1. Validate/lookup org, access control (above).
2. Resolve email and workspace ID.
3. Build the notification payload `{ email, workspaceId, spaceCatId }`.
4. Call `notifyOnboarding(env, payload)`.
5. On success → `ok({ notified: true, workspaceId })`.
6. On typed webhook error → `502` response (sanitized). Choice of http-utils helper
   is an implementation detail; the intended status is `502`.

### `src/support/onboarding/slack-notifier.js`

`notifyOnboarding(env, { email, workspaceId, spaceCatId })`:
- Reads `env.SLACK_ONBOARDING_WEBHOOK_URL`; if missing, throws a typed
  "not configured" error the controller maps to `500`.
- Builds a Slack message (text/blocks) summarizing: customer email, workspace ID
  (or "not available"), and org id.
- `POST`s JSON to the webhook URL using `tracingFetch` from
  `@adobe/spacecat-shared-utils`.
- Throws a typed error on non-2xx (mapped to `502`).
- **This is the seam** where the future Styx-authenticated SR API call will be added.

## Configuration

- New env var **`SLACK_ONBOARDING_WEBHOOK_URL`** — Semrush Slack workspace incoming
  webhook URL. Surfaces on `context.env` (same channel serenity uses).
- Unset → `500` "onboarding notifications not configured" (logged; URL/secret never
  echoed to the client).

## Error Handling

- Sanitize any outbound error text with `cleanupHeaderValue` before returning.
- Never expose the webhook URL, secrets, or stack traces to the client.
- Log failures with `context.log.error(...)` including org id and a redacted reason.

## Testing

### Unit
- `test/controllers/onboarding.test.js`:
  - access forbidden → 403
  - org not found → 404
  - missing email → 400
  - webhook success → 200 with `{ notified, workspaceId }`
  - webhook non-2xx → 502
  - missing env var → 500
  - workspace `null` → 200 with `workspaceId: null`
  - uses `esmock` (stub `AccessControlUtil`, `resolveWorkspaceId`) + `nock` for the webhook.
- `test/support/onboarding/slack-notifier.test.js`:
  - payload shape, missing-env error, non-2xx handling (via `nock`).

### Integration (`test/it/`)
- Shared factory in `test/it/shared/tests/`, postgres wiring file, seed org in
  `postgres/seed-data/` + `seed-ids.js`.
- Assert 200 and access-control paths; webhook stubbed/mocked.

## OpenAPI

- New path spec under `docs/openapi/paths/`, response schema in `schemas.yaml`,
  example in `examples.yaml`.
- Run `npm run docs:lint` and `npm run docs:build`.

## Future Work

- Replace/extend `notifyOnboarding` (or add a sibling call) to invoke the Semrush (SR)
  API using Styx authentication once available.
