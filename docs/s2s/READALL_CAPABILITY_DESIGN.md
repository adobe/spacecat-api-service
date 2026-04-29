# S2S `readAll` Capability — Solution Design

## Problem Statement

S2S consumers (e.g., dashboard services, opportunity creators) are increasingly built around a
"run for every site in an org" pattern. These services have no prior knowledge of site base URLs
or IMS org IDs — they need to discover them first. The current admin-gated endpoints (`GET /sites`,
`GET /organizations`) are inaccessible to S2S consumers because they require `hasAdminAccess()`,
which evaluates to `false` for any S2S token.

The goal is to open read-all access to these endpoints for S2S consumers that explicitly need it,
without diluting tenant isolation or weakening the existing admin gate for human/API-key callers.

---

## Non-Goals

- This does not grant S2S consumers write, delete, or any mutation capability.
- This does not bypass tenant isolation for site-scoped or org-scoped operations — those retain
  their existing `hasAccess(entity)` checks.
- This does not implicitly grant `readAll` to any consumer that has `site:read` or
  `organization:read`. Existing capabilities are unaffected.
- This does not apply to any endpoint other than the specific admin-gated list endpoints that
  explicitly opt in.
- Entitlement, enrollment, and delegation checks are unchanged for all other endpoints.

---

## Proposed Solution

### New Capability Action: `readAll`

Add `readAll` to the `Consumer.CAPABILITIES` allowlist in `spacecat-shared-data-access`. This
makes `site:readAll` and `organization:readAll` (and any future `entity:readAll`) valid capability
strings that pass `ConsumerCollection.validateCapabilities()`.

```
Current: Consumer.CAPABILITIES = ['read', 'write', 'delete']
Proposed: Consumer.CAPABILITIES = ['read', 'write', 'delete', 'readAll']
```

This is the only change required in the shared library.

### Route-to-Capability Remapping

The admin-gated list endpoints are remapped to require `readAll` instead of `read`:

| Route | Current Capability | Proposed Capability |
|---|---|---|
| `GET /sites` | `site:read` | `site:readAll` |
| `GET /organizations` | `organization:read` | `organization:readAll` |

`GET /sites/:siteId` and `GET /organizations/:organizationId` remain on `site:read` and
`organization:read` respectively — tenant-scoped reads are unaffected.

### Explicit Controller Opt-In

Each admin-gated list endpoint explicitly opts in to allow S2S consumers with the appropriate
`readAll` capability. This is not implicit — a consumer having `readAll` in the capability list
is not enough on its own; the specific endpoint must also permit it.

A new `async hasS2SCapability(capability)` method is added to `AccessControlUtil`. It uses
`context.s2sConsumer` (set by the s2sAuthWrapper) only as an identity source — extracting
`clientId` and `imsOrgId` — then performs its own independent DB fetch. It does not call
`context.s2sConsumer.getCapabilities()` or trust any capability data already in context:

```javascript
async hasS2SCapability(capability) {
  const s2sConsumer = this.context.s2sConsumer;
  if (!s2sConsumer) return false;

  // Re-fetch from DB using identity — capabilities must come from a fresh read
  const fresh = await this.context.dataAccess.Consumer.findByClientIdAndImsOrgId(
    s2sConsumer.getClientId(),
    s2sConsumer.getImsOrgId(),
  );
  if (!fresh || fresh.isRevoked() || fresh.getStatus() !== 'ACTIVE') return false;

  return fresh.getCapabilities()?.includes(capability) === true;
}
```

Controller gate pattern:

```javascript
// Before (admin-only)
if (!accessControlUtil.hasAdminAccess()) {
  return forbidden('Only admins can view all sites');
}

// After (admin OR S2S consumer with explicit readAll capability)
if (!accessControlUtil.hasAdminAccess() && !await accessControlUtil.hasS2SCapability('site:readAll')) {
  return forbidden('Only admins can view all sites');
}
```

The `hasAdminAccess()` path is completely unchanged — human admins and API key consumers are
unaffected.

---

## Two-Layer Validation

