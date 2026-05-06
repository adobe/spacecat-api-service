# S2S `readAll` Capability — Solution Design

## Problem Statement

A small set of platform-level S2S consumers — telemetry rollups, dashboarding services, the
opportunity-creation pipeline that runs continuously across the SpaceCat estate — need to
enumerate sites and organizations across tenants because they have no a-priori list of which
customers exist. They are not running on behalf of a single customer; they are running on
behalf of the platform itself.

Today, `GET /sites` and `GET /organizations` are gated by `hasAdminAccess()`, which returns
`false` for any S2S token regardless of capabilities. That gate was right for human-admin and
legacy API-key callers; it is too coarse for the S2S model where capabilities are explicit and
DB-backed.

This design opens those two endpoints to S2S consumers that hold an explicitly granted `readAll`
capability, while preserving every existing isolation invariant for tenant-scoped operations.

> **Why not org-scoped list endpoints?** `GET /organizations/:orgId/sites` already exists and
> is the right answer when the caller already knows the org. The use case here is the inverse:
> the caller does not yet know which orgs exist (or which sites belong to them) and cannot
> bootstrap from an org-scoped endpoint. This is platform-wide enumeration by design, and the
> security posture is treated accordingly throughout this document.

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
- This does not change the auth-service token-minting contract. `readAll` is enforced at the
  SpaceCat API layer; minting authority remains with the auth-service.

---

## Prerequisites

The security argument below assumes the following invariants are upheld by the S2S
authentication framework. Any deviation invalidates the analysis.

| Claim | Required Validation |
|---|---|
| `iss` | Must match the trusted SpaceCat S2S issuer. |
| `aud` | Must match the SpaceCat API audience. (Tracked separately — known gap per RFC 7519 §4.1.3 / RFC 8725 §3.11.) |
| `exp` | Must not be in the past. |
| `nbf` | Must not be in the future (when present). |
| `iat` | Sanity check; not load-bearing. |
| `is_s2s_consumer` | Must be `true` for the wrapper to engage S2S validation. |
| `client_id` | Must be present and non-empty. |
| `org` | Must be present, non-empty, and resolvable to an active Consumer record. |

> **Action item**: `aud` claim verification is a known gap in the current S2S validation path.
> This design does not depend on `aud` being verified, but a Consumer minted under a different
> intended audience could be reused against this API if the gap remains. Hardening `aud`
> verification is out of scope for this design but listed here as a load-bearing prerequisite.

---

## Proposed Solution

### New Capability Action: `readAll`

Add `readAll` to the `Consumer.CAPABILITIES` allowlist in `spacecat-shared-data-access`. This
makes `site:readAll` and `organization:readAll` (and any future `entity:readAll`) valid capability
strings that pass `ConsumerCollection.validateCapabilities()`.

```
Current:  Consumer.CAPABILITIES = ['read', 'write', 'delete']
Proposed: Consumer.CAPABILITIES = ['read', 'write', 'delete', 'readAll']
```

This is the only change required in the shared library.

### Capability Model Trade-offs

The current capability DSL is `entity:action`, where action is a verb (`read`, `write`,
`delete`). `readAll` is not a new verb — it is `read` plus a scope qualifier ("all tenants" vs
"the entity I have access to"). Adding it to the verb list conflates action and scope.

`ConsumerCollection.#getValidCapabilities()` flat-maps `entityNames × CAPABILITIES`, so adding
`readAll` immediately makes `audit:readAll`, `opportunity:readAll`, `apiKey:readAll`, and every
other `<entity>:readAll` schema-valid — even though only `site:readAll` and `organization:readAll`
are intended targets. Schema validity does **not** mean reachable: a route must be remapped and
a controller must opt in. The protection lives in routing and controllers, not in the schema.

#### Alternatives Considered

