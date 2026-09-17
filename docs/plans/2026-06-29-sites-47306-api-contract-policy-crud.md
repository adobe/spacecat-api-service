# Audit Policy — spacecat-api-service contract (policy CRUD + 501 scope stubs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ticket:** [SITES-47306](https://jira.corp.adobe.com/browse/SITES-47306) — `[Impl] spacecat-api-service contract (audit policy)`
**Spec (source of truth):** `adobe/mysticat-architecture` → `platform/design-audit-policy-api-contract.md` (PR #184). Read it before starting; this plan implements its §1–§7.
**Spec ticket:** [SITES-46352](https://jira.corp.adobe.com/browse/SITES-46352) (blocks this) · **Epic:** [SITES-44768](https://jira.corp.adobe.com/browse/SITES-44768)
**Repo / branch / worktree:** `spacecat-api-service` on `feat/sites-47306-api-contract` (shared session branch; resume via `mise run wt -- feat/sites-47306-api-contract`).
**Companion plan (other repo):** `mysticat-data-service` → `docs/plans/2026-06-29-sites-47306-api-contract-b2-followups.md` (the §6 RPC follow-ups this contract depends on).

**Goal:** Add a `/sites/{siteId}/audit-policy` CRUD surface (E1/E2/E3) over the B2 `audit_policy` table + `wrpc_upsert_audit_policy`, plus `/sites/{siteId}/audit-scope/{pages,summary,sections}` (E4/E5/E6) as OpenAPI `501` stubs, following the `agentic-rules-factory.js` precedent exactly.

**Architecture:** A single per-request factory controller `src/controllers/audit-policy.js` uses `context.dataAccess.services.postgrestClient` — `.from('audit_policy')` / `.from('audit_policy_revision')` for reads and `.rpc('wrpc_upsert_audit_policy', {...})` for the full-replace write. AuthZ is enforced at the gateway via `AccessControlUtil` (org membership for reads; ASO **or** LLMO entitlement for writes). The contract is a thin serializer (DTO camelCase ⇄ snake_case, validation, RPC-error→HTTP mapping, cursor pagination). E4–E6 return `501` until their backing blocks (B4/B7) land.

**Tech Stack:** Node ESM, `@adobe/spacecat-shared-http-utils`, `@adobe/spacecat-shared-utils`, PostgREST client, mocha + c8 (unit, sinon stubs) + `test/it/postgres` (integration, real RPC), redocly OpenAPI.

---

## Decisions / divergences (spec vs. repo reality — verified 2026-06-29)

1. **OpenAPI layout is flat files, not `paths/`.** Spec §5 says `docs/openapi/paths/audit-policy.yaml`; the repo uses flat operation files (`agentic-rules-api.yaml`, etc.) referenced from `api.yaml`. → Create `docs/openapi/audit-policy-api.yaml`. (No `docs/openapi/paths/` directory exists.)
2. **Entitlement product codes are `ASO` / `LLMO` (uppercase), not `aso`/`llmo_optimizer`.** Spec §3.1 wrote lowercase; the real `AccessControlUtil.hasAccess(entity, subService='', productCode='')` matches uppercase product codes and the request's `x-product` header. → Write gate = `hasAccess(site,'','ASO') || hasAccess(site,'','LLMO')`.
   - **Nuance to verify at impl:** `hasAccess` logs+returns false when `productCode` ≠ the request's `x-product` header (`access-control-util.js:293`). The OR handles "either product's UI" because each UI sends its own `x-product`. Confirm with an IT for both an ASO-header and an LLMO-header caller (API-9).
3. **No dedicated `409`/`501` helpers.** Use `createResponse(body, 409)` (precedent: `agentic-rules-factory.js` 23505 path) and an inline `createResponse({...}, 501)` for stubs. No shared `responses.yaml#/501` exists — declare `'501': { description: 'Not implemented yet.' }` inline per CLAUDE.md.
4. **`:siteId` is already an ASO ReBAC alias** (`PRODUCTS_FACS_RESOURCE_PARAM_ALIASES.ASO.site = ['siteId']`). The contract introduces **no new dynamic route param** (revisions is list-only, no `:version`). → **No `facs-capabilities.js` param-classification change.** Only FACS capability *route entries* are added (`aso/can_view` reads, `aso/can_configure` writes). `test/routes/facs-capabilities.test.js` enforces every route has an entry — running it is the gate (Task 6).
5. **Cross-repo conflict contract (with companion plan).** The optimistic-lock `409` relies on the data-service RPC raising `SQLSTATE 40000` (not `40001`: PostgREST v14.4, pinned by mysticat-data-service, hangs on `40001`/serialization_failure due to hasql-transaction's auto-retry on that code — PostgREST/postgrest#3673) with the current version in the error `DETAIL`. The controller maps either `40000` or `40001` → `409 { message, currentVersion: Number(error.details) }` (accepting `40001` too keeps the mapping working if a future PostgREST upgrade lets the RPC use the more conventional code). Both plans pin this token.

## Dependency / sequencing (read this)

This contract has **no compile-time** dependency on B1/B2 — the controller talks to PostgREST by string table/RPC names. So **Tasks 1–7 (DTOs, controller, routes, OpenAPI, unit tests) proceed now.** The **runtime** dependencies gate only the integration tests (Task 8):

1. B2 impl (**SITES-47301**, *In Progress*) merges to `mysticat-data-service` main → `audit_policy` table + `wrpc_upsert_audit_policy` exist.
2. The companion `mysticat-data-service` PR (this ticket) merges → adds `p_expected_version` + `audit_policy_revision.effective_at`.
3. A new versioned data-service image is published, and `test/it/postgres/docker-compose.yml` (currently pins `mysticat-data-service:v5.44.0`, line 44) is bumped to it.

Until step 3, **Task 8 integration tests are written but `.skip`-gated** (Task 8 explains how). Unit tests (Tasks 1–6) are the merge-blocking coverage for the first PR; flip the IT skip and bump the image in a follow-up commit once the image is cut.

## File Structure

- **Create:** `src/controllers/audit-policy.js` — the factory controller (E1/E2/E3 handlers + E4/E5/E6 `501` stubs). One responsibility: serialize the audit-policy contract.
- **Create:** `src/dto/audit-policy.js` — `AuditPolicyDto`, `AuditPolicyRevisionDto` (camelCase ⇄ snake_case), default-document synthesis.
- **Create:** `test/controllers/audit-policy.test.js` — unit tests (sinon-stubbed PostgREST + AccessControlUtil), mirrors `agentic-categories.test.js`.
- **Create:** `docs/openapi/audit-policy-api.yaml` — paths + operation-local schemas.
- **Create:** `test/it/postgres/audit-policy.test.js` + `test/it/shared/tests/audit-policy.js` — integration tests (gated).
- **Modify:** `src/index.js` — import + per-request instantiate the controller; pass to `getRouteHandlers`.
- **Modify:** `src/routes/index.js` — add 6 route → handler entries; add controller as a positional param.
- **Modify:** `src/routes/facs-capabilities.js` — add 6 FACS capability entries.
- **Modify:** `docs/openapi/api.yaml` — `$ref` the new operation file for each path.
- **Modify:** `test/it/postgres/seed-data/audit-policy.js` + `test/it/postgres/seed.js` — seed rows (gated; created in Task 8).

---

## Task 1: DTOs (camelCase ⇄ snake_case + synthetic default)

**Files:**
- Create: `src/dto/audit-policy.js`
- Test: `test/dto/audit-policy.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/dto/audit-policy.test.js
import { expect } from 'chai';
import { AuditPolicyDto, AuditPolicyRevisionDto } from '../../src/dto/audit-policy.js';

const SITE_ID = '7b2e3f9c-0000-4000-8000-000000000001';

describe('AuditPolicyDto', () => {
  it('toJSON maps snake_case row to camelCase', () => {
    const row = {
      site_id: SITE_ID, version: 5, budget: 4000, strategy_name: 'tiered',
      exclusion_globs: ['/checkout/*'], manual_urls: ['https://x/a'],
      scope_config: {}, lifecycle_overrides: {}, created_by: 'a', updated_by: 'b',
      reason: 'r', note: 'n', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    };
    const dto = AuditPolicyDto.toJSON(row);
    expect(dto).to.deep.equal({
      siteId: SITE_ID, version: 5, budget: 4000, strategyName: 'tiered',
      exclusionGlobs: ['/checkout/*'], manualUrls: ['https://x/a'],
      scopeConfig: {}, lifecycleOverrides: {}, createdBy: 'a', updatedBy: 'b',
      reason: 'r', note: 'n', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    });
    expect(dto).to.not.have.any.keys('site_id', 'strategy_name', 'exclusion_globs');
  });

  it('defaultDocument returns version 0 baseline when no row exists', () => {
    const dto = AuditPolicyDto.defaultDocument(SITE_ID);
    expect(dto).to.include({ siteId: SITE_ID, version: 0, budget: 5000, strategyName: 'tiered' });
    expect(dto.exclusionGlobs).to.deep.equal([]);
    expect(dto.manualUrls).to.deep.equal([]);
    expect(dto.scopeConfig).to.deep.equal({});
    expect(dto.createdBy).to.equal(null);
  });

  it('revision toJSON exposes effectiveAt/supersededAt and per-version provenance', () => {
    const row = {
      version: 4, budget: 4000, strategy_name: 'tiered', exclusion_globs: [], manual_urls: [],
      scope_config: {}, lifecycle_overrides: {}, updated_by: 'b', reason: 'r', note: 'n',
      effective_at: '2026-01-01T00:00:00Z', superseded_at: '2026-01-02T00:00:00Z',
    };
    const dto = AuditPolicyRevisionDto.toJSON(row);
    expect(dto).to.include({ version: 4, updatedBy: 'b', effectiveAt: '2026-01-01T00:00:00Z', supersededAt: '2026-01-02T00:00:00Z' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/dto/audit-policy.test.js`
Expected: FAIL — `Cannot find module '../../src/dto/audit-policy.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/dto/audit-policy.js
const DEFAULTS = { budget: 5000, strategyName: 'tiered' };

export const AuditPolicyDto = {
  toJSON(row) {
    return {
      siteId: row.site_id,
      version: row.version,
      budget: row.budget,
      strategyName: row.strategy_name,
      exclusionGlobs: row.exclusion_globs,
      manualUrls: row.manual_urls,
      scopeConfig: row.scope_config,
      lifecycleOverrides: row.lifecycle_overrides,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      reason: row.reason,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },
  defaultDocument(siteId) {
    return {
      siteId,
      version: 0,
      budget: DEFAULTS.budget,
      strategyName: DEFAULTS.strategyName,
      exclusionGlobs: [],
      manualUrls: [],
      scopeConfig: {},
      lifecycleOverrides: {},
      createdBy: null,
      updatedBy: null,
      reason: null,
      note: null,
      createdAt: null,
      updatedAt: null,
    };
  },
};

export const AuditPolicyRevisionDto = {
  toJSON(row) {
    return {
      version: row.version,
      budget: row.budget,
      strategyName: row.strategy_name,
      exclusionGlobs: row.exclusion_globs,
      manualUrls: row.manual_urls,
      scopeConfig: row.scope_config,
      lifecycleOverrides: row.lifecycle_overrides,
      updatedBy: row.updated_by,
      reason: row.reason,
      note: row.note,
      effectiveAt: row.effective_at,
      supersededAt: row.superseded_at,
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/dto/audit-policy.test.js`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/dto/audit-policy.js test/dto/audit-policy.test.js
git commit -m "feat(audit-policy): add AuditPolicyDto + AuditPolicyRevisionDto (SITES-47306)"
```

---

## Task 2: Controller scaffold + E1 `GET /sites/:siteId/audit-policy`

**Files:**
- Create: `src/controllers/audit-policy.js`
- Test: `test/controllers/audit-policy.test.js`

E1 returns the current policy, or a **synthetic `version: 0` default** when no row exists (spec §3.3), never `404`. Reads gate on org membership only.

- [ ] **Step 1: Write the failing test** (mirror `test/controllers/agentic-categories.test.js` — direct sinon, no esmock)

```js
// test/controllers/audit-policy.test.js
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import AuditPolicyController from '../../src/controllers/audit-policy.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(sinonChai);

const SITE_ID = '7b2e3f9c-0000-4000-8000-000000000001';

function loadController(hasAccess = sinon.stub().resolves(true)) {
  if (AccessControlUtil.fromContext.restore) AccessControlUtil.fromContext.restore();
  sinon.stub(AccessControlUtil, 'fromContext').returns({
    hasAccess,
    hasAdminAccess: sinon.stub().returns(false),
    isLLMOAdministrator: sinon.stub().returns(false),
  });
  return AuditPolicyController();
}

// PostgREST stub: .from().select().eq().maybeSingle() is terminal; .rpc() returns {data,error}.
function buildClient({ row = null, rpcResult, revisions = [] } = {}) {
  const single = () => Promise.resolve({ data: row, error: null });
  const chain = { select: () => chain, eq: () => chain, order: () => Promise.resolve({ data: revisions, error: null }), limit: () => chain, maybeSingle: single, single };
  return {
    from: () => chain,
    rpc: sinon.stub().callsFake(() => Promise.resolve(rpcResult ?? { data: row, error: null })),
  };
}

function buildContext({ client, params = {}, data = {}, profile = { email: 'u@x.com' } } = {}) {
  return {
    params: { siteId: SITE_ID, ...params },
    data,
    attributes: { authInfo: { getProfile: () => profile } },
    dataAccess: {
      Site: { findById: sinon.stub().resolves({ getId: () => SITE_ID }) },
      services: { postgrestClient: client || buildClient() },
    },
    log: { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() },
  };
}

describe('AuditPolicyController — E1 getPolicy', () => {
  afterEach(() => sinon.restore());

  it('returns 200 with the current policy mapped to camelCase', async () => {
    const row = {
      site_id: SITE_ID, version: 3, budget: 4000, strategy_name: 'tiered',
      exclusion_globs: [], manual_urls: [], scope_config: {}, lifecycle_overrides: {},
      created_by: 'a', updated_by: 'b', reason: 'r', note: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    };
    const controller = loadController();
    const res = await controller.getPolicy(buildContext({ client: buildClient({ row }) }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.include({ version: 3, strategyName: 'tiered' });
    expect(body).to.not.have.any.keys('site_id', 'strategy_name');
  });

  it('returns 200 synthetic default (version 0) when no row exists', async () => {
    const controller = loadController();
    const res = await controller.getPolicy(buildContext({ client: buildClient({ row: null }) }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.include({ version: 0, budget: 5000, strategyName: 'tiered' });
  });

  it('returns 403 when caller is not an org member', async () => {
    const controller = loadController(sinon.stub().resolves(false));
    const res = await controller.getPolicy(buildContext());
    expect(res.status).to.equal(403);
  });

  it('returns 404 when the site does not exist', async () => {
    const controller = loadController();
    const ctx = buildContext();
    ctx.dataAccess.Site.findById = sinon.stub().resolves(null);
    const res = await controller.getPolicy(ctx);
    expect(res.status).to.equal(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/controllers/audit-policy.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** (controller scaffold + E1)

```js
// src/controllers/audit-policy.js
import {
  badRequest, createResponse, forbidden, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isObject, isValidUUID } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';
import { AuditPolicyDto, AuditPolicyRevisionDto } from '../dto/audit-policy.js';

const POLICY_TABLE = 'audit_policy';
const REVISION_TABLE = 'audit_policy_revision';
const UPSERT_RPC = 'wrpc_upsert_audit_policy';

function getAuthor(context) {
  const profile = context.attributes?.authInfo?.getProfile?.();
  const identity = profile?.email || profile?.name;
  if (!identity) {
    context.log?.warn?.('audit-policy write has no authenticated identity; attributing to "system"');
    return 'system';
  }
  return identity;
}

export default function AuditPolicyController() {
  // Resolve site + client + read access. Returns { error } on failure, else { site, siteId, client }.
  async function authorizeRead(context) {
    const { siteId } = context.params || {};
    if (!isValidUUID(siteId)) return { error: badRequest('siteId is required and must be a UUID') };
    const site = await context.dataAccess.Site.findById(siteId);
    if (!site) return { error: notFound(`Site not found: ${siteId}`) };
    const client = context.dataAccess.services?.postgrestClient;
    if (!client?.from) return { error: internalServerError('PostgREST client is not available') };
    const ac = AccessControlUtil.fromContext(context);
    if (!await ac.hasAccess(site)) {
      return { error: forbidden('Only users belonging to the organization can access the audit policy') };
    }
    return { site, siteId, client, ac };
  }

  async function getPolicy(context) {
    const auth = await authorizeRead(context);
    if (auth.error) return auth.error;
    const { siteId, client } = auth;
    const { data, error } = await client
      .from(POLICY_TABLE).select('*').eq('site_id', siteId).maybeSingle();
    if (error) {
      context.log?.error?.(`audit-policy getPolicy failed: ${error.code} ${error.message}`);
      return internalServerError('Failed to read audit policy');
    }
    if (!data) return ok(AuditPolicyDto.defaultDocument(siteId));
    return ok(AuditPolicyDto.toJSON(data));
  }

  return { getPolicy };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/controllers/audit-policy.test.js`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/audit-policy.js test/controllers/audit-policy.test.js
git commit -m "feat(audit-policy): E1 GET current policy with synthetic default (SITES-47306)"
```

---

## Task 3: E2 `PUT /sites/:siteId/audit-policy` (full-replace, optimistic-locked, validated)

**Files:**
- Modify: `src/controllers/audit-policy.js`
- Modify: `test/controllers/audit-policy.test.js`

Implements spec §3.4–§3.8: full-replace via `wrpc_upsert_audit_policy`; `author` from token; `reason` + `expectedVersion` required; server-side validation ceilings; RPC-error→HTTP mapping incl. `409` on `SQLSTATE 40001` with `currentVersion`.

- [ ] **Step 1: Write the failing tests**

```js
// append to test/controllers/audit-policy.test.js
describe('AuditPolicyController — E2 putPolicy', () => {
  afterEach(() => sinon.restore());

  function writeCtx(body, opts = {}) {
    return buildContext({ data: body, ...opts });
  }
  const validBody = {
    budget: 4000, strategyName: 'tiered', exclusionGlobs: ['/checkout/*'],
    manualUrls: [], scopeConfig: {}, lifecycleOverrides: {},
    reason: 'trim crawl', note: 'q2', expectedVersion: 3,
  };

  it('writes via wrpc with token-derived author and returns 200 v+1', async () => {
    const newRow = { site_id: SITE_ID, version: 4, budget: 4000, strategy_name: 'tiered',
      exclusion_globs: ['/checkout/*'], manual_urls: [], scope_config: {}, lifecycle_overrides: {},
      created_by: 'a', updated_by: 'u@x.com', reason: 'trim crawl', note: 'q2',
      created_at: 'x', updated_at: 'y' };
    const client = buildClient({ rpcResult: { data: newRow, error: null } });
    const controller = loadController();
    const res = await controller.putPolicy(writeCtx({ ...validBody, author: 'FORGED' }, { client }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.version).to.equal(4);
    expect(body.updatedBy).to.equal('u@x.com');
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({ p_author: 'u@x.com', p_expected_version: 3 }));
    // author from body must be ignored
    expect(client.rpc.firstCall.args[1]).to.not.have.property('p_author', 'FORGED');
  });

  it('returns 400 when reason is missing', async () => {
    const controller = loadController();
    const { reason, ...noReason } = validBody;
    const res = await controller.putPolicy(writeCtx(noReason));
    expect(res.status).to.equal(400);
  });

  it('returns 400 when expectedVersion is missing', async () => {
    const controller = loadController();
    const { expectedVersion, ...noVer } = validBody;
    const res = await controller.putPolicy(writeCtx(noVer));
    expect(res.status).to.equal(400);
  });

  it('returns 400 when budget <= 0 or globs over cap', async () => {
    const controller = loadController();
    expect((await controller.putPolicy(writeCtx({ ...validBody, budget: 0 }))).status).to.equal(400);
    const tooMany = Array.from({ length: 1001 }, (_, i) => `/p${i}/*`);
    expect((await controller.putPolicy(writeCtx({ ...validBody, exclusionGlobs: tooMany }))).status).to.equal(400);
  });

  it('maps SQLSTATE 40001 to 409 with currentVersion from error.details', async () => {
    const client = buildClient({ rpcResult: { data: null, error: { code: '40001', message: 'audit_policy_version_conflict', details: '7' } } });
    const controller = loadController();
    const res = await controller.putPolicy(writeCtx(validBody, { client }));
    expect(res.status).to.equal(409);
    const body = await res.json();
    expect(body.currentVersion).to.equal(7);
  });

  it('maps a redaction/validation RPC raise (P0001) to 400', async () => {
    const client = buildClient({ rpcResult: { data: null, error: { code: 'P0001', message: 'secret detected in note' } } });
    const controller = loadController();
    const res = await controller.putPolicy(writeCtx(validBody, { client }));
    expect(res.status).to.equal(400);
  });

  it('returns 403 when caller lacks both ASO and LLMO entitlement', async () => {
    // hasAccess(site) -> true (org member); hasAccess(site,'','ASO') and (...,'LLMO') -> false
    const hasAccess = sinon.stub();
    hasAccess.withArgs(sinon.match.any).resolves(true);
    hasAccess.withArgs(sinon.match.any, '', 'ASO').resolves(false);
    hasAccess.withArgs(sinon.match.any, '', 'LLMO').resolves(false);
    const controller = loadController(hasAccess);
    const res = await controller.putPolicy(writeCtx(validBody));
    expect(res.status).to.equal(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/controllers/audit-policy.test.js`
Expected: FAIL — `controller.putPolicy is not a function`.

- [ ] **Step 3: Write minimal implementation** (add to `src/controllers/audit-policy.js`)

Add these constants near the top (after the `_RPC` consts):

```js
const MAX_EXCLUSION_GLOBS = 1000;
const MAX_MANUAL_URLS = 50000;
const MAX_ELEMENT_LEN = 2048;
const MAX_NOTE_LEN = 2000;
const STRATEGIES = ['tiered'];
const SQLSTATE_VERSION_CONFLICT = '40001';
```

Add a validation helper and `putPolicy`, and export it:

```js
// returns a string error message, or null when valid
function validatePolicyBody(b) {
  if (!isObject(b)) return 'request body must be a JSON object';
  if (!Number.isInteger(b.budget) || b.budget <= 0) return 'budget must be an integer > 0';
  if (!STRATEGIES.includes(b.strategyName)) return `strategyName must be one of: ${STRATEGIES.join(', ')}`;
  const arr = (v, max, name) => {
    if (!Array.isArray(v)) return `${name} must be an array`;
    if (v.length > max) return `${name} exceeds the maximum of ${max}`;
    if (v.some((s) => typeof s !== 'string' || s.length > MAX_ELEMENT_LEN)) return `${name} entries must be strings <= ${MAX_ELEMENT_LEN} chars`;
    return null;
  };
  const ge = arr(b.exclusionGlobs ?? [], MAX_EXCLUSION_GLOBS, 'exclusionGlobs'); if (ge) return ge;
  const mu = arr(b.manualUrls ?? [], MAX_MANUAL_URLS, 'manualUrls'); if (mu) return mu;
  if (b.scopeConfig !== undefined && !isObject(b.scopeConfig)) return 'scopeConfig must be an object';
  if (b.lifecycleOverrides !== undefined && !isObject(b.lifecycleOverrides)) return 'lifecycleOverrides must be an object';
  if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > MAX_NOTE_LEN)) return `note must be a string <= ${MAX_NOTE_LEN} chars`;
  if (!hasText(b.reason)) return 'reason is required';
  if (!Number.isInteger(b.expectedVersion) || b.expectedVersion < 0) return 'expectedVersion is required and must be an integer >= 0';
  return null;
}

async function putPolicy(context) {
  const auth = await authorizeRead(context);
  if (auth.error) return auth.error;
  const { site, siteId, client, ac } = auth;

  // write entitlement: ASO or LLMO (admin bypass handled inside hasAccess)
  const aso = await ac.hasAccess(site, '', 'ASO');
  const llmo = aso ? true : await ac.hasAccess(site, '', 'LLMO');
  if (!aso && !llmo) {
    return forbidden('Editing the audit policy requires ASO or LLMO entitlement for this site');
  }

  const body = context.data || {};
  const invalid = validatePolicyBody(body);
  if (invalid) return badRequest(invalid);

  const { data, error } = await client.rpc(UPSERT_RPC, {
    p_site_id: siteId,
    p_budget: body.budget,
    p_strategy_name: body.strategyName,
    p_exclusion_globs: body.exclusionGlobs ?? [],
    p_manual_urls: body.manualUrls ?? [],
    p_scope_config: body.scopeConfig ?? {},
    p_lifecycle_overrides: body.lifecycleOverrides ?? {},
    p_author: getAuthor(context),
    p_reason: body.reason,
    p_note: body.note ?? null,
    p_expected_version: body.expectedVersion,
  });

  if (error) {
    if (error.code === SQLSTATE_VERSION_CONFLICT) {
      const currentVersion = Number.parseInt(error.details, 10);
      return createResponse(
        { message: 'policy was modified; reload and retry', ...(Number.isInteger(currentVersion) ? { currentVersion } : {}) },
        409,
      );
    }
    if (error.code === 'P0001') return badRequest(error.message || 'audit policy rejected by validation');
    context.log?.error?.(`audit-policy putPolicy failed: ${error.code} ${error.message}`);
    return internalServerError('Failed to write audit policy');
  }
  return ok(AuditPolicyDto.toJSON(data));
}
```

Update the return statement: `return { getPolicy, putPolicy };`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha test/controllers/audit-policy.test.js`
Expected: PASS (all E1 + E2 cases).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/audit-policy.js test/controllers/audit-policy.test.js
git commit -m "feat(audit-policy): E2 PUT full-replace with optimistic lock + validation (SITES-47306)"
```

---

## Task 4: E3 `GET /sites/:siteId/audit-policy/revisions` (cursor-paginated, newest-first)

**Files:**
- Modify: `src/controllers/audit-policy.js`
- Modify: `test/controllers/audit-policy.test.js`

Implements spec §3.7. Opaque cursor over `version` (the unique, monotonic ordering column): `cursor` encodes the last-seen `version`; page is `version < cursor` ordered `version desc`, limited to `min(limit||50, 200)`.

- [ ] **Step 1: Write the failing test**

```js
// append to test/controllers/audit-policy.test.js
describe('AuditPolicyController — E3 listRevisions', () => {
  afterEach(() => sinon.restore());

  it('returns revisions newest-first with a cursor when a full page is returned', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({
      version: 4 - i, budget: 4000, strategy_name: 'tiered', exclusion_globs: [], manual_urls: [],
      scope_config: {}, lifecycle_overrides: {}, updated_by: 'b', reason: 'r', note: null,
      effective_at: 'e', superseded_at: 's',
    }));
    // capture the query chain to assert order desc + limit
    const orderSpy = sinon.stub().resolves({ data: rows, error: null });
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ order: orderSpy, lt: function () { return this; }, limit: function () { return this; } }) }) }),
      rpc: sinon.stub(),
    };
    const controller = loadController();
    const res = await controller.listRevisions(buildContext({ client, params: { limit: '2' } }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.items[0].version).to.equal(4);
    expect(body.items).to.have.length(2);
    expect(body.cursor).to.be.a('string'); // full page -> next cursor present
  });

  it('clamps limit to 200 max', async () => {
    const limitSpy = sinon.stub().returnsThis();
    const order = sinon.stub().resolves({ data: [], error: null });
    const client = { from: () => ({ select: () => ({ eq: () => ({ order, lt: function () { return this; }, limit: limitSpy }) }) }), rpc: sinon.stub() };
    const controller = loadController();
    await controller.listRevisions(buildContext({ client, params: { limit: '9999' } }));
    expect(limitSpy).to.have.been.calledWith(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/controllers/audit-policy.test.js`
Expected: FAIL — `controller.listRevisions is not a function`.

- [ ] **Step 3: Write minimal implementation** (add to `src/controllers/audit-policy.js`)

```js
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

function decodeCursor(c) {
  if (!hasText(c)) return null;
  const v = Number.parseInt(Buffer.from(c, 'base64url').toString('utf8'), 10);
  return Number.isInteger(v) ? v : null;
}
function encodeCursor(version) {
  return Buffer.from(String(version), 'utf8').toString('base64url');
}

async function listRevisions(context) {
  const auth = await authorizeRead(context);
  if (auth.error) return auth.error;
  const { siteId, client } = auth;
  const limit = Math.min(Number.parseInt(context.params?.limit, 10) || DEFAULT_PAGE, MAX_PAGE);
  const cursor = decodeCursor(context.params?.cursor);

  let q = client.from(REVISION_TABLE).select('*').eq('site_id', siteId);
  if (cursor !== null) q = q.lt('version', cursor);
  const { data, error } = await q.order('version', { ascending: false }).limit(limit);
  if (error) {
    context.log?.error?.(`audit-policy listRevisions failed: ${error.code} ${error.message}`);
    return internalServerError('Failed to read audit policy revisions');
  }
  const items = (data || []).map(AuditPolicyRevisionDto.toJSON);
  const nextCursor = items.length === limit ? encodeCursor(items[items.length - 1].version) : undefined;
  return ok({ items, ...(nextCursor ? { cursor: nextCursor } : {}) });
}
```

> **Note on the test stub:** the production code calls `.order(...).limit(...)` as the terminal pair. The Task-4 test stub returns the rows from `.order()` directly for the first test and asserts `.limit()` arg in the second; when wiring real code, `.limit()` must be the awaited terminal. If the unit test's chain shape fights the real client, prefer asserting via the integration test (Task 8, API-10) and keep the unit test focused on cursor encode/clamp logic. Adjust the stub so `.limit()` resolves the promise (`limit: () => Promise.resolve({data, error})`) to match the real PostgREST client, where `.limit()`/`.order()` are thenable.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/controllers/audit-policy.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/audit-policy.js test/controllers/audit-policy.test.js
git commit -m "feat(audit-policy): E3 GET revisions, cursor-paginated newest-first (SITES-47306)"
```

---

## Task 5: E4–E6 scope-read `501` stub handlers

**Files:**
- Modify: `src/controllers/audit-policy.js`
- Modify: `test/controllers/audit-policy.test.js`

Spec §2: E4 (B4) and E5/E6 (B7) are specified now, served as `501` until their block lands. Stubs still enforce read authZ (so authZ tests pass uniformly) before returning `501`.

- [ ] **Step 1: Write the failing test**

```js
// append to test/controllers/audit-policy.test.js
describe('AuditPolicyController — E4-E6 scope-read 501 stubs', () => {
  afterEach(() => sinon.restore());
  for (const fn of ['getScopePages', 'getScopeSummary', 'getScopeSections']) {
    it(`${fn} returns 501 for an authorized caller`, async () => {
      const controller = loadController();
      const res = await controller[fn](buildContext());
      expect(res.status).to.equal(501);
    });
    it(`${fn} returns 403 for a non-member`, async () => {
      const controller = loadController(sinon.stub().resolves(false));
      const res = await controller[fn](buildContext());
      expect(res.status).to.equal(403);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/controllers/audit-policy.test.js`
Expected: FAIL — `controller.getScopePages is not a function`.

- [ ] **Step 3: Write minimal implementation** (add to `src/controllers/audit-policy.js`)

```js
async function notImplemented(context) {
  const auth = await authorizeRead(context);
  if (auth.error) return auth.error;
  return createResponse({ message: 'Not implemented yet.' }, 501);
}
const getScopePages = notImplemented;
const getScopeSummary = notImplemented;
const getScopeSections = notImplemented;
```

Update the return: `return { getPolicy, putPolicy, listRevisions, getScopePages, getScopeSummary, getScopeSections };`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/controllers/audit-policy.test.js`
Expected: PASS (all controller tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/audit-policy.js test/controllers/audit-policy.test.js
git commit -m "feat(audit-policy): E4-E6 scope-read 501 stubs (SITES-47306)"
```

---

## Task 6: Route wiring (routes/index.js, index.js, facs-capabilities.js)

**Files:**
- Modify: `src/index.js`
- Modify: `src/routes/index.js`
- Modify: `src/routes/facs-capabilities.js`
- Verify against: `test/routes/facs-capabilities.test.js`

- [ ] **Step 1: Run the FACS test to confirm current green baseline**

Run: `npx mocha test/routes/facs-capabilities.test.js`
Expected: PASS (baseline before changes).

- [ ] **Step 2: Wire the controller in `src/index.js`**

Add with the other controller imports (near line 110):

```js
import AuditPolicyController from './controllers/audit-policy.js';
```

Add with the other per-request instantiations (near line 288):

```js
const auditPolicyController = AuditPolicyController();
```

Add `auditPolicyController` to the `getRouteHandlers(...)` positional argument list (the call near line 351) — append it as the **last** positional argument, after `agenticPageTypesController`.

- [ ] **Step 3: Add the param + routes in `src/routes/index.js`**

Add `auditPolicyController` as the **last** positional parameter of the route-handlers function signature (mirroring how `agenticPageTypesController` is the 58th param near line 172).

Add to the `dynamicRoutes` object (near the agentic-rules block, ~line 299) — static segments precede `:auditType`-style dynamic matches:

```js
// Audit Policy contract (SITES-47306). Static segments precede dynamic :auditType match.
'GET /sites/:siteId/audit-policy': auditPolicyController.getPolicy,
'PUT /sites/:siteId/audit-policy': auditPolicyController.putPolicy,
'GET /sites/:siteId/audit-policy/revisions': auditPolicyController.listRevisions,
'GET /sites/:siteId/audit-scope/pages': auditPolicyController.getScopePages,
'GET /sites/:siteId/audit-scope/summary': auditPolicyController.getScopeSummary,
'GET /sites/:siteId/audit-scope/sections': auditPolicyController.getScopeSections,
```

- [ ] **Step 4: Add FACS capability entries in `src/routes/facs-capabilities.js`**

Add to the ASO capability route map (the block near line 838, where `aso/can_*` entries live):

```js
'GET /sites/:siteId/audit-policy': 'aso/can_view',
'PUT /sites/:siteId/audit-policy': 'aso/can_configure',
'GET /sites/:siteId/audit-policy/revisions': 'aso/can_view',
'GET /sites/:siteId/audit-scope/pages': 'aso/can_view',
'GET /sites/:siteId/audit-scope/summary': 'aso/can_view',
'GET /sites/:siteId/audit-scope/sections': 'aso/can_view',
```

> No `:version`/`:revisionId` param is introduced, so **no `FACS_NON_RESOURCE_PARAMS` change** is needed. `:siteId` is already the ASO `site` ReBAC alias.

- [ ] **Step 5: Run the FACS + route tests to verify green**

Run: `npx mocha test/routes/facs-capabilities.test.js test/routes/index.test.js`
Expected: PASS — every new route has a capability entry; no unclassified dynamic param.

- [ ] **Step 6: Commit**

```bash
git add src/index.js src/routes/index.js src/routes/facs-capabilities.js
git commit -m "feat(audit-policy): wire routes + FACS capabilities for audit-policy/audit-scope (SITES-47306)"
```

---

## Task 7: OpenAPI (operation file + api.yaml refs + 501 stubs)

**Files:**
- Create: `docs/openapi/audit-policy-api.yaml`
- Modify: `docs/openapi/api.yaml`

- [ ] **Step 1: Create `docs/openapi/audit-policy-api.yaml`**

Define the six operations and operation-local schemas, mirroring `agentic-rules-api.yaml` structure (`parameters` → `$ref './parameters.yaml#/siteId'`, shared `responses.yaml` refs, `security: [ims_key, scoped_api_key]`). E1/E2/E3 are real; E4–E6 declare a single `'501': { description: 'Not implemented yet.' }`.

```yaml
audit-policy:
  parameters:
    - $ref: './parameters.yaml#/siteId'
  get:
    tags: [site, audit policy]
    summary: Get the current audit policy for a site (synthetic version 0 default when unset)
    operationId: getAuditPolicy
    responses:
      '200': { description: Current audit policy, content: { application/json: { schema: { $ref: '#/AuditPolicy' } } } }
      '401': { $ref: './responses.yaml#/401' }
      '403': { $ref: './responses.yaml#/403' }
      '404': { $ref: './responses.yaml#/404-site-not-found-with-id' }
      '500': { $ref: './responses.yaml#/500' }
    security: [ { ims_key: [] }, { scoped_api_key: [] } ]
  put:
    tags: [site, audit policy]
    summary: Full-replace the audit policy (optimistic-locked via expectedVersion)
    operationId: putAuditPolicy
    requestBody:
      required: true
      content: { application/json: { schema: { $ref: '#/AuditPolicyUpsertRequest' } } }
    responses:
      '200': { description: Updated audit policy, content: { application/json: { schema: { $ref: '#/AuditPolicy' } } } }
      '400': { $ref: './responses.yaml#/400' }
      '401': { $ref: './responses.yaml#/401' }
      '403': { $ref: './responses.yaml#/403' }
      '404': { $ref: './responses.yaml#/404-site-not-found-with-id' }
      '409': { description: Version conflict, content: { application/json: { schema: { $ref: '#/AuditPolicyConflict' } } } }
      '500': { $ref: './responses.yaml#/500' }
    security: [ { ims_key: [] }, { scoped_api_key: [] } ]

audit-policy-revisions:
  parameters:
    - $ref: './parameters.yaml#/siteId'
  get:
    tags: [site, audit policy]
    summary: List audit policy revisions, newest-first, cursor-paginated
    operationId: listAuditPolicyRevisions
    responses:
      '200': { description: Revision history, content: { application/json: { schema: { $ref: '#/AuditPolicyRevisionList' } } } }
      '401': { $ref: './responses.yaml#/401' }
      '403': { $ref: './responses.yaml#/403' }
      '404': { $ref: './responses.yaml#/404-site-not-found-with-id' }
      '500': { $ref: './responses.yaml#/500' }
    security: [ { ims_key: [] }, { scoped_api_key: [] } ]

audit-scope-pages:
  parameters:
    - $ref: './parameters.yaml#/siteId'
  get:
    tags: [site, audit policy]
    summary: 'Not implemented yet. In-scope page list (B4 / SITES-46351).'
    operationId: getAuditScopePages
    responses:
      '501': { description: Not implemented yet. }
    security: [ { ims_key: [] }, { scoped_api_key: [] } ]

audit-scope-summary:
  parameters:
    - $ref: './parameters.yaml#/siteId'
  get:
    tags: [site, audit policy]
    summary: 'Not implemented yet. R8 reconciliation counts (B7 / SITES-47089).'
    operationId: getAuditScopeSummary
    responses:
      '501': { description: Not implemented yet. }
    security: [ { ims_key: [] }, { scoped_api_key: [] } ]

audit-scope-sections:
  parameters:
    - $ref: './parameters.yaml#/siteId'
  get:
    tags: [site, audit policy]
    summary: 'Not implemented yet. R14 section aggregation (B7 / SITES-47089).'
    operationId: getAuditScopeSections
    responses:
      '501': { description: Not implemented yet. }
    security: [ { ims_key: [] }, { scoped_api_key: [] } ]

# --- operation-local schemas ---
AuditPolicy:
  type: object
  properties:
    siteId: { type: string, format: uuid }
    version: { type: integer }
    budget: { type: integer, minimum: 1 }
    strategyName: { type: string, enum: [tiered] }
    exclusionGlobs: { type: array, items: { type: string, maxLength: 2048 }, maxItems: 1000 }
    manualUrls: { type: array, items: { type: string, maxLength: 2048 }, maxItems: 50000 }
    scopeConfig: { type: object }
    lifecycleOverrides: { type: object }
    createdBy: { type: string, nullable: true }
    updatedBy: { type: string, nullable: true }
    reason: { type: string, nullable: true }
    note: { type: string, nullable: true }
    createdAt: { type: string, format: date-time, nullable: true }
    updatedAt: { type: string, format: date-time, nullable: true }
AuditPolicyUpsertRequest:
  type: object
  required: [budget, strategyName, reason, expectedVersion]
  properties:
    budget: { type: integer, minimum: 1 }
    strategyName: { type: string, enum: [tiered] }
    exclusionGlobs: { type: array, items: { type: string, maxLength: 2048 }, maxItems: 1000 }
    manualUrls: { type: array, items: { type: string, maxLength: 2048 }, maxItems: 50000 }
    scopeConfig: { type: object }
    lifecycleOverrides: { type: object }
    reason: { type: string, minLength: 1 }
    note: { type: string, maxLength: 2000, nullable: true }
    expectedVersion: { type: integer, minimum: 0 }
AuditPolicyConflict:
  type: object
  properties:
    message: { type: string }
    currentVersion: { type: integer }
AuditPolicyRevision:
  type: object
  properties:
    version: { type: integer }
    budget: { type: integer }
    strategyName: { type: string, enum: [tiered] }
    exclusionGlobs: { type: array, items: { type: string } }
    manualUrls: { type: array, items: { type: string } }
    scopeConfig: { type: object }
    lifecycleOverrides: { type: object }
    updatedBy: { type: string, nullable: true }
    reason: { type: string, nullable: true }
    note: { type: string, nullable: true }
    effectiveAt: { type: string, format: date-time, nullable: true }
    supersededAt: { type: string, format: date-time }
AuditPolicyRevisionList:
  type: object
  properties:
    items: { type: array, items: { $ref: '#/AuditPolicyRevision' } }
    cursor: { type: string }
```

- [ ] **Step 2: Reference the operations from `docs/openapi/api.yaml`**

Add under `paths:` (mirroring the agentic-categories `$ref` pattern):

```yaml
  /sites/{siteId}/audit-policy:
    $ref: './audit-policy-api.yaml#/audit-policy'
  /sites/{siteId}/audit-policy/revisions:
    $ref: './audit-policy-api.yaml#/audit-policy-revisions'
  /sites/{siteId}/audit-scope/pages:
    $ref: './audit-policy-api.yaml#/audit-scope-pages'
  /sites/{siteId}/audit-scope/summary:
    $ref: './audit-policy-api.yaml#/audit-scope-summary'
  /sites/{siteId}/audit-scope/sections:
    $ref: './audit-policy-api.yaml#/audit-scope-sections'
```

- [ ] **Step 3: Lint + build the OpenAPI docs**

Run: `npm run docs:lint`
Expected: clean (no errors). Then `npm run docs:build` — writes `docs/index.html` without error.

- [ ] **Step 4: Commit**

```bash
git add docs/openapi/audit-policy-api.yaml docs/openapi/api.yaml
git commit -m "docs(audit-policy): OpenAPI for policy CRUD + 501 scope stubs (SITES-47306)"
```

---

## Task 8: Integration tests (GATED — flip on after the data-service image is bumped)

**Files:**
- Create: `test/it/shared/tests/audit-policy.js`
- Create: `test/it/postgres/audit-policy.test.js`
- Create: `test/it/postgres/seed-data/audit-policy.js`
- Modify: `test/it/postgres/seed.js`
- Modify: `test/it/postgres/docker-compose.yml` (image bump — only when the new image exists)

> **Gate.** These exercise the real `wrpc_upsert_audit_policy` (incl. `p_expected_version` → `409`) against Postgres + PostgREST via the pinned data-service image. They cannot pass until (a) B2 (SITES-47301) and (b) this ticket's `mysticat-data-service` PR are merged and (c) a new image is published and pinned. Write them now, wrapped in `describe.skip`, and flip to `describe` + bump the image tag in `docker-compose.yml` line 44 in the unblocking commit.

- [ ] **Step 1: Write the shared IT factory** (mirror `test/it/shared/tests/<feature>.js`)

```js
// test/it/shared/tests/audit-policy.js
import { expect } from 'chai';
import { SITE_1_ID, SITE_2_ID } from '../seed-ids.js';

export default function auditPolicyTests(getHttpClient, resetData) {
  describe.skip('audit-policy contract [GATED: needs data-service image with B2 + p_expected_version]', () => {
    before(() => resetData());

    it('API-2: GET returns synthetic version 0 when no row exists', async () => {
      const res = await getHttpClient().admin.get(`/sites/${SITE_1_ID}/audit-policy`);
      expect(res.status).to.equal(200);
      expect((await res.json()).version).to.equal(0);
    });

    it('API-3/API-5: first PUT with expectedVersion 0 creates version 1', async () => {
      const res = await getHttpClient().admin.put(`/sites/${SITE_1_ID}/audit-policy`, {
        budget: 4000, strategyName: 'tiered', exclusionGlobs: [], manualUrls: [],
        scopeConfig: {}, lifecycleOverrides: {}, reason: 'init', expectedVersion: 0,
      });
      expect(res.status).to.equal(200);
      expect((await res.json()).version).to.equal(1);
    });

    it('API-5: stale expectedVersion yields 409 with currentVersion', async () => {
      const res = await getHttpClient().admin.put(`/sites/${SITE_1_ID}/audit-policy`, {
        budget: 4000, strategyName: 'tiered', exclusionGlobs: [], manualUrls: [],
        scopeConfig: {}, lifecycleOverrides: {}, reason: 'stale', expectedVersion: 0,
      });
      expect(res.status).to.equal(409);
      expect((await res.json()).currentVersion).to.equal(1);
    });

    it('API-8: non-member gets 403', async () => {
      const res = await getHttpClient().user.get(`/sites/${SITE_2_ID}/audit-policy`);
      expect(res.status).to.equal(403);
    });

    it('API-10: revisions are newest-first', async () => {
      const res = await getHttpClient().admin.get(`/sites/${SITE_1_ID}/audit-policy/revisions`);
      expect(res.status).to.equal(200);
      const { items } = await res.json();
      if (items.length > 1) expect(items[0].version).to.be.greaterThan(items[1].version);
    });

    it('API-15: scope-read endpoints return 501 pre-implementation', async () => {
      const res = await getHttpClient().admin.get(`/sites/${SITE_1_ID}/audit-scope/summary`);
      expect(res.status).to.equal(501);
    });
  });
}
```

- [ ] **Step 2: Write the postgres wiring file**

```js
// test/it/postgres/audit-policy.test.js
import { ctx } from './harness.js';
import { resetPostgres } from './seed.js';
import auditPolicyTests from '../shared/tests/audit-policy.js';

auditPolicyTests(() => ctx.httpClient, resetPostgres);
```

- [ ] **Step 3: Register seed cleanup** — add `audit_policy` and `audit_policy_revision` to the truncate lists in `test/it/postgres/seed.js`, and create `test/it/postgres/seed-data/audit-policy.js` exporting an empty array `export default [];` (E1's synthetic-default path needs no seed row; the PUT tests create rows).

- [ ] **Step 4: Run unit suite to confirm nothing regressed** (IT stays skipped)

Run: `npm test`
Expected: PASS; the gated IT block reports as pending/skipped.

- [ ] **Step 5: Commit**

```bash
git add test/it/shared/tests/audit-policy.js test/it/postgres/audit-policy.test.js test/it/postgres/seed-data/audit-policy.js test/it/postgres/seed.js
git commit -m "test(audit-policy): gated integration tests for policy CRUD + 409 path (SITES-47306)"
```

- [ ] **Step 6 (UNBLOCK — separate commit, after the data-service image is published):**
  1. Bump `test/it/postgres/docker-compose.yml` line 44 image tag from `v5.44.0` to the new version cut from B2 + this ticket's data-service PR.
  2. Change `describe.skip(...)` → `describe(...)` in `test/it/shared/tests/audit-policy.js`.
  3. Run `npx mocha --require test/it/postgres/harness.js --timeout 30000 test/it/postgres/audit-policy.test.js` → all green.
  4. Commit: `test(audit-policy): enable integration tests on data-service <new-tag> (SITES-47306)`.

---

## Self-Review (spec coverage → task)

| Spec section | Covered by |
|---|---|
| §2 endpoint map E1–E6 | Tasks 2–7 |
| §3.1 authZ (read org / write ASO\|LLMO) | Task 2 (read), Task 3/E2 (write entitlement), Task 6 (FACS) — gates API-8, API-9 |
| §3.2 AuditPolicyDto camelCase | Task 1 — API-1 |
| §3.3 E1 synthetic default | Task 2 — API-2 |
| §3.4 E2 full-replace via RPC, author-from-token | Task 3 — API-3, API-4 |
| §3.5 optimistic lock (expectedVersion, 0=assert-absent, 409+currentVersion) | Task 3 + Task 8 — API-5 |
| §3.6 server-side validation ceilings | Task 3 — API-6 |
| §3.7 E3 revisions newest-first, cursor | Task 4 — API-10 |
| §3.8 RPC raise → HTTP (400/409/500) | Task 3 — API-5, API-7 |
| §4.1–4.3 E4–E6 (501 until B4/B7) | Task 5 + Task 7 — API-15 |
| §5 controller/routing/OpenAPI/http-utils shape | Tasks 2–7 |
| §6 upstream B2 follow-ups | companion data-service plan + Task 8 gate |
| §7 test matrix API-1…API-16 | Tasks 1–8 (API-12/13/14 land with E4–E6 impls under B4/B7 tickets; API-16 = Task 7 docs:lint) |

**Deferred to later tickets (not this impl):** E4 real impl (B4 / SITES-46351), E5/E6 real impl (B7 / SITES-47089) — they replace the `501` stubs and add API-12/13/14 coverage when their views/RPCs exist.