Every S2S `readAll` request passes through two independent checks before data is returned.
Both must pass.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Incoming Request                             │
│              Authorization: Bearer <s2s-jwt>                        │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Layer 1: s2sAuthWrapper                          │
│                                                                     │
│  1. Validate JWT signature (public key)                             │
│  2. Check is_s2s_consumer claim                                     │
│  3. Fetch Consumer from DB (clientId + imsOrgId)                    │
│  4. Verify consumer.status = ACTIVE, not revoked                    │
│  5. Resolve route → required capability = 'site:readAll'            │
│  6. Check consumer.getCapabilities().includes('site:readAll')       │
│                                                                     │
│  ✗ Any check fails → 403 Forbidden (request never reaches handler) │
│  ✓ All pass → context.s2sConsumer = consumer, continue             │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Layer 2: Controller Gate                         │
│                  (explicit endpoint opt-in)                         │
│                                                                     │
│  accessControlUtil.hasAdminAccess()   → false (S2S token)          │
│  accessControlUtil.hasS2SCapability(  → independent DB fetch:      │
│    'site:readAll')                       identity from             │
│                                          context.s2sConsumer       │
│                                          .getClientId/ImsOrgId()  │
│                                          → Consumer.findBy...()   │
│                                          → re-check status +       │
│                                            revocation              │
│                                          → check capabilities      │
│                                                                     │
│  ✗ Both false → 403 Forbidden                                       │
│  ✓ Either true → proceed to data fetch                             │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
              Fetch all sites / organizations
              Map through DTO (no raw models exposed)
              Return 200 OK
```

The wrapper check (Layer 1) and the controller check (Layer 2) are genuinely independent —
Layer 2 derives consumer identity from `authInfo.getProfile()` (JWT claims) and issues its
own `Consumer.findByClientIdAndImsOrgId()` query. It does not read from `context.s2sConsumer`
or any other context state set by Layer 1. A consumer revoked between the two checks is caught
at Layer 2. A new list endpoint that forgets the controller check remains admin-only by default.

---

## Security Analysis

### Tenant Isolation Is Preserved

`readAll` grants visibility into the list of entities. It does not grant access to any
site-scoped or org-scoped operation. Any subsequent call on a specific site or org (read,
write, audit, opportunity, etc.) goes through the standard `hasAccess(entity)` path, which
validates org membership, delegation grants, and entitlements.

A consumer with `site:readAll` can see that `site-xyz` exists. It cannot read that site's
audits, opportunities, or configuration without also having `site:read` and passing the
tenant-scoped access check for that specific site.

### No Capability Inheritance

`site:readAll` and `site:read` are independent strings. Having `site:read` does not imply
`readAll`. A consumer is granted only the capabilities explicitly registered in its record.
`ConsumerCollection.validateCapabilities()` enforces the allowlist at create and save time,
so no capability can be injected via token claims or runtime mutation without a DB write.

### Database as Source of Truth — Both Layers

Both Layer 1 (wrapper) and Layer 2 (controller) independently fetch the consumer record from the
database. Layer 2 derives identity from `authInfo.getProfile()` JWT claims and calls
`Consumer.findByClientIdAndImsOrgId()` directly — it does not read capabilities from
`context.s2sConsumer` or any in-memory state set by the wrapper.

This means:
- A consumer revoked between the two checks is caught at Layer 2.
- There is no path where a forged or replayed token bypasses the capability check — capabilities
  are resolved from DB on both passes.
- No trust is placed on context state across middleware boundaries.

### Deny-by-Default for Unmapped Routes

The `s2sAuthWrapper` denies any route not present in `routeRequiredCapabilities`. A new
admin-gated endpoint that is not added to the capability map is automatically inaccessible
to S2S consumers — the deny-by-default posture is unchanged.

### Explicit Endpoint Opt-In Prevents Accidental Exposure

Even if `routeCapabilities` were misconfigured to map a sensitive endpoint to `readAll`,
the controller gate would still reject the request unless the endpoint explicitly calls
`hasS2SCapability('...:readAll')`. The two layers must both permit access independently.

---

## Changes Required

### `spacecat-shared-data-access`

**`packages/spacecat-shared-data-access/src/models/consumer/consumer.model.js`**
```javascript
// Add 'readAll' to the CAPABILITIES allowlist
static CAPABILITIES = ['read', 'write', 'delete', 'readAll'];
```

No schema changes required — capabilities are stored as a string array; `readAll` is just
a new valid action string.

---

### `spacecat-api-service`

**`src/support/access-control-util.js`** — add one method:
```javascript
/**
 * Independently verifies that the requesting S2S consumer holds the given capability
 * by issuing a fresh DB fetch. Uses context.s2sConsumer only for identity (clientId +
 * imsOrgId) — does NOT call context.s2sConsumer.getCapabilities().
 * @param {string} capability - e.g. 'site:readAll'
 * @returns {Promise<boolean>}
 */