| Option | Sketch | Why not for v1 |
|---|---|---|
| `entity:list` | New verb specifically for cross-tenant list operations. | Cleaner semantically, but still expands the verb list without solving the schema-namespace problem. Defers the scope-vs-action problem rather than naming it. |
| `entity:read:all` | Three-segment capability with explicit scope segment. | Requires a parser change in `ConsumerCollection`, breaks string-includes checks, and changes the wrapper contract. Larger blast radius for a v1 feature. |
| Separate `scope` field on Consumer | Capability remains `entity:action`; a parallel `scope: ['cross-tenant']` array gates list ops. | Cleanest long-term, but introduces a second allowlist and a second validation layer. Likely the right answer if the policy surface grows beyond this one feature. |
| `entity:readAll` (chosen) | Single capability string. | Smallest possible diff. The conflation is real but contained — explicitly documented here, contained to two endpoints in v1, and the "If 5+ entities adopt this pattern" off-ramp below names the threshold for revisiting. |

If 5+ entities adopt the `readAll` pattern, or if any non-read action grows a similar
"all-tenants" variant (e.g., `writeAll`), the right move is a policy engine (Cedar, OpenFGA,
OPA) — not more `<verb>All` strings. That threshold is the trigger to revisit this trade-off.

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
`context.s2sConsumer` (set by the s2sAuthWrapper) only to extract identity (`clientId`,
`imsOrgId`) and then issues an independent DB fetch for capabilities. It does **not** call
`context.s2sConsumer.getCapabilities()` — capability data must come from a fresh read:

```javascript
/**
 * Verifies the requesting S2S consumer holds the given capability by issuing a fresh
 * DB fetch. Uses context.s2sConsumer only for identity (clientId + imsOrgId).
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

Controller gate pattern:

```javascript
// Before (admin-only)
if (!accessControlUtil.hasAdminAccess()) {
  return forbidden('Only admins can view all sites');
}

// After (admin OR S2S consumer with explicit readAll capability)
const isAdmin = accessControlUtil.hasAdminAccess();
const hasS2S = !isAdmin && await accessControlUtil.hasS2SCapability('site:readAll');
if (!isAdmin && !hasS2S) {
  log.info(`[acl] Denied list access — admin=${isAdmin} s2sCap=${hasS2S} path=${pathInfo.suffix}`);
  return forbidden('Forbidden');
}
```

The external response is a generic `Forbidden` to avoid leaking which auth path was attempted;
denial paths are distinguishable in logs for operational debugging. The `hasAdminAccess()` path
is unchanged — human admins and API-key consumers are unaffected.

To prevent the route-map and controller capability strings from drifting, expose a single
constant and import it from both sites:

```javascript
// src/routes/capability-constants.js
export const CAP_SITE_READ_ALL = 'site:readAll';
export const CAP_ORG_READ_ALL  = 'organization:readAll';
```

A coverage test asserts that every controller-checked capability is present in
`routeRequiredCapabilities` and vice versa — the two maps cannot drift silently.

---

## Two-Layer Validation

Every S2S `readAll` request passes through two checks before data is returned. Both must pass.

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
│  1. Validate JWT signature + Prerequisites contract above           │
│  2. Check is_s2s_consumer claim                                     │
│  3. Fetch Consumer from DB (clientId + imsOrgId)                    │
│  4. Verify consumer.status = ACTIVE, not revoked                    │
│  5. Resolve route → required capability = 'site:readAll'            │
│  6. Check consumer.getCapabilities().includes('site:readAll')       │
│                                                                     │
│  ✗ Any check fails → 403 Forbidden (request never reaches handler)  │
│  ✓ All pass → context.s2sConsumer = consumer, continue              │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Layer 2: Controller Gate                         │
│                  (explicit endpoint opt-in)                         │
│                                                                     │
│  hasAdminAccess()   → false for S2S tokens (closes default gate)    │
│  hasS2SCapability(  → identity from context.s2sConsumer             │
│    'site:readAll')    capabilities from fresh DB fetch              │
│                                                                     │
│  ✗ Both false → 403 Forbidden (generic message, logged distinctly)  │
│  ✓ Either true → proceed to data fetch                              │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
              Fetch all sites / organizations
              Map through DTO (no raw models exposed)
              Audit-log the cross-tenant enumeration
              Return 200 OK
```

