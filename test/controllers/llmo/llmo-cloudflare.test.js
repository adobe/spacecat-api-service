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
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const ZONE_ID = 'fedcba9876543210fedcba9876543210';
const ROUTE_ID = 'route-789';
// Worker name is derived server-side from the site base URL (https://www.example.com).
const DERIVED_SCRIPT_NAME = 'edge-optimize-router-example-com';
const TARGET_HOST = 'www.example.com';
const LLMO_API_KEY = 'llmo-api-key-xyz';
const CF_CLIENT_ID = 'example-cloudflare-client-id';
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
    // esmock is expensive, so wire it once. The mock factories deliberately read the mutable
    // outer references (reassigned per-test in beforeEach) so each test gets fresh stubs
    // without re-running esmock.
    const mod = await esmock('../../../src/controllers/llmo/llmo-cloudflare.js', {
      '@adobe/spacecat-shared-cloudflare-client': {
        default: function CloudflareClientMock() { return mockCfClient; },
      },
      '@adobe/spacecat-shared-tokowaka-client': {
        default: {
          createFrom: () => mockTokowakaClient,
        },
      },
      '@adobe/spacecat-shared-utils': {
        hasText: (v) => typeof v === 'string' && v.trim().length > 0,
        tracingFetch: (...args) => mockFetch(...args),
      },
      '../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => mockAccessControlUtil,
        },
      },
    });

    LlmoCloudflareController = mod.default;
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockCfClient = {
      listAccounts: sandbox.stub(),
      listZones: sandbox.stub(),
      listRoutes: sandbox.stub(),
      deployWorkerScript: sandbox.stub(),
      setWorkerSecret: sandbox.stub(),
      addRoute: sandbox.stub(),
      listLogpushJobs: sandbox.stub(),
      requestLogpushOwnership: sandbox.stub(),
      createLogpushJob: sandbox.stub(),
      getZone: sandbox.stub(),
    };

    mockTokowakaClient = {
      fetchMetaconfig: sandbox.stub().resolves({ apiKeys: [LLMO_API_KEY] }),
    };

    mockFetch = sandbox.stub().resolves({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: sandbox.stub().resolves(WORKER_SCRIPT_TEXT),
    });

    const mockCdnBucketConfig = {
      bucketName: 'cdn-logs-adobe-dev',
      allowedPaths: ['9E1005A551ED61CA0A490D45AdobeOrg/raw/byocdn-cloudflare/'],
      region: 'us-east-1',
    };
    mockSite = {
      getId: () => SITE_ID,
      getBaseURL: () => 'https://www.example.com',
      getConfig: () => ({ getLlmoCdnBucketConfig: () => mockCdnBucketConfig }),
    };

    mockAccessControlUtil = {
      hasAccess: sandbox.stub().resolves(true),
      isLLMOAdministrator: sandbox.stub().returns(true),
    };

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
        AUTH_SERVICE_BASE_URL: 'https://auth.example.com',
      },
      params: { siteId: SITE_ID, zoneId: ZONE_ID },
      pathInfo: {
        headers: { 'x-cloudflare-token': CF_TOKEN, authorization: 'Bearer caller-token' },
      },
      dataAccess: {
        Site: mockSiteModel,
      },
      data: {},
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

    it('returns 403 when user does not have site access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);
      const res = await controller.getCloudflareConfig(mockContext);
      expect(res.status).to.equal(403);
    });

    it('returns 403 when user is not an LLMO administrator', async () => {
      mockAccessControlUtil.isLLMOAdministrator.returns(false);
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

    it('returns 401 when Cloudflare auth fails', async () => {
      mockCfClient.listAccounts.rejects(new Error('Cloudflare API returned 401 on /accounts: bad token'));
      const res = await controller.listAccounts(mockContext);
      expect(res.status).to.equal(401);
    });

    it('returns 429 when Cloudflare rate-limits', async () => {
      mockCfClient.listAccounts.rejects(new Error('Cloudflare API returned 429 on /accounts: slow down'));
      const res = await controller.listAccounts(mockContext);
      expect(res.status).to.equal(429);
    });

    it('returns 502 on generic Cloudflare failure', async () => {
      mockCfClient.listAccounts.rejects(new Error('Cloudflare API request to /accounts failed: ECONNRESET'));
      const res = await controller.listAccounts(mockContext);
      expect(res.status).to.equal(502);
    });

    it('returns 502 when the rejection is not an Error instance', async () => {
      mockCfClient.listAccounts.rejects({ noMessage: true });
      const res = await controller.listAccounts(mockContext);
      expect(res.status).to.equal(502);
    });
  });

  // ── listZones ────────────────────────────────────────────────────────────

  describe('listZones', () => {
    beforeEach(() => {
      mockContext.data = { accountId: ACCOUNT_ID };
    });

    it('passes the accountId to the client and returns the account-scoped zones', async () => {
      const zones = [{ id: ZONE_ID, name: 'example.com', account: { id: ACCOUNT_ID } }];
      mockCfClient.listZones.resolves(zones);

      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(200);
      expect(mockCfClient.listZones).to.have.been.calledWith({ accountId: ACCOUNT_ID });
      const body = await res.json();
      expect(body).to.deep.equal(zones);
    });

    it('treats a null zone list as empty', async () => {
      mockCfClient.listZones.resolves(null);
      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal([]);
    });

    it('returns only zones whose registrable domain matches the site domain', async () => {
      // Site base URL is https://www.example.com -> registrable domain example.com.
      const match = { id: ZONE_ID, name: 'example.com' };
      const subdomainZone = { id: 'z2', name: 'shop.example.com' }; // registrable = example.com
      const otherTld = { id: 'z3', name: 'example.net' };
      const unrelated = { id: 'z4', name: 'other.com' };
      const noName = { id: 'z5' }; // exercises the hasText(zone.name) guard
      mockCfClient.listZones.resolves([match, subdomainZone, otherTld, unrelated, noName]);

      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal([match, subdomainZone]);
    });

    it('returns no zones when the site host has no registrable domain (PSL miss)', async () => {
      mockSite.getBaseURL = () => 'http://localhost';
      mockCfClient.listZones.resolves([{ id: ZONE_ID, name: 'example.com' }, { id: 'z2', name: 'localhost' }]);

      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal([]);
    });

    it('returns 400 when CF token is missing', async () => {
      mockContext.pathInfo.headers = {};
      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when the request has no query data', async () => {
      mockContext.data = undefined;
      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when accountId is missing', async () => {
      mockContext.data = {};
      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(400);
      expect(mockCfClient.listZones).to.not.have.been.called;
    });

    it('returns 400 when accountId is not a 32-char hex id', async () => {
      mockContext.data = { accountId: 'acc-123' };
      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 404 when site is not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(404);
    });

    it('returns 403 when Cloudflare authorization fails', async () => {
      mockCfClient.listZones.rejects(new Error('Cloudflare API returned 403 on /zones: forbidden'));
      const res = await controller.listZones(mockContext);
      expect(res.status).to.equal(403);
    });
  });

  // ── deployWorker ─────────────────────────────────────────────────────────

  describe('deployWorker', () => {
    beforeEach(() => {
      mockContext.params = { siteId: SITE_ID };
      mockContext.data = { accountId: ACCOUNT_ID, targetHost: TARGET_HOST };
    });

    it('deploys worker script with a derived name and sets secret', async () => {
      mockCfClient.deployWorkerScript.resolves();
      mockCfClient.setWorkerSecret.resolves();

      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(200);

      expect(mockCfClient.deployWorkerScript).to.have.been.calledWith(
        ACCOUNT_ID,
        DERIVED_SCRIPT_NAME,
        WORKER_SCRIPT_TEXT,
        [{ name: 'EDGE_OPTIMIZE_TARGET_HOST', type: 'plain_text', text: TARGET_HOST }],
        { tags: ['adobe-llmo'] },
      );
      expect(mockCfClient.setWorkerSecret).to.have.been.calledWith(
        ACCOUNT_ID,
        DERIVED_SCRIPT_NAME,
        'EDGE_OPTIMIZE_API_KEY',
        LLMO_API_KEY,
      );

      const body = await res.json();
      expect(body).to.deep.equal({
        scriptName: DERIVED_SCRIPT_NAME, accountId: ACCOUNT_ID, targetHost: TARGET_HOST,
      });
    });

    it('tags the worker with the ownership tag and the sanitized caller IMS identity', async () => {
      // profile.email is an IMS GUID (GUID@hexOrgId.e); '@' is not a Cloudflare-safe tag char and
      // is sanitized to '_' so the deploy cannot be rejected for an invalid tag.
      mockContext.attributes = {
        authInfo: { getProfile: () => ({ email: 'CALLER-GUID@abc123.e' }) },
      };
      mockCfClient.deployWorkerScript.resolves({ id: 'deployment-1' });
      mockCfClient.setWorkerSecret.resolves();

      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(200);

      const opts = mockCfClient.deployWorkerScript.getCall(0).args[4];
      expect(opts).to.deep.equal({ tags: ['adobe-llmo', 'CALLER-GUID_abc123.e'] });
    });

    it('truncates an over-long caller identity tag to CF_TAG_MAX_LEN (80 chars)', async () => {
      const longId = `${'a'.repeat(120)}@org.e`;
      mockContext.attributes = { authInfo: { getProfile: () => ({ email: longId }) } };
      mockCfClient.deployWorkerScript.resolves({ id: 'deployment-1' });
      mockCfClient.setWorkerSecret.resolves();

      await controller.deployWorker(mockContext);

      const opts = mockCfClient.deployWorkerScript.getCall(0).args[4];
      expect(opts.tags[0]).to.equal('adobe-llmo');
      expect(opts.tags[1]).to.have.lengthOf(80);
      expect(opts.tags[1]).to.equal('a'.repeat(80));
    });

    it('quotes audit-log values containing spaces so key=value parsing stays intact', async () => {
      mockTokowakaClient.fetchMetaconfig.rejects(new Error('tokowaka is not reachable'));
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(502);
      const logged = mockContext.log.error.getCalls().map((c) => c.args[0]).join('\n');
      expect(logged).to.contain('error="tokowaka is not reachable"');
    });

    it('always tags with adobe-llmo first so any IMS user matches a worker another user deployed', async () => {
      // With no resolvable caller identity, only the stable ownership tag is attached — this is
      // the tag the client uses to recognize the worker on a later re-deploy by a different user.
      mockCfClient.deployWorkerScript.resolves({ id: 'deployment-1' });
      mockCfClient.setWorkerSecret.resolves();

      await controller.deployWorker(mockContext);

      const opts = mockCfClient.deployWorkerScript.getCall(0).args[4];
      expect(opts.tags[0]).to.equal('adobe-llmo');
      expect(opts.tags).to.deep.equal(['adobe-llmo']);
    });

    it('sanitizes Cloudflare-unsafe characters (commas, ampersands) out of the caller tag', async () => {
      mockContext.attributes = {
        authInfo: { getProfile: () => ({ email: 'a,b&c d:e' }) },
      };
      mockCfClient.deployWorkerScript.resolves({ id: 'deployment-1' });
      mockCfClient.setWorkerSecret.resolves();

      await controller.deployWorker(mockContext);

      const opts = mockCfClient.deployWorkerScript.getCall(0).args[4];
      expect(opts).to.deep.equal({ tags: ['adobe-llmo', 'a_b_c_d_e'] });
    });

    it('is idempotent (200, skips secret) when the client skips an already-tagged worker', async () => {
      // The client returns null when a worker we own (matching tag) already exists.
      mockCfClient.deployWorkerScript.resolves(null);

      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal({
        scriptName: DERIVED_SCRIPT_NAME,
        accountId: ACCOUNT_ID,
        targetHost: TARGET_HOST,
        alreadyDeployed: true,
      });
      expect(mockCfClient.setWorkerSecret).to.not.have.been.called;
    });

    it('fetches the worker script from a pinned commit SHA with a timeout', async () => {
      mockCfClient.deployWorkerScript.resolves();
      mockCfClient.setWorkerSecret.resolves();

      await controller.deployWorker(mockContext);

      const [url, opts] = mockFetch.firstCall.args;
      expect(url).to.match(/raw\.githubusercontent\.com\/adobe\/llmo-code-samples\/[0-9a-f]{40}\//);
      expect(url).to.not.include('/main/');
      expect(opts).to.have.property('signal');
    });

    it('returns 404 when site is not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(404);
      expect(mockCfClient.deployWorkerScript).to.not.have.been.called;
    });

    it('fetches the worker script from EDGE_OPTIMIZE_WORKER_SCRIPT_URL when set', async () => {
      mockContext.env.EDGE_OPTIMIZE_WORKER_SCRIPT_URL = 'https://example.test/custom-worker.js';
      mockCfClient.deployWorkerScript.resolves();
      mockCfClient.setWorkerSecret.resolves();

      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(200);
      expect(mockFetch.firstCall.args[0]).to.equal('https://example.test/custom-worker.js');
    });

    it('returns 400 when the request body is missing', async () => {
      mockContext.data = undefined;
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when accountId is missing', async () => {
      mockContext.data = { targetHost: TARGET_HOST };
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when accountId is not a 32-char hex id', async () => {
      mockContext.data = { accountId: 'acc-123', targetHost: TARGET_HOST };
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when targetHost is missing', async () => {
      mockContext.data = { accountId: ACCOUNT_ID };
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when targetHost is not a valid hostname', async () => {
      mockContext.data = { accountId: ACCOUNT_ID, targetHost: 'not a host' };
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when targetHost does not belong to the site domain', async () => {
      mockContext.data = { accountId: ACCOUNT_ID, targetHost: 'evil.com' };
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(400);
      expect(mockCfClient.deployWorkerScript).to.not.have.been.called;
    });

    it('accepts the canonical site host as targetHost', async () => {
      mockContext.data = { accountId: ACCOUNT_ID, targetHost: 'example.com' };
      mockCfClient.deployWorkerScript.resolves();
      mockCfClient.setWorkerSecret.resolves();
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(200);
    });

    it('accepts a subdomain of the site domain as targetHost', async () => {
      mockContext.data = { accountId: ACCOUNT_ID, targetHost: 'cdn.example.com' };
      mockCfClient.deployWorkerScript.resolves();
      mockCfClient.setWorkerSecret.resolves();
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(200);
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

    it('returns 502 when fetching the LLMO metaconfig fails', async () => {
      mockTokowakaClient.fetchMetaconfig.rejects(new Error('tokowaka unavailable'));
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(502);
      expect(mockCfClient.deployWorkerScript).to.not.have.been.called;
    });

    it('returns 400 when a worker name cannot be derived from the site base URL', async () => {
      mockSite.getBaseURL = () => 'https://-';
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(400);
      expect(mockCfClient.deployWorkerScript).to.not.have.been.called;
    });

    it('returns 502 when worker script fetch fails', async () => {
      mockFetch.resolves({ ok: false, status: 404, statusText: 'Not Found' });
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(502);
    });

    it('returns 502 when worker deployment fails', async () => {
      mockCfClient.deployWorkerScript.rejects(new Error('Cloudflare API returned 500 on /workers: boom'));
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(502);
      expect(mockCfClient.setWorkerSecret).to.not.have.been.called;
    });

    it('returns 502 when the deploy rejection is not an Error instance (no message)', async () => {
      mockCfClient.deployWorkerScript.rejects({ noMessage: true });
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(502);
      expect(mockCfClient.setWorkerSecret).to.not.have.been.called;
    });

    it('includes the invocation id in audit logs when present', async () => {
      mockContext.invocation = { id: 'req-abc-123' };
      mockCfClient.deployWorkerScript.resolves({ id: 'deployment-1' });
      mockCfClient.setWorkerSecret.resolves();

      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(200);
      const logged = mockContext.log.info.getCalls().map((c) => c.args[0]).join('\n');
      expect(logged).to.contain('requestId=req-abc-123');
    });

    it('returns 409 when a worker with the derived name already exists', async () => {
      mockCfClient.deployWorkerScript.rejects(
        new Error(`Worker script '${DERIVED_SCRIPT_NAME}' already exists in account ${ACCOUNT_ID}. Set overwrite: true to replace it.`),
      );
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.scriptName).to.equal(DERIVED_SCRIPT_NAME);
      expect(body.message).to.equal(
        `A worker named '${DERIVED_SCRIPT_NAME}' already exists in this Cloudflare account`,
      );
      expect(mockCfClient.setWorkerSecret).to.not.have.been.called;
    });

    it('returns 409 when existence check fails with non-JSON worker script GET (legacy client)', async () => {
      mockCfClient.deployWorkerScript.rejects(
        new Error(`Cloudflare API returned a non-JSON response on /accounts/${ACCOUNT_ID}/workers/scripts/${DERIVED_SCRIPT_NAME}`),
      );
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.scriptName).to.equal(DERIVED_SCRIPT_NAME);
      expect(body.message).to.equal(
        `A worker named '${DERIVED_SCRIPT_NAME}' already exists in this Cloudflare account`,
      );
      expect(mockCfClient.setWorkerSecret).to.not.have.been.called;
    });

    it('returns 502 with partial flag when secret set fails after deploy', async () => {
      mockCfClient.deployWorkerScript.resolves();
      mockCfClient.setWorkerSecret.rejects(new Error('Cloudflare API returned 500 on /secrets: boom'));
      const res = await controller.deployWorker(mockContext);
      expect(res.status).to.equal(502);
      const body = await res.json();
      expect(body.partial).to.be.true;
      expect(body.scriptName).to.equal(DERIVED_SCRIPT_NAME);
      expect(mockContext.log.error).to.have.been.called;
    });
  });

  // ── addRoute ─────────────────────────────────────────────────────────────

  describe('addRoute', () => {
    beforeEach(() => {
      mockContext.params = { siteId: SITE_ID };
      mockContext.data = { zoneId: ZONE_ID, pattern: 'example.com/*' };
      mockCfClient.listRoutes.resolves([]);
    });

    it('adds a route targeting the derived worker when no conflicting route exists', async () => {
      const route = { id: ROUTE_ID, pattern: 'example.com/*', script: DERIVED_SCRIPT_NAME };
      mockCfClient.addRoute.resolves(route);

      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal(route);
      expect(mockCfClient.listRoutes).to.have.been.calledWith(ZONE_ID);
      expect(mockCfClient.addRoute).to.have.been.calledWith(ZONE_ID, 'example.com/*', DERIVED_SCRIPT_NAME);
    });

    it('returns 409 and does not add when another worker already routes the same host', async () => {
      const existing = { id: ROUTE_ID, pattern: 'example.com/*', script: 'other-worker' };
      // Include a null entry to exercise the route?.pattern guard.
      mockCfClient.listRoutes.resolves([null, existing]);

      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.existingRoute).to.deep.equal(existing);
      expect(body.conflictingRoutes).to.deep.equal([existing]);
      expect(mockCfClient.addRoute).to.not.have.been.called;
    });

    it('returns 409 when a wildcard route to another worker covers the requested subdomain', async () => {
      // Customer has *.example.com/* on another worker; onboarding mistakenly targets
      // a.example.com/* — adding our worker there would collide, so it must fail with 409.
      mockContext.data = { zoneId: ZONE_ID, pattern: 'a.example.com/*' };
      const existing = { id: ROUTE_ID, pattern: '*.example.com/*', script: 'customer-worker' };
      mockCfClient.listRoutes.resolves([existing]);

      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.conflictingRoutes).to.deep.equal([existing]);
      expect(mockCfClient.addRoute).to.not.have.been.called;
    });

    it('caps conflictingRoutes at 10 for a zone with many overlapping routes', async () => {
      const many = Array.from({ length: 14 }, (_, i) => ({
        id: `r${i}`, pattern: 'example.com/*', script: `worker-${i}`,
      }));
      mockCfClient.listRoutes.resolves(many);

      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.conflictingRoutes).to.have.lengthOf(10);
      expect(mockCfClient.addRoute).to.not.have.been.called;
    });

    it('returns 409 when a broad "*example.com/*" route (no dot) on another worker covers the host', async () => {
      // *example.com/* matches the apex too (wildcard = zero-or-more chars), so onboarding
      // example.com/* must be blocked.
      mockContext.data = { zoneId: ZONE_ID, pattern: 'example.com/*' };
      const existing = { id: ROUTE_ID, pattern: '*example.com/*', script: 'customer-worker' };
      mockCfClient.listRoutes.resolves([existing]);

      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.conflictingRoutes).to.deep.equal([existing]);
      expect(mockCfClient.addRoute).to.not.have.been.called;
    });

    it('catches host conflicts across scheme/path variants (not just exact pattern strings)', async () => {
      const existing = { id: ROUTE_ID, pattern: 'https://example.com/blog/*', script: 'other-worker' };
      mockCfClient.listRoutes.resolves([existing]);

      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(409);
      expect(mockCfClient.addRoute).to.not.have.been.called;
    });

    it('allows the route when an existing route on a different host points to another worker', async () => {
      // A customer worker on a sibling subdomain must NOT block onboarding the apex host.
      mockContext.data = { zoneId: ZONE_ID, pattern: 'example.com/*' };
      const sibling = { id: ROUTE_ID, pattern: 'shop.example.com/*', script: 'other-worker' };
      mockCfClient.listRoutes.resolves([sibling]);
      const route = { id: 'r2', pattern: 'example.com/*', script: DERIVED_SCRIPT_NAME };
      mockCfClient.addRoute.resolves(route);

      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(200);
      expect(mockCfClient.addRoute).to.have.been.calledWith(ZONE_ID, 'example.com/*', DERIVED_SCRIPT_NAME);
    });

    it('does not block on an overlapping route that has no worker bound (disabled route)', async () => {
      const disabled = { id: ROUTE_ID, pattern: 'example.com/*' }; // no script
      mockCfClient.listRoutes.resolves([disabled]);
      const route = { id: 'r2', pattern: 'example.com/*', script: DERIVED_SCRIPT_NAME };
      mockCfClient.addRoute.resolves(route);

      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(200);
      expect(mockCfClient.addRoute).to.have.been.called;
    });

    it('is idempotent (200, no add) when an overlapping route already points to our worker', async () => {
      const own = { id: ROUTE_ID, pattern: 'example.com/*', script: DERIVED_SCRIPT_NAME };
      mockCfClient.listRoutes.resolves([own]);

      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.alreadyRouted).to.be.true;
      expect(mockCfClient.addRoute).to.not.have.been.called;
    });

    it('treats a null route list as empty and creates the route', async () => {
      mockCfClient.listRoutes.resolves(null);
      const route = { id: ROUTE_ID, pattern: 'example.com/*', script: DERIVED_SCRIPT_NAME };
      mockCfClient.addRoute.resolves(route);

      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(200);
      expect(mockCfClient.addRoute).to.have.been.called;
    });

    it('returns 400 when the request body is missing', async () => {
      mockContext.data = undefined;
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when pattern is missing', async () => {
      mockContext.data = { zoneId: ZONE_ID };
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when the pattern does not target the site domain', async () => {
      mockContext.data = { zoneId: ZONE_ID, pattern: 'evil.com/*' };
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(400);
      expect(mockCfClient.listRoutes).to.not.have.been.called;
      expect(mockCfClient.addRoute).to.not.have.been.called;
    });

    it('accepts a wildcard subdomain pattern within the site domain', async () => {
      mockContext.data = { zoneId: ZONE_ID, pattern: '*.example.com/*' };
      const route = { id: ROUTE_ID, pattern: '*.example.com/*', script: DERIVED_SCRIPT_NAME };
      mockCfClient.addRoute.resolves(route);
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(200);
    });

    it('returns 400 when a worker name cannot be derived from the site base URL', async () => {
      mockSite.getBaseURL = () => 'https://-';
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(400);
      expect(mockCfClient.addRoute).to.not.have.been.called;
    });

    it('returns 404 when site is not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(404);
      expect(mockCfClient.listRoutes).to.not.have.been.called;
    });

    it('returns 400 when zoneId is missing', async () => {
      mockContext.data = { pattern: 'example.com/*' };
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when zoneId is not a 32-char hex id', async () => {
      mockContext.data = { zoneId: 'zone-456', pattern: 'example.com/*' };
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when CF token is missing', async () => {
      mockContext.pathInfo.headers = {};
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 502 when the route lookup fails', async () => {
      mockCfClient.listRoutes.rejects(new Error('Cloudflare API request to /routes failed: ETIMEDOUT'));
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(502);
      expect(mockCfClient.addRoute).to.not.have.been.called;
    });

    it('returns 502 when route creation fails', async () => {
      mockCfClient.addRoute.rejects(new Error('Cloudflare API returned 500 on /routes: boom'));
      const res = await controller.addRoute(mockContext);
      expect(res.status).to.equal(502);
    });
  });

  // ── createLogpush ────────────────────────────────────────────────────────

  describe('createLogpush', () => {
    const DESTINATION_CONF = 's3://cdn-logs-adobe-dev/9E1005A551ED61CA0A490D45AdobeOrg/raw/byocdn-cloudflare/{DATE}?region=us-east-1';
    const JOB_ID = 'logpush-job-123';
    const FILENAME = '9E1005A551ED61CA0A490D45AdobeOrg/raw/byocdn-cloudflare/20260709/ownership-challenge-abc.txt';

    const okOwnershipTokenFetch = (token = 'ownership-token-xyz') => sandbox.stub().resolves({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: sandbox.stub().resolves({ ownershipToken: token }),
    });

    beforeEach(() => {
      mockContext.data = { zoneId: ZONE_ID };
      mockCfClient.listLogpushJobs.resolves([]);
      mockCfClient.requestLogpushOwnership.resolves({ filename: FILENAME, valid: true });
      mockCfClient.createLogpushJob.resolves({ id: JOB_ID });
      // Matches mockSite.getBaseURL() ('https://www.example.com') so the domain-match check
      // passes by default; individual tests override to exercise a mismatch.
      mockCfClient.getZone.resolves({ id: ZONE_ID, name: 'www.example.com' });
      mockFetch = okOwnershipTokenFetch();
    });

    it('creates a Logpush job and returns created:true', async () => {
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal({ created: true, alreadyExisted: false, jobId: JOB_ID });

      expect(mockCfClient.listLogpushJobs).to.have.been.calledWith(ZONE_ID, 'http_requests');
      expect(mockCfClient.requestLogpushOwnership)
        .to.have.been.calledWith(ZONE_ID, DESTINATION_CONF);
      expect(mockCfClient.createLogpushJob).to.have.been.calledWith(ZONE_ID, sinon.match({
        dataset: 'http_requests',
        destination_conf: DESTINATION_CONF,
        ownership_challenge: 'ownership-token-xyz',
        enabled: true,
        output_options: sinon.match({
          timestamp_format: 'rfc3339',
          field_names: sinon.match.array.deepEquals([
            'EdgeStartTimestamp',
            'ClientRequestHost',
            'ClientRequestURI',
            'ClientRequestMethod',
            'ClientRequestUserAgent',
            'EdgeResponseStatus',
            'ClientRequestReferer',
            'EdgeResponseContentType',
            'EdgeTimeToFirstByteMs',
          ]),
        }),
      }));

      // The auth-service call forwards the caller's own Authorization header + x-product, and
      // never has api-service touch S3 directly. POST with a body, not GET with a query string
      // — the endpoint has real side effects (deletes the S3 file, writes Secrets Manager).
      const [fetchUrl, fetchOptions] = mockFetch.getCall(0).args;
      expect(fetchUrl).to.equal(
        'https://auth.example.com/auth/cdn-logs-infrastructure/cloudflare-ownership-token',
      );
      expect(fetchOptions.method).to.equal('POST');
      expect(JSON.parse(fetchOptions.body)).to.deep.equal({ siteId: SITE_ID, filename: FILENAME });
      expect(fetchOptions.headers.Authorization).to.equal('Bearer caller-token');
      expect(fetchOptions.headers['x-product']).to.equal('LLMO');
    });

    it('omits the Authorization header when the caller request had none', async () => {
      delete mockContext.pathInfo.headers.authorization;
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(200);
      const [, fetchOptions] = mockFetch.getCall(0).args;
      expect(fetchOptions.headers).to.not.have.property('Authorization');
    });

    it('omits filename from the auth-service request body when Cloudflare returns none', async () => {
      mockCfClient.requestLogpushOwnership.resolves({ valid: true });
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(200);
      const [, fetchOptions] = mockFetch.getCall(0).args;
      expect(JSON.parse(fetchOptions.body)).to.deep.equal({ siteId: SITE_ID });
    });

    it('treats a null Logpush job list as empty and creates a new job', async () => {
      mockCfClient.listLogpushJobs.resolves(null);
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(200);
      expect(mockCfClient.createLogpushJob).to.have.been.called;
    });

    it('returns 400 when the site host has no registrable domain (domain-match guard, not reached)', async () => {
      // The domain-match guard computes registrableDomain from the same site.getBaseURL()
      // used for the job name, so a site with no registrable domain is rejected before job
      // creation is ever attempted — there is no siteId fallback to fall back to.
      mockSite.getBaseURL = () => 'https://localhost';
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(400);
      expect(mockCfClient.createLogpushJob).to.not.have.been.called;
    });

    it('uses the site\'s registrable domain as the Logpush job name', async () => {
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(200);
      expect(mockCfClient.createLogpushJob).to.have.been.calledWith(
        ZONE_ID,
        sinon.match({ name: 'example.com' }),
      );
    });

    it('is idempotent (does not create) when a job with the same destination already exists', async () => {
      const existing = { id: 'existing-job', destination_conf: DESTINATION_CONF };
      mockCfClient.listLogpushJobs.resolves([null, existing]);

      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal({ created: false, alreadyExisted: true, jobId: 'existing-job' });
      expect(mockCfClient.requestLogpushOwnership).to.not.have.been.called;
      expect(mockCfClient.createLogpushJob).to.not.have.been.called;
    });

    it('ignores a job with a different destination_conf and creates a new one', async () => {
      mockCfClient.listLogpushJobs.resolves([{ id: 'other-job', destination_conf: 's3://other/x' }]);
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(200);
      expect(mockCfClient.createLogpushJob).to.have.been.called;
    });

    it('returns 409 when the site is missing bucketName in its CDN bucket config', async () => {
      mockSite.getConfig = () => ({ getLlmoCdnBucketConfig: () => ({ allowedPaths: ['x/'], region: 'us-east-1' }) });
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(409);
      expect(mockCfClient.listLogpushJobs).to.not.have.been.called;
    });

    it('returns 409 when the site has no CDN bucket config at all', async () => {
      mockSite.getConfig = () => ({ getLlmoCdnBucketConfig: () => null });
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(409);
    });

    it('returns 400 when zoneId is missing from the request body', async () => {
      mockContext.data = {};
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when the request body is missing entirely', async () => {
      mockContext.data = undefined;
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when zoneId is not a 32-char hex id', async () => {
      mockContext.data = { zoneId: 'not-hex' };
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(400);
    });

    it("returns 400 when the zone's domain does not match the site's domain", async () => {
      mockCfClient.getZone.resolves({ id: ZONE_ID, name: 'unrelated-domain.com' });
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include("does not belong to the site's domain");
      expect(mockCfClient.listLogpushJobs).to.not.have.been.called;
    });

    it('accepts a zone whose domain is a subdomain of the site domain', async () => {
      mockCfClient.getZone.resolves({ id: ZONE_ID, name: 'www.example.com' });
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(200);
    });

    it('returns 400 when the zone has no resolvable domain', async () => {
      mockCfClient.getZone.resolves({ id: ZONE_ID, name: '' });
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 502 when the zone lookup fails', async () => {
      mockCfClient.getZone.rejects(new Error('Cloudflare API returned 500 on /zones: boom'));
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(502);
      expect(mockCfClient.listLogpushJobs).to.not.have.been.called;
    });

    it('returns 400 when CF token is missing', async () => {
      mockContext.pathInfo.headers = {};
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns 404 when site is not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(404);
      expect(mockCfClient.listLogpushJobs).to.not.have.been.called;
    });

    it('returns 502 when the Logpush job listing fails', async () => {
      mockCfClient.listLogpushJobs.rejects(new Error('Cloudflare API returned 500 on /jobs: boom'));
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(502);
      expect(mockCfClient.requestLogpushOwnership).to.not.have.been.called;
    });

    it('returns 502 when the ownership challenge request fails', async () => {
      mockCfClient.requestLogpushOwnership.rejects(new Error('Cloudflare API returned 500 on /ownership: boom'));
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(502);
      expect(mockFetch).to.not.have.been.called;
      expect(mockCfClient.createLogpushJob).to.not.have.been.called;
    });

    it('returns 502 when AUTH_SERVICE_BASE_URL is not configured', async () => {
      delete mockContext.env.AUTH_SERVICE_BASE_URL;
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(502);
      expect(mockFetch).to.not.have.been.called;
      expect(mockCfClient.createLogpushJob).to.not.have.been.called;
    });

    it('returns 502 when the auth-service ownership-token call fails (non-ok response)', async () => {
      mockFetch = sandbox.stub().resolves({ ok: false, status: 500, statusText: 'Internal Server Error' });
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(502);
      expect(mockCfClient.createLogpushJob).to.not.have.been.called;
    });

    it('returns 502 when the auth-service response has no ownershipToken', async () => {
      mockFetch = sandbox.stub().resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: sandbox.stub().resolves({}),
      });
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(502);
      expect(mockCfClient.createLogpushJob).to.not.have.been.called;
    });

    it('recovers from a create-time race by re-listing and returning alreadyExisted:true', async () => {
      mockCfClient.createLogpushJob.rejects(new Error('Cloudflare API returned 400 on /jobs: duplicate destination'));
      // Second listLogpushJobs call (post-failure re-check) finds the job the race created.
      mockCfClient.listLogpushJobs.onSecondCall().resolves([{ id: 'race-job', destination_conf: DESTINATION_CONF }]);

      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal({ created: false, alreadyExisted: true, jobId: 'race-job' });
    });

    it('returns 502 when job creation fails and the post-failure re-check finds no match', async () => {
      mockCfClient.createLogpushJob.rejects(new Error('Cloudflare API returned 500 on /jobs: boom'));
      // Null re-check result exercises the same "treat as empty" fallback as the initial check.
      mockCfClient.listLogpushJobs.onSecondCall().resolves(null);
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(502);
    });

    it('returns 502 when job creation fails and the post-failure re-check itself fails', async () => {
      mockCfClient.createLogpushJob.rejects(new Error('Cloudflare API returned 500 on /jobs: boom'));
      mockCfClient.listLogpushJobs.onSecondCall().rejects(new Error('Cloudflare API returned 500 on /jobs: boom'));
      const res = await controller.createLogpush(mockContext);
      expect(res.status).to.equal(502);
    });
  });
});
