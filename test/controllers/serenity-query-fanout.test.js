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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';
import { ErrorWithStatusCode } from '../../src/support/utils.js';
// Real error classes (not mocks) so the controller's `instanceof` checks in
// its catch blocks match errors thrown by these tests — see the same pattern
// (and max-classes-per-file rationale) in test/controllers/elements.test.js.
import { SerenityTransportError } from '../../src/support/serenity/serenity-transport-error.js';
import { ElementsTransportError } from '../../src/support/elements/errors.js';

use(chaiAsPromised);
use(sinonChai);

const ORG_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BRAND_ID = '11111111-2222-3333-4444-555555555555';
const RUN_ID = '01a00fae-053a-7ec4-83d6-a8c45a07fc1b'; // real Lovesac run id, used as the reference fixture
const WORKSPACE_ID = 'ws-uuid-123';
const IMS_TOKEN = 'test-ims-token';
const ENV = { SEMRUSH_PROJECTS_BASE_URL: 'https://www.semrush.com' };

const SUCCEEDED_COVERAGE = {
  type: 'table',
  blocks: {
    data: [
      { topic_name: 'Couches and Sofas', rank_band: 'Not ranking' },
      { topic_name: 'Couches and Sofas', rank_band: 'Not ranking' },
      { topic_name: 'Home Decor Inspiration', rank_band: 'Not ranking' },
    ],
  },
};

function fakeLog() {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
    debug: sinon.stub(),
  };
}

// Faithful re-implementation of support/utils.js#resolveSemrushImsToken, mirroring
// the pattern in test/controllers/elements.test.js: exercises the REAL fallback
// (IMS-type gate) the controller passes in, while letting the promise-token
// exchange be controlled per-test.
function makeResolveSemrushImsTokenStub(exchangeStub) {
  return async (ctx, log, logLabel, fallback) => {
    const promiseTokenHeader = ctx?.pathInfo?.headers?.['x-promise-token'];
    if (promiseTokenHeader) {
      try {
        return await exchangeStub(ctx, promiseTokenHeader);
      } catch (e) {
        log.error(`${logLabel}: promise token exchange failed`, { error: e?.message });
        throw new ErrorWithStatusCode('Invalid or expired promise token', 401);
      }
    }
    return fallback(ctx);
  };
}

function fakeContext({
  bearer = IMS_TOKEN,
  authType = 'ims',
  params = {},
  org = { getId: () => ORG_ID },
  promiseToken = undefined,
} = {}) {
  return {
    params: {
      spaceCatId: ORG_ID, brandId: BRAND_ID, runId: RUN_ID, ...params,
    },
    pathInfo: {
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(promiseToken ? { 'x-promise-token': promiseToken } : {}),
      },
    },
    attributes: {
      authInfo: { getType: () => authType },
    },
    dataAccess: {
      Organization: { findById: sinon.stub().resolves(org) },
    },
  };
}

