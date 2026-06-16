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
import {
  PLG_MODEL_DOMAIN_HELPERS,
  TEST_DOMAIN,
  TEST_IMS_ORG_ID,
  TEST_SITE_ID,
  DEFAULT_ORG_ID,
  ASO_PRODUCT_CODE,
  createSharedMocks,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  buildContext as buildContextShared,
} from './shared-fixtures.js';

use(sinonChai);

describe('PlgOnboardingController', function describePlgOnboarding() {
  // esmock + extensive sinon stubs make individual tests slower than the 2000ms default.
  this.timeout(10000);

  let sandbox;
  let PlgOnboardingController;

  // Stubs for external dependencies
  let rumRetrieveDomainkeyStub;
  let composeBaseURLStub;
  let detectBotBlockerStub;
  let detectLocaleStub;
  let resolveCanonicalUrlStub;
  let createOrFindOrganizationStub;
  let enableAuditsStub;
  let enableImportsStub;
  let triggerAuditsStub;
  let autoResolveAuthorUrlStub;
  let resolveWwwUrlStub;
  let updateCodeConfigStub;
  let findDeliveryTypeStub;
  let deriveProjectNameStub;
  let loadProfileConfigStub;
  let queueDeliveryConfigWriterStub;
  let triggerBrandProfileAgentStub;
  let tierClientCreateForSiteStub;
  let tierClientCreateForOrgStub;
  let ldGetFeatureFlagStub;
  let ldUpdateVariationValueStub;
  let ldCreateFromStub;
  let configToDynamoItemStub;
  let updateRumConfigStub;

  // Mock objects
  let mockLog;
  let mockEnv;
  let mockSiteConfig;
  let mockSite;
  let mockOrganization;
  let mockProject;
  let mockDataAccess;
  let mockOnboarding;

  function createMockSite(overrides = {}) {
    return createMockSiteShared(sandbox, overrides, mockSiteConfig);
  }

  function createMockOnboarding(overrides = {}) {
    return createMockOnboardingShared(sandbox, overrides);
  }

  function buildContext(data = {}, options = {}) {
    return buildContextShared(sandbox, mockDataAccess, mockLog, mockEnv, data, options);
  }

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    const shared = createSharedMocks(sandbox);
    ({
      rumRetrieveDomainkeyStub,
      updateRumConfigStub,
      composeBaseURLStub,
      detectBotBlockerStub,
      detectLocaleStub,
      resolveCanonicalUrlStub,
      createOrFindOrganizationStub,
      enableAuditsStub,
      enableImportsStub,
      triggerAuditsStub,
      autoResolveAuthorUrlStub,
      resolveWwwUrlStub,
      updateCodeConfigStub,
      findDeliveryTypeStub,
      deriveProjectNameStub,
      queueDeliveryConfigWriterStub,
      loadProfileConfigStub,
      triggerBrandProfileAgentStub,
      ldGetFeatureFlagStub,
      ldUpdateVariationValueStub,
      ldCreateFromStub,
      tierClientCreateForSiteStub,
      tierClientCreateForOrgStub,
      configToDynamoItemStub,
      mockLog,
      mockEnv,
      mockSiteConfig,
      mockOrganization,
      mockProject,
    } = shared);

    // Default mock site (for new site flow: findByBaseURL returns null)
    mockSite = createMockSite();

    // PlgOnboarding mock
    mockOnboarding = createMockOnboarding();

    // DataAccess
    mockDataAccess = createMockDataAccess(sandbox, {
      mockSite, mockOrganization, mockProject, mockOnboarding,
    });

    PlgOnboardingController = (await esmock(
      '../../../../src/controllers/plg/plg-onboarding.js',
      {
        '@adobe/spacecat-shared-utils': {
          composeBaseURL: composeBaseURLStub,
          detectBotBlocker: detectBotBlockerStub,
          detectLocale: detectLocaleStub,
          hasText: (val) => typeof val === 'string' && val.trim().length > 0,
          isValidIMSOrgId: (val) => typeof val === 'string' && val.endsWith('@AdobeOrg'),
          resolveCanonicalUrl: resolveCanonicalUrlStub,
        },
        '@adobe/spacecat-shared-http-utils': {
          badRequest: (msg) => ({ status: 400, value: msg }),
          createResponse: (body, status) => ({ status, value: body }),
          forbidden: (msg) => ({ status: 403, value: msg }),
          internalServerError: (msg) => ({ status: 500, value: msg }),
          notFound: (msg) => ({ status: 404, value: msg }),
          ok: (data) => ({ status: 200, value: data }),
        },
        '@adobe/spacecat-shared-launchdarkly-client': {
          default: ldCreateFromStub,
        },
        '@adobe/spacecat-shared-rum-api-client': {
          default: {
            createFrom: sandbox.stub().returns({
              retrieveDomainkey: rumRetrieveDomainkeyStub,
            }),
          },
        },
        '@adobe/spacecat-shared-tier-client': {
          default: {
            createForSite: tierClientCreateForSiteStub,
            createForOrg: tierClientCreateForOrgStub,
          },
        },
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: { toDynamoItem: configToDynamoItemStub },
        },
        '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
          Entitlement: {
            PRODUCT_CODES: { ASO: ASO_PRODUCT_CODE },
            TIERS: {
              FREE_TRIAL: 'FREE_TRIAL', PAID: 'PAID', PLG: 'PLG', PRE_ONBOARD: 'PRE_ONBOARD',
            },
          },
        },
        '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js': {
          default: {
            ...PLG_MODEL_DOMAIN_HELPERS,
            STATUSES: {
              IN_PROGRESS: 'IN_PROGRESS',
              ONBOARDED: 'ONBOARDED',
              PRE_ONBOARDING: 'PRE_ONBOARDING',
              ERROR: 'ERROR',
              WAITING_FOR_IP_ALLOWLISTING: 'WAITING_FOR_IP_ALLOWLISTING',
              WAITLISTED: 'WAITLISTED',
              INACTIVE: 'INACTIVE',
              REJECTED: 'REJECTED',
              OUTDATED: 'OUTDATED',
            },
            REVIEW_REASONS: {
              DOMAIN_ALREADY_ONBOARDED_IN_ORG: 'DOMAIN_ALREADY_ONBOARDED_IN_ORG',
              AEM_SITE_CHECK: 'AEM_SITE_CHECK',
              DOMAIN_ALREADY_ASSIGNED: 'DOMAIN_ALREADY_ASSIGNED',
              BOT_BLOCKER: 'BOT_BLOCKER',
            },
            REVIEW_DECISIONS: {
              BYPASSED: 'BYPASSED',
              UPHELD: 'UPHELD',
              CLOSED: 'CLOSED',
              REOPENED: 'REOPENED',
              OFFBOARDED: 'OFFBOARDED',
              PENDING: 'PENDING',
            },
          },
        },
        '../../../../src/controllers/llmo/llmo-onboarding.js': {
          createOrFindOrganization: createOrFindOrganizationStub,
          enableAudits: enableAuditsStub,
          enableImports: enableImportsStub,
          triggerAudits: triggerAuditsStub,
        },
        '../../../../src/support/utils.js': {
          autoResolveAuthorUrl: autoResolveAuthorUrlStub,
          resolveWwwUrl: resolveWwwUrlStub,
          updateCodeConfig: updateCodeConfigStub,
          findDeliveryType: findDeliveryTypeStub,
          deriveProjectName: deriveProjectNameStub,
          queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
        },
        '../../../../src/utils/slack/base.js': {
          loadProfileConfig: loadProfileConfigStub,
        },
        '../../../../src/support/brand-profile-trigger.js': {
          triggerBrandProfileAgent: triggerBrandProfileAgentStub,
        },
        '../../../../src/support/access-control-util.js': {
          default: {
            fromContext: () => ({ hasAdminAccess: () => false, hasAdminReadAccess: () => false }),
          },
        },
        '../../../../src/support/rum-config-service.js': {
          updateRumConfig: updateRumConfigStub,
        },
      },
    )).default;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('onboard - LaunchDarkly flag update', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('adds org and site to all 3 auto-fix flags in variation 0', async () => {
      ldGetFeatureFlagStub.resolves({ variations: [{ value: {} }] });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      const expectedFlags = ['FF_cwv-auto-fix', 'FF_alt-text-auto-fix', 'FF_broken-backlinks-auto-fix'];
      expectedFlags.forEach((flagKey) => {
        expect(ldGetFeatureFlagStub).to.have.been.calledWith('experience-success-studio', flagKey);
      });
      expect(ldUpdateVariationValueStub.callCount).to.equal(3);
      const cwvCall = ldUpdateVariationValueStub.getCalls().find((c) => c.args[1] === 'FF_cwv-auto-fix');
      expect(cwvCall).to.exist;
      expect(cwvCall.args[0]).to.equal('experience-success-studio');
      expect(cwvCall.args[2]).to.equal(0);
      expect(cwvCall.args[3]).to.deep.equal({ [TEST_IMS_ORG_ID]: [TEST_SITE_ID] });
    });

    it('skips duplicate site already present in variation 0', async () => {
      ldGetFeatureFlagStub.resolves({
        variations: [{ value: { [TEST_IMS_ORG_ID]: [TEST_SITE_ID] } }],
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(ldUpdateVariationValueStub).to.not.have.been.called;
    });

    it('continues onboarding when LD flag update fails', async () => {
      ldGetFeatureFlagStub.rejects(new Error('LD service unavailable'));

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('skips LD update when LD_EXPERIENCE_SUCCESS_API_TOKEN is not set', async () => {
      const context = {
        ...buildContext({ domain: TEST_DOMAIN }),
        env: { DEFAULT_ORGANIZATION_ID: DEFAULT_ORG_ID },
      };
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldGetFeatureFlagStub).to.not.have.been.called;
      expect(mockLog.warn).to.have.been.calledWithMatch(/LD_EXPERIENCE_SUCCESS_API_TOKEN/);
    });

    it('skips LD update when org has no IMS org ID', async () => {
      mockOrganization.getImsOrgId.returns(null);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldUpdateVariationValueStub).to.not.have.been.called;
    });

    it('skips LD update when flag has no variations', async () => {
      ldGetFeatureFlagStub.resolves({ variations: [] });

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldUpdateVariationValueStub).to.not.have.been.called;
    });

    it('handles string-wrapped variation 0 value', async () => {
      ldGetFeatureFlagStub.resolves({
        variations: [{ value: JSON.stringify({}) }],
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(ldUpdateVariationValueStub.callCount).to.equal(3);
      ldUpdateVariationValueStub.getCalls().forEach((call) => {
        const newValue = call.args[3];
        expect(typeof newValue).to.equal('string');
        expect(JSON.parse(newValue)).to.deep.equal({ [TEST_IMS_ORG_ID]: [TEST_SITE_ID] });
      });
    });

    it('skips flag and warns when variation 0 contains malformed JSON string', async () => {
      ldGetFeatureFlagStub.resolves({
        variations: [{ value: 'not-valid-json{{{' }],
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldUpdateVariationValueStub).to.not.have.been.called;
      expect(mockLog.warn).to.have.been.calledWithMatch(/malformed JSON/);
    });
  });
});
