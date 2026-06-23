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
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

import AgenticCategoriesController from '../../src/controllers/agentic-categories.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(sinonChai);

const SITE_ID = '0178a3f0-1234-7000-8000-000000000001';

// Builds a postgrestClient mock that captures the table name + last
// resolved value. Tests can override `resolveWith` per-call to simulate
// success/error/not-found.
function buildClient({
  resolveWith = { data: [], error: null },
  lastResolveByOp = {},
} = {}) {
  const ops = [];
  function chain(initialOp) {
    // eslint-disable-next-line no-underscore-dangle
    const c = { _ops: [initialOp] };
    const tracker = (op) => function track(...args) {
      // eslint-disable-next-line no-underscore-dangle
      c._ops.push({ op, args });
      // operations that resolve the promise
      if (['maybeSingle', 'single'].includes(op)) {
        return Promise.resolve(lastResolveByOp[op] ?? resolveWith);
      }
      return c;
    };
    c.select = tracker('select');
    c.insert = tracker('insert');
    c.update = tracker('update');
    c.delete = tracker('delete');
    c.eq = tracker('eq');
    c.limit = tracker('limit');
    c.order = (...args) => {
      // eslint-disable-next-line no-underscore-dangle
      c._ops.push({ op: 'order', args });
      return Promise.resolve(lastResolveByOp.order ?? resolveWith);
    };
    c.maybeSingle = tracker('maybeSingle');
    c.single = tracker('single');
    return c;
  }
  return {
    from: (table) => {
      const c = chain({ op: 'from', table });
      ops.push(c);
      return c;
    },
    _ops: ops,
  };
}

function buildContext({
  accessControl, client, params = {}, data = {},
} = {}) {
  return {
    params: { siteId: SITE_ID, ...params },
    data,
    attributes: {
      authInfo: new AuthInfo().withType('jwt').withProfile({ user_id: 'u' }).withAuthenticated(true),
    },
    dataAccess: {
      Site: { findById: sinon.stub().resolves({ getId: () => SITE_ID }) },
      services: { postgrestClient: client || buildClient() },
    },
    log: { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() },
    _accessControl: accessControl,
  };
}

function loadController(
  mockHasAccess = sinon.stub().resolves(true),
  mockIsAdmin = sinon.stub().returns(true),
) {
  // Restore prior stub before re-applying to keep tests independent.
  if (AccessControlUtil.fromContext.restore) {
    AccessControlUtil.fromContext.restore();
  }
  sinon.stub(AccessControlUtil, 'fromContext').returns({
    hasAccess: mockHasAccess,
    hasAdminAccess: sinon.stub().returns(false),
    isLLMOAdministrator: mockIsAdmin,
  });
  return { controller: AgenticCategoriesController(), mockHasAccess };
}

