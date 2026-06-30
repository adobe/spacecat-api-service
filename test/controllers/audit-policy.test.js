/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import AuditPolicyController from '../../src/controllers/audit-policy.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(sinonChai);

const SITE_ID = '7b2e3f9c-0000-4000-8000-000000000001';

function loadController(hasAccess = sinon.stub().resolves(true)) {
  if (AccessControlUtil.fromContext.restore) {
    AccessControlUtil.fromContext.restore();
  }
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
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data: revisions, error: null }),
    limit: () => chain,
    maybeSingle: single,
    single,
  };
  return {
    from: () => chain,
    rpc: sinon.stub().callsFake(() => Promise.resolve(rpcResult ?? { data: row, error: null })),
  };
}

function buildContext({
  client, params = {}, data = {}, profile = { email: 'u@x.com' },
} = {}) {
  return {
    params: { siteId: SITE_ID, ...params },
    data,
    attributes: { authInfo: { getProfile: () => profile } },
    dataAccess: {
      Site: { findById: sinon.stub().resolves({ getId: () => SITE_ID }) },
      services: { postgrestClient: client || buildClient() },
    },
    log: {
      info: sinon.stub(), error: sinon.stub(), warn: sinon.stub(),
    },
  };
}

describe('AuditPolicyController — E1 getPolicy', () => {
  afterEach(() => sinon.restore());

  it('returns 200 with the current policy mapped to camelCase', async () => {
    const row = {
      site_id: SITE_ID,
      version: 3,
      budget: 4000,
      strategy_name: 'tiered',
      exclusion_globs: [],
      manual_urls: [],
      scope_config: {},
      lifecycle_overrides: {},
      created_by: 'a',
      updated_by: 'b',
      reason: 'r',
      note: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
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

const UPSERT_RPC = 'wrpc_upsert_audit_policy';

describe('AuditPolicyController — E2 putPolicy', () => {
  afterEach(() => sinon.restore());

  function writeCtx(body, opts = {}) {
    return buildContext({ data: body, ...opts });
  }
  const validBody = {
    budget: 4000,
    strategyName: 'tiered',
    exclusionGlobs: ['/checkout/*'],
    manualUrls: [],
    scopeConfig: {},
    lifecycleOverrides: {},
    reason: 'trim crawl',
    note: 'q2',
    expectedVersion: 3,
  };

  it('writes via wrpc with token-derived author and returns 200 v+1', async () => {
    const newRow = {
      site_id: SITE_ID,
      version: 4,
      budget: 4000,
      strategy_name: 'tiered',
      exclusion_globs: ['/checkout/*'],
      manual_urls: [],
      scope_config: {},
      lifecycle_overrides: {},
      created_by: 'a',
      updated_by: 'u@x.com',
      reason: 'trim crawl',
      note: 'q2',
      created_at: 'x',
      updated_at: 'y',
    };
    const client = buildClient({ rpcResult: { data: newRow, error: null } });
    const controller = loadController();
    const res = await controller.putPolicy(writeCtx({ ...validBody, author: 'FORGED' }, { client }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.version).to.equal(4);
    expect(body.updatedBy).to.equal('u@x.com');
    expect(client.rpc).to.have.been.calledWith(
      UPSERT_RPC,
      sinon.match({ p_author: 'u@x.com', p_expected_version: 3 }),
    );
    // author from body must be ignored
    expect(client.rpc.firstCall.args[1]).to.not.have.property('p_author', 'FORGED');
  });

  it('returns 400 when reason is missing', async () => {
    const controller = loadController();
    const noReason = { ...validBody, reason: undefined };
    const res = await controller.putPolicy(writeCtx(noReason));
    expect(res.status).to.equal(400);
  });

  it('returns 400 when expectedVersion is missing', async () => {
    const controller = loadController();
    const noVer = { ...validBody, expectedVersion: undefined };
    const res = await controller.putPolicy(writeCtx(noVer));
    expect(res.status).to.equal(400);
  });

  it('returns 400 when budget <= 0 or globs over cap', async () => {
    const controller = loadController();
    const zeroBudgetRes = await controller.putPolicy(writeCtx({ ...validBody, budget: 0 }));
    expect(zeroBudgetRes.status).to.equal(400);
    const tooMany = Array.from({ length: 1001 }, (_, i) => `/p${i}/*`);
    const tooManyGlobsRes = await controller.putPolicy(
      writeCtx({ ...validBody, exclusionGlobs: tooMany }),
    );
    expect(tooManyGlobsRes.status).to.equal(400);
  });

  it('maps SQLSTATE 40001 to 409 with currentVersion from error.details', async () => {
    const client = buildClient({
      rpcResult: {
        data: null,
        error: { code: '40001', message: 'audit_policy_version_conflict', details: '7' },
      },
    });
    const controller = loadController();
    const res = await controller.putPolicy(writeCtx(validBody, { client }));
    expect(res.status).to.equal(409);
    const body = await res.json();
    expect(body.currentVersion).to.equal(7);
  });

  it('maps a redaction/validation RPC raise (P0001) to 400', async () => {
    const client = buildClient({
      rpcResult: { data: null, error: { code: 'P0001', message: 'secret detected in note' } },
    });
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

describe('AuditPolicyController — E3 listRevisions', () => {
  afterEach(() => sinon.restore());

  it('returns revisions newest-first with a cursor when a full page is returned', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({
      version: 4 - i,
      budget: 4000,
      strategy_name: 'tiered',
      exclusion_globs: [],
      manual_urls: [],
      scope_config: {},
      lifecycle_overrides: {},
      updated_by: 'b',
      reason: 'r',
      note: null,
      effective_at: 'e',
      superseded_at: 's',
    }));
    // Real PostgREST client chaining: select/eq/order are synchronous and chainable
    // (returnsThis); only the terminal limit() call resolves { data, error } — see
    // makeWeeksChainClient in test/controllers/llmo/llmo-referral-traffic.test.js.
    const orderSpy = sinon.stub().returnsThis();
    const limitSpy = sinon.stub().resolves({ data: rows, error: null });
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ order: orderSpy, limit: limitSpy }) }),
      }),
      rpc: sinon.stub(),
    };
    const controller = loadController();
    const res = await controller.listRevisions(buildContext({ client, params: { limit: '2' } }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.items[0].version).to.equal(4);
    expect(body.items).to.have.length(2);
    expect(body.cursor).to.be.a('string'); // full page -> next cursor present
    expect(orderSpy).to.have.been.calledWith('version', { ascending: false });
  });

  it('clamps limit to 200 max', async () => {
    const limitSpy = sinon.stub().resolves({ data: [], error: null });
    const order = sinon.stub().returnsThis();
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ order, limit: limitSpy }) }) }),
      rpc: sinon.stub(),
    };
    const controller = loadController();
    await controller.listRevisions(buildContext({ client, params: { limit: '9999' } }));
    expect(limitSpy).to.have.been.calledWith(200);
  });
});
