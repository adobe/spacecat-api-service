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
      log: { error: sandbox.stub() },
      attributes: { authInfo: { isAdmin: () => true } },
      request: { url: 'https://spacecat.experiencecloud.live/tools/launchdarkly/flags?env=production' },
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

    it('returns the raw LaunchDarkly response on success', async () => {
      const ldBody = { items: [{ key: 'FF_alt-text-assess' }] };
      sandbox.stub(global, 'fetch').resolves({
        ok: true,
        status: 200,
        json: async () => ldBody,
      });

      const resp = await controller.getFlags(baseCtx);

      expect(global.fetch).to.have.been.calledOnce;
      const [url, options] = global.fetch.firstCall.args;
      expect(url).to.equal('https://app.launchdarkly.com/api/v2/flags/experience-success-studio?env=production');
      expect(options.headers.Authorization).to.equal('test-token');
      expect(resp.status).to.equal(STATUS_OK);
      const body = await resp.json();
      expect(body).to.deep.equal(ldBody);
    });

    it('forwards no query string when request.url is absent', async () => {
      sandbox.stub(global, 'fetch').resolves({ ok: true, status: 200, json: async () => ({}) });
      await controller.getFlags({ ...baseCtx, request: undefined });
      const [url] = global.fetch.firstCall.args;
      expect(url).to.equal('https://app.launchdarkly.com/api/v2/flags/experience-success-studio');
    });

    it('returns 500 when LaunchDarkly responds with an error status', async () => {
      sandbox.stub(global, 'fetch').resolves({
        ok: false,
        status: 401,
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
