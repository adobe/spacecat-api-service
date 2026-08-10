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
const PROPERTY_ID = 'prp_1253269';
const CONTRACT_ID = 'ctr_1-ABC123';
const GROUP_ID = 'grp_18385';
const LLMO_API_KEY = 'llmo-api-key-xyz';
const CALLER_EMAIL = 'onboarder@adobe.com';

// A minimal but valid PAPI rule tree the client returns from getRuleTree. The default rule has a
// CUSTOM origin (passes the onboarding scope gate) and its own Caching behavior (so the OAE rule is
// built WITHOUT adding a Caching behavior of its own — the common/tokowaka case).
const RULE_TREE = {
  rules: {
    name: 'default',
    behaviors: [
      { name: 'origin', options: { verificationMode: 'CUSTOM' } },
      { name: 'caching', options: { behavior: 'CACHE_CONTROL_AND_EXPIRES' } },
    ],
    children: [{ name: 'Existing' }],
    variables: [],
  },
};

describe('LlmoAkamaiController', () => {
  let sandbox;
  let LlmoAkamaiController;
  let controller;
  let mockContext;
  let mockSite;
  let mockAccessControlUtil;
  let mockAkamaiClient;
  let mockTokowakaClient;
  let capturedClientConfig;

  before(async () => {
    // esmock is expensive, so wire it once. The mock factories read the mutable outer references
    // (reassigned per-test in beforeEach) so each test gets fresh stubs without re-running esmock.
    // Captures the constructor config so tests can assert credential + notifyEmails forwarding, and
    // throws on a sentinel client-token so the requireClient catch-branch can be exercised.
    function AkamaiClientMock(cfg) {
      capturedClientConfig = cfg;
      if (cfg && cfg.clientToken === '__throw__') {
        throw new Error('AkamaiClient requires clientToken');
      }
      return mockAkamaiClient;
    }
    // Mirror the real activationIdFromLink: strip the query string, trailing slashes, then the
    // last path segment.
    AkamaiClientMock.activationIdFromLink = (link) => (link || '').split('?')[0].replace(/\/+$/, '').split('/').pop();

    const mod = await esmock('../../../src/controllers/llmo/llmo-akamai.js', {
      '@adobe/spacecat-shared-akamai-client': {
        default: AkamaiClientMock,
        normalizeDomain: (d) => String(d || '').trim().toLowerCase().replace(/\.$/, ''),
      },
      '@adobe/spacecat-shared-tokowaka-client': {
        default: { createFrom: () => mockTokowakaClient },
      },
      '../../../src/support/access-control-util.js': {
        default: { fromContext: () => mockAccessControlUtil },
      },
    });
    LlmoAkamaiController = mod.default;
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    capturedClientConfig = undefined;

    mockAkamaiClient = {
      findPropertiesByDomain: sandbox.stub().resolves([
        { propertyId: PROPERTY_ID, propertyName: 'example', matchedOn: ['hostname'] },
      ]),
      getLatestVersion: sandbox.stub().resolves(7),
      getRuleTree: sandbox.stub().resolves({ ruleTree: RULE_TREE, ruleFormat: 'v2024-01-01', etag: 'etag-7' }),
      createVersion: sandbox.stub().resolves(8),
      updateRuleTree: sandbox.stub().resolves({ errors: [], warnings: [] }),
      patchRuleTree: sandbox.stub().resolves({ errors: [], warnings: [] }),
      activate: sandbox.stub().resolves('/papi/v1/properties/prp_1253269/activations/atv_123'),
      getActivation: sandbox.stub().resolves({ activationId: 'atv_123', status: 'ACTIVE' }),
      latestActivation: sandbox.stub().resolves({ activationId: 'atv_999', status: 'PENDING' }),
    };
    // Deploy fetches the NEW version (8); return a distinct etag so the deploy test proves it uses
    // the freshly-fetched version's etag, not a stale one from the latest-version (v7) lookup.
    mockAkamaiClient.getRuleTree.withArgs(PROPERTY_ID, 8)
      .resolves({ ruleTree: RULE_TREE, ruleFormat: 'v2024-01-01', etag: 'etag-8' });

    mockTokowakaClient = {
      fetchMetaconfig: sandbox.stub().resolves({ apiKeys: [LLMO_API_KEY] }),
    };

    mockSite = {
      getId: () => SITE_ID,
      getBaseURL: () => 'https://www.example.com',
    };

    mockAccessControlUtil = {
      hasAccess: sandbox.stub().resolves(true),
      isLLMOAdministrator: sandbox.stub().returns(true),
    };

    mockContext = {
      log: { info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub() },
      env: {},
      params: { siteId: SITE_ID },
      pathInfo: {
        headers: {
          'x-akamai-host': 'akab-xxx.luna.akamaiapis.net',
          'x-akamai-client-token': 'ctok',
          'x-akamai-client-secret': 'csec',
          'x-akamai-access-token': 'atok',
        },
      },
      data: {},
      dataAccess: { Site: { findById: sandbox.stub().resolves(mockSite) } },
      attributes: {
        authInfo: { getProfile: () => ({ email: 'guid@org.e', trial_email: CALLER_EMAIL }) },
      },
      invocation: { id: 'req-1' },
    };

    controller = LlmoAkamaiController(mockContext);
  });

  afterEach(() => sandbox.restore());

  const withData = (data) => ({ ...mockContext, data });
  const propertyRef = { propertyId: PROPERTY_ID, contractId: CONTRACT_ID, groupId: GROUP_ID };

  describe('access control', () => {
    it('returns 404 when the site is not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const res = await controller.getConfig(mockContext);
      expect(res.status).to.equal(404);
    });

    it('returns 403 when the caller lacks site access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);
      const res = await controller.getConfig(mockContext);
      expect(res.status).to.equal(403);
    });

    it('returns 403 when the caller is not an LLMO administrator', async () => {
      mockAccessControlUtil.isLLMOAdministrator.returns(false);
      const res = await controller.getConfig(mockContext);
      expect(res.status).to.equal(403);
    });
  });

  describe('getConfig', () => {
    it('returns the supported networks and required credential headers', async () => {
      const res = await controller.getConfig(mockContext);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.networks).to.deep.equal(['STAGING', 'PRODUCTION']);
      expect(body.requiredCredentialHeaders).to.include('x-akamai-host');
    });
  });

  describe('listProperties', () => {
    it('returns 400 when a credential header is missing', async () => {
      delete mockContext.pathInfo.headers['x-akamai-client-secret'];
      const res = await controller.listProperties(mockContext);
      expect(res.status).to.equal(400);
    });

    it('returns properties serving the site domain', async () => {
      const res = await controller.listProperties(mockContext);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.domain).to.equal('www.example.com');
      expect(body.properties[0].propertyId).to.equal(PROPERTY_ID);
      expect(mockAkamaiClient.findPropertiesByDomain).to.have.been.calledWith('www.example.com');
    });

    it('emits a list-properties audit line carrying caller and host (onboarding-started signal)', async () => {
      await controller.listProperties(mockContext);
      const logged = mockContext.log.info.getCalls().map((c) => c.args[0]).join('\n');
      expect(logged).to.contain('[llmo-akamai] action=list-properties outcome=ok');
      expect(logged).to.contain('host=www.example.com');
      expect(logged).to.contain('caller=');
    });

    it('returns 200 with an empty list when the client finds nothing (it swallows search errors)', async () => {
      // The real findPropertiesByDomain returns [] on bad creds/no match rather than rejecting.
      mockAkamaiClient.findPropertiesByDomain.resolves([]);
      const res = await controller.listProperties(mockContext);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.properties).to.deep.equal([]);
    });

    it('defensively maps a thrown PAPI 401 to a 401 (future client versions)', async () => {
      mockAkamaiClient.findPropertiesByDomain.rejects(new Error('PAPI POST /papi/v1/search -> 401: nope'));
      const res = await controller.listProperties(mockContext);
      expect(res.status).to.equal(401);
    });

    it('rejects a non-EdgeGrid x-akamai-host (SSRF guard)', async () => {
      mockContext.pathInfo.headers['x-akamai-host'] = 'https://evil.example.com/steal';
      const res = await controller.listProperties(mockContext);
      expect(res.status).to.equal(400);
      expect(mockAkamaiClient.findPropertiesByDomain).to.not.have.been.called;
    });

    it('rejects an IP-literal x-akamai-host (SSRF guard)', async () => {
      mockContext.pathInfo.headers['x-akamai-host'] = '169.254.169.254';
      const res = await controller.listProperties(mockContext);
      expect(res.status).to.equal(400);
    });

    it('rejects a malformed x-akamai-account-switch-key', async () => {
      mockContext.pathInfo.headers['x-akamai-account-switch-key'] = 'bad key!';
      const res = await controller.listProperties(mockContext);
      expect(res.status).to.equal(400);
    });

    it('accepts a well-formed account switch key', async () => {
      mockContext.pathInfo.headers['x-akamai-account-switch-key'] = '1-ABC123:1-DEF456';
      const res = await controller.listProperties(mockContext);
      expect(res.status).to.equal(200);
    });
  });

  describe('plan', () => {
    it('returns the before/after child rules and merged tree, without any Akamai validation call', async () => {
      const res = await controller.plan(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.latestVersion).to.equal(7);
      expect(body.currentChildRules).to.deep.equal(['Existing']);
      // The OAE wrapper is appended LAST so its origin + cacheId win (Akamai is last-match-wins).
      expect(body.mergedChildRules).to.deep.equal(['Existing', 'Optimize at Edge']);
      expect(body.mergedChildRules[body.mergedChildRules.length - 1]).to.equal('Optimize at Edge');
      // plan is now a fast read-only preview: NO dry-run, NO version created — the slow validate
      // call moved to deploy (it timed out past the CDN window on large properties).
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
      expect(mockAkamaiClient.updateRuleTree).to.not.have.been.called;
      // No pre-deploy validation is performed; the shape is kept for FE compatibility.
      expect(body.validated).to.equal(false);
      expect(body.errors).to.deep.equal([]);
      expect(body.warnings).to.deep.equal([]);
    });

    it('injects the x-edgeoptimize-fetcher-key header in the preview with its value redacted', async () => {
      const res = await controller.plan(withData({ ...propertyRef }));
      const body = await res.json();
      expect(res.status).to.equal(200);
      const headers = [];
      const collect = (rule) => {
        (rule.behaviors || []).forEach((b) => {
          if (b.name === 'modifyIncomingRequestHeader') {
            headers.push(b.options);
          }
        });
        (rule.children || []).forEach(collect);
      };
      collect(body.merged.rules);
      // The header is present (deploy adds it too), but its value is redacted in the returned tree.
      const fetcher = headers.find((o) => o.customHeaderName === 'x-edgeoptimize-fetcher-key');
      expect(fetcher).to.exist;
      expect(fetcher.headerValue).to.equal('***');
      // redactSecrets also redacts the LLMO API key.
      const apiKey = headers.find((o) => o.customHeaderName === 'x-edgeoptimize-api-key');
      expect(apiKey.headerValue).to.equal('***');
    });

    it('redacts the LLMO API key from the previewed merged tree', async () => {
      const res = await controller.plan(withData(propertyRef));
      const body = await res.json();
      const serialized = JSON.stringify(body.merged);
      expect(serialized).to.not.contain(LLMO_API_KEY);
      expect(serialized).to.contain('***');
    });

    it('rejects a malformed propertyId', async () => {
      const res = await controller.plan(withData({ ...propertyRef, propertyId: 'nope' }));
      expect(res.status).to.equal(400);
    });

    it('returns 500 when the site has no LLMO API key', async () => {
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: [] });
      const res = await controller.plan(withData(propertyRef));
      expect(res.status).to.equal(500);
    });

    it('returns 502 when fetching the metaconfig fails', async () => {
      mockTokowakaClient.fetchMetaconfig.rejects(new Error('boom'));
      const res = await controller.plan(withData(propertyRef));
      expect(res.status).to.equal(502);
    });
  });

  describe('deploy', () => {
    it('creates a new version, applies the rules via a full-tree PUT, and returns it', async () => {
      const res = await controller.deploy(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.baseVersion).to.equal(7);
      expect(body.newVersion).to.equal(8);
      // The tree is read from the BASE version (for the scope gate + merge), then the merged tree
      // is PUT into the NEW version, pinning the base version's ruleFormat.
      expect(mockAkamaiClient.getRuleTree).to.have.been.calledWith(PROPERTY_ID, 7);
      expect(mockAkamaiClient.updateRuleTree).to.have.been.calledOnce;
      const [, version, , , merged, ruleFormat] = mockAkamaiClient.updateRuleTree.firstCall.args;
      expect(version).to.equal(8);
      expect(ruleFormat).to.equal('v2024-01-01');
      const parent = merged.rules.children.find((c) => c.name === 'Optimize at Edge');
      expect(parent).to.exist;
      expect(mockAkamaiClient.patchRuleTree).to.not.have.been.called;
    });

    it('blocks deploy when the property does not serve the site domain', async () => {
      mockAkamaiClient.findPropertiesByDomain.resolves([
        { propertyId: 'prp_other', matchedOn: ['hostname'] },
      ]);
      const res = await controller.deploy(withData(propertyRef));
      expect(res.status).to.equal(403);
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
    });

    it('returns 422 when PAPI rejects the rule tree', async () => {
      mockAkamaiClient.updateRuleTree.resolves({ errors: [{ title: 'bad' }], warnings: [] });
      const res = await controller.deploy(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(422);
      expect(body.papiErrors).to.have.length(1);
    });

    it('maps a PAPI 403 to a 403 response', async () => {
      mockAkamaiClient.getLatestVersion.rejects(new Error('PAPI GET /x -> 403: locked'));
      const res = await controller.deploy(withData(propertyRef));
      expect(res.status).to.equal(403);
    });

    it('reports the created newVersion when the PUT throws after createVersion', async () => {
      mockAkamaiClient.updateRuleTree.rejects(new Error('PAPI PUT /x -> 500: boom'));
      const res = await controller.deploy(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(502);
      expect(body.newVersion).to.equal(8);
    });

    it('accepts an explicit baseVersion and copies from it', async () => {
      const res = await controller.deploy(withData({ ...propertyRef, baseVersion: 5 }));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.baseVersion).to.equal(5);
      expect(mockAkamaiClient.getRuleTree).to.have.been.calledWith(PROPERTY_ID, 5);
      expect(mockAkamaiClient.createVersion).to.have.been.calledWith(PROPERTY_ID, 5);
      // Default (latest) is not consulted when baseVersion is given.
      expect(mockAkamaiClient.getLatestVersion).to.not.have.been.called;
    });

    it('rejects a non-integer baseVersion', async () => {
      const res = await controller.deploy(withData({ ...propertyRef, baseVersion: '1e3' }));
      expect(res.status).to.equal(400);
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
    });

    it('resumes into retryVersion instead of minting a new version', async () => {
      const res = await controller.deploy(withData({ ...propertyRef, retryVersion: 9 }));
      const body = await res.json();
      expect(res.status).to.equal(200);
      // Guard against version pileup: no new version is created — we write into the existing one.
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
      expect(body.newVersion).to.equal(9);
      // The PUT targets the resumed version.
      const [, putVersion] = mockAkamaiClient.updateRuleTree.firstCall.args;
      expect(putVersion).to.equal(9);
    });

    it('rejects a non-positive-integer retryVersion', async () => {
      const res = await controller.deploy(withData({ ...propertyRef, retryVersion: '0' }));
      expect(res.status).to.equal(400);
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
      expect(mockAkamaiClient.updateRuleTree).to.not.have.been.called;
    });

    it('always injects a server-minted x-edgeoptimize-fetcher-key header and returns it', async () => {
      const res = await controller.deploy(withData({ ...propertyRef }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      const [, , , , merged] = mockAkamaiClient.updateRuleTree.firstCall.args;
      const headers = [];
      const collect = (rule) => {
        (rule.behaviors || []).forEach((b) => {
          if (b.name === 'modifyIncomingRequestHeader') {
            headers.push(b.options);
          }
        });
        (rule.children || []).forEach(collect);
      };
      collect(merged.rules.children.find((c) => c.name === 'Optimize at Edge'));
      const fetcher = headers.find((o) => o.customHeaderName === 'x-edgeoptimize-fetcher-key');
      expect(fetcher).to.exist;
      // 32 random bytes as hex (`openssl rand -hex 32`).
      expect(fetcher.headerValue).to.match(/^[0-9a-f]{64}$/);
      // The deployed key is returned once and matches what was baked into the rule.
      expect(body.fetcherKey).to.equal(fetcher.headerValue);
    });

    it('mints a fresh fetcher key on each deploy (rotation)', async () => {
      const first = await (await controller.deploy(withData({ ...propertyRef }))).json();
      const second = await (await controller.deploy(withData({ ...propertyRef }))).json();
      expect(first.fetcherKey).to.match(/^[0-9a-f]{64}$/);
      expect(second.fetcherKey).to.not.equal(first.fetcherKey);
    });

    it('rejects baseVersion 0 (PAPI versions start at 1)', async () => {
      const res = await controller.deploy(withData({ ...propertyRef, baseVersion: 0 }));
      expect(res.status).to.equal(400);
      expect(mockAkamaiClient.getRuleTree).to.not.have.been.called;
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
    });
  });

  describe('CUSTOM scope gate + caching decision', () => {
    // Default rule origin is PLATFORM_SETTINGS -> onboarding is not supported.
    const platformTree = {
      rules: {
        name: 'default',
        behaviors: [{ name: 'origin', options: { verificationMode: 'PLATFORM_SETTINGS' } }],
        children: [],
        variables: [],
      },
    };

    it('deploy rejects (400) a property whose default origin is not CUSTOM', async () => {
      mockAkamaiClient.getRuleTree.resolves({ ruleTree: platformTree, ruleFormat: 'latest' });
      const res = await controller.deploy(withData(propertyRef));
      expect(res.status).to.equal(400);
      // Gate runs before any mutation.
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
      expect(mockAkamaiClient.updateRuleTree).to.not.have.been.called;
    });

    it('plan rejects (400) a property whose default origin is not CUSTOM', async () => {
      mockAkamaiClient.getRuleTree.resolves({ ruleTree: platformTree, ruleFormat: 'latest' });
      const res = await controller.plan(withData(propertyRef));
      expect(res.status).to.equal(400);
    });

    it('adds a Caching behavior to the OAE rule ONLY when the default rule has none', async () => {
      // Default tree here (RULE_TREE) HAS caching -> OAE routing rule must NOT add its own.
      await controller.deploy(withData(propertyRef));
      const withCaching = mockAkamaiClient.updateRuleTree.firstCall.args[4];
      const routingA = withCaching.rules.children
        .find((c) => c.name === 'Optimize at Edge').children
        .find((c) => c.name === 'Optimize at Edge Routing');
      expect(routingA.behaviors.some((b) => b.name === 'caching')).to.equal(false);

      // A default rule WITHOUT caching -> OAE routing rule adds one so cacheId validates.
      mockAkamaiClient.updateRuleTree.resetHistory();
      const noCacheTree = {
        rules: {
          name: 'default',
          behaviors: [{ name: 'origin', options: { verificationMode: 'CUSTOM' } }],
          children: [],
          variables: [],
        },
      };
      mockAkamaiClient.getRuleTree.resolves({ ruleTree: noCacheTree, ruleFormat: 'latest' });
      await controller.deploy(withData(propertyRef));
      const noCache = mockAkamaiClient.updateRuleTree.firstCall.args[4];
      const routingB = noCache.rules.children
        .find((c) => c.name === 'Optimize at Edge').children
        .find((c) => c.name === 'Optimize at Edge Routing');
      expect(routingB.behaviors.some((b) => b.name === 'caching')).to.equal(true);
    });
  });

  describe('deployStatus', () => {
    // A tree WITH the managed OAE wrapper at top level (what a completed deploy leaves behind).
    const DEPLOYED_TREE = {
      rules: {
        name: 'default',
        behaviors: [],
        children: [{ name: 'Existing' }, { name: 'Optimize at Edge', children: [] }],
        variables: [],
      },
    };

    it('reports deployed:false when the checked version has no managed rule (default: latest)', async () => {
      const res = await controller.deployStatus(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(200);
      // Defaults to the latest version and reads it (no version param supplied).
      expect(body.version).to.equal(7);
      expect(body.latestVersion).to.equal(7);
      expect(body.deployed).to.equal(false);
      expect(body.managedRulesPresent).to.deep.equal([]);
      expect(mockAkamaiClient.getRuleTree).to.have.been.calledWith(PROPERTY_ID, 7);
      // Read-only: never creates a version or writes.
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
      expect(mockAkamaiClient.updateRuleTree).to.not.have.been.called;
    });

    it('reports deployed:true when the checked version has the managed rule', async () => {
      mockAkamaiClient.getRuleTree.withArgs(PROPERTY_ID, 7)
        .resolves({ ruleTree: DEPLOYED_TREE, ruleFormat: 'v2024-01-01', etag: 'etag-7' });
      const res = await controller.deployStatus(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.deployed).to.equal(true);
      expect(body.managedRulesPresent).to.deep.equal(['Optimize at Edge']);
    });

    it('checks a specific version when one is supplied', async () => {
      mockAkamaiClient.getRuleTree.withArgs(PROPERTY_ID, 5)
        .resolves({ ruleTree: DEPLOYED_TREE, ruleFormat: 'v2024-01-01', etag: 'etag-5' });
      const res = await controller.deployStatus(withData({ ...propertyRef, version: '5' }));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.version).to.equal(5);
      // latestVersion is still reported alongside the checked version.
      expect(body.latestVersion).to.equal(7);
      expect(body.deployed).to.equal(true);
      expect(mockAkamaiClient.getRuleTree).to.have.been.calledWith(PROPERTY_ID, 5);
    });

    // A managed tree carrying a specific per-deploy fetcher key, for re-onboard disambiguation.
    const treeWithFetcherKey = (key) => ({
      rules: {
        name: 'default',
        children: [{
          name: 'Optimize at Edge',
          children: [{
            name: 'Optimize at Edge Routing',
            behaviors: [{
              name: 'modifyIncomingRequestHeader',
              options: { customHeaderName: 'x-edgeoptimize-fetcher-key', headerValue: key },
            }],
          }],
        }],
        variables: [],
      },
    });

    it('reports freshWrite:true when the fetcher key differs from the base (write landed)', async () => {
      mockAkamaiClient.getRuleTree.withArgs(PROPERTY_ID, 7)
        .resolves({ ruleTree: treeWithFetcherKey('NEW_KEY'), ruleFormat: 'v', etag: 'e7' });
      mockAkamaiClient.getRuleTree.withArgs(PROPERTY_ID, 6)
        .resolves({ ruleTree: treeWithFetcherKey('OLD_KEY'), ruleFormat: 'v', etag: 'e6' });
      const res = await controller.deployStatus(withData({ ...propertyRef, baseVersion: '6' }));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.deployed).to.equal(true);
      expect(body.freshWrite).to.equal(true);
      // The secret fetcher-key value is compared server-side but never returned.
      expect(JSON.stringify(body)).to.not.contain('NEW_KEY');
      expect(JSON.stringify(body)).to.not.contain('OLD_KEY');
    });

    it('reports freshWrite:false when the version is an unwritten clone (same key as base)', async () => {
      mockAkamaiClient.getRuleTree.withArgs(PROPERTY_ID, 7)
        .resolves({ ruleTree: treeWithFetcherKey('SAME_KEY'), ruleFormat: 'v', etag: 'e7' });
      mockAkamaiClient.getRuleTree.withArgs(PROPERTY_ID, 6)
        .resolves({ ruleTree: treeWithFetcherKey('SAME_KEY'), ruleFormat: 'v', etag: 'e6' });
      const res = await controller.deployStatus(withData({ ...propertyRef, baseVersion: '6' }));
      const body = await res.json();
      expect(body.deployed).to.equal(true);
      expect(body.freshWrite).to.equal(false);
    });

    it('omits freshWrite when no baseVersion is supplied', async () => {
      mockAkamaiClient.getRuleTree.withArgs(PROPERTY_ID, 7)
        .resolves({ ruleTree: treeWithFetcherKey('K'), ruleFormat: 'v', etag: 'e7' });
      const res = await controller.deployStatus(withData(propertyRef));
      const body = await res.json();
      expect(body.deployed).to.equal(true);
      expect(body).to.not.have.property('freshWrite');
      // No base comparison ⇒ only the target version was read.
      expect(mockAkamaiClient.getRuleTree).to.have.been.calledOnceWith(PROPERTY_ID, 7);
    });

    it('rejects a non-positive-integer version', async () => {
      const res = await controller.deployStatus(withData({ ...propertyRef, version: '0' }));
      expect(res.status).to.equal(400);
    });

    it('rejects a non-positive-integer baseVersion', async () => {
      const res = await controller.deployStatus(withData({ ...propertyRef, baseVersion: '0' }));
      expect(res.status).to.equal(400);
    });

    it('with validate=true, reports activatable:false + errors when the version has validation errors', async () => {
      mockAkamaiClient.getRuleTree.withArgs(PROPERTY_ID, 7)
        .resolves({
          ruleTree: DEPLOYED_TREE,
          ruleFormat: 'v',
          errors: [{ detail: 'rule X invalid' }, { detail: 'rule Y invalid' }],
          warnings: [{ detail: 'w' }],
        });
      const res = await controller.deployStatus(withData({ ...propertyRef, validate: 'true' }));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.deployed).to.equal(true);
      expect(body.activatable).to.equal(false);
      expect(body.errorCount).to.equal(2);
      expect(body.errors).to.have.length(2);
      expect(body.warningCount).to.equal(1);
      // The validated read must ask PAPI to validate.
      expect(mockAkamaiClient.getRuleTree)
        .to.have.been.calledWith(PROPERTY_ID, 7, CONTRACT_ID, GROUP_ID, { validateRules: true });
    });

    it('with validate=true, reports activatable:true when the version has no errors', async () => {
      mockAkamaiClient.getRuleTree.withArgs(PROPERTY_ID, 7)
        .resolves({
          ruleTree: DEPLOYED_TREE, ruleFormat: 'v', errors: [], warnings: [],
        });
      const res = await controller.deployStatus(withData({ ...propertyRef, validate: 'true' }));
      const body = await res.json();
      expect(body.activatable).to.equal(true);
      expect(body.errorCount).to.equal(0);
    });

    it('omits activatable/errorCount when validate is not requested', async () => {
      const res = await controller.deployStatus(withData(propertyRef));
      const body = await res.json();
      expect(body).to.not.have.property('activatable');
      expect(body).to.not.have.property('errorCount');
      // Cheap read: validateRules not requested.
      expect(mockAkamaiClient.getRuleTree)
        .to.have.been.calledWith(PROPERTY_ID, 7, CONTRACT_ID, GROUP_ID, { validateRules: false });
    });

    it('maps a PAPI error through the shared error mapper', async () => {
      mockAkamaiClient.getRuleTree.rejects(new Error('PAPI GET /x -> 500: boom'));
      const res = await controller.deployStatus(withData(propertyRef));
      expect(res.status).to.equal(502);
    });

    it('rejects a malformed propertyId', async () => {
      const res = await controller.deployStatus(withData({ ...propertyRef, propertyId: 'nope' }));
      expect(res.status).to.equal(400);
    });
  });

  describe('activate', () => {
    it('activates the latest version to STAGING and returns the activation id', async () => {
      const res = await controller.activate(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.network).to.equal('STAGING');
      expect(body.version).to.equal(7);
      expect(body.activationId).to.equal('atv_123');
      // notifyEmails is derived server-side from the caller's trial_email.
      expect(mockAkamaiClient.activate)
        .to.have.been.calledWith(PROPERTY_ID, 7, CONTRACT_ID, GROUP_ID, 'STAGING');
    });

    it('passes an activation note attributing the caller', async () => {
      await controller.activate(withData(propertyRef));
      const note = mockAkamaiClient.activate.firstCall.args[5];
      expect(note).to.be.a('string');
      expect(note).to.contain('Optimize at Edge');
      expect(note).to.contain('via Adobe LLM Optimizer');
    });

    it('activates a specific version when provided', async () => {
      const res = await controller.activate(withData({ ...propertyRef, version: 5 }));
      const body = await res.json();
      expect(body.version).to.equal(5);
      expect(mockAkamaiClient.getLatestVersion).to.not.have.been.called;
    });

    it('activates to PRODUCTION when requested', async () => {
      const res = await controller.activate(withData({ ...propertyRef, network: 'PRODUCTION' }));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.network).to.equal('PRODUCTION');
    });

    it('rejects an unknown network', async () => {
      const res = await controller.activate(withData({ ...propertyRef, network: 'DEV' }));
      expect(res.status).to.equal(400);
    });

    it('rejects a non-integer version', async () => {
      const res = await controller.activate(withData({ ...propertyRef, version: 'abc' }));
      expect(res.status).to.equal(400);
    });

    it('rejects version 0', async () => {
      const res = await controller.activate(withData({ ...propertyRef, version: 0 }));
      expect(res.status).to.equal(400);
      expect(mockAkamaiClient.activate).to.not.have.been.called;
    });

    it('returns 403 when no notify email can be derived from the caller', async () => {
      // getProfile() returning undefined exercises the empty-profile fallback in getCallerEmail.
      mockContext.attributes.authInfo.getProfile = () => undefined;
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(403);
      expect(mockAkamaiClient.activate).to.not.have.been.called;
    });

    it('falls back to preferred_username for the notify email when trial_email is absent', async () => {
      mockContext.attributes.authInfo.getProfile = () => ({ preferred_username: 'admin@corp.com' });
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(200);
      expect(capturedClientConfig.notifyEmails).to.deep.equal(['admin@corp.com']);
    });

    it('rejects a non-decimal version (e.g. 1e3)', async () => {
      const res = await controller.activate(withData({ ...propertyRef, version: '1e3' }));
      expect(res.status).to.equal(400);
      expect(mockAkamaiClient.activate).to.not.have.been.called;
    });

    it('returns 502 when Akamai returns no activation link', async () => {
      mockAkamaiClient.activate.resolves('');
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(502);
    });

    it('threads server-derived notifyEmails and forwards the EdgeGrid credentials to the client', async () => {
      await controller.activate(withData(propertyRef));
      expect(capturedClientConfig.notifyEmails).to.deep.equal([CALLER_EMAIL]);
      expect(capturedClientConfig.host).to.equal('akab-xxx.luna.akamaiapis.net');
      expect(capturedClientConfig.clientToken).to.equal('ctok');
      expect(capturedClientConfig.accessToken).to.equal('atok');
    });

    it('recovers to 200 when the POST errors (timeout/422) but Akamai queued the activation', async () => {
      mockAkamaiClient.activate.rejects(
        new Error('PAPI POST /papi/v1/properties/prp_1253269/activations request failed: '
          + 'Request timeout after 10000ms'),
      );
      mockAkamaiClient.latestActivation.resolves({
        activationId: 'atv_777', status: 'PENDING', propertyVersion: 7, submitDate: new Date().toISOString(),
      });
      const res = await controller.activate(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.activationId).to.equal('atv_777');
      expect(body.recovered).to.equal(true);
      expect(mockAkamaiClient.latestActivation)
        .to.have.been.calledWith(PROPERTY_ID, CONTRACT_ID, GROUP_ID, 'STAGING');
    });

    it('recovers an already-active version regardless of age (422 already-activated)', async () => {
      // Re-activating an already-ACTIVE version returns 422 already-activated; the version is live
      // on the network (the goal), so we report success even though it was submitted long ago.
      mockAkamaiClient.activate.rejects(
        new Error('PAPI POST /papi/v1/properties/prp_1253269/activations -> 422: already-activated'),
      );
      mockAkamaiClient.latestActivation.resolves({
        activationId: 'atv_20135944',
        status: 'ACTIVE',
        propertyVersion: 7,
        submitDate: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });
      const res = await controller.activate(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.recovered).to.equal(true);
      expect(body.activationId).to.equal('atv_20135944');
    });

    it('recovers with a null activationId when Akamai has not yet assigned one (placeholder)', async () => {
      mockAkamaiClient.activate.rejects(
        new Error('PAPI POST /papi/v1/properties/prp_1253269/activations request failed: '
          + 'Request timeout after 10000ms'),
      );
      // A just-queued activation appears in the list as "atv_null" before the id is assigned.
      mockAkamaiClient.latestActivation.resolves({
        activationId: 'atv_null', status: 'PENDING', propertyVersion: 7, submitDate: new Date().toISOString(),
      });
      const res = await controller.activate(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.recovered).to.equal(true);
      // Placeholder id is not pollable — return null so the UI polls by network instead.
      expect(body.activationId).to.equal(null);
    });

    it('surfaces the error when the POST fails and no matching activation is in flight', async () => {
      mockAkamaiClient.activate.rejects(
        new Error('PAPI POST /papi/v1/properties/prp_1253269/activations -> 500: boom'),
      );
      mockAkamaiClient.latestActivation.resolves(undefined);
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(502);
    });

    it('blocks activation with a specific 422 when the version has validation errors (Akamai 400)', async () => {
      // Akamai refuses to activate a version with blocking errors: 400 on the activations endpoint.
      mockAkamaiClient.activate.rejects(
        new Error('PAPI POST /papi/v1/properties/prp_1253269/activations -> 400: '
          + '{"errors":[{"detail":"rule X is invalid"}]}'),
      );
      // No activation was created, so the recovery probe finds nothing for this version.
      mockAkamaiClient.latestActivation.resolves(undefined);
      const res = await controller.activate(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(422);
      expect(body.code).to.equal('version_has_validation_errors');
      expect(body.message).to.contain('validation errors');
    });

    it('does not recover when the in-flight activation is for a different version', async () => {
      mockAkamaiClient.activate.rejects(
        new Error('PAPI POST /papi/v1/properties/prp_1253269/activations -> 422: already-activated'),
      );
      mockAkamaiClient.latestActivation.resolves({
        activationId: 'atv_x', status: 'PENDING', propertyVersion: 999,
      });
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(502);
    });

    it('surfaces the original error when the recovery lookup itself fails', async () => {
      mockAkamaiClient.activate.rejects(
        new Error('PAPI POST /papi/v1/properties/prp_1253269/activations request failed: '
          + 'Request timeout after 10000ms'),
      );
      mockAkamaiClient.latestActivation.rejects(new Error('listActivations failed'));
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(502);
    });
  });

  describe('activationStatus', () => {
    it('checks a specific activation when activationId is supplied', async () => {
      const res = await controller.activationStatus(withData({ ...propertyRef, activationId: 'atv_123' }));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.activation.status).to.equal('ACTIVE');
      expect(mockAkamaiClient.getActivation).to.have.been.calledOnce;
    });

    it('returns the latest activation for a network when no id is supplied', async () => {
      const res = await controller.activationStatus(withData({ ...propertyRef, network: 'STAGING' }));
      const body = await res.json();
      expect(body.activation.status).to.equal('PENDING');
      expect(mockAkamaiClient.latestActivation)
        .to.have.been.calledWith(PROPERTY_ID, CONTRACT_ID, GROUP_ID, 'STAGING');
    });

    it('returns 404 when no activation is found', async () => {
      mockAkamaiClient.latestActivation.resolves(undefined);
      const res = await controller.activationStatus(withData(propertyRef));
      expect(res.status).to.equal(404);
    });

    it('rejects an unknown network when no activationId is supplied', async () => {
      const res = await controller.activationStatus(withData({ ...propertyRef, network: 'DEV' }));
      expect(res.status).to.equal(400);
    });
  });

  describe('guard paths across endpoints', () => {
    const endpoints = ['listProperties', 'plan', 'deploy', 'activate', 'activationStatus'];

    it('every endpoint returns 404 when the site is missing', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      for (const name of endpoints) {
        // eslint-disable-next-line no-await-in-loop
        const res = await controller[name](withData(propertyRef));
        expect(res.status, name).to.equal(404);
      }
    });

    it('every credentialed endpoint returns 400 when a credential header is missing', async () => {
      delete mockContext.pathInfo.headers['x-akamai-access-token'];
      for (const name of endpoints) {
        // eslint-disable-next-line no-await-in-loop
        const res = await controller[name](withData(propertyRef));
        expect(res.status, name).to.equal(400);
      }
    });

    it('property endpoints reject a malformed contractId or groupId', async () => {
      for (const name of ['plan', 'deploy', 'activate', 'activationStatus']) {
        // eslint-disable-next-line no-await-in-loop
        const rc = await controller[name](withData({ ...propertyRef, contractId: 'bad' }));
        expect(rc.status, `${name} contractId`).to.equal(400);
        // eslint-disable-next-line no-await-in-loop
        const rg = await controller[name](withData({ ...propertyRef, groupId: 'bad' }));
        expect(rg.status, `${name} groupId`).to.equal(400);
      }
    });
  });

  describe('error mapping', () => {
    it('maps a PAPI 429 to 429 and a generic error to 502', async () => {
      mockAkamaiClient.findPropertiesByDomain.rejects(new Error('PAPI POST /s -> 429: slow down'));
      expect((await controller.listProperties(mockContext)).status).to.equal(429);
      mockAkamaiClient.findPropertiesByDomain.rejects(new Error('socket hang up'));
      expect((await controller.listProperties(mockContext)).status).to.equal(502);
    });

    it('plan maps a PAPI failure to 502', async () => {
      mockAkamaiClient.getLatestVersion.rejects(new Error('PAPI GET /x -> 500: oops'));
      const res = await controller.plan(withData(propertyRef));
      expect(res.status).to.equal(502);
    });

    it('deploy returns 502 when the property-serves-site lookup fails', async () => {
      mockAkamaiClient.findPropertiesByDomain.rejects(new Error('lookup boom'));
      const res = await controller.deploy(withData(propertyRef));
      expect(res.status).to.equal(502);
    });

    it('deploy surfaces a real 401 (not a misleading 403) when the guard probe fails on bad creds', async () => {
      // findPropertiesByDomain swallows the auth error and returns []; the guard then probes with
      // getLatestVersion, which surfaces the real 401.
      mockAkamaiClient.findPropertiesByDomain.resolves([]);
      mockAkamaiClient.getLatestVersion.rejects(new Error('PAPI GET /x -> 401: The signature does not match'));
      const res = await controller.deploy(withData(propertyRef));
      expect(res.status).to.equal(401);
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
    });

    it('anchors status detection to the "-> NNN:" token, not the response body', async () => {
      // A genuine 500 whose body text mentions "-> 404" must still map to 502, not 404.
      mockAkamaiClient.getLatestVersion.rejects(
        new Error('PAPI GET /x -> 500: upstream said "route -> 404 not configured"'),
      );
      const res = await controller.plan(withData(propertyRef));
      expect(res.status).to.equal(502);
    });

    it('activate maps a generic activation failure to 502', async () => {
      mockAkamaiClient.activate.rejects(new Error('PAPI POST /activations -> 500: nope'));
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(502);
    });

    it('activate surfaces a notifyEmails client error as 400', async () => {
      mockAkamaiClient.activate.rejects(new Error('client requires a non-empty notifyEmails array'));
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(400);
    });

    it('activationStatus maps a PAPI failure to 502', async () => {
      mockAkamaiClient.latestActivation.rejects(new Error('PAPI GET /activations -> 500'));
      const res = await controller.activationStatus(withData({ ...propertyRef, network: 'STAGING' }));
      expect(res.status).to.equal(502);
    });
  });

  describe('undeliverable site base URL', () => {
    beforeEach(() => {
      mockContext.dataAccess.Site.findById.resolves({
        getId: () => SITE_ID,
        getBaseURL: () => 'not a url',
      });
    });

    it('listProperties returns 400 when the hostname cannot be derived', async () => {
      const res = await controller.listProperties(mockContext);
      expect(res.status).to.equal(400);
    });

    it('plan returns 400 when the hostname cannot be derived (via resolveRuleConfig)', async () => {
      const res = await controller.plan(withData(propertyRef));
      expect(res.status).to.equal(400);
    });

    it('activate returns 400 when the hostname cannot be derived (guard)', async () => {
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(400);
    });
  });

  describe('remaining branches', () => {
    it('returns a generic 400 (no leaked detail) when the AkamaiClient constructor rejects', async () => {
      mockContext.pathInfo.headers['x-akamai-client-token'] = '__throw__';
      const res = await controller.listProperties(mockContext);
      const body = await res.json();
      expect(res.status).to.equal(400);
      expect(body.message).to.equal('Invalid Akamai credentials');
    });

    it('deploy returns 500 when the site has no LLMO API key (cfg error)', async () => {
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: [] });
      const res = await controller.deploy(withData(propertyRef));
      expect(res.status).to.equal(500);
    });

    it('activate is blocked when the property does not serve the site domain', async () => {
      mockAkamaiClient.findPropertiesByDomain.resolves([
        { propertyId: 'prp_other', matchedOn: ['hostname'] },
      ]);
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(403);
      expect(mockAkamaiClient.activate).to.not.have.been.called;
    });

    it('logs "unknown" caller/requestId when auth profile and invocation are absent', async () => {
      delete mockContext.attributes.authInfo;
      delete mockContext.invocation;
      // plan logs an audit line on success, exercising the getCallerId/requestId fallbacks.
      const res = await controller.plan(withData(propertyRef));
      expect(res.status).to.equal(200);
    });

    it('returns 400 when the request has no headers at all (getCredentials fallback)', async () => {
      delete mockContext.pathInfo;
      const res = await controller.listProperties(mockContext);
      expect(res.status).to.equal(400);
    });

    it('maps a thrown non-Error (no .message) to 502 (String(error) fallback)', async () => {
      mockAkamaiClient.findPropertiesByDomain.rejects({ code: 'WAT' });
      const res = await controller.listProperties(mockContext);
      expect(res.status).to.equal(502);
    });

    it('rejects a request with no body/query at all (requirePropertyRef fallback)', async () => {
      const res = await controller.activationStatus({ ...mockContext, data: undefined });
      expect(res.status).to.equal(400);
    });

    it('guard reports "none" when the domain lookup returns no properties', async () => {
      mockAkamaiClient.findPropertiesByDomain.resolves(undefined);
      const res = await controller.deploy(withData(propertyRef));
      expect(res.status).to.equal(403);
    });

    it('guard handles a candidate property with no matchedOn field', async () => {
      mockAkamaiClient.findPropertiesByDomain.resolves([{ propertyId: PROPERTY_ID }]);
      const res = await controller.deploy(withData(propertyRef));
      expect(res.status).to.equal(403);
    });

    it('plan tolerates a rule tree whose root has no children', async () => {
      const bareTree = {
        rules: {
          name: 'default',
          behaviors: [{ name: 'origin', options: { verificationMode: 'CUSTOM' } }],
        },
      };
      mockAkamaiClient.getRuleTree.resolves({ ruleTree: bareTree, ruleFormat: 'latest' });
      const res = await controller.plan(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.currentChildRules).to.deep.equal([]);
    });

    it('deploy treats an empty updateRuleTree response as success', async () => {
      mockAkamaiClient.updateRuleTree.resolves(undefined);
      const res = await controller.deploy(withData(propertyRef));
      expect(res.status).to.equal(200);
    });

    it('activate maps a thrown non-Error activation failure to 502', async () => {
      mockAkamaiClient.activate.rejects({ code: 'BOOM' });
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(502);
    });
  });

  describe('review follow-ups', () => {
    it('rejects a malformed activationId', async () => {
      const res = await controller.activationStatus(withData({ ...propertyRef, activationId: 'nope' }));
      expect(res.status).to.equal(400);
      expect(mockAkamaiClient.getActivation).to.not.have.been.called;
    });

    it('deploy is blocked when the matching property is not matched on hostname (e.g. cname only)', async () => {
      mockAkamaiClient.findPropertiesByDomain.resolves([
        { propertyId: PROPERTY_ID, matchedOn: ['cname'] },
      ]);
      const res = await controller.deploy(withData(propertyRef));
      expect(res.status).to.equal(403);
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
    });

    it('plan is read-only and does not invoke the domain-serves-site guard', async () => {
      await controller.plan(withData(propertyRef));
      expect(mockAkamaiClient.findPropertiesByDomain).to.not.have.been.called;
    });

    it('rejects a malformed insertIndex on plan', async () => {
      const res = await controller.plan(withData({ ...propertyRef, insertIndex: -1 }));
      expect(res.status).to.equal(400);
      expect(mockAkamaiClient.getLatestVersion).to.not.have.been.called;
    });

    it('accepts a valid insertIndex on deploy', async () => {
      const res = await controller.deploy(withData({ ...propertyRef, insertIndex: 1 }));
      expect(res.status).to.equal(200);
    });

    it('rejects a malformed insertIndex on deploy', async () => {
      const res = await controller.deploy(withData({ ...propertyRef, insertIndex: 'x' }));
      expect(res.status).to.equal(400);
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
    });

    it('maps a PAPI 404 (target not found) to 404', async () => {
      mockAkamaiClient.getLatestVersion.rejects(new Error('PAPI GET /x -> 404: not found'));
      const res = await controller.plan(withData(propertyRef));
      expect(res.status).to.equal(404);
    });
  });
});