**The primary value of Layer 2 is fail-closed-by-default**, not revocation-race protection.
A controller that forgets to call `hasS2SCapability` keeps the existing admin-only behavior:
`hasAdminAccess()` returns `false` for S2S tokens, so without an explicit S2S branch the
endpoint is not reachable by S2S callers. New list endpoints inherit safe defaults; opening
them up to S2S is an affirmative act.

The capability re-fetch at Layer 2 also catches the (narrow) case where the wrapper-cached
consumer object diverged from DB state mid-request, but this is structural belt-and-suspenders,
not the primary justification.

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

### Trust Boundary at Discovery Step 3

The Consumer Discovery Flow (below) describes a service that uses an internal-org token to
enumerate sites/orgs and then mints a "scoped token" for a specific customer org to operate on
it. **The boundary that prevents this from being de-facto admin-of-everything is the per-org
Consumer record.**

Concretely, a token presented at the SpaceCat API has `client_id` and `org` claims. Layer 1 of
the wrapper does:

```javascript
Consumer.findByClientIdAndImsOrgId(clientId, orgId)
```

If no Consumer row exists for that pair, the request is rejected with 403 — regardless of
what the auth-service was willing to mint. The implication:

1. **Discovery alone confers no operational access.** A service holding a Consumer record
   against the SpaceCat internal org with `site:readAll` can list every customer's sites.
   It cannot read, audit, write to, or otherwise touch any of those sites unless a separate
   Consumer record exists for the `(clientId, customerOrgId)` pair with the appropriate
   capabilities.
2. **Per-org provisioning is the trust boundary.** To act on customer X, the service must be
   provisioned in the Consumer table with `(clientId, customerOrg-X-imsOrgId)`. Provisioning
   is an out-of-band administrative action; it is not implied by `readAll`.
3. **The auth-service minting policy is independent.** Whether the auth-service freely mints
   tokens for any `(clientId, org)` pair, or restricts minting to provisioned pairs, does
   not affect the SpaceCat tenant-isolation guarantee. The Consumer-record lookup at Layer 1
   is the enforcement point. (Hardening auth-service minting is still desirable as
   defense-in-depth, but it is not load-bearing for this design.)

If at any point the SpaceCat wrapper's Consumer-record lookup is removed or weakened, this
analysis no longer holds. That lookup is the load-bearing invariant.

### No Capability Inheritance

`site:readAll` and `site:read` are independent strings. Having `site:read` does not imply
`readAll`. A consumer is granted only the capabilities explicitly registered in its record.
`ConsumerCollection.validateCapabilities()` enforces the allowlist at create and save time,
so no capability can be injected via token claims or runtime mutation without a DB write.

### Database as Source of Truth — Both Layers

Both Layer 1 and Layer 2 resolve capabilities from the database, not from token claims.
Layer 1 fetches the Consumer record by `(clientId, orgId)` from the JWT and validates the
required route capability. Layer 2 takes that consumer's identity, issues a second
`Consumer.findByClientIdAndImsOrgId` call, and validates the required capability against the
freshly fetched record.

There is no path where a forged or stale capability claim grants elevated access — both
checks query DB, and the capabilities allowlist is validated server-side at Consumer
create/save time.

### Data Classification

`GET /sites` and `GET /organizations` expose customer-meaningful information across tenants.
The DTOs returned today include:

**`SiteDto`** (per item): `id`, `baseURL`, `gitHubURL` (if set), `deliveryType`,
`organizationId`, `isLive`, `isLiveToggledAt`, `createdAt`, `updatedAt`, plus selected config
fields. `baseURL` and the existence of the site itself are competitively meaningful — the fact
that customer X is on SpaceCat (and the URLs they have onboarded) is non-public information.

**`OrganizationDto`** (per item): `id`, `name`, `imsOrgId`, `config` (Slack channels, IMS
mappings), `fulfillableItems`, `createdAt`, `updatedAt`. Names and IMS org IDs of every
SpaceCat customer.

Implications:

1. **`readAll` is a sensitive grant.** Consumer records with `readAll` should be limited to
   services with a documented platform-level need; the grant is approved at the same level
   as administrative access, not as routine API access.
2. **Cross-tenant enumeration must be audit-logged.** Every successful Layer 2 pass on
   `GET /sites` or `GET /organizations` by an S2S consumer logs at minimum: `clientId`,
   resolved Consumer ID, capability used, response size, request ID. This log is reviewed
   periodically; unexpected new consumers or step-changes in volume are alerted.
3. **DTO field-level review is part of any future `readAll` rollout.** Adding a new field
   to `SiteDto` or `OrganizationDto` automatically widens what `readAll` exposes. The DTO
   change review must consider this surface explicitly.

### Deny-by-Default for Unmapped Routes

The `s2sAuthWrapper` denies any route not present in `routeRequiredCapabilities`. A new
admin-gated endpoint that is not added to the capability map is automatically inaccessible
to S2S consumers — the deny-by-default posture is unchanged.

### Fail-Closed Controller Gate

A controller that forgets to add the `hasS2SCapability` branch keeps the existing
admin-only behavior. `hasAdminAccess()` returns `false` for S2S tokens, so endpoints without
an explicit S2S branch are simply not reachable by S2S callers — they fall through to the
existing forbidden response. This is the structural property that makes opening a new
endpoint to S2S an affirmative action rather than an accidental one.

---

## Operational Bounds

`src/controllers/sites.js` already carries a TODO acknowledging that `GET /sites` lacks
pagination and could approach the AWS Lambda 6 MB response-size limit. Today, the only callers
are infrequent human admins; the new pattern (programmatic S2S consumers polling on cron
cadences) will hit this surface harder.

