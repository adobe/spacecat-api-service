---
name: plg-suggestion-grants
description: >-
  Inspect and drive the PLG "SuggestionGrant" token-gated fix system for a
  site's opportunities (broken-backlinks, alt-text, cwv) — check which
  suggestions currently hold a grant, revoke stale ones, and trigger a
  regrant of the best available suggestion. Use when asked to check/revoke/
  regrant suggestion "grants" or "tokens" for a site, investigate why a PLG
  customer isn't seeing a proposed fix, or verify the top-ranked suggestion
  is actually the one granted. Supports dev/stage/prod. This mutates real
  per-site PLG token allocations — not a dry run.
---

# PLG Suggestion Grants (check / revoke / regrant)

Drives `@adobe/spacecat-shared-utils`'s PLG token-quota system for
suggestions, implemented in
[`src/support/grant-suggestions-handler.js`](../../../src/support/grant-suggestions-handler.js)
and exposed indirectly through the opportunities/suggestions controllers.
Each PLG site gets a small monthly quota ("token") of suggestions it's
allowed to see per opportunity type — this skill lets you inspect that state
and force a refresh (revoke anything stale, backfill with the current best).

**This mutates a real site's PLG token allocation in whichever environment
you point it at.** There is no dedicated "revoke" or "regrant" endpoint you
call with a body — the revoke+regrant cycle is a side effect of `GET
/sites/:siteId/opportunities/:opportunityId`, gated behind the site's
entitlement tier. Treat every trigger call here as a real action against
that environment's data — same spirit as the `plg-onboard` skill's safety
gate — and be especially careful on `prod`, where it's customer-facing.

## Target environment

**Ask which environment (`dev`, `stage`, or `prod`) before doing anything**,
unless the user already said. Default to `prod` only after confirming — a
real PLG customer's token allocation lives there, so don't assume.

| Env | App API base | PostgREST base | Auth |
|---|---|---|---|
| `prod` | `https://spacecat.experiencecloud.live/api/v1` | `https://d1xldhzwm6wv00.cloudfront.net` | `mysticat auth token` / `mysticat login` (defaults to prod) |
| `stage` | `https://spacecat.experiencecloud.live/api/stage` | *(none — see caveat below)* | `mysticat auth token --env stage` / `mysticat login --env stage` |
| `dev` | `https://spacecat.experiencecloud.live/api/ci` | `https://dql63ofcyt4dr.cloudfront.net` | `mysticat auth token --env dev` / `mysticat login --env dev` |

**Caveat — no separate stage PostgREST instance.** The app API has all three
environments, but the PostgREST reporting service (used for every read-only
inspection step below) only has `dev` and `prod` deployments — confirmed
against the `query-sites`/`query-opportunities` skills' own endpoint tables,
neither of which lists a stage URL. If the target is `stage`, you can still
trigger the app-API refresh call against `/api/stage`, but you cannot verify
grant/token state via PostgREST for a stage-only site — the `dev` PostgREST
instance won't have that site's rows either. Say this limitation out loud
rather than silently querying the wrong environment's data.

Once the env is picked, set both bases for the rest of this skill:

```bash
# example for prod — swap per the table above
APP_API="https://spacecat.experiencecloud.live/api/v1"
POSTGREST="https://d1xldhzwm6wv00.cloudfront.net"
ENV_FLAG="prod"   # dev | stage | prod — passed to mysticat auth/login
```

## Precondition: does this even apply to the site?

The grant/revoke cycle only fires when `getIsSummitPlgEnabled()`
(`src/support/utils.js:655`) returns true:

1. Request carries header `x-client-type: sites-optimizer-ui`, **and**
2. Either `x-view-as-trial: true` is also set (don't fake this on a real
   customer site — it's a UI-only trial simulation), **or** the site's
   organization has an `ASO` entitlement with `tier: "PLG"`.

Check the entitlement first, via the `query-sites` skill:

```bash
python <query-sites-skill>/scripts/fetch_site.py entitlements --site-id <siteId>
```

Look for `org_entitlements[] where product_code=="ASO"`. If `tier` isn't
`PLG`, the trigger call below will be accepted (200) but is a guaranteed
no-op — say so rather than declaring success.

## Auth — use the session token, not the IMS token

**Use `mysticat auth token` (no `--ims` flag) for every call to the live app
API**, on whichever env you picked above. The raw IMS access token
(`mysticat auth token --ims`) gets rejected with a plain-text `401
Unauthorized` before it ever reaches the app — the response carries an
`apigw-requestid` header and `content-length: 12`, meaning API Gateway's
custom authorizer layer rejected it, not the app's own `authWrapper`. This
reproduced consistently across multiple fresh `mysticat login --force`
cycles, so it isn't a stale-session issue — re-authenticating with `--ims`
will not fix it. Root cause was never fully isolated (the authorizer's
`identity_sources` is a Fastly-injected shared secret unrelated to the
`Authorization` header per `spacecat-infrastructure/modules/api_gateway/
api_gateways.tf`, so in theory it shouldn't care about this header at all —
but empirically swapping to the session token is what works). Don't spend
time re-diagnosing this — just use the session token:

```bash
TOKEN=$(mysticat auth token --env "$ENV_FLAG")   # omit --env for prod, it's the default
```

Make sure you're logged into the right env first — `mysticat login --env
"$ENV_FLAG"` if `mysticat auth token --env "$ENV_FLAG"` prints nothing or a
token for the wrong tenant. A prod session doesn't carry over to
dev/stage and vice versa.

## Data model (read-only inspection)

Three PostgREST tables back this feature, all queryable the same way as
`sites`/`opportunities`/`suggestions` (see the `query-opportunities` skill's
auth/endpoint setup):

| Table | Key fields | Notes |
|---|---|---|
| `tokens` | `id, site_id, token_type, cycle, total, used` | One row per site per token type per month (`cycle` = `YYYY-MM`). `token_type` ∈ `grant_broken_backlinks`, `grant_alt_text`, `grant_cwv`. `total` is `tokensPerCycle` (currently 3 for all three types, per `OPPORTUNITY_GRANT_CONFIG` in `@adobe/spacecat-shared-utils`'s `src/token-grant-config.js`). |
| `suggestion_grants` | `id, grant_id, suggestion_id, site_id, token_id, token_type, granted_at` | Insert-only join between a token and a granted suggestion. One row consumes one unit of `tokens.used`. |
| `suggestions` | `id, opportunity_id, status, rank, data, updated_at` | `status` drives staleness — see below. |

```bash
# $POSTGREST already set from the Target environment table above
TOKEN=$(mysticat auth token --env "$ENV_FLAG")

# Current token state for a site
curl -s "$POSTGREST/tokens?select=*&site_id=eq.<siteId>" -H "Authorization: Bearer $TOKEN"

# Grants currently tied to a specific token
curl -s "$POSTGREST/suggestion_grants?select=*&token_id=eq.<tokenId>" -H "Authorization: Bearer $TOKEN"

# Status/rank/data of the granted suggestions (cross-check "best" claims — see Gotchas)
curl -s "$POSTGREST/suggestions?select=id,status,rank,data,updated_at&id=in.(<id1>,<id2>,...)" -H "Authorization: Bearer $TOKEN"
```

Use the `query-opportunities` skill's `fetch_opportunities.py` /
`fetch_suggestions.py` to find the opportunity ID(s) and full suggestion set
for a site + type first (e.g. `type=eq.broken-backlinks`), before querying
`suggestion_grants`/`tokens` directly.

## The actual mechanism (what the trigger call does)

`grantSuggestionsForOpportunity(dataAccess, site, opportunity)` runs
server-side, called from `opportunities.js` `getByID` (and from a couple of
spots in `suggestions.js`), only when the opportunity's own status is still
`NEW`:

1. **Revoke stale grants.** If any currently-granted suggestion for this
   site+token has gone `OUTDATED` / `REJECTED` / `PENDING_VALIDATION`,
   revokes *all* revocable grants for that token (which also includes plain
   `NEW`, so a full stale-triggered refresh can reshuffle even
   still-`NEW` grants) via `SuggestionGrant.revokeSuggestionGrant()`
   (RPC `wrpc_revoke_suggestion_grant`). If nothing is stale, this step is a
   no-op — existing grants are left untouched, even if a "better" `NEW`
   suggestion has since appeared.
2. **Fill remaining capacity** from ungranted `NEW` suggestions, ranked by a
   per-opportunity-type strategy in `OPPORTUNITY_STRATEGIES`
   (`grant-suggestions-handler.js`):
   - `broken-backlinks` — groups suggestions by `data.url_to`; a group's
     priority is the **max of the suggestions' `rank` DB column** among its
     items (not `data.traffic_domain` directly — see Gotchas); highest-rank
     group granted first.
   - `alt-text` — excludes any suggestion where
     `data.recommendations[].isDecorative === true`; remaining suggestions
     use the default ascending-`rank` order (lower `rank` = higher
     priority).
   - `cwv` — top 3 suggestions by `data.pageviews`, then ranked by `rank`
     (confidence) descending.
   - Any other opportunity type — default: one group per suggestion, sorted
     ascending by `rank`.
3. If the token is already full (`used == total`) and nothing was stale,
   the whole call is a safe no-op.

There's also a manual single-grant revoke, unrelated to the auto-refresh
above: `DELETE /sites/:siteId/suggestions/grants/:grantId`
(`suggestionsController.revokeGrant`, capability `CAP_SUGGESTION_WRITE`),
and a listing endpoint `GET /sites/:siteId/tokens/:tokenId/grants`
(`tokensController.getGrants`).

## Steps

1. **Confirm target with the user**: environment (`dev`/`stage`/`prod` — see
   above), site (ID or URL), opportunity type(s) (`broken-backlinks`,
   `alt-text`, `cwv`, ...), and what outcome they expect (just inspect?
   force a refresh?). Don't skip this even if a similar request ran earlier
   in the session for a different site or env.
2. **Check the PLG precondition** (entitlement tier, above). If it's not
   `PLG`, say so up front — the trigger call will "succeed" but do nothing.
3. **Find the opportunity ID(s)** via `query-opportunities` skill
   (`fetch_opportunities.py --env <env> --filters site_id=eq.<siteId>
   type=eq.<type>`).
4. **Inspect current state before mutating** — pull `tokens` for the site,
   `suggestion_grants` for the relevant token(s), and the full `suggestions`
   data for both the currently-granted ones and all `NEW` ones for the
   opportunity. This is what tells you whether a trigger call will actually
   *do* anything (any stale grants? any remaining capacity?). Skip this step
   for `stage` — no PostgREST instance to query (see caveat above).
5. **Trigger the refresh**:
   ```bash
   TOKEN=$(mysticat auth token --env "$ENV_FLAG")
   curl -s -w "\nHTTP_STATUS:%{http_code}\n" --request GET \
     --url "$APP_API/sites/<siteId>/opportunities/<opportunityId>" \
     --header "authorization: Bearer ${TOKEN}" \
     --header 'accept: */*' \
     --header 'x-client-type: sites-optimizer-ui'
   ```
   A `200` here does **not** by itself mean anything changed — the grant
   handler runs in a `try/catch` inside the controller and only logs a
   warning on failure (`ctx.log?.warn?.('Grant suggestions handler failed'
   ...)`); the opportunity JSON response gives no signal either way.
6. **Verify by re-querying** `tokens` (did `used`/`updated_at` change?) and
   `suggestion_grants` for that token (are the suggestion IDs different?).
   Cross-check the newly-granted suggestion IDs against the ranking
   strategy for that opportunity type yourself — don't just trust that
   "granted" means "best" (see Gotchas). For `stage`, you can't do this
   step — say so instead of guessing at the outcome.
7. **Content-quality check on what actually got granted** — "granted" only
   means "won the priority ranking," it says nothing about whether the
   proposed fix itself is good. The ranking strategies in
   `grant-suggestions-handler.js` never look at content quality, only
   `rank`/`traffic_domain`/`pageviews`. For each newly-granted suggestion:
   - **`broken-backlinks`**: take `data.urlsSuggested[0]` (the top
     candidate) and fetch it (`WebFetch` or open it in the browser). Confirm
     it's live (200, not 404/redirect-loop) **and** that its content
     plausibly matches the broken URL's original intent — cross-reference
     `data.title` / `data.aiRationale` for what the broken page was likely
     about. Two additional failure modes to check beyond a dead URL:
     - **Stale content**: a 200 that displays "this promotion has ended",
       "page no longer available", or similar expired-content signals is a
       bad redirect even though the URL resolves. Check if a live parent
       section page exists and prefer that instead.
     - **Generic fallback**: if `urlsSuggested[0]` is the site homepage or
       a catch-all page (e.g. `/member-support`), the AI couldn't find a
       specific match. Check `data.title` / `data.aiRationale` for the
       original topic, then search the site's `/sitemap.xml` to find a
       topically-specific live page — almost always a better grant than the
       homepage. If `urlsSuggested` has multiple entries, check them all
       before settling on the homepage.
     If none of `urlsSuggested` has a good destination and the broken URL
     references a **discontinued product or feature** with no equivalent
     anywhere in the sitemap, recommend **lowering this suggestion's
     `rank`** so better suggestions consume the token quota first — an
     unavoidable homepage redirect wastes a token slot that could serve a
     real fix.
   - **`alt-text`**: for each `data.recommendations[]` entry, download
     `data.recommendations[].imageUrl` to the scratchpad (`curl -sL
     <imageUrl> -o <scratchpad>/img.png` — the `Read` tool only opens local
     paths, it can't fetch a remote URL directly) and **view it with
     `Read`**, which renders images directly. Judge the proposed `altText`
     against what's actually visible — not just "some text is present."
     Flag generic/lazy captions (e.g. "image", "photo", the filename
     verbatim, keyword-stuffed text unrelated to the visible content) and
     outright mismatches (alt text describes a different subject than the
     image shows). Also check `isDecorativeByAgent` alongside `isDecorative`
     — see Gotchas; a suggestion can have `isDecorative: false` (so the
     grant filter lets it through) while `isDecorativeByAgent: true` (a
     secondary AI check already flagged it as probably not needing
     meaningful alt text at all) — worth surfacing even though nothing in
     the grant/revoke code looks at that field.
   - Report specific findings (URL live/dead, caption accurate/wrong), not
     just "looks fine" — this is exactly the kind of check the automated
     ranking can't do.
8. **Report precisely**: environment used, what was already there, what
   changed (or didn't, and why — no stale grants / token already full /
   tier not PLG), any ranking anomalies you found, and the content-quality
   verdict from step 7. Don't just say "done."

## Gotchas (hard-won this session)

- **`rank` drives grant priority for `broken-backlinks`, not
  `data.traffic_domain`.** They're supposed to match (the audit worker is
  meant to populate `rank` with the authority score), and usually do — but
  a freshly-audited batch can have `rank` populated sequentially (`0, 1,
  2, ...`) instead. When that happens, the two highest-authority backlinks
  can lose out to lower-authority ones purely because of `rank`
  mispopulation upstream, even though the grant handler is behaving exactly
  as coded. Always compare `rank` vs `data.traffic_domain` across all `NEW`
  suggestions for the opportunity before declaring a grant result correct.
- **`view=minimal` on suggestions hides real data — don't use it to judge
  completeness.** `SuggestionDto.toJSON()` (`src/dto/suggestion.js`) applies
  a schema-driven minimal projection
  (`suggestion.data-schemas.js` in `@adobe/spacecat-shared-data-access`).
  For `broken-backlinks` specifically, the minimal projection's field list
  is `['url_from', 'url_to', 'urlFrom', 'urlTo']` — it drops `urlsSuggested`,
  `aiRationale`, `title`, and `traffic_domain` even though the Joi schema
  for that type defines them and the data has them. A suggestion that looks
  "incomplete" through a minimal-view API response may have full data
  underneath — always cross-check via a direct PostgREST `suggestions`
  query (full row) or `view=full` before concluding data is actually
  missing. (This is an open bug in `spacecat-shared`'s
  `suggestion.data-schemas.js`, not yet fixed.)
- **"Granted" ≠ "content is good."** The ranking strategies only compare
  `rank` / `traffic_domain` / `pageviews` — none of them evaluate whether
  the proposed fix actually makes sense. A suggestion can win the priority
  ranking and still be a bad grant: the top `broken-backlinks` candidate
  URL can 404 or be unrelated to the original page's topic; an `alt-text`
  caption can be generic ("image", the filename, boilerplate) or describe
  something other than what the image actually shows. Always do the
  content-quality check (Steps, step 7) — don't equate "the algorithm
  picked it" with "it's a good suggestion."
- **`alt-text`'s decorative filter only checks `isDecorative`, not
  `isDecorativeByAgent`.** The `alt-text` `groupFn` in
  `grant-suggestions-handler.js` excludes a suggestion only when
  `data.recommendations[].isDecorative === true`. Real production data
  (virginaustralia.com) shows a second, independent field,
  `isDecorativeByAgent`, that can be `true` while `isDecorative` stays
  `false` — meaning a secondary AI check already flagged an image as
  probably decorative, but the grant filter never looks at that field and
  lets it through anyway. Observed outcome: 2 of a site's 3 monthly
  alt-text token slots went to tiny UI icons (a ~1KB airplane icon, a ~1KB
  timezone icon) that `isDecorativeByAgent` had flagged, while a real
  content image (a banner photo, already `isManuallyEdited: true`) got the
  third slot. Not itself a bug in the grant mechanism (it does exactly what
  its filter says), but worth flagging when reporting alt-text grant
  results — the filter is incomplete relative to signals the data already
  carries.
- **No stale grant + full token capacity = the trigger is a correct no-op.**
  Don't interpret an unchanged `tokens.used`/`suggestion_grants` after the
  trigger call as a failure — check whether any currently-granted
  suggestion is actually `OUTDATED`/`REJECTED`/`PENDING_VALIDATION` first.
- **PLG tier gates everything.** A non-PLG site (e.g. `PAID` or
  `FREE_TRIAL` tier, or missing `x-client-type` header) will return a normal
  `200` from the trigger call with zero side effects. Always check the
  entitlement before running this, and say clearly when that's why nothing
  happened.

## Related

- `plg-onboard` skill — provisioning a PLG site in the first place; same
  admin credential and safety-gate philosophy.
- `query-sites` / `query-opportunities` skills — read-only lookups this
  skill leans on for site, entitlement, opportunity, and suggestion data.