async hasS2SCapability(capability) {
  const s2sConsumer = this.context.s2sConsumer;
  if (!s2sConsumer) return false;

  const fresh = await this.context.dataAccess.Consumer.findByClientIdAndImsOrgId(
    s2sConsumer.getClientId(),
    s2sConsumer.getImsOrgId(),
  );
  if (!fresh || fresh.isRevoked() || fresh.getStatus() !== 'ACTIVE') return false;

  return fresh.getCapabilities()?.includes(capability) === true;
}
```

**`src/routes/required-capabilities.js`** — remap list endpoints:
```javascript
'GET /sites': 'site:readAll',                  // was 'site:read'
'GET /organizations': 'organization:readAll',   // was 'organization:read'
```

**`src/controllers/sites.js`** — update `getAll()` gate:
```javascript
if (!accessControlUtil.hasAdminAccess() && !await accessControlUtil.hasS2SCapability('site:readAll')) {
  return forbidden('Only admins can view all sites');
}
```

**`src/controllers/organizations.js`** — update `getAll()` gate:
```javascript
if (!accessControlUtil.hasAdminAccess() && !await accessControlUtil.hasS2SCapability('organization:readAll')) {
  return forbidden('Only admins can view all organizations');
}
```

---

## Consumer Registration

To grant a service `readAll` access, its Consumer record must be created or updated with the
required capabilities:

```json
{
  "clientId": "my-dashboard-service",
  "imsOrgId": "ABCDEF1234567890@AdobeOrg",
  "consumerName": "Dashboard Service",
  "capabilities": ["site:readAll", "organization:readAll"]
}
```

The `site:read` and `organization:read` capabilities are NOT required alongside `readAll` —
they serve different routes (`/sites/:siteId` vs `/sites`). A service that only needs to
enumerate all sites and then call individual site APIs would hold:
- `site:readAll` — for `GET /sites`
- `site:read` — for `GET /sites/:siteId`

---

## Consumer Discovery Flow

This capability is specifically designed for services that have no prior knowledge of site base
URLs or IMS org IDs — they need to discover them before they can operate. The intended flow is:

### Step 1 — Mint a token using the SpaceCat internal org

S2S tokens are signed with a `client_id` + `imsOrgId` pair. A service that hasn't yet discovered
any customer org can use the SpaceCat platform internal org to mint its initial token:

| Environment | Internal imsOrgId |
|---|---|
| Production | `908936ED5D35CC220A495CD4@AdobeOrg` |
| Dev / Stage | `8C6043F15F43B6390A49401A@AdobeOrg` |

The Consumer record for the service is registered against this internal org and granted
`site:readAll` and/or `organization:readAll`.

### Step 2 — Discover sites / organizations

Using the token from Step 1, call the list endpoints:

```
GET /sites           → returns all sites (DTO, no sensitive internals)
GET /organizations   → returns all organizations
```

The service now has the site IDs, base URLs, and IMS org IDs it needs to scope further operations.

### Step 3 — Mint a scoped token for the target site / org

With a known `imsOrgId` for the target customer, the service mints a scoped S2S token for that
org and uses it for all subsequent operations (`GET /sites/:siteId`, audit reads, opportunity
writes, etc.). Those calls go through the standard tenant-scoped `hasAccess(entity)` checks.

### Flow Summary

```
Service (no prior context)
        │
        ▼
[1] Mint token with internal org
    (Prod: 908936ED5D35CC220A495CD4@AdobeOrg)
    (Dev:  8C6043F15F43B6390A49401A@AdobeOrg)
        │
        ▼
[2] GET /sites  or  GET /organizations
    → s2sAuthWrapper validates token + site:readAll capability
    → controller gate: hasS2SCapability('site:readAll') → fresh DB fetch
    → returns full site/org list
        │
        ▼
[3] Mint scoped token for target imsOrgId
        │
        ▼
[4] Operate on specific site/org
    GET /sites/:siteId, POST /audits, etc.
    → standard tenant-scoped hasAccess() checks apply
```

This keeps the discovery step explicit and auditable — the internal-org token is used only
for enumeration; all write and site-scoped operations require a customer-org-scoped token.

---

## What Does Not Change

- Human admin flows (`hasAdminAccess()`) — completely unaffected.
- API key consumers — `hasAdminAccess()` returns `true` for them already; they retain access
  to `GET /sites` and `GET /organizations` without any capability.
- All site-scoped and org-scoped endpoints — no changes to their gating or the `hasAccess()` path.
- All write, delete, and mutating endpoints — these are not in scope for `readAll`.
- The internal routes exclusion list — entries there remain blocked for S2S regardless.
- Consumer revocation, status checks, and DB-backed capability resolution — all unchanged.

---

## Future Extension

The `readAll` action is generic. When another entity's list endpoint needs to open to S2S
consumers, the pattern is:

1. Remap `GET /<entity>` to `<entity>:readAll` in `required-capabilities.js`.
2. Add `hasS2SCapability('<entity>:readAll')` check to the controller's list gate.
3. Grant the consuming service `<entity>:readAll` in its Consumer record.

No further changes to the shared library or wrapper are needed.
