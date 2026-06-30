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