describe('AgenticCategoriesController', () => {
  afterEach(() => sinon.restore());

  it('exposes four handlers', async () => {
    const { controller } = loadController();
    expect(controller.list).to.be.a('function');
    expect(controller.create).to.be.a('function');
    expect(controller.update).to.be.a('function');
    expect(controller.remove).to.be.a('function');
  });

  // ───── auth + setup gates ─────
  it('returns 400 on missing/invalid siteId', async () => {
    const { controller } = loadController();
    const ctx = buildContext({ params: { siteId: 'not-a-uuid' } });
    const res = await controller.list(ctx);
    expect(res.status).to.equal(400);
  });

  it('returns 500 when dataAccess is missing', async () => {
    const { controller } = loadController();
    const ctx = buildContext();
    delete ctx.dataAccess;
    const res = await controller.list(ctx);
    expect(res.status).to.equal(500);
  });

  it('returns 500 when postgrestClient is unavailable (server misconfig, not bad input)', async () => {
    const { controller } = loadController();
    const ctx = buildContext();
    ctx.dataAccess.services = {};
    const res = await controller.list(ctx);
    expect(res.status).to.equal(500);
  });

  it('returns 404 when site is missing', async () => {
    const { controller } = loadController();
    const ctx = buildContext();
    ctx.dataAccess.Site.findById = sinon.stub().resolves(null);
    const res = await controller.list(ctx);
    expect(res.status).to.equal(404);
  });

  it('returns 403 when access is denied', async () => {
    const denied = sinon.stub().resolves(false);
    const { controller } = loadController(denied);
    const res = await controller.list(buildContext());
    expect(res.status).to.equal(403);
  });

  it('create/update/remove all enforce the auth gate', async () => {
    const denied = sinon.stub().resolves(false);
    const { controller } = loadController(denied);
    const create = await controller.create(buildContext({ data: { name: 'c', urls: ['/a'] } }));
    const update = await controller.update(buildContext({ params: { name: 'c' }, data: { urls: ['/a'] } }));
    const remove = await controller.remove(buildContext({ params: { name: 'c' } }));
    expect(create.status).to.equal(403);
    expect(update.status).to.equal(403);
    expect(remove.status).to.equal(403);
  });

  it('create/update/remove require LLMO administrator (403 for org member, non-admin)', async () => {
    // org member (hasAccess true) but NOT an LLMO admin → writes forbidden
    const { controller } = loadController(sinon.stub().resolves(true), sinon.stub().returns(false));
    const create = await controller.create(buildContext({ data: { name: 'c', urls: ['/a'] } }));
    const update = await controller.update(buildContext({ params: { name: 'c' }, data: { urls: ['/a'] } }));
    const remove = await controller.remove(buildContext({ params: { name: 'c' } }));
    expect(create.status).to.equal(403);
    expect(update.status).to.equal(403);
    expect(remove.status).to.equal(403);
  });

  it('list does NOT require LLMO administrator (org membership is enough)', async () => {
    const client = buildClient({ resolveWith: { data: [], error: null } });
    const { controller } = loadController(sinon.stub().resolves(true), sinon.stub().returns(false));
    const res = await controller.list(buildContext({ client }));
    expect(res.status).to.equal(200);
  });

  // ───── list ─────
  it('list returns rows from PostgREST, mapped to the camelCase DTO', async () => {
    const client = buildClient({
      resolveWith: {
        data: [{
          id: 'r1',
          site_id: SITE_ID,
          name: 'cat-1',
          regex: '(?i)/cat',
          sort_order: 2,
          source: 'human',
          sample_urls: ['/cat/a'],
          derivation_method: 'customer',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          created_by: 'author',
          updated_by: 'u',
        }],
        error: null,
      },
    });
    const { controller } = loadController();
    const res = await controller.list(buildContext({ client }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    // snake_case columns must surface as camelCase, no raw column leak.
    expect(body.items).to.deep.equal([{
      id: 'r1',
      siteId: SITE_ID,
      name: 'cat-1',
      regex: '(?i)/cat',
      sortOrder: 2,
      source: 'human',
      sampleUrls: ['/cat/a'],
      derivationMethod: 'customer',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      createdBy: 'author',
      updatedBy: 'u',
    }]);
    expect(body.items[0]).to.not.have.any.keys('site_id', 'sample_urls', 'sort_order', 'derivation_method');
  });

  it('list returns 500 on PostgREST error', async () => {
    const client = buildClient({ resolveWith: { data: null, error: { message: 'boom' } } });
    const { controller } = loadController();
    const res = await controller.list(buildContext({ client }));
    expect(res.status).to.equal(500);
  });

  // ───── create ─────
  it('create returns 400 when name missing', async () => {
    const { controller } = loadController();
    const res = await controller.create(buildContext({ data: { urls: ['/a'] } }));
    expect(res.status).to.equal(400);
  });

  it('create returns 400 when urls missing', async () => {
    const { controller } = loadController();
    const res = await controller.create(buildContext({ data: { name: 'x' } }));
    expect(res.status).to.equal(400);
  });

  it('create returns 400 when regex cannot be derived', async () => {
    const { controller } = loadController();
    const res = await controller.create(buildContext({ data: { name: 'x', urls: [42] } }));
    expect(res.status).to.equal(400);
  });

  it('create returns 400 when regexFromUrls throws (urls exceed the regex length cap)', async () => {
    // Valid strings (pass isValidUrlListBody) but a 600-char shared segment makes
    // every derivation strategy exceed MAX_REGEX_LEN, so regexFromUrls throws.
    const seg = 'a'.repeat(600);
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      data: { name: 'x', urls: [`/${seg}/x`, `/${seg}/y`] },
    }));
    expect(res.status).to.equal(400);
  });

  it('create returns 400 when urls exceeds the 50-item cap', async () => {
    const { controller } = loadController();
    const urls = Array.from({ length: 51 }, (_, i) => `/p/${i}`);
    const res = await controller.create(buildContext({ data: { name: 'x', urls } }));
    expect(res.status).to.equal(400);
  });

  it('create returns 400 when a url exceeds the 2048-char cap', async () => {
    const { controller } = loadController();
    const longUrl = `/${'a'.repeat(2048)}`;
    const res = await controller.create(buildContext({ data: { name: 'x', urls: [longUrl] } }));
    expect(res.status).to.equal(400);
  });

  it('create returns 400 when name exceeds the 200-char cap', async () => {
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      data: { name: 'a'.repeat(201), urls: ['/products/photoshop/a'] },
    }));
    expect(res.status).to.equal(400);
  });

  it('create returns 400 when name is only whitespace', async () => {
    const { controller } = loadController();
    const res = await controller.create(buildContext({ data: { name: '   ', urls: ['/a'] } }));
    expect(res.status).to.equal(400);
  });

  it('list bounds the scan with a limit of 1000', async () => {
    const client = buildClient({ resolveWith: { data: [], error: null } });
    const { controller } = loadController();
    await controller.list(buildContext({ client }));
    // eslint-disable-next-line no-underscore-dangle
    const limitOp = client._ops[0]._ops.find((o) => o.op === 'limit');
    expect(limitOp).to.not.equal(undefined);
    expect(limitOp.args[0]).to.equal(1000);
  });

  it('list warns when the result hits the scan cap (silent truncation)', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, name: `c${i}` }));
    const client = buildClient({ resolveWith: { data: rows, error: null } });
    const ctx = buildContext({ client });
    const { controller } = loadController();
    const res = await controller.list(ctx);
    expect(res.status).to.equal(200);
    expect(ctx.log.warn).to.have.been.calledWithMatch(/truncated at 1000/);
  });

  it('create persists with source=human and returns the new row', async () => {
    const client = buildClient({
      resolveWith: { data: { name: 'photoshop', source: 'human' }, error: null },
    });
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      client,
      data: { name: 'photoshop', urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    }));
    expect(res.status).to.equal(201);
    const body = await res.json();
    expect(body.source).to.equal('human');
  });

  it('create returns 500 on PostgREST insert error', async () => {
    const client = buildClient({ resolveWith: { data: null, error: { message: 'dup' } } });
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      client,
      data: { name: 'photoshop', urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    }));
    expect(res.status).to.equal(500);
  });

  it('create returns 409 on a duplicate-name unique violation (PG 23505)', async () => {
    const client = buildClient({
      resolveWith: { data: null, error: { code: '23505', message: 'duplicate key value' } },
    });
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      client,
      data: { name: 'photoshop', urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    }));
    expect(res.status).to.equal(409);
    const body = await res.json();
    expect(body.message).to.match(/already exists/);
  });

  it('create returns 500 when the insert returns no row (data null, no error)', async () => {
    const client = buildClient({ resolveWith: { data: null, error: null } });
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      client,
      data: { name: 'photoshop', urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    }));
    expect(res.status).to.equal(500);
  });

  // ───── update ─────
  it('update returns 400 when name path param missing', async () => {
    const { controller } = loadController();
    const ctx = buildContext({ params: { name: '' }, data: { urls: ['/a'] } });
    const res = await controller.update(ctx);
    expect(res.status).to.equal(400);
  });

  it('update returns 400 on an empty patch (no newName, urls, or newRegex)', async () => {
    // Guards against silently flipping source ai→human with no content change.
    const { controller } = loadController();
    const ctx = buildContext({ params: { name: 'foo' }, data: {} });
    const res = await controller.update(ctx);
    expect(res.status).to.equal(400);
  });

  it('update returns 400 when newName is provided but empty', async () => {
    const { controller } = loadController();
    const ctx = buildContext({ params: { name: 'foo' }, data: { newName: '' } });
    const res = await controller.update(ctx);
    expect(res.status).to.equal(400);
  });

  it('update returns 400 when newName exceeds the 200-char cap', async () => {
    const { controller } = loadController();
    const ctx = buildContext({ params: { name: 'foo' }, data: { newName: 'a'.repeat(201) } });
    const res = await controller.update(ctx);
    expect(res.status).to.equal(400);
  });

  it('update returns 400 when urls exceeds the 50-item cap', async () => {
    const client = buildClient({ resolveWith: { data: { name: 'foo', source: 'human' }, error: null } });
    const { controller } = loadController();
    const urls = Array.from({ length: 51 }, (_, i) => `/p/${i}`);
    const res = await controller.update(buildContext({
      client, params: { name: 'foo' }, data: { urls },
    }));
    expect(res.status).to.equal(400);
  });

  it('update returns 400 when a url exceeds the 2048-char cap', async () => {
    const client = buildClient({ resolveWith: { data: { name: 'foo', source: 'human' }, error: null } });
    const { controller } = loadController();
    const longUrl = `/${'a'.repeat(2048)}`;
    const res = await controller.update(buildContext({
      client, params: { name: 'foo' }, data: { urls: [longUrl] },
    }));
    expect(res.status).to.equal(400);
  });

  it('update returns 400 when both urls and newRegex supplied', async () => {
    const { controller } = loadController();
    const ctx = buildContext({
      params: { name: 'foo' },
      data: { urls: ['/a'], newRegex: '^/a' },
    });
    const res = await controller.update(ctx);
    expect(res.status).to.equal(400);
  });

  it('update returns 500 when fetch errors', async () => {
    const client = buildClient({ resolveWith: { data: null, error: { message: 'boom' } } });
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'foo' },
      data: { newName: 'bar' },
    }));
    expect(res.status).to.equal(500);
  });

  it('update returns 404 when rule is missing', async () => {
    const client = buildClient({ resolveWith: { data: null, error: null } });
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'foo' },
      data: { newName: 'bar' },
    }));
    expect(res.status).to.equal(404);
  });

  it('update marks the rule source=human when previous source was ai', async () => {
    // Two maybeSingle resolutions: first the SELECT (returns ai row),
    // second the UPDATE (returns the patched, human-owned row).
    let call = 0;
    const client = {
      from: () => {
        const c = {};
        c.select = () => c;
        c.update = () => c;
        c.eq = () => c;
        c.limit = () => c;
        c.maybeSingle = () => {
          call += 1;
          return call === 1
            ? Promise.resolve({ data: { name: 'foo', source: 'ai' }, error: null })
            : Promise.resolve({ data: { name: 'foo', source: 'human' }, error: null });
        };
        return c;
      },
    };
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'foo' },
      data: { urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.source).to.equal('human');
  });

  it('update accepts newRegex (advanced) and validates it', async () => {
    let call = 0;
    const client = {
      from: () => {
        const c = {};
        c.select = () => c;
        c.update = () => c;
        c.eq = () => c;
        c.maybeSingle = () => {
          call += 1;
          return call === 1
            ? Promise.resolve({ data: { name: 'foo', source: 'human' }, error: null })
            : Promise.resolve({ data: { name: 'foo', regex: '^/x' }, error: null });
        };
        return c;
      },
    };
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'foo' },
      data: { newRegex: '^/x' },
    }));
    expect(res.status).to.equal(200);
  });

  it('update returns 400 when urls list is invalid', async () => {
    const client = buildClient({ resolveWith: { data: { name: 'foo', source: 'human' }, error: null } });
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'foo' },
      data: { urls: [] },
    }));
    expect(res.status).to.equal(400);
  });

  it('update returns 400 when urls cannot derive regex', async () => {
    const client = buildClient({ resolveWith: { data: { name: 'foo', source: 'human' }, error: null } });
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'foo' },
      data: { urls: [42] },
    }));
    expect(res.status).to.equal(400);
  });

  it('update returns 400 when regexFromUrls throws (urls exceed the regex length cap)', async () => {
    const seg = 'a'.repeat(600);
    const client = buildClient({ resolveWith: { data: { name: 'foo', source: 'human' }, error: null } });
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'foo' },
      data: { urls: [`/${seg}/x`, `/${seg}/y`] },
    }));
    expect(res.status).to.equal(400);
  });

  it('update returns 400 when newRegex is invalid', async () => {
    const client = buildClient({ resolveWith: { data: { name: 'foo', source: 'human' }, error: null } });
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'foo' },
      data: { newRegex: '' },
    }));
    expect(res.status).to.equal(400);
  });

  it('update returns 400 for a newRegex with catastrophic backtracking (ReDoS)', async () => {
    const client = buildClient({ resolveWith: { data: { name: 'foo', source: 'human' }, error: null } });
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'foo' },
      data: { newRegex: '(a+)+$' },
    }));
    expect(res.status).to.equal(400);
  });

  it('update returns 500 on update error', async () => {
    let call = 0;
    const client = {
      from: () => {
        const c = {};
        c.select = () => c;
        c.update = () => c;
        c.eq = () => c;
        c.maybeSingle = () => {
          call += 1;
          return call === 1
            ? Promise.resolve({ data: { name: 'foo', source: 'human' }, error: null })
            : Promise.resolve({ data: null, error: { message: 'boom' } });
        };
        return c;
      },
    };
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'foo' },
      data: { newName: 'bar' },
    }));
    expect(res.status).to.equal(500);
  });

  it('update returns 404 when update returns no row', async () => {
    let call = 0;
    const client = {
      from: () => {
        const c = {};
        c.select = () => c;
        c.update = () => c;
        c.eq = () => c;
        c.maybeSingle = () => {
          call += 1;
          return call === 1
            ? Promise.resolve({ data: { name: 'foo', source: 'human' }, error: null })
            : Promise.resolve({ data: null, error: null });
        };
        return c;
      },
    };
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'foo' },
      data: { newName: 'bar' },
    }));
    expect(res.status).to.equal(404);
  });

  // ───── remove ─────
  it('remove returns 400 when name missing', async () => {
    const { controller } = loadController();
    const res = await controller.remove(buildContext({ params: { name: '' } }));
    expect(res.status).to.equal(400);
  });

  it('remove deletes and returns 200', async () => {
    const client = buildClient({ resolveWith: { data: { name: 'foo' }, error: null } });
    const { controller } = loadController();
    const res = await controller.remove(buildContext({ client, params: { name: 'foo' } }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.deleted).to.equal(true);
    expect(body.name).to.equal('foo');
  });

  it('remove URL-decodes the name before querying and echoes the decoded name', async () => {
    const client = buildClient({ resolveWith: { data: { name: 'Blog Posts' }, error: null } });
    const { controller } = loadController();
    const res = await controller.remove(buildContext({ client, params: { name: 'Blog%20Posts' } }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.name).to.equal('Blog Posts');
    // eslint-disable-next-line no-underscore-dangle
    const nameEq = client._ops[0]._ops.find((o) => o.op === 'eq' && o.args[0] === 'name');
    expect(nameEq.args[1]).to.equal('Blog Posts');
  });

  it('remove returns 400 when the name is malformed percent-encoding', async () => {
    const { controller } = loadController();
    const res = await controller.remove(buildContext({ params: { name: '%E0%A4%A' } }));
    expect(res.status).to.equal(400);
  });

  it('update URL-decodes the name before querying', async () => {
    const client = buildClient({ resolveWith: { data: { name: 'Blog Posts', source: 'human' }, error: null } });
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'Blog%20Posts' },
      data: { newName: 'Articles' },
    }));
    expect(res.status).to.equal(200);
    // eslint-disable-next-line no-underscore-dangle
    const nameEq = client._ops[0]._ops.find((o) => o.op === 'eq' && o.args[0] === 'name');
    expect(nameEq.args[1]).to.equal('Blog Posts');
  });

  it('update returns 400 when the name is malformed percent-encoding', async () => {
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      params: { name: '%E0%A4%A' },
      data: { newName: 'x' },
    }));
    expect(res.status).to.equal(400);
  });

  it('remove returns 404 when row missing', async () => {
    const client = buildClient({ resolveWith: { data: null, error: null } });
    const { controller } = loadController();
    const res = await controller.remove(buildContext({ client, params: { name: 'foo' } }));
    expect(res.status).to.equal(404);
  });

  it('remove returns 500 on PostgREST error', async () => {
    const client = buildClient({ resolveWith: { data: null, error: { message: 'boom' } } });
    const { controller } = loadController();
    const res = await controller.remove(buildContext({ client, params: { name: 'foo' } }));
    expect(res.status).to.equal(500);
  });

  // ───── sample-URL cross-rule uniqueness ─────
  // A chain that is thenable (resolves the dedup SELECT to `dedupRows`) and also
  // exposes maybeSingle (resolves write ops to `single`). Tracks ops for asserts.
  function dedupClient(dedupRows, single = { data: { name: 'x' }, error: null }, dedupError = null) {
    const opsLog = [];
    const c = {};
    const track = (op) => (...args) => {
      opsLog.push({ op, args });
      return c;
    };
    c.select = track('select');
    c.insert = track('insert');
    c.update = track('update');
    c.eq = track('eq');
    c.limit = track('limit');
    c.maybeSingle = () => Promise.resolve(single);
    c.then = (resolve) => Promise.resolve({ data: dedupRows, error: dedupError }).then(resolve);
    return { from: () => c, capturedOps: opsLog };
  }

  it('create returns 409 when a sample URL already belongs to another rule', async () => {
    const client = dedupClient([{ name: 'acrobat', sample_urls: ['/products/acrobat/a'] }]);
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      client,
      // shares /products/acrobat/a (normalized) with the existing rule
      data: { name: 'photoshop', urls: ['/products/acrobat/a/', '/products/photoshop/x'] },
    }));
    expect(res.status).to.equal(409);
    const body = await res.json();
    expect(body.message).to.match(/already belongs to category rule "acrobat"/);
  });

  it('create detects a cross-format sample-URL conflict (full URL / locale vs stored path)', async () => {
    // Stored path is "/products/acrobat/a"; the new samples are the same content
    // as a full URL and a locale-prefixed path — must still be detected.
    const client = dedupClient([{ name: 'acrobat', sample_urls: ['/products/acrobat/a'] }]);
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      client,
      data: { name: 'photoshop', urls: ['https://x.com/en-us/products/acrobat/a', '/products/photoshop/x'] },
    }));
    expect(res.status).to.equal(409);
    expect((await res.json()).message).to.match(/already belongs to category rule "acrobat"/);
  });

  it('create returns 409 when the site is at the 20-rule cap', async () => {
    const existing = Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, sample_urls: [] }));
    const client = dedupClient(existing);
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      client,
      data: { name: 'twentyfirst', urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    }));
    expect(res.status).to.equal(409);
    const body = await res.json();
    expect(body.message).to.match(/maximum of 20 active category rules/);
  });

  it('create succeeds at 19 existing rules (cap boundary is >= 20)', async () => {
    const existing = Array.from({ length: 19 }, (_, i) => ({ name: `c${i}`, sample_urls: [] }));
    const client = dedupClient(existing, { data: { name: 'twentieth' }, error: null });
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      client,
      data: { name: 'twentieth', urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    }));
    expect(res.status).to.equal(201);
  });

  it('create stamps both created_by and updated_by from the auth profile', async () => {
    const client = dedupClient([], { data: { name: 'photoshop' }, error: null });
    const ctx = buildContext({
      client,
      data: { name: 'photoshop', urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    });
    ctx.attributes.authInfo = { getProfile: () => ({ email: 'editor@adobe.com' }) };
    const { controller } = loadController();
    const res = await controller.create(ctx);
    expect(res.status).to.equal(201);
    const insertOp = client.capturedOps.find((o) => o.op === 'insert');
    expect(insertOp.args[0].created_by).to.equal('editor@adobe.com');
    expect(insertOp.args[0].updated_by).to.equal('editor@adobe.com');
  });

  it('create trims surrounding whitespace from the name before persisting', async () => {
    const client = dedupClient([], { data: { name: 'photoshop' }, error: null });
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      client,
      data: { name: '  photoshop  ', urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    }));
    expect(res.status).to.equal(201);
    const insertOp = client.capturedOps.find((o) => o.op === 'insert');
    expect(insertOp.args[0].name).to.equal('photoshop');
  });

  it('create falls back to "system" identity and warns when no profile', async () => {
    const client = dedupClient([], { data: { name: 'photoshop' }, error: null });
    const ctx = buildContext({
      client,
      data: { name: 'photoshop', urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    });
    ctx.attributes.authInfo = {};
    const { controller } = loadController();
    const res = await controller.create(ctx);
    expect(res.status).to.equal(201);
    const insertOp = client.capturedOps.find((o) => o.op === 'insert');
    expect(insertOp.args[0].created_by).to.equal('system');
    expect(ctx.log.warn).to.have.been.called;
  });

  it('update stamps updated_by but never created_by (author survives edits)', async () => {
    const client = dedupClient([], { data: { name: 'foo', source: 'human' }, error: null });
    const ctx = buildContext({
      client,
      params: { name: 'foo' },
      data: { newName: 'bar' },
    });
    ctx.attributes.authInfo = { getProfile: () => ({ email: 'editor@adobe.com' }) };
    const { controller } = loadController();
    const res = await controller.update(ctx);
    expect(res.status).to.equal(200);
    const updateOp = client.capturedOps.find((o) => o.op === 'update');
    expect(updateOp.args[0].updated_by).to.equal('editor@adobe.com');
    expect(updateOp.args[0]).to.not.have.property('created_by');
  });

  it('update returns 409 when a sample URL belongs to another rule', async () => {
    const client = dedupClient(
      [{ name: 'acrobat', sample_urls: ['/products/acrobat/a'] }],
      { data: { name: 'photoshop', source: 'human' }, error: null },
    );
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'photoshop' },
      data: { urls: ['/products/acrobat/a', '/products/photoshop/x'] },
    }));
    expect(res.status).to.equal(409);
  });

  it('update does not conflict on the rule\'s own existing sample URLs', async () => {
    // The edited rule already owns these URLs; excluding self must avoid a
    // false 409 against itself.
    const client = dedupClient(
      [{ name: 'photoshop', sample_urls: ['/products/photoshop/a'] }],
      { data: { name: 'photoshop', source: 'human' }, error: null },
    );
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'photoshop' },
      data: { urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    }));
    expect(res.status).to.equal(200);
  });

  it('create returns 500 when the sample-URL lookup errors', async () => {
    const client = dedupClient([], { data: { name: 'x' }, error: null }, { message: 'boom' });
    const { controller } = loadController();
    const res = await controller.create(buildContext({
      client,
      data: { name: 'photoshop', urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    }));
    expect(res.status).to.equal(500);
  });

  it('update returns 500 when the sample-URL lookup errors', async () => {
    const client = dedupClient(
      [],
      { data: { name: 'photoshop', source: 'human' }, error: null },
      { message: 'boom' },
    );
    const { controller } = loadController();
    const res = await controller.update(buildContext({
      client,
      params: { name: 'photoshop' },
      data: { urls: ['/products/photoshop/a', '/products/photoshop/b'] },
    }));
    expect(res.status).to.equal(500);
  });

  // ───── soft delete ─────
  it('remove soft-deletes via UPDATE status=deleted (never a hard delete)', async () => {
    const client = dedupClient([], { data: { name: 'foo' }, error: null });
    const ctx = buildContext({ client, params: { name: 'foo' } });
    ctx.attributes.authInfo = { getProfile: () => ({ email: 'editor@adobe.com' }) };
    const { controller } = loadController();
    const res = await controller.remove(ctx);
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.deleted).to.equal(true);
    const updateOp = client.capturedOps.find((o) => o.op === 'update');
    expect(updateOp.args[0]).to.deep.equal({ status: 'deleted', updated_by: 'editor@adobe.com' });
    expect(client.capturedOps.find((o) => o.op === 'delete')).to.equal(undefined);
  });

  // ───── factory validation ─────
  it('factory throws when tableName/dimensionLabel are missing', async () => {
    const { createRulesController } = await import('../../src/controllers/agentic-rules-factory.js');
    expect(() => createRulesController({ tableName: '', dimensionLabel: '' })).to.throw();
    expect(() => createRulesController({ tableName: 'x', dimensionLabel: '' })).to.throw();
  });
});
