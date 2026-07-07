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

// A minimal but valid PAPI rule tree the client returns from getRuleTree.
const RULE_TREE = { rules: { name: 'default', children: [{ name: 'Existing' }], variables: [] } };

describe('LlmoAkamaiController', () => {
  let sandbox;
  let LlmoAkamaiController;
  let controller;
  let mockContext;
  let mockSite;
  let mockAccessControlUtil;
  let mockAkamaiClient;
  let mockTokowakaClient;

  before(async () => {
    // esmock is expensive, so wire it once. The mock factories read the mutable outer references
    // (reassigned per-test in beforeEach) so each test gets fresh stubs without re-running esmock.
    // Simulates the real client's constructor validation: throws when a credential is the
    // sentinel below, so the controller's requireClient catch-branch can be exercised.
    function AkamaiClientMock(cfg) {
      if (cfg && cfg.clientToken === '__throw__') {
        throw new Error('AkamaiClient requires clientToken');
      }
      return mockAkamaiClient;
    }
    AkamaiClientMock.activationIdFromLink = (link) => (link || '').split('/').pop();

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

    mockAkamaiClient = {
      findPropertiesByDomain: sandbox.stub().resolves([
        { propertyId: PROPERTY_ID, propertyName: 'example', matchedOn: ['hostname'] },
      ]),
      getLatestVersion: sandbox.stub().resolves(7),
      getRuleTree: sandbox.stub().resolves({ ruleTree: RULE_TREE, ruleFormat: 'v2024-01-01' }),
      createVersion: sandbox.stub().resolves(8),
      updateRuleTree: sandbox.stub().resolves({ errors: [], warnings: [] }),
      activate: sandbox.stub().resolves('/papi/v1/properties/prp_1253269/activations/atv_123'),
      getActivation: sandbox.stub().resolves({ activationId: 'atv_123', status: 'ACTIVE' }),
      latestActivation: sandbox.stub().resolves({ activationId: 'atv_999', status: 'PENDING' }),
    };

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

    it('maps a PAPI 401 to a 401 response', async () => {
      mockAkamaiClient.findPropertiesByDomain.rejects(new Error('PAPI POST /papi/v1/search -> 401: nope'));
      const res = await controller.listProperties(mockContext);
      expect(res.status).to.equal(401);
    });
  });

  describe('plan', () => {
    it('returns the before/after child rules and merged tree', async () => {
      const res = await controller.plan(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.latestVersion).to.equal(7);
      expect(body.currentChildRules).to.deep.equal(['Existing']);
      expect(body.mergedChildRules[0]).to.equal('Optimize at Edge');
      expect(mockAkamaiClient.createVersion).to.not.have.been.called;
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
    it('creates a new version, applies the rules, and returns it', async () => {
      const res = await controller.deploy(withData(propertyRef));
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.baseVersion).to.equal(7);
      expect(body.newVersion).to.equal(8);
      expect(mockAkamaiClient.updateRuleTree).to.have.been.calledOnce;
      // updateRuleTree receives the merged tree with the managed wrapper first.
      const mergedArg = mockAkamaiClient.updateRuleTree.firstCall.args[4];
      expect(mergedArg.rules.children[0].name).to.equal('Optimize at Edge');
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

    it('returns 403 when no notify email can be derived from the caller', async () => {
      mockContext.attributes.authInfo.getProfile = () => ({ email: 'guid@org.e' });
      const res = await controller.activate(withData(propertyRef));
      expect(res.status).to.equal(403);
      expect(mockAkamaiClient.activate).to.not.have.been.called;
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
      mockAkamaiClient.getRuleTree.resolves({ ruleTree: { rules: { name: 'default' } }, ruleFormat: 'latest' });
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