**Pagination is a precondition, not a follow-up.** The implementation rollout (see "Cross-Repo
Rollout Order") gates the route remap behind shipping cursor-based pagination on `GET /sites`
and `GET /organizations` first:

- `?limit=` (default 100, max 500) and `?cursor=` query parameters
- Response includes `nextCursor` when more results exist
- Hard cap on total results per request to keep payload below 4 MB headroom
- Clients are expected to iterate; no single-call "give me everything" path

Until pagination ships, the existing endpoints continue to require admin access; S2S `readAll`
is not enabled. This avoids opening a programmatic surface that the platform cannot bound.

Operational targets for the paginated endpoints:

| Concern | Target |
|---|---|
| p95 latency at limit=100 | < 500 ms |
| Maximum payload per page | 4 MB |
| Rate limit per Consumer | 60 rpm (initial; revisit after 30 days of telemetry) |
| Cross-tenant enumeration audit log retention | 90 days |

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

**`src/routes/capability-constants.js`** — single source of truth for capability strings:
```javascript
export const CAP_SITE_READ_ALL = 'site:readAll';
export const CAP_ORG_READ_ALL  = 'organization:readAll';
```

**`src/support/access-control-util.js`** — add one method:
```javascript
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

**`src/routes/required-capabilities.js`** — remap list endpoints (importing from constants):
```javascript
import { CAP_SITE_READ_ALL, CAP_ORG_READ_ALL } from './capability-constants.js';
// ...
'GET /sites': CAP_SITE_READ_ALL,                  // was 'site:read'
'GET /organizations': CAP_ORG_READ_ALL,           // was 'organization:read'
```

**`src/controllers/sites.js`** — update `getAll()` gate (uses generic forbidden + structured log):
```javascript
import { CAP_SITE_READ_ALL } from '../routes/capability-constants.js';
// ...
const isAdmin = accessControlUtil.hasAdminAccess();
const hasS2S = !isAdmin && await accessControlUtil.hasS2SCapability(CAP_SITE_READ_ALL);
if (!isAdmin && !hasS2S) {
  log.info(`[acl] Denied GET /sites — admin=${isAdmin} s2sCap=${hasS2S}`);
  return forbidden('Forbidden');
}
// audit-log successful cross-tenant enumeration here
```

**`src/controllers/organizations.js`** — update `getAll()` gate analogously with
`CAP_ORG_READ_ALL`.

---

## Consumer Registration

To grant a service `readAll` access, its Consumer record must be created with the required
capabilities. Per the Trust Boundary section, the Consumer is registered against the
**internal SpaceCat org** for discovery; per-customer-org Consumer records are required
separately for any post-discovery operations.

```json
{
  "clientId": "my-dashboard-service",
  "imsOrgId": "908936ED5D35CC220A495CD4@AdobeOrg",
  "consumerName": "Dashboard Service (discovery)",
  "capabilities": ["site:readAll", "organization:readAll"]
}
```

The `site:read` and `organization:read` capabilities are NOT required alongside `readAll` —
they serve different routes (`/sites/:siteId` vs `/sites`).

---

## Consumer Discovery Flow

This capability is specifically designed for platform-level services that have no prior
knowledge of which customer orgs or sites exist. The intended flow is:

### Step 1 — Mint a token using the SpaceCat internal org

S2S tokens are signed with a `client_id` + `imsOrgId` pair. A service that hasn't yet discovered
any customer org uses the SpaceCat platform internal org for its discovery token:

| Environment | Internal imsOrgId |
|---|---|
| Production | `908936ED5D35CC220A495CD4@AdobeOrg` |
| Dev / Stage | `8C6043F15F43B6390A49401A@AdobeOrg` |

A Consumer record for the service **must exist** against this internal org with the relevant
`readAll` capabilities.

### Step 2 — Discover sites / organizations

Using the token from Step 1, call the list endpoints:

```
GET /sites           → returns all sites (DTO, paginated)
GET /organizations   → returns all organizations (paginated)
```

The service now has the site IDs, base URLs, and IMS org IDs it needs to scope further
operations.

### Step 3 — Mint a token for the target customer org and operate

To act on a discovered org, the service mints an S2S token with `client_id` = service's
client id and `org` = the discovered customer org's IMS org id, then makes its tenant-scoped
calls.

**That token is honored by SpaceCat only if the Consumer table contains a row for
`(clientId, customerOrgImsOrgId)` with the appropriate `read` / `write` capabilities and an
ACTIVE status.** Without such a row, the wrapper at Layer 1 returns 403 — discovery does not
imply operational access. See "Trust Boundary at Discovery Step 3" above for the full analysis.

This separation — discovery via the internal-org Consumer, operations via per-customer-org
Consumers — is the design's central isolation guarantee. A service can be granted `readAll`
discovery without being granted operational access to any specific customer; operational
provisioning is a separate, deliberate, per-customer-org act.

### Flow Summary

```
Service (no prior context)
        │
        ▼
[1] Mint token with internal org (Prod / Dev imsOrgId)
    Consumer must exist: (clientId, internalOrgId) with readAll
        │
        ▼
[2] GET /sites  or  GET /organizations
    → s2sAuthWrapper validates token + site:readAll
    → controller gate: hasS2SCapability('site:readAll')
    → returns paginated list, audit-logged
        │
        ▼
[3] Mint token for customer org (clientId, customerOrgImsOrgId)
    → Layer 1 wrapper requires Consumer row for that pair
    → If absent: 403, regardless of what auth-service signed
        │
        ▼
[4] Operate on specific site/org
    GET /sites/:siteId, POST /audits, etc.
    → standard tenant-scoped hasAccess() checks apply
```

---

## Cross-Repo Rollout Order

The implementation lands across two repositories in a strict order to avoid the route-map
referencing a capability the schema has not yet learned to accept.

1. **`spacecat-shared-data-access`**: add `readAll` to `Consumer.CAPABILITIES`. Release a new
   minor version. (No consumers using `readAll` yet — release is safe.)
2. **Pagination on `GET /sites` and `GET /organizations`** in `spacecat-api-service` (separate
   PR(s)). Cursor pagination, hard payload cap, rate limit. **Precondition for step 4.**
3. **`spacecat-api-service`** picks up the new shared-data-access version. Consumer-record
   creation tooling updated to accept `readAll` capabilities.
4. **`spacecat-api-service`** route remap (`required-capabilities.js`) and controller gate
   updates (`sites.js`, `organizations.js`) ship in a final PR. At this point:
   - S2S consumers with `readAll` granted can reach the endpoints.
   - Admin / API-key callers see no behavior change.
   - Pagination is in place.

Reversing steps 1 and 3 means the route map references a capability that Consumer creation
rejects as schema-invalid. Reversing 2 and 4 means S2S consumers immediately hit the
6-MB-Lambda ceiling.

---

## Test Strategy

**Unit tests** — `AccessControlUtil.hasS2SCapability`:

| Case | Expected |
|---|---|
| `context.s2sConsumer` is `null` (non-S2S request) | `false` |
| Consumer not found in DB on re-fetch | `false` |
| Consumer found, status `SUSPENDED` | `false` |
| Consumer found, `isRevoked()` returns `true` | `false` |
| Consumer found, ACTIVE, capabilities does not include requested one | `false` |
| Consumer found, ACTIVE, capabilities includes requested one | `true` |

**Unit tests** — `sites.getAll` and `organizations.getAll`:

| Case | Expected |
|---|---|
| Admin caller, no S2S | 200, full list |
| API-key caller (legacy, non-JWT/IMS) | 200, full list |
| S2S consumer with `site:readAll`, status ACTIVE | 200, full list, audit log emitted |
| S2S consumer with only `site:read` (not `readAll`) | 403, denied at Layer 1 (wrapper) |
| S2S consumer with `site:readAll` revoked between Layer 1 and Layer 2 | 403, denied at Layer 2 |
| Non-S2S non-admin JWT | 403 |

**Integration tests** — `test/it/postgres/sites.test.js` and `organizations.test.js`:

| Case | Expected |
|---|---|
| Consumer with `site:readAll` against internal org → `GET /sites` | 200 |
| Consumer with `site:read` (no `readAll`) against internal org → `GET /sites` | 403 |
| Consumer absent from Consumer table → `GET /sites` with otherwise-valid token | 403 |
| Pagination: response respects `limit` and returns `nextCursor` correctly | 200 |

**Negative coverage tests**:

- A controller that gates a list endpoint admin-only and forgets `hasS2SCapability` returns
  403 to S2S callers (proves fail-closed-by-default).
- Capability strings in `required-capabilities.js` and controller checks all resolve to the
  same constants in `capability-constants.js` — coverage test fails if drift is introduced.

---

## What Does Not Change

- Human admin flows (`hasAdminAccess()`) — completely unaffected.
- API-key consumers — `hasAdminAccess()` returns `true` for them already; they retain access
  to `GET /sites` and `GET /organizations` without any capability.
- All site-scoped and org-scoped endpoints — no changes to their gating or the `hasAccess()`
  path.
- All write, delete, and mutating endpoints — these are not in scope for `readAll`.
- The internal routes exclusion list — entries there remain blocked for S2S regardless.
- Consumer revocation, status checks, and DB-backed capability resolution — all unchanged.
- Auth-service token-minting policy — unchanged. SpaceCat enforces tenant isolation via the
  per-org Consumer record lookup at Layer 1, independent of mint policy.

---

## Future Extension

The `readAll` action is generic. When another entity's list endpoint needs to open to S2S
consumers, the pattern is:

1. Remap `GET /<entity>` to `<entity>:readAll` in `required-capabilities.js` (via
   `capability-constants.js`).
2. Add `hasS2SCapability('<entity>:readAll')` check to the controller's list gate.
3. Confirm the entity's list endpoint supports pagination and audit logging.
4. Grant the consuming service `<entity>:readAll` in its Consumer record.

**Threshold for revisiting the capability model**: if 5 or more entities adopt this pattern,
or if any non-read action grows an "all-tenants" variant (e.g., `writeAll`), the design should
be revisited in favor of a policy engine (Cedar, OpenFGA, OPA). The hand-coded
`<verb>All` namespace does not scale beyond a handful of entries, and a policy engine
expresses scope-vs-action separation natively.
