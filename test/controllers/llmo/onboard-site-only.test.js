/*
 * Copyright 2025 Adobe. All rights reserved.
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

/**
 * Unit tests for the paid-gated, site-only self-serve onboarding handler
 * (POST /v2/orgs/:spaceCatId/llmo/onboard-site — LLMO-5606, Piece 1).
 *
 * The orchestration (`performLlmoOnboarding`) is stubbed here — these tests
 * exercise the controller's HTTP concerns: auth gate (membership → PAID → admin),
 * org lookup, validation, generic error responses, ops alerts, and that the
 * handler threads `siteOnly: true` and never triggers the brand-profile agent.
 * The "nothing DRS / nothing brand" side-effect guarantees are covered by the
 * orchestration tests in llmo-onboarding.test.js.
 */
describe('LlmoController — onboardSiteOnly (LLMO-5606)', () => {
  const GENERIC_ERROR = "We couldn't onboard this domain right now. Please use our "
    + 'domain onboarding guide instead: https://experienceleague.adobe.com/en/docs/'
    + 'llm-optimizer/using/essentials/quick-start#step-1-onboard-your-domain';
  // Header-safe range enforced by cleanupHeaderValue() / Node's http header validation
  // (this is the exact class of char — em dash, curly quotes — that previously crashed
  // the response with a 500 "Invalid character in header content [\"x-error\"]").
  const HEADER_SAFE = /^[\t\x20-\x7E\x80-\xFF]*$/;

  let LlmoController;
  let controller;

  let findByIdStub;
  let hasAccessStub;
  let hasAdminAccessStub;
  let isLLMOAdministratorStub;
  let createForOrgStub;
  let checkValidEntitlementStub;
  let performLlmoOnboardingStub;
  let validateSiteNotOnboardedStub;
  let generateDataFolderStub;
  let postLlmoAlertStub;
  let triggerBrandProfileAgentStub;
  let organization;

  const mockHttpUtils = {
    ok: (data) => ({ status: 200, json: async () => data }),
    created: (data) => ({ status: 201, json: async () => data }),
    badRequest: (message) => ({ status: 400, json: async () => ({ message }) }),
    forbidden: (message) => ({ status: 403, json: async () => ({ message }) }),
    notFound: (message) => ({ status: 404, json: async () => ({ message }) }),
    internalServerError: (message) => ({ status: 500, json: async () => ({ message }) }),
    createResponse: (data, status) => ({ status, json: async () => data }),
    unauthorized: (message) => ({ status: 401, json: async () => ({ message }) }),
  };

  const buildContext = (overrides = {}) => ({
    log: {
      info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
    },
    env: { ENV: 'dev' },
    dataAccess: { Organization: { findById: findByIdStub } },
    params: { spaceCatId: 'org123' },
    data: { domain: 'example.com', brandName: 'Test Brand' },
    ...overrides,
  });

  const invoke = async (overrides = {}) => {
    const context = buildContext(overrides);
    controller = LlmoController(context);
    return controller.onboardSiteOnly(context);
  };

  before(async () => {
    findByIdStub = sinon.stub();
    hasAccessStub = sinon.stub();
    hasAdminAccessStub = sinon.stub();
    isLLMOAdministratorStub = sinon.stub();
    checkValidEntitlementStub = sinon.stub();
    createForOrgStub = sinon.stub();
    performLlmoOnboardingStub = sinon.stub();
    validateSiteNotOnboardedStub = sinon.stub();
    generateDataFolderStub = sinon.stub();
    postLlmoAlertStub = sinon.stub();
    triggerBrandProfileAgentStub = sinon.stub();

    LlmoController = await esmock('../../../src/controllers/llmo/llmo.js', {
      '@adobe/spacecat-shared-http-utils': mockHttpUtils,
      '@adobe/spacecat-shared-tier-client': {
        default: { createForOrg: (...a) => createForOrgStub(...a) },
      },
      '../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({
            hasAccess: (...a) => hasAccessStub(...a),
            hasAdminAccess: (...a) => hasAdminAccessStub(...a),
            isLLMOAdministrator: (...a) => isLLMOAdministratorStub(...a),
          }),
        },
      },
      '../../../src/controllers/llmo/llmo-onboarding.js': {
        validateSiteNotOnboarded: (...a) => validateSiteNotOnboardedStub(...a),
        generateDataFolder: (...a) => generateDataFolderStub(...a),
        performLlmoOnboarding: (...a) => performLlmoOnboardingStub(...a),
        performLlmoOffboarding: sinon.stub(),
        postLlmoAlert: (...a) => postLlmoAlertStub(...a),
        appendRowsToQueryIndex: sinon.stub(),
        previewAndPublishQueryIndex: sinon.stub(),
      },
      '../../../src/support/brand-profile-trigger.js': {
        triggerBrandProfileAgent: (...a) => triggerBrandProfileAgentStub(...a),
      },
      '../../../src/support/cached-response.js': {
        cachedOk: (data) => ({ status: 200, json: async () => data }),
      },
      '@adobe/spacecat-shared-tokowaka-client': {
        default: { createFrom: () => ({}) },
        calculateForwardedHost: () => 'www.example.com',
        getEffectiveBaseURL: (x) => (typeof x === 'string' ? x : x?.getBaseURL?.()),
      },
      '../../../src/utils/slack/base.js': { postSlackMessage: sinon.stub() },
    });
  });

  beforeEach(() => {
    [
      findByIdStub, hasAccessStub, hasAdminAccessStub, isLLMOAdministratorStub,
      checkValidEntitlementStub, createForOrgStub, performLlmoOnboardingStub,
      validateSiteNotOnboardedStub, generateDataFolderStub, postLlmoAlertStub,
      triggerBrandProfileAgentStub,
    ].forEach((s) => s.reset());

    organization = {
      getId: () => 'org123',
      getImsOrgId: () => 'ABC123@AdobeOrg',
    };

    findByIdStub.resolves(organization);
    hasAccessStub.resolves(true);
    hasAdminAccessStub.returns(true);
    isLLMOAdministratorStub.returns(true);
    createForOrgStub.returns({ checkValidEntitlement: checkValidEntitlementStub });
    checkValidEntitlementStub.resolves({ entitlement: { getTier: () => 'PAID' } });
    validateSiteNotOnboardedStub.resolves({ isValid: true });
    generateDataFolderStub.returns('dev/example-com');
    performLlmoOnboardingStub.resolves({
      siteId: 'site123',
      organizationId: 'org123',
      baseURL: 'https://example.com',
      dataFolder: 'dev/example-com',
      detectedCdn: null,
      message: 'LLMO onboarding completed successfully',
    });
    postLlmoAlertStub.resolves();
    triggerBrandProfileAgentStub.resolves('exec-1');
  });

  describe('happy path (PAID + admin + member)', () => {
    it('returns 201 with status: processing and the site details', async () => {
      const res = await invoke();

      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body).to.deep.equal({
        siteId: 'site123',
        organizationId: 'org123',
        baseURL: 'https://example.com',
        dataFolder: 'dev/example-com',
        status: 'processing',
      });
    });

    it('threads siteOnly: true into performLlmoOnboarding and passes no `say`', async () => {
      await invoke({ data: { domain: 'example.com', brandName: 'Test Brand', deliveryType: 'aem_edge' } });

      expect(performLlmoOnboardingStub).to.have.been.calledOnce;
      const [params, ctx] = performLlmoOnboardingStub.firstCall.args;
      // only (params, context) — no `say` callback → zero customer Slack
      expect(performLlmoOnboardingStub.firstCall.args).to.have.lengthOf(2);
      expect(ctx).to.exist;
      expect(params).to.deep.include({
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
        siteOnly: true,
      });
    });

    it('does NOT trigger the brand-profile agent', async () => {
      await invoke();
      expect(triggerBrandProfileAgentStub).to.not.have.been.called;
    });

    it('posts a success alert to ops (postLlmoAlert)', async () => {
      await invoke();
      expect(postLlmoAlertStub).to.have.been.calledOnce;
      const [message] = postLlmoAlertStub.firstCall.args;
      expect(message).to.contain('site123');
      expect(message).to.contain('https://example.com');
    });

    it('onboards a non-admin org member — no admin/LLMO-admin claim required', async () => {
      // Real customer IMS tokens carry neither is_admin nor is_llmo_administrator;
      // the gate is membership + PAID only, so this must pass (not 403).
      hasAdminAccessStub.returns(false);
      isLLMOAdministratorStub.returns(false);

      const res = await invoke();

      expect(res.status).to.equal(201);
      expect(performLlmoOnboardingStub).to.have.been.calledOnce;
    });
  });

  describe('auth gate', () => {
    it('returns 404 when the organization does not exist', async () => {
      findByIdStub.resolves(null);

      const res = await invoke();

      expect(res.status).to.equal(404);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });

    it('returns 403 when the caller is not a member of the org', async () => {
      hasAccessStub.resolves(false);

      const res = await invoke();

      expect(res.status).to.equal(403);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });

    it('returns 403 when the org has no LLMO entitlement', async () => {
      checkValidEntitlementStub.resolves({});

      const res = await invoke();

      expect(res.status).to.equal(403);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });

    it('returns 403 when the org entitlement is FREE_TRIAL (not PAID)', async () => {
      checkValidEntitlementStub.resolves({ entitlement: { getTier: () => 'FREE_TRIAL' } });

      const res = await invoke();

      expect(res.status).to.equal(403);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });
  });

  describe('request validation', () => {
    it('returns 400 when the body is missing', async () => {
      const res = await invoke({ data: null });
      expect(res.status).to.equal(400);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });

    it('returns 400 when domain or brandName is missing', async () => {
      const res = await invoke({ data: { domain: 'example.com' } });
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.contain('domain and brandName are required');
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });

    it('returns 400 when domain/brandName are not strings', async () => {
      const res = await invoke({ data: { domain: ['example.com'], brandName: { x: 1 } } });
      expect(res.status).to.equal(400);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });

    it('returns 400 when domain/brandName are whitespace-only', async () => {
      const res = await invoke({ data: { domain: '   ', brandName: '  ' } });
      expect(res.status).to.equal(400);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });

    it('returns 400 when domain exceeds the length cap', async () => {
      const res = await invoke({ data: { domain: `${'a'.repeat(254)}.com`, brandName: 'Test Brand' } });
      expect(res.status).to.equal(400);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });

    it('returns 400 when brandName exceeds the length cap', async () => {
      const res = await invoke({ data: { domain: 'example.com', brandName: 'b'.repeat(257) } });
      expect(res.status).to.equal(400);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });

    it('returns 400 when the domain is not a valid hostname', async () => {
      const res = await invoke({ data: { domain: 'not a domain!!', brandName: 'Test Brand' } });
      expect(res.status).to.equal(400);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });
  });

  describe('SSRF guard', () => {
    it('returns 400 for an IP-literal host (incl. the metadata address)', async () => {
      const res = await invoke({ data: { domain: '169.254.169.254', brandName: 'Test Brand' } });
      expect(res.status).to.equal(400);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });

    it('returns 400 for localhost / non-public single-label hosts', async () => {
      const res = await invoke({ data: { domain: 'localhost', brandName: 'Test Brand' } });
      expect(res.status).to.equal(400);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });
  });

  describe('validateSiteNotOnboarded rejection', () => {
    it('returns a generic 400 and never leaks the internal reason', async () => {
      validateSiteNotOnboardedStub.resolves({
        isValid: false,
        error: 'Data folder for site https://example.com already exists. The site is already onboarded.',
      });

      const res = await invoke();

      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal(GENERIC_ERROR);
      expect(body.message).to.not.contain('already onboarded');
      // Regression guard (LLMO-6147): a message with a char outside this range
      // crashes the real x-error header with a 500 at the HTTP layer — a failure
      // this mocked http-utils test can't otherwise catch.
      expect(HEADER_SAFE.test(body.message)).to.be.true;
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });
  });

  describe('orchestration failure', () => {
    it('returns a generic 500 and posts the real reason to ops', async () => {
      performLlmoOnboardingStub.rejects(new Error('SharePoint folder creation exploded'));

      const res = await invoke();

      expect(res.status).to.equal(500);
      const body = await res.json();
      expect(body.message).to.equal(GENERIC_ERROR);
      expect(body.message).to.not.contain('SharePoint');
      expect(HEADER_SAFE.test(body.message)).to.be.true;

      // Ops gets the internal reason; the customer does not.
      expect(postLlmoAlertStub).to.have.been.calledOnce;
      const [message] = postLlmoAlertStub.firstCall.args;
      expect(message).to.contain('SharePoint folder creation exploded');
    });
  });
});
