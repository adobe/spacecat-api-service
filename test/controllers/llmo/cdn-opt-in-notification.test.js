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

describe('cdn-opt-in-notification', () => {
  let notifyOptInIfNeeded;
  let sendEmailStub;
  let mockContext;

  before(async () => {
    sendEmailStub = sinon.stub();

    const module = await esmock(
      '../../../src/controllers/llmo/cdn-opt-in-notification.js',
      {
        '../../../src/support/email-service.js': {
          sendEmail: (...args) => sendEmailStub(...args),
        },
      },
    );

    notifyOptInIfNeeded = module.notifyOptInIfNeeded;
  });

  beforeEach(() => {
    sendEmailStub.reset();
    sendEmailStub.resolves({ success: true, statusCode: 200 });

    mockContext = {
      env: {
        OPT_IN_NOTIFICATION_RECIPIENTS: 'llmo-team@adobe.com',
        ADOBE_POSTOFFICE_ENDPOINT: 'https://postoffice.example.com',
      },
      log: {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
      },
      dataAccess: {
        TrialUser: {
          allByOrganizationId: sinon.stub().resolves([]),
        },
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('notifyOptInIfNeeded', () => {
    const baseParams = {
      siteId: 'site-uuid-123',
      siteBaseURL: 'https://www.example.com',
      cdnLogSource: 'byocdn-akamai',
      orgId: 'org-uuid-456',
      optedBy: 'user@adobe.com',
    };

    it('sends email and returns sent:true for a newly opted site', async () => {
      const result = await notifyOptInIfNeeded(mockContext, baseParams);

      expect(result.sent).to.be.true;
      expect(sendEmailStub).to.have.been.calledOnce;

      const [, opts] = sendEmailStub.firstCall.args;
      expect(opts.recipients).to.deep.equal(['llmo-team@adobe.com']);
      expect(opts.templateName).to.equal('llmo_cdn_opt_in_notification');
      expect(opts.templateData.siteBaseURL).to.equal('https://www.example.com');
      expect(opts.templateData.cdnDisplayName).to.equal('Akamai (BYOCDN)');
      expect(opts.templateData.optedBy).to.equal('user@adobe.com');
      expect(opts.templateData.docLink).to.be.a('string');
      expect(opts.templateData.cdnNote).to.be.a('string');
      expect(opts.templateData.orgMembers).to.equal('');
    });

    it('adds organization members as comma-separated emails', async () => {
      mockContext.dataAccess.TrialUser.allByOrganizationId.resolves([
        { getEmailId: () => 'b@example.com', getStatus: () => 'USER' },
        { getEmailId: () => 'a@example.com', getStatus: () => 'INVITED' },
      ]);

      await notifyOptInIfNeeded(mockContext, baseParams);

      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.orgMembers).to.equal('a@example.com, b@example.com');
      expect(mockContext.dataAccess.TrialUser.allByOrganizationId).to.have.been.calledWith('org-uuid-456');
    });

    it('filters blocked/deleted org members and deduplicates emails', async () => {
      mockContext.dataAccess.TrialUser.allByOrganizationId.resolves([
        { getEmailId: () => 'keep@example.com', getStatus: () => 'USER' },
        { getEmailId: () => 'KEEP@example.com', getStatus: () => 'INVITED' },
        { getEmailId: () => 'blocked@example.com', getStatus: () => 'BLOCKED' },
        { getEmailId: () => 'deleted@example.com', getStatus: () => 'DELETED' },
      ]);

      await notifyOptInIfNeeded(mockContext, baseParams);

      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.orgMembers).to.equal('keep@example.com');
    });

    it('falls back from getStatus/getEmailId to status/emailId fields', async () => {
      mockContext.dataAccess.TrialUser.allByOrganizationId.resolves([
        {
          getStatus: () => '',
          status: 'USER',
          getEmailId: () => '',
          emailId: 'fallback@example.com',
        },
      ]);

      await notifyOptInIfNeeded(mockContext, baseParams);

      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.orgMembers).to.equal('fallback@example.com');
    });

    it('skips org members with non-string email values', async () => {
      mockContext.dataAccess.TrialUser.allByOrganizationId.resolves([
        { getStatus: () => 'USER', getEmailId: () => 12345 },
      ]);

      await notifyOptInIfNeeded(mockContext, baseParams);

      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.orgMembers).to.equal('');
    });

    it('skips null/empty org member entries safely', async () => {
      mockContext.dataAccess.TrialUser.allByOrganizationId.resolves([null, {}]);

      await notifyOptInIfNeeded(mockContext, baseParams);

      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.orgMembers).to.equal('');
    });

    it('keeps sending when org members fetch fails', async () => {
      mockContext.dataAccess.TrialUser.allByOrganizationId.rejects(new Error('db unavailable'));

      const result = await notifyOptInIfNeeded(mockContext, baseParams);

      expect(result.sent).to.be.true;
      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.orgMembers).to.equal('');
      expect(mockContext.log.warn).to.have.been.calledWith(
        sinon.match(/Failed to fetch org members/),
      );
    });

    it('keeps sending with empty org members when TrialUser model is unavailable', async () => {
      mockContext.dataAccess = {};

      const result = await notifyOptInIfNeeded(mockContext, baseParams);

      expect(result.sent).to.be.true;
      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.orgMembers).to.equal('');
    });

    it('formats org members when trial users expose plain status/emailId fields', async () => {
      mockContext.dataAccess.TrialUser.allByOrganizationId.resolves([
        { emailId: 'plain1@example.com', status: 'USER' },
        { emailId: 'plain2@example.com', status: 'INVITED' },
      ]);

      await notifyOptInIfNeeded(mockContext, baseParams);

      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.orgMembers).to.equal('plain1@example.com, plain2@example.com');
    });

    it('passes docLink for CDNs with setup guide and empty note for CDNs without one', async () => {
      await notifyOptInIfNeeded(mockContext, { ...baseParams, cdnLogSource: 'byocdn-cloudflare' });

      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.docLink).to.include('cloudflare');
      expect(templateData.cdnNote).to.equal('');
      expect(templateData.cdnDisplayName).to.equal('Cloudflare (BYOCDN)');
    });

    it('passes docLink and cdnNote for CloudFront which has Lambda@Edge specific note', async () => {
      await notifyOptInIfNeeded(mockContext, { ...baseParams, cdnLogSource: 'byocdn-cloudfront' });

      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.docLink).to.include('cloudfront');
      expect(templateData.cdnNote).to.include('Lambda@Edge');
      expect(templateData.cdnDisplayName).to.equal('CloudFront (BYOCDN)');
    });

    it('passes empty docLink and cdnNote for CDNs without extra config', async () => {
      await notifyOptInIfNeeded(mockContext, { ...baseParams, cdnLogSource: 'byocdn-imperva' });

      const { templateData, templateName } = sendEmailStub.firstCall.args[1];
      expect(templateData.docLink).to.equal('');
      expect(templateData.cdnNote).to.equal('');
      expect(templateData.cdnDisplayName).to.equal('Imperva (BYOCDN)');
      expect(templateName).to.equal('llmo_cdn_opt_in_notification');
    });

    it('uses adobe managed template for ams-cloudfront', async () => {
      await notifyOptInIfNeeded(mockContext, { ...baseParams, cdnLogSource: 'ams-cloudfront' });

      const { templateName, templateData } = sendEmailStub.firstCall.args[1];
      expect(templateName).to.equal('llmo_cdn_opt_in_notification_adobe_managed');
      expect(templateData.cdnDisplayName).to.equal('AMS CloudFront');
    });

    it('uses adobe managed template for ams-frontdoor', async () => {
      await notifyOptInIfNeeded(mockContext, { ...baseParams, cdnLogSource: 'ams-frontdoor' });

      const { templateName } = sendEmailStub.firstCall.args[1];
      expect(templateName).to.equal('llmo_cdn_opt_in_notification_adobe_managed');
    });

    it('uses adobe managed template for aem-cs-fastly', async () => {
      await notifyOptInIfNeeded(mockContext, { ...baseParams, cdnLogSource: 'aem-cs-fastly' });

      const { templateName } = sendEmailStub.firstCall.args[1];
      expect(templateName).to.equal('llmo_cdn_opt_in_notification_adobe_managed');
    });

    it('uses adobe managed template for commerce-fastly', async () => {
      await notifyOptInIfNeeded(mockContext, { ...baseParams, cdnLogSource: 'commerce-fastly' });

      const { templateName } = sendEmailStub.firstCall.args[1];
      expect(templateName).to.equal('llmo_cdn_opt_in_notification_adobe_managed');
    });

    it('uses byocdn template for a CDN type and handles gracefully', async () => {
      await notifyOptInIfNeeded(mockContext, { ...baseParams, cdnLogSource: 'some-unknown-cdn' });

      const { templateName, templateData } = sendEmailStub.firstCall.args[1];
      expect(templateName).to.equal('llmo_cdn_opt_in_notification');
      expect(templateData.cdnDisplayName).to.equal('some-unknown-cdn');
      expect(templateData.docLink).to.equal('');
      expect(templateData.cdnNote).to.equal('');
    });

    it('skips and logs error when OPT_IN_NOTIFICATION_RECIPIENTS is not configured', async () => {
      delete mockContext.env.OPT_IN_NOTIFICATION_RECIPIENTS;

      const result = await notifyOptInIfNeeded(mockContext, baseParams);

      expect(result.sent).to.be.false;
      expect(result.reason).to.equal('no-recipients');
      expect(sendEmailStub).to.not.have.been.called;
      expect(mockContext.log.error).to.have.been.calledWith(
        sinon.match(/OPT_IN_NOTIFICATION_RECIPIENTS is not configured/),
      );
    });

    it('skips when OPT_IN_NOTIFICATION_RECIPIENTS is empty', async () => {
      mockContext.env.OPT_IN_NOTIFICATION_RECIPIENTS = '   ';

      const result = await notifyOptInIfNeeded(mockContext, baseParams);

      expect(result.sent).to.be.false;
      expect(result.reason).to.equal('no-recipients');
      expect(sendEmailStub).to.not.have.been.called;
    });

    it('filters out non-adobe.com recipients and skips when none remain', async () => {
      mockContext.env.OPT_IN_NOTIFICATION_RECIPIENTS = 'outsider@gmail.com,hacker@evil.com';

      const result = await notifyOptInIfNeeded(mockContext, baseParams);

      expect(result.sent).to.be.false;
      expect(result.reason).to.equal('no-recipients');
      expect(sendEmailStub).to.not.have.been.called;
    });

    it('filters out non-adobe.com addresses but sends to valid ones', async () => {
      mockContext.env.OPT_IN_NOTIFICATION_RECIPIENTS = 'valid@adobe.com,bad@gmail.com,also@adobe.com';

      await notifyOptInIfNeeded(mockContext, baseParams);

      const { recipients } = sendEmailStub.firstCall.args[1];
      expect(recipients).to.deep.equal(['valid@adobe.com', 'also@adobe.com']);
    });

    it('logs warning when sendEmail does not succeed', async () => {
      sendEmailStub.resolves({ success: false, statusCode: 500, error: 'Server Error' });

      const result = await notifyOptInIfNeeded(mockContext, baseParams);

      expect(result.sent).to.be.false;
      expect(mockContext.log.warn).to.have.been.calledWith(
        sinon.match(/Email not delivered/),
      );
    });

    it('logs status code when sendEmail fails without error message', async () => {
      sendEmailStub.resolves({ success: false, statusCode: 503 });

      const result = await notifyOptInIfNeeded(mockContext, baseParams);

      expect(result.sent).to.be.false;
      expect(mockContext.log.warn).to.have.been.calledWith(
        sinon.match(/status 503/),
      );
    });

    it('catches and logs unexpected errors, never throws', async () => {
      sendEmailStub.rejects(new Error('Unexpected network failure'));

      const result = await notifyOptInIfNeeded(mockContext, baseParams);

      expect(result.sent).to.be.false;
      expect(result.reason).to.equal('error');
      expect(result.error).to.equal('Unexpected network failure');
      expect(mockContext.log.error).to.have.been.calledWith(
        sinon.match(/Unexpected error/),
      );
    });

    it('handles missing optional params (undefined cdnLogSource, orgId, optedBy)', async () => {
      const result = await notifyOptInIfNeeded(mockContext, {
        siteId: 'site-uuid-123',
        siteBaseURL: 'https://www.example.com',
      });

      expect(result.sent).to.be.true;
      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.siteBaseURL).to.equal('https://www.example.com');
      expect(templateData.optedBy).to.equal('');
      expect(templateData.cdnDisplayName).to.equal('A CDN');
      expect(templateData.docLink).to.equal('');
      expect(templateData.cdnNote).to.equal('');
      expect(templateData.orgMembers).to.equal('');
    });

    it('handles null params object without throwing', async () => {
      const result = await notifyOptInIfNeeded(mockContext, null);

      // Recipients still come from env, so email is sent even with null params
      expect(result.sent).to.be.true;
      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.siteBaseURL).to.equal('');
      expect(templateData.orgMembers).to.equal('');
    });
  });
});
