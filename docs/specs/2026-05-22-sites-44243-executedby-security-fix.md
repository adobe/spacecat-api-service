# SITES-44243 Fix `executedBy` PII Exposure via IMS Admin API

- **Date:** 2026-05-22
- **Author:** Sandeep Sinh
- **Status:** In Review
- **Jira:** [SITES-44243](https://jira.corp.adobe.com/browse/SITES-44243)
- **Target repo:** `adobe/spacecat-api-service`
- **PR:** #2445

## Context

`FixEntity` has an `executedBy` field that stores the IMS user ID (format: `GUID@AdobeOrg`) of the
person who manually marked an optimization suggestion fix as "deployed". At read time, the controller
was enriching each fix with a human-readable user object (firstName, lastName, email) by calling
`imsClient.getImsAdminProfile(executedBy)` - an admin-only Adobe IMS API.

The enrichment was introduced in commit `391089c9` ("fix: Add audit trail for manually marked
'deployed' optimization suggestions") and the IMS admin API was adopted in commit `e7ff222c`
("fix: use api client instead of trial users"), which replaced a prior org-scoped TrialUser lookup
with an unrestricted admin-level IMS call.

## Security Vulnerability

Because `executedBy` was also writable by clients via `PATCH /sites/:siteId/opportunities/:oppId/fixes/:fixId`
and `POST /sites/:siteId/opportunities/:oppId/fixes`, any org-admin could exploit the following chain:

1. **Write:** `PATCH` a fix with an arbitrary IMS user ID in `executedBy`.
2. **Read:** `GET /sites/:siteId/opportunities/:oppId/fixes` - the server calls the admin IMS API
   for the stored (attacker-supplied) user ID.
3. **Exfiltrate:** Receive `firstName`, `lastName`, and `email` of any user in the Adobe IMS system.

This is a PII leak via an unauthenticated server-side request forgery pattern: the client-supplied
value drives which admin API target the server queries.

No design document, wiki page, or spec records a requirement that `executedBy` must be settable to
an arbitrary user ID. The field's purpose is an audit trail of who performed an action - it should
always record the authenticated caller, not a client-supplied string.

## Design Decision

**Auto-populate `executedBy` from the authenticated caller's JWT identity; never accept an
arbitrary user ID from the client.**

The person marking a fix "deployed" via the UI is always the authenticated caller. There is no
legitimate need to record someone else's identity. The presence of `executedBy` in the request body
is treated as an **intent signal** only - "the caller wants to record themselves as executor" - and
the server resolves the actual value from the authenticated profile.

### Identity resolution

```js
const profile = context.attributes?.authInfo?.getProfile?.();
const callerUserId = profile?.user_id ?? profile?.sub;
```

The `user_id` claim is the primary IMS user ID. `sub` is the fallback for non-IMS JWT paths. The
resolved `callerUserId` is used as the stored value; the client-supplied string is ignored.

`profile?.email` is intentionally excluded as a third fallback. An email string does not pass
`IMS_ID_RE`, so any value stored via the email path would silently produce un-enrichable records
at read time — creating two classes of `executedBy` values with different behaviors. If the email
fallback becomes necessary, the regex and enrichment logic must be updated together with it.

### Known limitation: IMS auth path

The IMS authentication handler (in `@adobe/helix-shared-wrap`) strips `user_id` from the profile
via `IGNORED_PROFILE_PROPS`. For callers authenticated via IMS (not S2S JWT), `profile?.user_id` is
`undefined`, so `callerUserId` falls back to `sub` (which IMS also populates). The behavior when
both are `undefined` is a silent no-op: `setExecutedBy` is not called and the stored value is
unchanged. This is preferable to accepting the client-supplied ID, but it leaves `executedBy`
unset for IMS-authenticated callers who do not have `sub` populated.

## Scope

### In scope

- **`patchFix`**: Remove direct acceptance of client-supplied `executedBy`. When `executedBy` is
  present in the request body, resolve the actual value from the authenticated caller's profile
  and call `fix.setExecutedBy(callerUserId)` only if a verified identity is available and it
  differs from the current stored value.
- **`createFixes`**: Extract `callerUserId` once before the batch loop and override any
  client-supplied `executedBy` in each `FixEntity.create()` call via spread.
- **`#enrichFixesWithUserNames` (read time)**: Safe once stored IDs are guaranteed to originate
  from authenticated JWT tokens. No change to the enrichment logic itself; the IMS admin API
  call remains valid because the stored value now always comes from a verified identity.
- **OpenAPI `FixUpdate` schema**: Remove `executedBy` from the patchable properties.

### Out of scope

- Changing `getAllForOpportunity` enrichment logic.
- `getByStatus` enrichment — intentionally skipped to avoid unbounded IMS fan-out on large result sets.
- Handling the IMS auth path `user_id`/`sub` disambiguation fully.
- Adding `executedByUser` to the OpenAPI `Fix` response schema (tracked as follow-up).

## Changes

| File | Change |
|------|--------|
| `src/controllers/fixes.js` | Added `#imsClient` field and `#enrichFixesWithUserNames` private method; modified `patchFix` to use intent-signal pattern; modified `createFixes` to override client-supplied `executedBy` with JWT identity |
| `src/dto/fix.js` | Added conditional `executedByUser: { firstName, lastName, email }` field to `FixDto.toJSON` output |
| `docs/openapi/schemas.yaml` | Removed `executedBy` from `FixUpdate` schema |
| `test/controllers/fixes.test.js` | Updated `patchFix` and `createFixes` tests; added enrichment tests |
| `test/dto/fix.test.js` | Added `executedByUser` inclusion/exclusion tests |

## Follow-up

The following items were identified during review and are tracked for follow-up:

1. **`executedByUser` missing from OpenAPI `Fix` response schema** - the field is returned by the
   controller but not documented in `schemas.yaml`. Add it to the `Fix` schema.
2. **`getByStatus` not enriched** - `#enrichFixesWithUserNames` is called from `getAllForOpportunity`
   and `getByID`. `getByStatus` intentionally omits enrichment to avoid fan-out for large result
   sets, but this inconsistency should be documented in the API contract.
3. **IMS auth path silent no-op** - for callers whose profile has neither `user_id` nor `sub`,
   a client-supplied `executedBy` intent signal results in a no-op with a `log.warn`. Consider
   returning a `400` instead for clearer operator feedback.
4. **Stale comment in `src/dto/fix.js:57`** - says "TrialUser store"; should say "IMS admin
   profile API".

## Verification

```bash
npm test                # all unit tests pass
npm run docs:lint       # OpenAPI spec valid after removing executedBy from FixUpdate
```

Manual:
- `PATCH` a fix with `{ "status": "DEPLOYED" }` (no `executedBy`) - verify `executedBy` on the
  saved entity equals the auth profile's `user_id`.
- `PATCH` a fix with `{ "executedBy": "attacker@evil.org" }` - verify the stored value is the
  authenticated caller's ID, not the supplied string.
- `GET` the fixes list - verify `executedByUser` is populated from the stored (JWT-originated) ID
  via IMS admin profile.
