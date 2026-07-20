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
import { UnauthorizedProductError } from '../../src/support/errors.js';

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

const UPSERT_RPC = 'wrpc_upsert_audit_policy';

// Like buildClient, but `.maybeSingle()` and `.rpc()` each return the next
// entry in a queue on every call (needed to simulate: read v5 -> RPC 409 ->
// re-read v6 -> RPC succeeds). Each queue entry is `{ data, error }`.
function buildSequencedClient({ selectQueue, rpcQueue }) {
  let selectCall = 0;
  let rpcCall = 0;
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => {
      const next = selectQueue[Math.min(selectCall, selectQueue.length - 1)];
      selectCall += 1;
      return Promise.resolve(next);
    },
  };
  return {
    from: () => chain,
    rpc: sinon.stub().callsFake(() => {
      const next = rpcQueue[Math.min(rpcCall, rpcQueue.length - 1)];
      rpcCall += 1;
      return Promise.resolve(next);
    }),
  };
}

const ROW_V5 = {
  site_id: SITE_ID,
  version: 5,
  budget: 4000,
  strategy_name: 'tiered',
  exclusion_globs: ['/checkout/*'],
  manual_urls: [],
  scope_config: {},
  lifecycle_overrides: {},
  created_by: 'a',
  updated_by: 'a',
  reason: 'r',
  note: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('AuditPolicyController — defensive/error-handling branches', () => {
  afterEach(() => sinon.restore());

  it('hasProductAccess returns false (not throw) when hasAccess rejects with UnauthorizedProductError, letting the other product check proceed', async () => {
    const hasAccess = sinon.stub();
    hasAccess.withArgs(sinon.match.any).resolves(true);
    hasAccess.withArgs(sinon.match.any, '', 'ASO').rejects(new UnauthorizedProductError('wrong product'));
    hasAccess.withArgs(sinon.match.any, '', 'LLMO').resolves(true);
    const controller = loadController(hasAccess);
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6 }, error: null }],
    });
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/account/*'], reason: 'r' },
    }));
    expect(res.status).to.equal(200);
  });

  it('hasProductAccess propagates non-UnauthorizedProductError errors instead of swallowing them', async () => {
    const hasAccess = sinon.stub();
    hasAccess.withArgs(sinon.match.any).resolves(true);
    hasAccess.withArgs(sinon.match.any, '', 'ASO').rejects(new Error('boom'));
    hasAccess.withArgs(sinon.match.any, '', 'LLMO').resolves(true);
    const controller = loadController(hasAccess);
    await expect(controller.addExclusions(buildContext({
      data: { values: ['/account/*'], reason: 'r' },
    }))).to.be.rejectedWith('boom');
  });

  it('getAuthor falls back to "system" and logs a warning when there is no authenticated identity', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6 }, error: null }],
    });
    const controller = loadController();
    const ctx = buildContext({ client, profile: {}, data: { values: ['/account/*'], reason: 'r' } });
    const res = await controller.addExclusions(ctx);
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({ p_author: 'system' }));
    expect(ctx.log.warn).to.have.been.calledWith(sinon.match(/no authenticated identity/));
  });

  it('authorizeRead falls back to {} when context.params is entirely absent (siteId required -> 400)', async () => {
    const controller = loadController();
    // Built by hand (not via buildContext, which always supplies `params`) so the
    // `context.params || {}` fallback in authorizeRead is actually exercised.
    const ctx = {
      data: {},
      attributes: { authInfo: { getProfile: () => ({ email: 'u@x.com' }) } },
      dataAccess: {
        Site: { findById: sinon.stub().resolves({ getId: () => SITE_ID }) },
        services: { postgrestClient: buildClient() },
      },
      log: { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() },
    };
    const res = await controller.getPolicy(ctx);
    expect(res.status).to.equal(400);
  });
});

describe('AuditPolicyController — exclusions add/remove', () => {
  afterEach(() => sinon.restore());

  it('add: unions a new glob into exclusionGlobs and calls the RPC with expectedVersion = current version', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6, exclusion_globs: ['/checkout/*', '/account/*'] }, error: null }],
    });
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/account/*'], reason: 'add account exclusion' },
    }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.exclusionGlobs).to.deep.equal(['/checkout/*', '/account/*']);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_exclusion_globs: ['/checkout/*', '/account/*'],
      p_manual_urls: [],
      p_expected_version: 5,
      p_reason: 'add account exclusion',
    }));
  });

  it('add: adding an already-present glob is a no-op for that element (still 200, array unchanged)', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6 }, error: null }],
    });
    const controller = loadController();
    await controller.addExclusions(buildContext({
      client, data: { values: ['/checkout/*'], reason: 'no-op add' },
    }));
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_exclusion_globs: ['/checkout/*'],
    }));
  });

  it('add: bulk values are all unioned in one call, one revision', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6 }, error: null }],
    });
    const controller = loadController();
    await controller.addExclusions(buildContext({
      client, data: { values: ['/a/*', '/b/*', '/c/*'], reason: 'bulk add' },
    }));
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_exclusion_globs: ['/checkout/*', '/a/*', '/b/*', '/c/*'],
    }));
    expect(client.rpc).to.have.been.calledOnce;
  });

  it('remove: set-difference drops the given glob', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: { ...ROW_V5, exclusion_globs: ['/checkout/*', '/account/*'] }, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6, exclusion_globs: ['/account/*'] }, error: null }],
    });
    const controller = loadController();
    const res = await controller.removeExclusions(buildContext({
      client, data: { values: ['/checkout/*'], reason: 'remove checkout' },
    }));
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_exclusion_globs: ['/account/*'],
    }));
  });

  it('remove: removing an absent value is a no-op (still 200, array unchanged)', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6 }, error: null }],
    });
    const controller = loadController();
    await controller.removeExclusions(buildContext({
      client, data: { values: ['/never-there/*'], reason: 'no-op remove' },
    }));
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_exclusion_globs: ['/checkout/*'],
    }));
  });

  it('cap exceeded after computing the new array -> 400 before calling the RPC', async () => {
    const bigRow = { ...ROW_V5, exclusion_globs: Array.from({ length: 200 }, (_, i) => `/g${i}/*`) };
    const client = buildSequencedClient({
      selectQueue: [{ data: bigRow, error: null }],
      rpcQueue: [],
    });
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/one-too-many/*'], reason: 'over cap' },
    }));
    expect(res.status).to.equal(400);
    expect(client.rpc).to.not.have.been.called;
  });

  it('missing reason -> 400', async () => {
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      data: { values: ['/a/*'] },
    }));
    expect(res.status).to.equal(400);
  });

  it('empty values array -> 400', async () => {
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      data: { values: [], reason: 'nothing to add' },
    }));
    expect(res.status).to.equal(400);
  });

  it('body is not a JSON object (e.g. an array) -> 400', async () => {
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({ data: ['not', 'an', 'object'] }));
    expect(res.status).to.equal(400);
  });

  it('values array contains a non-string entry -> 400', async () => {
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      data: { values: [123], reason: 'r' },
    }));
    expect(res.status).to.equal(400);
  });

  it('non-string note -> 400', async () => {
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      data: { values: ['/a/*'], reason: 'r', note: 12345 },
    }));
    expect(res.status).to.equal(400);
  });

  it('mutateArray returns authorizeRead\'s own error (invalid siteId) before touching the client', async () => {
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({ params: { siteId: 'not-a-uuid' } }));
    expect(res.status).to.equal(400);
  });

  it('returns 500 and logs when the initial policy read fails inside the RPC attempt loop', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: null, error: { code: '500', message: 'boom' } }],
      rpcQueue: [],
    });
    const controller = loadController();
    const ctx = buildContext({ client, data: { values: ['/a/*'], reason: 'r' } });
    const res = await controller.addExclusions(ctx);
    expect(res.status).to.equal(500);
    expect(client.rpc).to.not.have.been.called;
    expect(ctx.log.error).to.have.been.calledWith(sinon.match(/500.*boom/));
  });

  it('RPC rejects with P0001 -> 400 and logs a validation warning', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [{ data: null, error: { code: 'P0001', message: 'some validation message' } }],
    });
    const controller = loadController();
    const ctx = buildContext({ client, data: { values: ['/account/*'], reason: 'r' } });
    const res = await controller.addExclusions(ctx);
    expect(res.status).to.equal(400);
    expect(ctx.log.warn).to.have.been.calledWith(sinon.match(/P0001/));
  });

  it('conflict then retry succeeds: re-reads fresh version and reapplies', async () => {
    const client = buildSequencedClient({
      selectQueue: [
        { data: ROW_V5, error: null },
        { data: { ...ROW_V5, version: 6 }, error: null },
      ],
      rpcQueue: [
        { data: null, error: { code: '40000', details: '6' } },
        { data: { ...ROW_V5, version: 7, exclusion_globs: ['/checkout/*', '/account/*'] }, error: null },
      ],
    });
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/account/*'], reason: 'retry add' },
    }));
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledTwice;
    expect(client.rpc.secondCall).to.have.been.calledWith(
      UPSERT_RPC,
      sinon.match({ p_expected_version: 6 }),
    );
  });

  it('conflict on every attempt exhausts retries -> 409 with currentVersion', async () => {
    const conflict = { data: null, error: { code: '40000', details: '9' } };
    const client = buildSequencedClient({
      selectQueue: [
        { data: ROW_V5, error: null },
        { data: { ...ROW_V5, version: 6 }, error: null },
        { data: { ...ROW_V5, version: 7 }, error: null },
      ],
      rpcQueue: [conflict, conflict, conflict],
    });
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/account/*'], reason: 'always conflicts' },
    }));
    expect(res.status).to.equal(409);
    const body = await res.json();
    expect(body.currentVersion).to.equal(9);
    expect(client.rpc).to.have.been.calledThrice;
  });

  it('conflict on every attempt with non-numeric error.details omits currentVersion from the 409 body', async () => {
    const conflict = { data: null, error: { code: '40000', details: undefined } };
    const client = buildSequencedClient({
      selectQueue: [
        { data: ROW_V5, error: null },
        { data: { ...ROW_V5, version: 6 }, error: null },
        { data: { ...ROW_V5, version: 7 }, error: null },
      ],
      rpcQueue: [conflict, conflict, conflict],
    });
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/account/*'], reason: 'always conflicts, no version details' },
    }));
    expect(res.status).to.equal(409);
    const body = await res.json();
    expect(body).to.not.have.property('currentVersion');
  });

  it('first-write bootstrap: no existing row -> uses synthetic defaults and expectedVersion 0', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: null, error: null }],
      rpcQueue: [{
        data: {
          site_id: SITE_ID,
          version: 1,
          budget: 5000,
          strategy_name: 'tiered',
          exclusion_globs: ['/checkout/*'],
          manual_urls: [],
          scope_config: {},
          lifecycle_overrides: {},
          created_by: 'u@x.com',
          updated_by: 'u@x.com',
          reason: 'first policy',
          note: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        error: null,
      }],
    });
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/checkout/*'], reason: 'first policy' },
    }));
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_budget: 5000,
      p_strategy_name: 'tiered',
      p_expected_version: 0,
    }));
  });

  it('returns 403 when caller lacks both ASO and LLMO entitlement', async () => {
    // Same idiom as the (removed) E2 putPolicy test: hasAccess(site) -> true (org member);
    // hasAccess(site,'','ASO') and (...,'LLMO') -> false.
    const hasAccess = sinon.stub();
    hasAccess.withArgs(sinon.match.any).resolves(true);
    hasAccess.withArgs(sinon.match.any, '', 'ASO').resolves(false);
    hasAccess.withArgs(sinon.match.any, '', 'LLMO').resolves(false);
    const controller = loadController(hasAccess);
    const res = await controller.addExclusions(buildContext({ data: { values: ['/a/*'], reason: 'r' } }));
    expect(res.status).to.equal(403);
  });

  it('exclusion glob containing a path-traversal sequence (../) -> 400', async () => {
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      data: { values: ['/checkout/../admin/*'], reason: 'r' },
    }));
    expect(res.status).to.equal(400);
    const body = await res.json();
    expect(body.message).to.match(/path-traversal/);
  });

  it('exclusion glob containing ../ is rejected even alongside otherwise-valid globs, before the RPC is called', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [],
    });
    const controller = loadController();
    const res = await controller.removeExclusions(buildContext({
      client, data: { values: ['/checkout/*', '../etc/passwd'], reason: 'r' },
    }));
    expect(res.status).to.equal(400);
    expect(client.rpc).to.not.have.been.called;
  });
});

describe('AuditPolicyController — inclusions add/remove', () => {
  afterEach(() => sinon.restore());

  it('add: unions a new URL into manualUrls and calls the RPC against manual_urls, not exclusion_globs', async () => {
    const row = { ...ROW_V5, manual_urls: ['https://example.com/a'] };
    const client = buildSequencedClient({
      selectQueue: [{ data: row, error: null }],
      rpcQueue: [{ data: { ...row, version: 6, manual_urls: ['https://example.com/a', 'https://example.com/b'] }, error: null }],
    });
    const controller = loadController();
    const res = await controller.addInclusions(buildContext({
      client, data: { values: ['https://example.com/b'], reason: 'add partner page' },
    }));
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_manual_urls: ['https://example.com/a', 'https://example.com/b'],
      p_exclusion_globs: ['/checkout/*'],
    }));
  });

  it('remove: set-difference drops the given URL from manualUrls', async () => {
    const row = { ...ROW_V5, manual_urls: ['https://example.com/a', 'https://example.com/b'] };
    const client = buildSequencedClient({
      selectQueue: [{ data: row, error: null }],
      rpcQueue: [{ data: { ...row, version: 6, manual_urls: ['https://example.com/a'] }, error: null }],
    });
    const controller = loadController();
    const res = await controller.removeInclusions(buildContext({
      client, data: { values: ['https://example.com/b'], reason: 'remove partner page' },
    }));
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_manual_urls: ['https://example.com/a'],
    }));
  });

  it('cap exceeded uses the manualUrls cap (2000), not exclusionGlobs\' (200)', async () => {
    const bigRow = { ...ROW_V5, manual_urls: Array.from({ length: 2000 }, (_, i) => `https://example.com/p${i}`) };
    const client = buildSequencedClient({
      selectQueue: [{ data: bigRow, error: null }],
      rpcQueue: [],
    });
    const controller = loadController();
    const res = await controller.addInclusions(buildContext({
      client, data: { values: ['https://example.com/one-too-many'], reason: 'over cap' },
    }));
    expect(res.status).to.equal(400);
    expect(client.rpc).to.not.have.been.called;
  });

  it('inclusion URL containing ../ in its path is still accepted (path-traversal check is exclusions-only)', async () => {
    const row = { ...ROW_V5, manual_urls: [] };
    const client = buildSequencedClient({
      selectQueue: [{ data: row, error: null }],
      rpcQueue: [{ data: { ...row, version: 6, manual_urls: ['https://example.com/a/../b'] }, error: null }],
    });
    const controller = loadController();
    const res = await controller.addInclusions(buildContext({
      client, data: { values: ['https://example.com/a/../b'], reason: 'add url with ../ in path' },
    }));
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_manual_urls: ['https://example.com/a/../b'],
    }));
  });
});

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

  it('returns an empty items array (not throwing) when the terminal query resolves data: null', async () => {
    const limitSpy = sinon.stub().resolves({ data: null, error: null });
    const order = sinon.stub().returnsThis();
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ order, limit: limitSpy }) }) }),
      rpc: sinon.stub(),
    };
    const controller = loadController();
    const res = await controller.listRevisions(buildContext({ client }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.items).to.deep.equal([]);
    expect(body.cursor).to.be.undefined;
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
