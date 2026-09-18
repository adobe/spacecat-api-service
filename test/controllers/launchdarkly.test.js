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

import LaunchDarklyController from '../../src/controllers/launchdarkly.js';
import AccessControlUtil from '../../src/support/access-control-util.js';
import {
  STATUS_FORBIDDEN,
  STATUS_OK,
  STATUS_INTERNAL_SERVER_ERROR,
} from '../../src/utils/constants.js';

use(chaiAsPromised);
use(sinonChai);

/**
 * Builds a minimal raw-LD-shaped flag object, with an optional `next` link
 * (relative href, as LD returns them) to simulate pagination.
 */
function ldPage(items, nextHref) {
  return {
    items,
    _links: nextHref ? { next: { href: nextHref } } : {},
  };
}

describe('LaunchDarklyController', () => {
  const sandbox = sinon.createSandbox();

  let mockHasAdmin;
  let baseCtx;
  let controller;

  beforeEach(() => {
    sandbox.restore();

    mockHasAdmin = sandbox.stub().returns(true);
    sandbox.stub(AccessControlUtil, 'fromContext').returns({
      hasAdminAccess: mockHasAdmin,
    });

    baseCtx = {
      env: { LD_EXPERIENCE_SUCCESS_API_TOKEN: 'test-token' },
      log: { error: sandbox.stub(), warn: sandbox.stub() },
      attributes: { authInfo: { isAdmin: () => true } },
    };
    controller = LaunchDarklyController(baseCtx);
  });

  afterEach(() => sandbox.restore());

  it('throws without context', () => {
    expect(() => LaunchDarklyController()).to.throw('Context required');
  });

  describe('getFlags', () => {
    it('returns 403 when caller is not an admin', async () => {
      mockHasAdmin.returns(false);
      const resp = await controller.getFlags(baseCtx);
      expect(resp.status).to.equal(STATUS_FORBIDDEN);
    });

    it('returns 500 when the LD API token is not configured', async () => {
      const resp = await controller.getFlags({ ...baseCtx, env: {} });
      expect(resp.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
    });

    it('returns key + variation-0 value per flag, on a single page', async () => {
      const flags = [
        { key: 'FF_bool-flag', variations: [{ value: true }, { value: false }] },
        {
          key: 'FF_alt-text-assess',
          variations: [{ value: '{"org-1":["site-1"]}' }],
        },
      ];
      sandbox.stub(global, 'fetch').resolves({
        ok: true,
        status: 200,
        json: async () => ldPage(flags),
      });

      const resp = await controller.getFlags(baseCtx);

      expect(global.fetch).to.have.been.calledOnce;
      const [url, options] = global.fetch.firstCall.args;
      expect(url.toString()).to.equal('https://app.launchdarkly.com/api/v2/flags/experience-success-studio?limit=50');
      expect(options.headers.Authorization).to.equal('test-token');
      expect(resp.status).to.equal(STATUS_OK);
      const body = await resp.json();
      expect(body).to.deep.equal({
        totalCount: 2,
        items: [
          { key: 'FF_bool-flag', value: true },
          { key: 'FF_alt-text-assess', value: '{"org-1":["site-1"]}' },
        ],
      });
    });

    it('follows LD pagination links until exhausted', async () => {
      const fetchStub = sandbox.stub(global, 'fetch');
      fetchStub.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ldPage(
          [{ key: 'flag-1', variations: [{ value: true }] }],
          '/api/v2/flags/experience-success-studio?limit=50&offset=50',
        ),
      });
      fetchStub.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ldPage([{ key: 'flag-2', variations: [{ value: false }] }]),
      });

      const resp = await controller.getFlags(baseCtx);

      expect(fetchStub).to.have.been.calledTwice;
      expect(fetchStub.secondCall.args[0].toString()).to.equal(
        'https://app.launchdarkly.com/api/v2/flags/experience-success-studio?limit=50&offset=50',
      );
      const body = await resp.json();
      expect(body.totalCount).to.equal(2);
      expect(body.items.map((i) => i.key)).to.deep.equal(['flag-1', 'flag-2']);
    });

    it('returns value: null for a flag with no variations', async () => {
      sandbox.stub(global, 'fetch').resolves({
        ok: true,
        status: 200,
        json: async () => ldPage([{ key: 'FF_no-variations', variations: [] }]),
      });
      const resp = await controller.getFlags(baseCtx);
      const body = await resp.json();
      expect(body.items).to.deep.equal([{ key: 'FF_no-variations', value: null }]);
    });

    it('rejects a pagination link that escapes the expected flags path', async () => {
      sandbox.stub(global, 'fetch').resolves({
        ok: true,
        status: 200,
        json: async () => ldPage(
          [{ key: 'flag-1', variations: [{ value: true }] }],
          'https://evil.example.com/steal-token',
        ),
      });
      const resp = await controller.getFlags(baseCtx);
      expect(resp.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
      expect(baseCtx.log.error).to.have.been.calledWithMatch(/Unexpected LaunchDarkly pagination path/);
    });

    it('rejects a same-origin pagination link that traverses outside the flags path', async () => {
      sandbox.stub(global, 'fetch').resolves({
        ok: true,
        status: 200,
        json: async () => ldPage(
          [{ key: 'flag-1', variations: [{ value: true }] }],
          '/api/v2/flags/experience-success-studio/../../admin-secrets',
        ),
      });
      const resp = await controller.getFlags(baseCtx);
      expect(resp.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
      expect(baseCtx.log.error).to.have.been.calledWithMatch(/Unexpected LaunchDarkly pagination path/);
    });

    it('stops after the page cap and logs a warning when more pages remain', async () => {
      const fetchStub = sandbox.stub(global, 'fetch').callsFake(() => Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ldPage(
          [{ key: 'flag', variations: [{ value: true }] }],
          '/api/v2/flags/experience-success-studio?limit=50&offset=next',
        ),
      }));

      const resp = await controller.getFlags(baseCtx);

      // Matches MAX_PAGES in src/controllers/launchdarkly.js.
      expect(fetchStub.callCount).to.equal(50);
      expect(resp.status).to.equal(STATUS_OK);
      const body = await resp.json();
      expect(body.totalCount).to.equal(50);
      expect(baseCtx.log.warn).to.have.been.calledWithMatch(/pagination stopped at 50 pages/);
    });

    it('returns 500 when LaunchDarkly responds with an error status', async () => {
      sandbox.stub(global, 'fetch').resolves({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ message: 'invalid token' }),
      });
      const resp = await controller.getFlags(baseCtx);
      expect(resp.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
    });

    it('returns 500 when the fetch call throws', async () => {
      sandbox.stub(global, 'fetch').rejects(new Error('network down'));
      const resp = await controller.getFlags(baseCtx);
      expect(resp.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
    });
  });
});
