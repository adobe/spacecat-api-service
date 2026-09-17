# Accessing Semrush Data via Serenity APIs (S2S)

This guide shows an S2S consumer how to read Semrush-sourced Brand Presence data through the Serenity/Elements API routes (`/v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/*`), end to end: minting credentials, exchanging them for a customer-scoped session token, and calling the API.

For the generic S2S registration/authentication mechanics (requesting an account, capability approval, token lifetimes, troubleshooting), see the [S2S Consumer Integration Guide](CONSUMER_INTEGRATION_GUIDE.md) — this doc only covers what's specific to the Serenity/Elements routes.

---

## Prerequisites

- An S2S consumer registered per the [Consumer Integration Guide](CONSUMER_INTEGRATION_GUIDE.md), with the **`brand:read`** capability granted (all 21 `brand-presence/*` routes require it — see `src/routes/required-capabilities.js`).
- Since these routes are LLMO routes, mint your session token via the **LLMO host** (`llmo.experiencecloud.live` in production, `llmo.experiencecloud.page` in dev/CI) — see the "Host-driven product context" note in the Consumer Integration Guide. Using the wrong host mints a session token scoped to the wrong product and the API call will fail its entitlement check even with a valid capability grant.
- The target customer's IMS org ID (e.g. `899D173E60B73D8B0A495C0A@AdobeOrg` for Lovesac).
- The SpaceCat `spaceCatId` (organization UUID) and `brandId` (brand UUID) for that customer — these are SpaceCat's own identifiers, not IMS org IDs; resolve them via `GET /organizations/by-ims-org-id/:imsOrgId` and `GET /organizations/:organizationId/brands` if you don't already have them.

---

## Step 1: Generate an IMS access token

Exchange your S2S consumer's Client ID/Secret for a 24h IMS access token:

```bash
curl --request POST \
  --url https://ims-na1.adobelogin.com/ims/token/v3 \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data grant_type=client_credentials \
  --data client_id=<S2S consumer clientId> \
  --data client_secret=<S2S consumer client secret> \
  --data 'scope=openid,AdobeID,user_management_sdk'
```

## Step 2: Exchange the IMS token for a customer-scoped SpaceCat session token

Call the LLMO S2S login endpoint, naming the target customer's IMS org. This mints a short-lived (15 min) JWT whose `tenants` claim names that org — this is what actually authorizes the subsequent API calls (see [How authorization works](#how-authorization-works) below).

```bash
curl --request POST \
  --url https://llmo.experiencecloud.live/api/v1/auth/s2s/login \
  --header 'Authorization: Bearer <S2S client access token of step 1>' \
  --header 'Content-Type: application/json' \
  --data '{
    "imsOrgId": "899D173E60B73D8B0A495C0A@AdobeOrg"
  }'
```

## Step 3: Call the Serenity/Elements API with the session token

```bash
curl --request GET \
  --url 'https://llmo.experiencecloud.live/v2/orgs/e07a0aae-b794-41f6-9622-a602203c5a3e/brands/cb84e91a-f7e9-488b-8220-e0d031941cd7/serenity/brand-presence/market-tracking-trends?startDate=2026-08-31&endDate=2026-09-06&platform=search-gpt' \
  --header 'accept: application/json' \
  --header 'authorization: Bearer <S2S client session token of step 2>'
```

Any of the 21 `brand-presence/*` routes can be called the same way once you have the session token — see the [Semrush Elements API reference](../elements/semrush-elements-api-reference.md) for the full route list and response shapes.

**Note — `prompts-by-url` uses a different capability split.** Two additional routes also proxy to Semrush, but only conditionally (see the [S2S Elements Access](../elements/semrush-elements-api-reference.md#s2s-elements-access) section): `GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/prompts-by-url` requires `brand:read`, but the `brands/all` variant (`GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/prompts-by-url`, org-wide/cross-brand data) requires `organization:read` instead — a consumer holding only `brand:read` cannot call the `all` variant.

---

## How authorization works

There is **no dedicated "read all customers" capability** for these routes — a consumer's access is exactly whatever its session token's `tenants` claim says, request by request:

1. **Route entry** (`s2sAuthWrapper`) checks your consumer's registered `capabilities` array includes `brand:read`.
2. **Per-organization access** (`accessControl.hasAccess(organization)`) checks that the target `:spaceCatId`'s IMS org ID appears in your session token's `tenants` claim — the same check a human session-token user goes through. This is why Step 2 (naming the customer's `imsOrgId`) is required before Step 3 — a session token minted for one customer cannot read another customer's data, regardless of your consumer's `brand:read` grant.
3. Each successful or denied S2S read is logged server-side (`[s2s] ... granted ...` / `[acl] Denied ... reason=no-org-access ...`) for audit purposes.

Because the session token is customer-scoped and short-lived (15 min), you'll repeat Step 2 for each customer org you need to read, and refresh it before expiry for long-running jobs.

## Upstream call shape (informational)

Server-side, these routes proxy to Semrush's Elements API. For S2S callers specifically, the server uses a different upstream gateway (`Apikey` auth, no forwarded IMS token) than it does for human/IMS callers — this is transparent to you as a consumer; you only ever need the session token from Step 2. See the [S2S Elements Access](../elements/semrush-elements-api-reference.md#s2s-elements-access) section of the Elements API reference if you need the implementation details.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401` on Step 3 | Session token expired (15 min lifetime) — repeat Step 2 |
| `403` with `reason=no-org-access` in server logs | The session token's `tenants` claim doesn't name the org you're requesting — re-run Step 2 with the correct `imsOrgId`, or confirm you minted the token via the correct product host |
| `403` at the route-entry layer | Your consumer's registered capabilities don't include `brand:read` — request it via the [Consumer Integration Guide](CONSUMER_INTEGRATION_GUIDE.md#request-s2s-account) |
| `404` on the organization/brand | `spaceCatId`/`brandId` are SpaceCat UUIDs, not IMS org IDs — resolve them first via `GET /organizations/by-ims-org-id/:imsOrgId` |

---

**Document Owner**: S2S Admin Team
**Target Audience**: Consumer Service Teams integrating with Semrush/Serenity data