async function readBody(response) {
  if (typeof response.text !== 'function') {
    return null;
  }
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe('SerenityQueryFanoutController', () => {
  let resolveBrandWorkspaceStub;
  let accessControlHasAccessStub;
  let getRunStatusStub;
  let fetchElementStub;
  let createQueryFanoutTransportStub;
  let createElementsTransportStub;
  let exchangePromiseTokenStub;
  let SerenityQueryFanoutController;

  beforeEach(async () => {
    resolveBrandWorkspaceStub = sinon.stub().resolves({
      mode: 'subworkspace', workspaceId: WORKSPACE_ID, parentWorkspaceId: 'parent-ws',
    });
    accessControlHasAccessStub = sinon.stub().resolves(true);

    getRunStatusStub = sinon.stub().resolves({ id: RUN_ID, status: 'succeeded' });
    createQueryFanoutTransportStub = sinon.stub().returns({ getRunStatus: getRunStatusStub });

    fetchElementStub = sinon.stub().resolves(SUCCEEDED_COVERAGE);
    createElementsTransportStub = sinon.stub().returns({ fetchElement: fetchElementStub });

    exchangePromiseTokenStub = sinon.stub().resolves('exchanged-ims-token');

    const MockAccessControlUtil = {
      default: {
        fromContext: () => ({ hasAccess: accessControlHasAccessStub }),
      },
    };

    SerenityQueryFanoutController = (await esmock('../../src/controllers/serenity-query-fanout.js', {
      '../../src/support/serenity/workspace-resolver.js': {
        resolveBrandWorkspace: resolveBrandWorkspaceStub,
      },
      '../../src/support/serenity/query-fanout-transport.js': {
        createQueryFanoutTransport: createQueryFanoutTransportStub,
      },
      '../../src/support/elements/elements-transport.js': {
        createElementsTransport: createElementsTransportStub,
      },
      '../../src/support/access-control-util.js': MockAccessControlUtil,
      '../../src/support/utils.js': {
        resolveSemrushImsToken: makeResolveSemrushImsTokenStub(
          (...args) => exchangePromiseTokenStub(...args),
        ),
      },
    })).default;
  });

  afterEach(() => sinon.restore());

  describe('constructor', () => {
    it('throws when context is missing', () => {
      expect(() => SerenityQueryFanoutController(null, fakeLog(), ENV)).to.throw('Context required');
    });

    it('throws when log is missing', () => {
      expect(() => SerenityQueryFanoutController({ env: {} }, null, ENV)).to.throw('Log required');
    });

    it('returns a controller object with the expected method', () => {
      const ctrl = SerenityQueryFanoutController(fakeContext(), fakeLog(), ENV);
      expect(ctrl).to.include.keys('getQueryFanoutStatus');
    });
  });

  describe('getQueryFanoutStatus', () => {
    it('returns 400 when brandId is not a valid UUID', async () => {
      const ctx = fakeContext({ params: { brandId: 'not-a-uuid' } });
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when runId is empty', async () => {
      const ctx = fakeContext({ params: { runId: '' } });
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 404 when the organization is not found', async () => {
      const ctx = fakeContext({ org: null });
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);
      expect(res.status).to.equal(404);
    });

    it('returns 403 when the caller lacks org access', async () => {
      accessControlHasAccessStub.resolves(false);
      const ctx = fakeContext();
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);
      expect(res.status).to.equal(403);
    });

    it('returns 404 when the brand has no resolvable workspace', async () => {
      resolveBrandWorkspaceStub.resolves({ mode: 'flat', workspaceId: null, parentWorkspaceId: null });
      const ctx = fakeContext();
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);
      expect(res.status).to.equal(404);
    });

    it('returns 401 pointing at x-promise-token when the caller did not authenticate via IMS', async () => {
      const ctx = fakeContext({ authType: 'jwt' });
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);
      expect(res.status).to.equal(401);
      const body = await readBody(res);
      expect(body.error).to.equal('promiseTokenRequired');
    });

    it('exchanges x-promise-token and forwards the exchanged token upstream', async () => {
      const ctx = fakeContext({ authType: 'jwt', bearer: 'sc-session-token', promiseToken: 'ptok' });
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);

      expect(res.status).to.equal(200);
      expect(exchangePromiseTokenStub).to.have.been.calledOnce;
      expect(createQueryFanoutTransportStub).to.have.been.calledWith(
        sinon.match({ imsToken: 'exchanged-ims-token' }),
      );
    });

    it('returns just runId/workspaceId/status while the run is still in flight', async () => {
      getRunStatusStub.resolves({ id: RUN_ID, status: 'running' });
      const ctx = fakeContext();
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);

      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal({ runId: RUN_ID, workspaceId: WORKSPACE_ID, status: 'running' });
      expect(fetchElementStub).to.not.have.been.called;
    });

    it('defaults status to "unknown" when the upstream response has none', async () => {
      getRunStatusStub.resolves({ id: RUN_ID });
      const ctx = fakeContext();
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);

      const body = await readBody(res);
      expect(body.status).to.equal('unknown');
    });

    it('maps a SerenityTransportError from the status check to its upstream status', async () => {
      getRunStatusStub.rejects(new SerenityTransportError(404, 'run not found'));
      const ctx = fakeContext();
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);

      expect(res.status).to.equal(404);
      const body = await readBody(res);
      expect(body.error).to.equal('upstreamError');
    });

    it('returns 500 when the status check throws an unexpected error', async () => {
      getRunStatusStub.rejects(new Error('boom'));
      const ctx = fakeContext();
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);
      expect(res.status).to.equal(500);
    });

    it('on succeeded: fetches coverage, scopes it via CBF_workflow_id, and summarizes topics', async () => {
      const ctx = fakeContext();
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);

      expect(res.status).to.equal(200);
      expect(fetchElementStub).to.have.been.calledOnce;
      const [workspaceIdArg, elementIdArg, payloadArg] = fetchElementStub.getCall(0).args;
      expect(workspaceIdArg).to.equal(WORKSPACE_ID);
      expect(elementIdArg).to.equal('9f8bb77f-008e-4c80-8f3c-059986a045cd');
      expect(payloadArg.filters.advanced.filters[0]).to.deep.equal({
        op: 'eq', val: RUN_ID, col: 'CBF_workflow_id',
      });

      const body = await readBody(res);
      expect(body.status).to.equal('succeeded');
      expect(body.rowCount).to.equal(3);
      expect(body.topics).to.deep.equal([
        { name: 'Couches and Sofas', count: 2 },
        { name: 'Home Decor Inspiration', count: 1 },
      ]);
      expect(body.data).to.deep.equal(SUCCEEDED_COVERAGE.blocks.data);
    });

    it('treats a missing blocks.data as an empty coverage table', async () => {
      fetchElementStub.resolves({ type: 'table', blocks: {} });
      const ctx = fakeContext();
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);

      const body = await readBody(res);
      expect(body.rowCount).to.equal(0);
      expect(body.topics).to.deep.equal([]);
      expect(body.data).to.deep.equal([]);
    });

    it('maps an ElementsTransportError from the coverage fetch to its upstream status', async () => {
      fetchElementStub.rejects(new ElementsTransportError(422, 'bad filter'));
      const ctx = fakeContext();
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);

      expect(res.status).to.equal(422);
      const body = await readBody(res);
      expect(body.error).to.equal('upstreamError');
    });

    it('returns 500 when the coverage fetch throws an unexpected error', async () => {
      fetchElementStub.rejects(new Error('boom'));
      const ctx = fakeContext();
      const ctrl = SerenityQueryFanoutController(ctx, fakeLog(), ENV);
      const res = await ctrl.getQueryFanoutStatus(ctx);
      expect(res.status).to.equal(500);
    });
  });
});
