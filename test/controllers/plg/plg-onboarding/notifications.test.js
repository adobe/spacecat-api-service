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
  TEST_SITE_ID,
  TEST_ONBOARDING_ID,
  createSharedMocks,
  resetStubDefaults,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  mockAuthInfo as mockAuthInfoShared,
} from './shared-fixtures.js';
import { createPlgEsmock } from './plg-esmock-factory.js';

use(sinonChai);

describe('PlgOnboardingController', function describePlgOnboarding() {
  // esmock + extensive sinon stubs make individual tests slower than the 2000ms default.
  this.timeout(10000);

  let sandbox;
  let stubs;

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

  function mockAuthInfo(imsOrgId = TEST_IMS_ORG_ID) {
    return mockAuthInfoShared(sandbox, imsOrgId);
  }

  before(async () => {
    sandbox = sinon.createSandbox();
    stubs = createSharedMocks(sandbox);
    ({
      mockSiteConfig, mockOrganization, mockProject, mockLog, mockEnv,
    } = stubs);
  });

  after(() => sandbox.restore());

  beforeEach(() => {
    sandbox.reset();
    resetStubDefaults(stubs);
    ({
      mockLog,
      mockEnv,
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

  describe('onboard - Slack notifications', () => {
    let postSlackMessageStub;
    let SlackControllerFactory;

    before(async () => {
      postSlackMessageStub = sandbox.stub().resolves();
      SlackControllerFactory = await createPlgEsmock(stubs, {
        hasAdminAccess: false,
        postSlackMessageStub,
      });
    });

    beforeEach(() => {
      postSlackMessageStub.reset();
    });

    function buildSlackContext(onboarding) {
      return {
        data: { domain: TEST_DOMAIN },
        dataAccess: {
          ...mockDataAccess,
          PlgOnboarding: {
            ...mockDataAccess.PlgOnboarding,
            findByImsOrgIdAndDomain: sandbox.stub().resolves(null),
            create: sandbox.stub().resolves(onboarding),
          },
        },
        log: mockLog,
        env: {
          ...mockEnv,
          SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123TEST',
          SLACK_BOT_TOKEN: 'xoxb-test-token',
        },
        sqs: { sendMessage: sandbox.stub().resolves() },
        attributes: { authInfo: mockAuthInfo() },
      };
    }

    it('posts notification with botBlocker type and ipsToAllowlist', async () => {
      const onboarding = createMockOnboarding({
        status: 'WAITING_FOR_IP_ALLOWLISTING',
        botBlocker: { type: 'cloudflare', ipsToAllowlist: ['1.2.3.4', '5.6.7.8'] },
        organizationId: TEST_ORG_ID,
        siteId: TEST_SITE_ID,
      });
      stubs.detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4', '5.6.7.8'],
      });

      await SlackControllerFactory({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [channelId, message] = postSlackMessageStub.firstCall.args;
      expect(channelId).to.equal('C123TEST');
      expect(message).to.include('Waiting for IP Allowlisting');
      expect(message).to.include('cloudflare');
      expect(message).to.include('1.2.3.4, 5.6.7.8');
      expect(message).to.include('Test Org');
      expect(message).to.include(TEST_ORG_ID);
      expect(message).to.include(TEST_SITE_ID);
      expect(message).to.not.include('ASO Link');
      expect(message).to.include(`https://experience.adobe.com/#/@aem-sites-engineering/custom-apps/24749-EssDeveloperUI/#/sites/${TEST_SITE_ID}`);
    });

    it('posts notification with botBlocker type but no ipsToAllowlist', async () => {
      const onboarding = createMockOnboarding({
        status: 'WAITING_FOR_IP_ALLOWLISTING',
        botBlocker: { type: 'akamai' },
      });
      stubs.detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'akamai',
      });

      await SlackControllerFactory({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('akamai');
      expect(message).to.not.include('IPs to allowlist');
      // organizationId is null on this onboarding, so org name/ID should not appear
      expect(message).to.not.include('IMS Org Name');
      expect(message).to.not.include('SpaceCat Org ID (derived from IMS Org)');
      expect(message).to.not.include('Site ID');
      expect(message).to.not.include('ASO Link');
      expect(message).to.not.include('Backoffice Link');
    });

    it('posts error notification including error message', async () => {
      const onboarding = createMockOnboarding({
        status: 'ERROR',
        error: { message: 'An internal error occurred' },
      });
      stubs.createOrFindOrganizationStub.rejects(new Error('DB failure'));

      await SlackControllerFactory({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Error');
      expect(message).to.include('An internal error occurred');
    });

    it('posts notification with waitlist reason for non-AEM site', async () => {
      const onboarding = createMockOnboarding({
        status: 'WAITLISTED',
        waitlistReason: `Domain ${TEST_DOMAIN} is not an AEM site`,
      });
      stubs.rumRetrieveDomainkeyStub.rejects(new Error('No domainkey'));
      stubs.findDeliveryTypeStub.resolves('other');

      await SlackControllerFactory({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Waitlisted');
      expect(message).to.include('is not an AEM site');
    });

    it('logs error when postSlackMessage fails but does not propagate', async () => {
      postSlackMessageStub.rejects(new Error('Slack API unavailable'));
      const onboarding = createMockOnboarding({
        status: 'WAITING_FOR_IP_ALLOWLISTING',
        botBlocker: { type: 'cloudflare', ipsToAllowlist: ['1.2.3.4'] },
      });
      stubs.detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4'],
      });

      const res = await SlackControllerFactory({ log: mockLog })
        .onboard(buildSlackContext(onboarding));

      expect(res.status).to.equal(200);
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Failed to post PLG onboarding notification to Slack/),
      );
    });

    it('posts notification without org name when org lookup fails', async function () {
      this.timeout(10000);
      const onboarding = createMockOnboarding({
        status: 'WAITLISTED',
        waitlistReason: `Domain ${TEST_DOMAIN} is not an AEM site`,
        organizationId: TEST_ORG_ID,
      });
      stubs.rumRetrieveDomainkeyStub.rejects(new Error('No domainkey'));
      stubs.findDeliveryTypeStub.resolves('other');

      const ctx = buildSlackContext(onboarding);
      ctx.dataAccess = {
        ...ctx.dataAccess,
        Organization: {
          ...ctx.dataAccess.Organization,
          findById: sandbox.stub().rejects(new Error('DB error')),
        },
      };

      await SlackControllerFactory({ log: mockLog }).onboard(ctx);

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Waitlisted');
      expect(message).to.not.include('IMS Org Name');
      expect(message).to.not.include('ASO Link');
      expect(message).to.not.include('Backoffice Link');
      expect(mockLog.warn).to.have.been.calledWith(
        sinon.match(/Failed to look up org name for onboarding notification/),
      );
    });

    it('posts notification without org name when org has no name', async function () {
      this.timeout(10000);
      const onboarding = createMockOnboarding({
        status: 'ONBOARDED',
        organizationId: TEST_ORG_ID,
        siteId: TEST_SITE_ID,
      });

      const ctx = buildSlackContext(onboarding);
      ctx.dataAccess = {
        ...ctx.dataAccess,
        Organization: {
          ...ctx.dataAccess.Organization,
          findById: sandbox.stub().resolves({ getName: () => null }),
        },
      };

      await SlackControllerFactory({ log: mockLog }).onboard(ctx);

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Onboarded');
      expect(message).to.not.include('IMS Org Name');
      expect(message).to.include(TEST_ORG_ID);
      expect(message).to.include(TEST_SITE_ID);
      expect(message).to.include(`https://experience.adobe.com/?organizationId=${TEST_ORG_ID}#/sites-optimizer/sites/${TEST_SITE_ID}`);
      expect(message).to.include(`https://experience.adobe.com/#/@aem-sites-engineering/custom-apps/24749-EssDeveloperUI/#/sites/${TEST_SITE_ID}`);
    });

    it('uses custom EXPERIENCE_URL for ASO link when provided', async () => {
      const onboarding = createMockOnboarding({
        status: 'ONBOARDED',
        organizationId: TEST_ORG_ID,
        siteId: TEST_SITE_ID,
      });

      const ctx = buildSlackContext(onboarding);
      ctx.env = { ...ctx.env, EXPERIENCE_URL: 'https://experience-stage.adobe.com' };

      await SlackControllerFactory({ log: mockLog }).onboard(ctx);

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include(`https://experience-stage.adobe.com/?organizationId=${TEST_ORG_ID}#/sites-optimizer/sites/${TEST_SITE_ID}`);
      expect(message).to.include(`https://experience-stage.adobe.com/#/@aem-sites-engineering/custom-apps/24749-EssDeveloperUI/#/sites/${TEST_SITE_ID}`);
      expect(message).to.not.include('https://experience.adobe.com/');
    });

    it('posts notification with fast onboarded note via fast path (PRE_ONBOARDING + siteId)', async () => {
      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        organizationId: TEST_ORG_ID,
        steps: { orgResolved: true },
      });
      // setStatus is a stub; make getStatus track the last set value so the
      // notification function sees ONBOARDED when postPlgOnboardingNotification is called.
      let currentStatus = 'PRE_ONBOARDING';
      preonboardedOnboarding.getStatus = () => currentStatus;
      preonboardedOnboarding.setStatus = (s) => {
        currentStatus = s;
      };

      const ctx = {
        data: { domain: TEST_DOMAIN },
        dataAccess: {
          ...mockDataAccess,
          Organization: {
            ...mockDataAccess.Organization,
            findByImsOrgId: sandbox.stub().resolves(null),
          },
          PlgOnboarding: {
            ...mockDataAccess.PlgOnboarding,
            findByImsOrgIdAndDomain: sandbox.stub().resolves(preonboardedOnboarding),
          },
          Site: {
            ...mockDataAccess.Site,
            findById: sandbox.stub().resolves(createMockSite()),
          },
        },
        log: mockLog,
        env: {
          ...mockEnv,
          SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123TEST',
          SLACK_BOT_TOKEN: 'xoxb-test-token',
        },
        sqs: { sendMessage: sandbox.stub().resolves() },
        attributes: { authInfo: mockAuthInfo() },
      };

      await SlackControllerFactory({ log: mockLog }).onboard(ctx);

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Notes:');
      expect(message).to.include('Fast onboarding (pre-onboarded site)');
    });

    it('posts notification with org reassigned note when steps.siteOrgReassigned is set', async () => {
      const onboarding = createMockOnboarding({
        status: 'ONBOARDED',
        organizationId: TEST_ORG_ID,
        siteId: TEST_SITE_ID,
        steps: { siteOrgReassigned: true, entitlementCreated: true },
      });

      await SlackControllerFactory({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Notes:');
      expect(message).to.include('Site moved from internal org to customer org');
    });

    it('posts notification with author URL note when steps.authorUrlResolved is set', async () => {
      const onboarding = createMockOnboarding({
        status: 'ONBOARDED',
        organizationId: TEST_ORG_ID,
        siteId: TEST_SITE_ID,
        steps: { authorUrlResolved: true, entitlementCreated: true },
      });

      await SlackControllerFactory({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Notes:');
      expect(message).to.include('Author URL auto-resolved (AEM CS)');
    });

    it('posts notification with multiple notes when several steps are set', async () => {
      const onboarding = createMockOnboarding({
        status: 'ONBOARDED',
        organizationId: TEST_ORG_ID,
        siteId: TEST_SITE_ID,
        steps: { siteOrgReassigned: true, authorUrlResolved: true },
      });

      await SlackControllerFactory({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Site moved from internal org to customer org');
      expect(message).to.include('Author URL auto-resolved (AEM CS)');
    });

    it('posts notification without Notes section when no notable steps are set', async () => {
      const onboarding = createMockOnboarding({
        status: 'ONBOARDED',
        organizationId: TEST_ORG_ID,
        siteId: TEST_SITE_ID,
        steps: { entitlementCreated: true, orgResolved: true },
      });

      await SlackControllerFactory({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.not.include('Notes:');
    });

    describe('admin update/transition notifications', () => {
      let AdminSlackControllerFactory;

      before(async () => {
        AdminSlackControllerFactory = await createPlgEsmock(stubs, {
          hasAdminAccess: true,
          postSlackMessageStub,
        });
      });

      it('REJECTED notification includes review decision, justification, and reviewer', async () => {
        const record = createMockOnboarding({
          status: 'WAITLISTED',
          waitlistReason: 'another domain is already onboarded for this IMS org',
          reviews: null,
        });
        // Simulate setStatus updating the status so notification reads REJECTED
        let currentStatus = 'WAITLISTED';
        let currentReviews = null;
        record.getStatus.callsFake(() => currentStatus);
        record.setStatus.callsFake((s) => {
          currentStatus = s;
        });
        record.getReviews.callsFake(() => currentReviews);
        record.setReviews.callsFake((r) => {
          currentReviews = r;
        });
        mockDataAccess.PlgOnboarding.findById.resolves(record);

        await AdminSlackControllerFactory({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'UPHELD', justification: 'Domain is not ready' },
          attributes: { authInfo: { getProfile: () => ({ email: 'ese@adobe.com' }) } },
          env: { SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123TEST', SLACK_BOT_TOKEN: 'xoxb-test' },
          log: mockLog,
        });

        expect(postSlackMessageStub).to.have.been.called;
        const [, message] = postSlackMessageStub.firstCall.args;
        expect(message).to.include('Rejected');
        expect(message).to.include('Domain is not ready');
        expect(message).to.not.include('Decision:');
        expect(message).to.not.include('Reviewed by:');
      });

      it('REJECTED notification omits review details when there are no prior reviews', async () => {
        const record = createMockOnboarding({
          status: 'WAITLISTED',
          waitlistReason: 'domain is not an AEM site',
          reviews: null,
        });
        let currentStatus = 'WAITLISTED';
        record.getStatus.callsFake(() => currentStatus);
        record.setStatus.callsFake((s) => {
          currentStatus = s;
        });
        mockDataAccess.PlgOnboarding.findById.resolves(record);

        await AdminSlackControllerFactory({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'UPHELD', justification: 'Inactivating per request' },
          attributes: { authInfo: { getProfile: () => ({ email: 'ese@adobe.com' }) } },
          env: { SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123TEST', SLACK_BOT_TOKEN: 'xoxb-test' },
          log: mockLog,
        });

        expect(postSlackMessageStub).to.have.been.called;
        const [, message] = postSlackMessageStub.firstCall.args;
        expect(message).to.include('Rejected');
        expect(message).to.not.include('Justification:');
      });

      it('OUTDATED notification omits review section when no reviews', async () => {
        let currentStatus = 'WAITLISTED';
        const record = createMockOnboarding({ status: 'WAITLISTED' });
        record.getStatus.callsFake(() => currentStatus);
        record.setStatus.callsFake((s) => {
          currentStatus = s;
        });
        record.getReviews.returns(null);
        mockDataAccess.PlgOnboarding.findById.resolves(record);

        await AdminSlackControllerFactory({ log: mockLog }).transitionStatus({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { status: 'OUTDATED', justification: 'Closing old waitlist entry' },
          attributes: { authInfo: { getProfile: () => ({ email: 'admin@adobe.com' }) } },
          env: { SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123TEST', SLACK_BOT_TOKEN: 'xoxb-test' },
          log: mockLog,
        });

        expect(postSlackMessageStub).to.have.been.called;
        const [, message] = postSlackMessageStub.firstCall.args;
        expect(message).to.include('Outdated');
        // No justification appended when getReviews returns null
        expect(message).to.not.include('Justification:');
      });
    });
  });
});
