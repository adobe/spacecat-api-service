---
name: plg-onboard
description: >-
  Onboard a domain into SpaceCat/ASO via POST /plg/onboard using an admin IMS
  token, so it can target any IMS org (not just the caller's own tenant). Use
  when asked to "onboard <domain>" for a customer/org, run PLG onboarding
  manually, onboard on behalf of an IMS org, or check/unblock a waitlisted PLG
  onboarding. This is a real production action (creates an Organization/Site,
  provisions an ASO entitlement, enrolls audits, sends Slack notifications) —
  not a dry run.
---

# PLG Onboard (admin path)

Runs `POST /plg/onboard` against the live SpaceCat API as an admin, so the
`imsOrgId` in the body is trusted as-is instead of being restricted to the
caller's own tenant (see `src/controllers/plg/plg-onboarding.js:247-344`).

**This is production, not a sandbox.** `spacecat.experiencecloud.live` is the
prod host (see this repo's own `CLAUDE.md` Fastly section) — not "dev", despite
how some other docs label the `/api/v1` path. A successful call creates a real
`Organization`/`Site`, provisions an ASO entitlement, enrolls the site in
audits/imports, and posts Slack notifications. There is no "undo onboarding" —
reversal only happens via the separate `PATCH /plg/onboard/:onboardingId/status`
→ `OUTDATED` transition. Treat every run here as a real, largely irreversible
customer-facing action.

## Required inputs

- `domain` — the hostname (or hostname/path) to onboard, e.g. `pullman.accor.com`.
- `imsOrgId` — the target IMS org, format `<orgId>@AdobeOrg`. If the user gives
  an org name instead of an ID, look it up (e.g. via `Organization.findByImsOrgId`
  through an existing query skill, or ask the user) before proceeding — don't guess.

If either is missing, ask for it. Don't infer `imsOrgId` from a domain guess.

## Safety gate

Before sending the request, confirm with the user:

1. **Domain + org are correct** — read them back explicitly.
2. **They intend to hit prod** — this is not reversible via this endpoint.
3. **Which credential to use** — default is the caller's own mysticat session
   token via `mysticat auth token` (requires `mysticat login` first). Only
   proceed without asking again if the user has already explicitly confirmed
   this exact action in the current conversation.

**Use `mysticat auth token` (no `--ims` flag).** The raw IMS access token
(`mysticat auth token --ims`) gets rejected with a plain-text `401
Unauthorized` on every route of the live app API — confirmed via response
headers (`apigw-requestid` present, `content-length: 12`), meaning API
Gateway's custom authorizer layer rejects it before the app's own
`authWrapper` ever runs. This reproduced across multiple fresh `mysticat
login --force` cycles, so it isn't a stale-session issue — re-authenticating
with `--ims` will not fix it. The session token works. See the
`plg-suggestion-grants` skill for more detail on this if it resurfaces.

Do not skip this gate just because a similar call was made earlier in the
session for a different domain/org.

## Steps

1. Get a token:
   ```bash
   TOKEN=$(mysticat auth token)
   ```
2. Call the endpoint:
   ```bash
   curl -s -w "\n\nHTTP_STATUS:%{http_code}\n" --request POST \
     --url https://spacecat.experiencecloud.live/api/v1/plg/onboard \
     --header "authorization: Bearer ${TOKEN}" \
     --header 'accept: */*' \
     --header 'content-type: application/json' \
     --header 'x-client-type: sites-optimizer-ui' \
     --data '{
       "domain": "<domain>",
       "imsOrgId": "<imsOrgId>@AdobeOrg"
     }'
   ```
3. Interpret the response:

   | Result | Meaning | Next step |
   |---|---|---|
   | `400 Authentication information is required` | Token missing/not attached | Re-check `TOKEN` was set |
   | `400 Valid imsOrgId is required when onboarding as admin` | Token isn't resolving to admin (`hasAdminAccess()` false), so it fell to the self-service branch and rejected the org mismatch, **or** the org ID is malformed | Verify the caller's IMS token actually carries admin/scope; check `imsOrgId` format |
   | `400 ... not available for frescopa domains / demo/internal sites / internal organizations / paid customers` | A guardrail rejected the org/domain outright | This domain/org is intentionally excluded from PLG — don't try to force it through this endpoint |
   | `200` with `status: "ONBOARDED"` | Fully provisioned | Done — site/org/entitlement live |
   | `200` with `status: "WAITLISTED"` | Provisioning paused; check `waitlistReason` | Common reason: another domain is already onboarded for this org (PLG allows one active domain per org). Report the reason to the user; don't retry blindly |
   | `409` | Conflict (e.g. race with an existing onboarding record) | Re-check via `GET /plg/onboard/status/:imsOrgId` before retrying |
   | `500 Onboarding failed. Please try again later.` | Unhandled error in the onboarding pipeline | Check Lambda/Splunk logs for the failure — don't blind-retry a real provisioning call |

4. Report the full response body back to the user verbatim (or the key fields:
   `status`, `organizationId`, `waitlistReason`) — don't just say "done".

## Related endpoints (for follow-up, not part of the default flow)

- `GET /plg/onboard/status/:imsOrgId` — check current onboarding status for an org.
- `GET /plg/sites` — list all PLG onboardings.
- `PATCH /plg/onboard/:onboardingId` / `.../status` — admin-only transitions
  (e.g. approving a waitlisted record, or marking `OUTDATED` to revoke ASO
  enrollments). Treat these with the same safety gate as the initial onboard —
  they mutate the same real records.
