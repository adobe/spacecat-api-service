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
import {
  TEST_DOMAIN,
  TEST_IMS_ORG_ID,
  TEST_ORG_ID,
  ASO_PRODUCT_CODE,
  createSharedMocks,
  resetStubDefaults,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  buildContext as buildContextShared,
} from './shared-fixtures.js';
import { createPlgEsmock } from './plg-esmock-factory.js';

use(sinonChai);

describe('PlgOnboardingController', function describePlgOnboarding() {
  // esmock + extensive sinon stubs make individual tests slower than the 2000ms default.
  this.timeout(10000);

  let sandbox;
  let stubs;
  let PlgOnboardingControllerFactory;

  // Mock objects
  let mockLog;
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
    return buildContextShared(sandbox, mockDataAccess, mockLog, stubs.mockEnv, data, options);
  }

  before(async () => {
    sandbox = sinon.createSandbox();
    stubs = createSharedMocks(sandbox);
    ({
      mockSiteConfig, mockOrganization, mockProject, mockLog,
    } = stubs);
    PlgOnboardingControllerFactory = await createPlgEsmock(stubs, {
      hasAdminAccess: false,
      hasAdminReadAccess: false,
    });
  });

  after(() => sandbox.restore());

  beforeEach(() => {
    sandbox.reset();
    resetStubDefaults(stubs);
    ({
      mockLog,
      mockSiteConfig,
      mockOrganization,
      mockProject,
    } = stubs);

    mockSite = createMockSite();
    mockOnboarding = createMockOnboarding();
    mockDataAccess = createMockDataAccess(sandbox, {
      mockSite, mockOrganization, mockProject, mockOnboarding,
    });
  });

  describe('onboard - early-return guards', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
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

    describe('rejection Slack notifications', () => {
      let postSlackMessageStub;
      let NotifControllerFactory;

      before(async () => {
        postSlackMessageStub = sandbox.stub().resolves();
        NotifControllerFactory = await createPlgEsmock(stubs, {
          hasAdminAccess: false,
          postSlackMessageStub,
        });
      });

      beforeEach(() => {
        postSlackMessageStub.reset();
      });

      it('posts Slack notification when internal org is rejected', async () => {
        const notifController = NotifControllerFactory({ log: mockLog });
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
        mockDataAccess.Entitlement.allByOrganizationId.resolves([{
          getProductCode: sandbox.stub().returns(ASO_PRODUCT_CODE),
          getTier: sandbox.stub().returns('PAID'),
        }]);

        const notifController = NotifControllerFactory({ log: mockLog });
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
        postSlackMessageStub.rejects(new Error('Slack API down'));

        const notifController = NotifControllerFactory({ log: mockLog });
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
});
