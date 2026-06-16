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
  TEST_ORG_ID,
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

  describe('onboard - early-return guards', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('returns 400 when imsOrgId is an internal org', async () => {
      const context = buildContext({ domain: TEST_DOMAIN });
      context.env = { ...context.env, ASO_PLG_EXCLUDED_ORGS: TEST_ORG_ID };
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.include('internal organizations');
    });

    it('returns 400 for frescopa domain', async () => {
      const context = buildContext({ domain: 'frescopa.com' });
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.include('not available for frescopa domains');
    });

    it('returns 400 for frescopa subdomain', async () => {
      const context = buildContext({ domain: 'shop.frescopa.com' });
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.include('not available for frescopa domains');
    });

    it('returns 400 when org already has a non-PLG ASO entitlement (paid customer)', async () => {
      const paidEntitlement = {
        getProductCode: sandbox.stub().returns(ASO_PRODUCT_CODE),
        getTier: sandbox.stub().returns('PAID'),
      };
      mockDataAccess.Entitlement.allByOrganizationId.resolves([paidEntitlement]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.include('paid customers');
    });

    it('proceeds when org has a PLG-tier ASO entitlement', async () => {
      const plgEntitlement = {
        getProductCode: sandbox.stub().returns(ASO_PRODUCT_CODE),
        getTier: sandbox.stub().returns('PLG'),
      };
      mockDataAccess.Entitlement.allByOrganizationId.resolves([plgEntitlement]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
    });

    it('proceeds when org has a FREE_TRIAL ASO entitlement (not treated as paid)', async () => {
      const trialEntitlement = {
        getProductCode: sandbox.stub().returns(ASO_PRODUCT_CODE),
        getTier: sandbox.stub().returns('FREE_TRIAL'),
      };
      mockDataAccess.Entitlement.allByOrganizationId.resolves([trialEntitlement]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
    });

    it('proceeds when org has a PRE_ONBOARD ASO entitlement (not treated as paid)', async () => {
      const preOnboardEntitlement = {
        getProductCode: sandbox.stub().returns(ASO_PRODUCT_CODE),
        getTier: sandbox.stub().returns('PRE_ONBOARD'),
      };
      mockDataAccess.Entitlement.allByOrganizationId.resolves([preOnboardEntitlement]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
    });

    it('proceeds when org has no entitlements', async () => {
      mockDataAccess.Entitlement.allByOrganizationId.resolves([]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
    });

    it('proceeds when org does not exist yet (new customer)', async () => {
      mockDataAccess.Organization.findByImsOrgId.resolves(null);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
      expect(mockDataAccess.Entitlement.allByOrganizationId).not.to.have.been.called;
    });

    it('posts Slack notification when internal org is rejected', async () => {
      const postSlackMessageStub = sandbox.stub().resolves();
      const NotifController = (await esmock(
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
            created: (data) => ({ status: 201, value: data }),
            forbidden: (msg) => ({ status: 403, value: msg }),
            internalServerError: (msg) => ({ status: 500, value: msg }),
            notFound: (msg) => ({ status: 404, value: msg }),
            noContent: () => ({ status: 204 }),
            ok: (data) => ({ status: 200, value: data }),
          },
          '@adobe/spacecat-shared-launchdarkly-client': { default: ldCreateFromStub },
          '@adobe/spacecat-shared-rum-api-client': {
            default: {
              createFrom: sandbox.stub().returns({ retrieveDomainkey: rumRetrieveDomainkeyStub }),
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
              },
              REVIEW_DECISIONS: { BYPASSED: 'BYPASSED', UPHELD: 'UPHELD' },
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
            updateCodeConfig: updateCodeConfigStub,
            findDeliveryType: findDeliveryTypeStub,
            deriveProjectName: deriveProjectNameStub,
            queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
          },
          '../../../../src/utils/slack/base.js': {
            loadProfileConfig: loadProfileConfigStub,
            postSlackMessage: postSlackMessageStub,
          },
          '../../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: triggerBrandProfileAgentStub },
          '../../../../src/support/access-control-util.js': {
            default: { fromContext: () => ({ hasAdminAccess: () => false }) },
          },
          '../../../../src/support/rum-config-service.js': {
            updateRumConfig: updateRumConfigStub,
          },
        },
      )).default;

      const notifController = NotifController({ log: mockLog });
      const context = buildContext({ domain: TEST_DOMAIN });
      context.env = {
        ...context.env,
        ASO_PLG_EXCLUDED_ORGS: TEST_ORG_ID,
        SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123',
        SLACK_BOT_TOKEN: 'xoxb-test',
      };

      const res = await notifController.onboard(context);
      expect(res.status).to.equal(400);
      expect(postSlackMessageStub).to.have.been.calledOnce;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Internal Org');
      expect(message).to.include(TEST_DOMAIN);
      expect(message).to.include('Onboarding requested on IMS Org');
      expect(message).to.include(TEST_IMS_ORG_ID);
      expect(message).to.include('IMS Org Name');
      expect(message).to.include('Test Org');
    });

    it('posts Slack notification when paid customer is rejected', async () => {
      const postSlackMessageStub = sandbox.stub().resolves();
      const NotifController = (await esmock(
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
            created: (data) => ({ status: 201, value: data }),
            forbidden: (msg) => ({ status: 403, value: msg }),
            internalServerError: (msg) => ({ status: 500, value: msg }),
            notFound: (msg) => ({ status: 404, value: msg }),
            noContent: () => ({ status: 204 }),
            ok: (data) => ({ status: 200, value: data }),
          },
          '@adobe/spacecat-shared-launchdarkly-client': { default: ldCreateFromStub },
          '@adobe/spacecat-shared-rum-api-client': {
            default: {
              createFrom: sandbox.stub().returns({ retrieveDomainkey: rumRetrieveDomainkeyStub }),
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
              },
              REVIEW_DECISIONS: { BYPASSED: 'BYPASSED', UPHELD: 'UPHELD' },
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
            updateCodeConfig: updateCodeConfigStub,
            findDeliveryType: findDeliveryTypeStub,
            deriveProjectName: deriveProjectNameStub,
            queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
          },
          '../../../../src/utils/slack/base.js': {
            loadProfileConfig: loadProfileConfigStub,
            postSlackMessage: postSlackMessageStub,
          },
          '../../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: triggerBrandProfileAgentStub },
          '../../../../src/support/access-control-util.js': {
            default: { fromContext: () => ({ hasAdminAccess: () => false }) },
          },
          '../../../../src/support/rum-config-service.js': {
            updateRumConfig: updateRumConfigStub,
          },
        },
      )).default;

      const notifController = NotifController({ log: mockLog });
      mockDataAccess.Entitlement.allByOrganizationId.resolves([{
        getProductCode: sandbox.stub().returns(ASO_PRODUCT_CODE),
        getTier: sandbox.stub().returns('PAID'),
      }]);

      const context = buildContext({ domain: TEST_DOMAIN });
      context.env = {
        ...context.env,
        SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123',
        SLACK_BOT_TOKEN: 'xoxb-test',
      };

      const res = await notifController.onboard(context);
      expect(res.status).to.equal(400);
      expect(postSlackMessageStub).to.have.been.calledOnce;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Paid Customer');
      expect(message).to.include(TEST_DOMAIN);
      expect(message).to.include('Onboarding requested on IMS Org');
      expect(message).to.include(TEST_IMS_ORG_ID);
      expect(message).to.include('IMS Org Name');
      expect(message).to.include('Test Org');
    });

    it('logs error and still returns 400 when rejection Slack notification fails', async () => {
      const postSlackMessageStub = sandbox.stub().rejects(new Error('Slack API down'));
      const NotifController = (await esmock(
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
            created: (data) => ({ status: 201, value: data }),
            forbidden: (msg) => ({ status: 403, value: msg }),
            internalServerError: (msg) => ({ status: 500, value: msg }),
            notFound: (msg) => ({ status: 404, value: msg }),
            noContent: () => ({ status: 204 }),
            ok: (data) => ({ status: 200, value: data }),
          },
          '@adobe/spacecat-shared-launchdarkly-client': { default: ldCreateFromStub },
          '@adobe/spacecat-shared-rum-api-client': {
            default: {
              createFrom: sandbox.stub().returns({ retrieveDomainkey: rumRetrieveDomainkeyStub }),
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
              },
              REVIEW_DECISIONS: { BYPASSED: 'BYPASSED', UPHELD: 'UPHELD' },
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
            updateCodeConfig: updateCodeConfigStub,
            findDeliveryType: findDeliveryTypeStub,
            deriveProjectName: deriveProjectNameStub,
            queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
          },
          '../../../../src/utils/slack/base.js': {
            loadProfileConfig: loadProfileConfigStub,
            postSlackMessage: postSlackMessageStub,
          },
          '../../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: triggerBrandProfileAgentStub },
          '../../../../src/support/access-control-util.js': {
            default: { fromContext: () => ({ hasAdminAccess: () => false }) },
          },
          '../../../../src/support/rum-config-service.js': {
            updateRumConfig: updateRumConfigStub,
          },
        },
      )).default;

      const notifController = NotifController({ log: mockLog });
      const context = buildContext({ domain: TEST_DOMAIN });
      context.env = {
        ...context.env,
        ASO_PLG_EXCLUDED_ORGS: TEST_ORG_ID,
        SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123',
        SLACK_BOT_TOKEN: 'xoxb-test',
      };

      const res = await notifController.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.include('internal organizations');
      expect(mockLog.error).to.have.been.calledWith(sinon.match('Failed to post PLG rejection notification'));
    });
  });
});
