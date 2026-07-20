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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import AuditPolicyController from '../../src/controllers/audit-policy.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(sinonChai);
use(chaiAsPromised);

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

  it('returns 403 when caller is not an org member, without reading the policy', async () => {
    const client = buildClient();
    const fromSpy = sinon.spy(client, 'from');
    const controller = loadController(sinon.stub().resolves(false));
    const res = await controller.getPolicy(buildContext({ client }));
    expect(res.status).to.equal(403);
    expect(fromSpy).to.not.have.been.called;
  });

  it('returns 404 when the site does not exist', async () => {
    const controller = loadController();
    const ctx = buildContext();
    ctx.dataAccess.Site.findById = sinon.stub().resolves(null);
    const res = await controller.getPolicy(ctx);
    expect(res.status).to.equal(404);
  });

  it('returns 400 when siteId is not a valid UUID', async () => {
    const controller = loadController();
    const res = await controller.getPolicy(buildContext({ params: { siteId: 'not-a-uuid' } }));
    expect(res.status).to.equal(400);
  });

  it('returns 500 when the PostgREST client is not available', async () => {
    const controller = loadController();
    const ctx = buildContext();
    ctx.dataAccess.services.postgrestClient = undefined;
    const res = await controller.getPolicy(ctx);
    expect(res.status).to.equal(500);
  });

  it('returns 500 and logs the PostgREST error when the read fails', async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { code: '500', message: 'boom' } }) }),
        }),
      }),
      rpc: sinon.stub(),
    };
    const controller = loadController();
    const ctx = buildContext({ client });
    const res = await controller.getPolicy(ctx);
    expect(res.status).to.equal(500);
    expect(ctx.log.error).to.have.been.calledWith(sinon.match(/500.*boom/));
  });
});

// Unused until a later task's write-endpoint tests reuse it.
// eslint-disable-next-line no-unused-vars
const UPSERT_RPC = 'wrpc_upsert_audit_policy';

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

  it('floors a negative limit to 1', async () => {
    const limitSpy = sinon.stub().resolves({ data: [], error: null });
    const order = sinon.stub().returnsThis();
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ order, limit: limitSpy }) }) }),
      rpc: sinon.stub(),
    };
    const controller = loadController();
    await controller.listRevisions(buildContext({ client, params: { limit: '-5' } }));
    expect(limitSpy).to.have.been.calledWith(1);
  });

  it('returns 400 for an out-of-range cursor instead of silently falling back to page 1', async () => {
    const limitSpy = sinon.stub().resolves({ data: [], error: null });
    const order = sinon.stub().returnsThis();
    const ltSpy = sinon.stub().returnsThis();
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order, limit: limitSpy, lt: ltSpy,
          }),
        }),
      }),
      rpc: sinon.stub(),
    };
    const controller = loadController();
    // encodeCursor(Number.MAX_SAFE_INTEGER) — far beyond MAX_CURSOR_VERSION
    const tamperedCursor = Buffer.from(String(Number.MAX_SAFE_INTEGER), 'utf8').toString('base64url');
    const ctx = buildContext({ client, params: { cursor: tamperedCursor } });
    const res = await controller.listRevisions(ctx);
    expect(res.status).to.equal(400);
    expect(ltSpy).to.not.have.been.called;
    expect(limitSpy).to.not.have.been.called;
  });

  it('returns 400 for a malformed (non-numeric) cursor', async () => {
    const client = buildClient();
    const controller = loadController();
    const res = await controller.listRevisions(buildContext({ client, params: { cursor: 'not-base64-number' } }));
    expect(res.status).to.equal(400);
  });

  it('applies .lt(version, cursor) for a valid in-range cursor', async () => {
    const limitSpy = sinon.stub().resolves({ data: [], error: null });
    const order = sinon.stub().returnsThis();
    const ltSpy = sinon.stub().returnsThis();
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order, limit: limitSpy, lt: ltSpy,
          }),
        }),
      }),
      rpc: sinon.stub(),
    };
    const controller = loadController();
    const cursor = Buffer.from('5', 'utf8').toString('base64url');
    await controller.listRevisions(buildContext({ client, params: { cursor } }));
    expect(ltSpy).to.have.been.calledWith('version', 5);
  });

  it('returns 403 when the caller fails the shared read authorization, without querying revisions', async () => {
    const client = buildClient();
    const fromSpy = sinon.spy(client, 'from');
    const controller = loadController(sinon.stub().resolves(false));
    const res = await controller.listRevisions(buildContext({ client }));
    expect(res.status).to.equal(403);
    expect(fromSpy).to.not.have.been.called;
  });

  it('returns 500 and logs the PostgREST error when the read fails', async () => {
    const limitSpy = sinon.stub().resolves({ data: null, error: { code: '500', message: 'boom' } });
    const order = sinon.stub().returnsThis();
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ order, limit: limitSpy }) }) }),
      rpc: sinon.stub(),
    };
    const controller = loadController();
    const ctx = buildContext({ client });
    const res = await controller.listRevisions(ctx);
    expect(ctx.log.error).to.have.been.calledWith(sinon.match(/500.*boom/));
    expect(res.status).to.equal(500);
  });
});

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
