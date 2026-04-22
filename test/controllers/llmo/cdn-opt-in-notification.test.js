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
    });

    it('passes docLink and cdnNote as separate variables for CDNs with extra config', async () => {
      await notifyOptInIfNeeded(mockContext, { ...baseParams, cdnLogSource: 'byocdn-cloudflare' });

      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.docLink).to.include('cloudflare');
      expect(templateData.cdnNote).to.include('AdobeEdgeOptimize/1.0');
      expect(templateData.cdnDisplayName).to.equal('Cloudflare (BYOCDN)');
    });

    it('passes empty docLink and cdnNote for CDNs without extra config', async () => {
      await notifyOptInIfNeeded(mockContext, { ...baseParams, cdnLogSource: 'byocdn-imperva' });

      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.docLink).to.equal('');
      expect(templateData.cdnNote).to.equal('');
      expect(templateData.cdnDisplayName).to.equal('Imperva (BYOCDN)');
    });

    it('handles unknown CDN type gracefully', async () => {
      await notifyOptInIfNeeded(mockContext, { ...baseParams, cdnLogSource: 'some-unknown-cdn' });

      const { templateData } = sendEmailStub.firstCall.args[1];
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
      expect(templateData.cdnDisplayName).to.equal('Unknown CDN');
      expect(templateData.docLink).to.equal('');
      expect(templateData.cdnNote).to.equal('');
    });

    it('handles null params object without throwing', async () => {
      const result = await notifyOptInIfNeeded(mockContext, null);

      // Recipients still come from env, so email is sent even with null params
      expect(result.sent).to.be.true;
      const { templateData } = sendEmailStub.firstCall.args[1];
      expect(templateData.siteId).to.equal('');
      expect(templateData.siteBaseURL).to.equal('');
    });
  });
});
