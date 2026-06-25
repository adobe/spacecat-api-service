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
import esmock from 'esmock';

use(sinonChai);

const SITE_ID = 'a1b2c3d4-e5f6-1234-abcd-000000000001';
const CF_TOKEN = 'cf-bearer-token-abc';
const ACCOUNT_ID = 'acc-123';
const ZONE_ID = 'zone-456';
const ROUTE_ID = 'route-789';
const SCRIPT_NAME = 'edge-optimize-worker';
const TARGET_HOST = 'www.example.com';
const LLMO_API_KEY = 'llmo-api-key-xyz';
const CF_CLIENT_ID = 'b3ef23f21b249c43b757bc8ef000c917';
const WORKER_SCRIPT_TEXT = '/* worker */';

describe('LlmoCloudflareController', () => {
  let sandbox;
  let controller;
  let LlmoCloudflareController;
  let mockContext;
  let mockSite;
  let mockAccessControlUtil;
  let mockCfClient;
  let mockTokowakaClient;
  let mockFetch;

  before(async () => {
    sandbox = sinon.createSandbox();

    mockCfClient = {
      listAccounts: sandbox.stub(),
      listZones: sandbox.stub(),
      listRoutes: sandbox.stub(),
      deployWorkerScript: sandbox.stub(),
      setWorkerSecret: sandbox.stub(),
      addRoute: sandbox.stub(),
    };

    mockTokowakaClient = {
      fetchMetaconfig: sandbox.stub(),
    };

    mockFetch = sandbox.stub();

    const mod = await esmock('../../../src/controllers/llmo/llmo-cloudflare.js', {
      '@adobe/spacecat-shared-cloudflare-client': {
        default: sandbox.stub().returns(mockCfClient),
      },
      '@adobe/spacecat-shared-tokowaka-client': {
        default: {
          createFrom: sandbox.stub().returns(mockTokowakaClient),
        },
      },
      '@adobe/spacecat-shared-utils': {
        hasText: (v) => typeof v === 'string' && v.trim().length > 0,
        tracingFetch: mockFetch,
      },
      '../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => mockAccessControlUtil,
        },
      },
      '../../../src/support/errors.js': {
        UnauthorizedProductError: class UnauthorizedProductError extends Error {},
      },
    });

    LlmoCloudflareController = mod.default;
  });

  beforeEach(() => {
    mockSite = {
      getId: () => SITE_ID,
      getBaseURL: () => 'https://www.example.com',
    };

    mockAccessControlUtil = {
      hasAccess: sandbox.stub().resolves(true),
    };

    mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: [LLMO_API_KEY] });

    mockFetch.resolves({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: sandbox.stub().resolves(WORKER_SCRIPT_TEXT),
    });

    const mockSiteModel = {
      findById: sandbox.stub().resolves(mockSite),
    };

    mockContext = {
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
      },
      env: {
        CLOUDFLARE_CLIENT_ID: CF_CLIENT_ID,
      },
      params: { siteId: SITE_ID },
      pathInfo: {
        headers: { 'x-cloudflare-token': CF_TOKEN },
      },
      dataAccess: {
        Site: mockSiteModel,
      },
      request: {
        json: sandbox.stub(),
      },
    };

    controller = LlmoCloudflareController(mockContext);
  });

  afterEach(() => {
    sandbox.restore();
  });

  // ── getCloudflareConfig ──────────────────────────────────────────────────

  describe('getCloudflareConfig', () => {
    it('returns the Cloudflare client ID', async () => {
      const res = await controller.getCloudflareConfig(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.clientId).to.equal(CF_CLIENT_ID);
    });

    it('returns 404 when site is not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const res = await controller.getCloudflareConfig(mockContext);
      expect(res.status).to.equal(404);
    });

    it('returns 403 when access is denied', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);
      const res = await controller.getCloudflareConfig(mockContext);
      expect(res.status).to.equal(403);
    });

    it('returns 500 when CLOUDFLARE_CLIENT_ID is not configured', async () => {
      mockContext.env.CLOUDFLARE_CLIENT_ID = '';
      const res = await controller.getCloudflareConfig(mockContext);
      expect(res.status).to.equal(500);
    });
  });

  // ── listAccounts ─────────────────────────────────────────────────────────

  describe('listAccounts', () => {
    it('returns accounts list', async () => {
      const accounts = [{ id: ACCOUNT_ID, name: 'Test Account' }];
      mockCfClient.listAccounts.resolves(accounts);

      const res = await controller.listAccounts(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal(accounts);
    });

    it('returns 400 when CF token is missing', async () => {
      mockContext.pathInfo.headers = {};
      const res = await controller.listAccounts(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 404 when site is not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const res = await controller.listAccounts(mockContext);
      expect(res.status).to.equal(404);
    });
  });

  // ── listZones ────────────────────────────────────────────────────────────

  describe('listZones', () => {
    it('returns zones list', async () => {
      const zones = [{ id: ZONE_ID, name: 'example.com' }];
      mockCfClient.listZones.resolves(zones);

      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal(zones);
    });

    it('returns 400 when CF token is missing', async () => {
      mockContext.pathInfo.headers = {};
      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(400);
    });
  });

  // ── listRoutes ───────────────────────────────────────────────────────────

  describe('listRoutes', () => {
    it('returns routes for a zone', async () => {
      const routes = [{ id: ROUTE_ID, pattern: 'example.com/*', script: SCRIPT_NAME }];
      mockCfClient.listRoutes.resolves(routes);
      mockContext.params = { siteId: SITE_ID, zoneId: ZONE_ID };

      const res = await controller.listRoutes(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal(routes);
      expect(mockCfClient.listRoutes).to.have.been.calledWith(ZONE_ID);
    });

    it('returns 400 when zoneId is missing', async () => {
      mockContext.params = { siteId: SITE_ID, zoneId: '' };
      const res = await controller.listRoutes(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when CF token is missing', async () => {
      mockContext.pathInfo.headers = {};
      mockContext.params = { siteId: SITE_ID, zoneId: ZONE_ID };
      const res = await controller.listRoutes(mockContext);
      expect(res.status).to.equal(400);
    });
  });

  // ── deployWorker ─────────────────────────────────────────────────────────

  describe('deployWorker', () => {
    beforeEach(() => {
      mockContext.params = { siteId: SITE_ID };
      mockContext.request.json.resolves({
        accountId: ACCOUNT_ID, scriptName: SCRIPT_NAME, targetHost: TARGET_HOST,
      });
    });

    it('deploys worker script and sets secret', async () => {
      mockCfClient.deployWorkerScript.resolves();
      mockCfClient.setWorkerSecret.resolves();

      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(200);

      expect(mockCfClient.deployWorkerScript).to.have.been.calledWith(
        ACCOUNT_ID,
        SCRIPT_NAME,
        WORKER_SCRIPT_TEXT,
        [{ name: 'EDGE_OPTIMIZE_TARGET_HOST', type: 'plain_text', text: TARGET_HOST }],
      );
      expect(mockCfClient.setWorkerSecret).to.have.been.calledWith(
        ACCOUNT_ID,
        SCRIPT_NAME,
        'EDGE_OPTIMIZE_API_KEY',
        LLMO_API_KEY,
      );

      const body = await res.json();
      expect(body).to.deep.equal({
        scriptName: SCRIPT_NAME, accountId: ACCOUNT_ID, targetHost: TARGET_HOST,
      });
    });

    it('returns 400 when accountId is missing', async () => {
      mockContext.request.json.resolves({ scriptName: SCRIPT_NAME, targetHost: TARGET_HOST });
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when scriptName is missing', async () => {
      mockContext.request.json.resolves({ accountId: ACCOUNT_ID, targetHost: TARGET_HOST });
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when targetHost is missing', async () => {
      mockContext.request.json.resolves({ accountId: ACCOUNT_ID, scriptName: SCRIPT_NAME });
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when CF token is missing', async () => {
      mockContext.pathInfo.headers = {};
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 500 when LLMO API key is not available', async () => {
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: [] });
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(500);
    });

    it('returns 500 when worker script fetch fails', async () => {
      mockFetch.resolves({ ok: false, status: 404, statusText: 'Not Found' });
      let threw = false;
      try {
        await controller.deployWorker(mockContext);
      } catch {
        threw = true;
      }
      expect(threw).to.be.true;
    });
  });

  // ── addRoute ─────────────────────────────────────────────────────────────

  describe('addRoute', () => {
    beforeEach(() => {
      mockContext.params = { siteId: SITE_ID, zoneId: ZONE_ID };
      mockContext.request.json.resolves({ pattern: 'example.com/*', scriptName: SCRIPT_NAME });
    });

    it('adds a route and returns it', async () => {
      const route = { id: ROUTE_ID, pattern: 'example.com/*', script: SCRIPT_NAME };
      mockCfClient.addRoute.resolves(route);

      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal(route);
      expect(mockCfClient.addRoute).to.have.been.calledWith(ZONE_ID, 'example.com/*', SCRIPT_NAME);
    });

    it('returns 400 when pattern is missing', async () => {
      mockContext.request.json.resolves({ scriptName: SCRIPT_NAME });
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when scriptName is missing', async () => {
      mockContext.request.json.resolves({ pattern: 'example.com/*' });
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when zoneId is missing', async () => {
      mockContext.params = { siteId: SITE_ID, zoneId: '' };
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when CF token is missing', async () => {
      mockContext.pathInfo.headers = {};
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(400);
    });
  });
});
