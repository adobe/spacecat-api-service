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

/* eslint-env mocha */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';
import {
  buildEmailPayload,
} from '../../src/support/email-service.js';

use(chaiAsPromised);
use(sinonChai);

describe('Email Service', () => {
  const sandbox = sinon.createSandbox();
  let emailServiceWithMocks;
  let mockImsClient;

  const mockEnv = {
    EMAIL_IMS_CLIENT_ID: 'test-client-id',
    EMAIL_IMS_CLIENT_SECRET: 'test-client-secret',
    EMAIL_IMS_CLIENT_CODE: 'test-client-code',
    EMAIL_IMS_SCOPE: 'test-scope',
    ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message',
    EMAIL_LLMO_TEMPLATE: 'expdev_xwalk_trial_confirm',
  };

  const mockContext = {
    env: mockEnv,
    log: {
      info: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
      warn: sandbox.stub(),
    },
  };

  beforeEach(async () => {
    sandbox.restore();

    mockImsClient = {
      createFrom: sandbox.stub().returns({
        getServiceAccessToken: sandbox.stub().resolves({ access_token: 'mock-access-token' }),
      }),
    };

    global.fetch = sandbox.stub().resolves({
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    emailServiceWithMocks = await esmock('../../src/support/email-service.js', {
      '@adobe/spacecat-shared-ims-client': { ImsClient: mockImsClient },
    });
  });

  afterEach(() => {
    sandbox.restore();
    delete global.fetch;
  });

  describe('buildEmailPayload', () => {
    it('should build basic email payload with recipient', () => {
      // Use direct import for coverage
      const payload = buildEmailPayload({
        to: 'test@example.com',
      });

      expect(payload).to.include('<toList>test@example.com</toList>');
      expect(payload).to.include('<sendTemplateEmailReq>');
    });

    it('should include template parameters', () => {
      const payload = buildEmailPayload({
        to: 'test@example.com',
        templateParams: {
          name: 'John',
          value: '100',
        },
      });

      expect(payload).to.include('<param name="name">John</param>');
      expect(payload).to.include('<param name="value">100</param>');
    });

    it('should escape XML special characters', () => {
      const payload = buildEmailPayload({
        to: 'test@example.com',
        templateParams: {
          message: '<script>alert("xss")</script>',
        },
      });

      expect(payload).to.include('&lt;script&gt;');
      expect(payload).to.not.include('<script>alert');
    });

    it('should handle empty template params', () => {
      const payload = buildEmailPayload({
        to: 'test@example.com',
        templateParams: {},
      });

      expect(payload).to.include('<toList>test@example.com</toList>');
    });

    it('should handle array of recipients', () => {
      const payload = buildEmailPayload({
        to: ['a@test.com', 'b@test.com'],
      });

      expect(payload).to.include('<toList>a@test.com,b@test.com</toList>');
    });

    it('should escape all XML special characters', () => {
      const payload = buildEmailPayload({
        to: 'test@example.com',
        templateParams: {
          ampersand: 'AT&T',
          quotes: 'He said "hello"',
          apostrophe: "It's a test",
        },
      });

      expect(payload).to.include('AT&amp;T');
      expect(payload).to.include('&quot;hello&quot;');
      expect(payload).to.include('&apos;s');
    });

    it('should handle edge case parameter values', () => {
      const payload = buildEmailPayload({
        to: 'test@example.com',
        templateParams: {
          nullValue: null,
          undefinedValue: undefined,
          emptyValue: '',
          zeroValue: 0,
        },
      });

      expect(payload).to.include('<param name="nullValue">');
      expect(payload).to.include('<param name="undefinedValue">');
      expect(payload).to.include('<param name="emptyValue"></param>');
      expect(payload).to.include('<param name="zeroValue">0</param>');
    });
  });

  describe('sendEmail', () => {
    it('should send email successfully', async () => {
      const result = await emailServiceWithMocks.sendEmail({
        context: mockContext,
        templateName: 'test-template',
        to: 'test@example.com',
        templateParams: { name: 'Test' },
      });

      expect(result.success).to.be.true;
      expect(global.fetch).to.have.been.called;
    });

    it('should return error when fetch returns non-200', async () => {
      global.fetch.resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('Server error'),
      });

      const result = await emailServiceWithMocks.sendEmail({
        context: mockContext,
        templateName: 'test-template',
        to: 'test@example.com',
      });

      expect(result.success).to.be.false;
      expect(result.statusCode).to.equal(500);
    });

    it('should return error when IMS token fails', async () => {
      mockImsClient.createFrom.returns({
        getServiceAccessToken: sandbox.stub().rejects(new Error('Token error')),
      });

      const result = await emailServiceWithMocks.sendEmail({
        context: mockContext,
        templateName: 'test-template',
        to: 'test@example.com',
      });

      expect(result.success).to.be.false;
      expect(result.error).to.include('Token error');
    });

    it('should use default locale when not specified', async () => {
      await emailServiceWithMocks.sendEmail({
        context: mockContext,
        templateName: 'test-template',
        to: 'test@example.com',
      });

      const fetchCall = global.fetch.getCall(0);
      expect(fetchCall.args[0]).to.include('locale=en-us');
    });

    it('should use custom locale when specified', async () => {
      await emailServiceWithMocks.sendEmail({
        context: mockContext,
        templateName: 'test-template',
        to: 'test@example.com',
        locale: 'fr-fr',
      });

      const fetchCall = global.fetch.getCall(0);
      expect(fetchCall.args[0]).to.include('locale=fr-fr');
    });

    it('should return error when endpoint not configured', async () => {
      const contextNoEndpoint = {
        ...mockContext,
        env: { ...mockEnv, ADOBE_POSTOFFICE_ENDPOINT: '' },
      };

      const result = await emailServiceWithMocks.sendEmail({
        context: contextNoEndpoint,
        templateName: 'test-template',
        to: 'test@example.com',
      });

      expect(result.success).to.be.false;
      expect(result.error).to.include('not configured');
    });
  });

  describe('sendTrialUserInviteEmail', () => {
    it('should send trial user invite email', async () => {
      const result = await emailServiceWithMocks.sendTrialUserInviteEmail({
        context: mockContext,
        emailAddress: 'newuser@example.com',
      });

      expect(result.success).to.be.true;
      const fetchCall = global.fetch.getCall(0);
      expect(fetchCall.args[1].body).to.include('newuser@example.com');
    });

    it('should use correct template for invite', async () => {
      await emailServiceWithMocks.sendTrialUserInviteEmail({
        context: mockContext,
        emailAddress: 'newuser@example.com',
      });

      const fetchCall = global.fetch.getCall(0);
      // Template is passed in the URL, not body
      expect(fetchCall.args[0]).to.include(`templateName=${mockEnv.EMAIL_LLMO_TEMPLATE}`);
    });
  });

  describe('sendEmail with array recipients', () => {
    it('should handle array of recipients and log them', async () => {
      const result = await emailServiceWithMocks.sendEmail({
        context: mockContext,
        templateName: 'test-template',
        to: ['user1@example.com', 'user2@example.com'],
        templateParams: {},
      });

      expect(result.success).to.be.true;
      expect(mockContext.log.info).to.have.been.called;
    });
  });

  describe('sendWeeklyDigestEmail', () => {
    const digestParams = {
      context: mockContext,
      emailAddress: 'user@example.com',
      customerName: 'John Doe',
      brandName: 'Acme Corp',
      orgName: 'Acme Organization',
      dateRange: 'Jan 1 - Jan 7, 2025',
      visibilityScore: 85,
      visibilityDelta: '+5%',
      mentionsCount: 150,
      mentionsDelta: '-2%',
      citationsCount: 45,
      citationsDelta: '+10%',
      overviewUrl: 'https://llmo.now/acme.com/overview',
      settingsUrl: 'https://llmo.now/acme.com/settings',
    };

    it('should send weekly digest email with all parameters', async () => {
      const result = await emailServiceWithMocks.sendWeeklyDigestEmail(digestParams);

      expect(result.success).to.be.true;
      const fetchCall = global.fetch.getCall(0);
      const { body } = fetchCall.args[1];
      expect(body).to.include('user@example.com');
      expect(body).to.include('John Doe');
      expect(body).to.include('Acme Corp');
    });

    it('should format metrics in email', async () => {
      await emailServiceWithMocks.sendWeeklyDigestEmail(digestParams);

      const fetchCall = global.fetch.getCall(0);
      const { body } = fetchCall.args[1];
      expect(body).to.include('85');
      expect(body).to.include('150');
      expect(body).to.include('45');
    });

    it('should include delta values', async () => {
      await emailServiceWithMocks.sendWeeklyDigestEmail(digestParams);

      const fetchCall = global.fetch.getCall(0);
      const { body } = fetchCall.args[1];
      expect(body).to.include('+5%');
      expect(body).to.include('-2%');
      expect(body).to.include('+10%');
    });

    it('should include URLs', async () => {
      await emailServiceWithMocks.sendWeeklyDigestEmail(digestParams);

      const fetchCall = global.fetch.getCall(0);
      const { body } = fetchCall.args[1];
      expect(body).to.include('https://llmo.now/acme.com/overview');
      expect(body).to.include('https://llmo.now/acme.com/settings');
    });

    it('should handle email send failure', async () => {
      global.fetch.resolves({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: () => Promise.resolve('Service down'),
      });

      const result = await emailServiceWithMocks.sendWeeklyDigestEmail(digestParams);

      expect(result.success).to.be.false;
    });

    it('should handle null counts gracefully', async () => {
      const paramsWithNullCounts = {
        ...digestParams,
        mentionsCount: null,
        citationsCount: undefined,
      };

      const result = await emailServiceWithMocks.sendWeeklyDigestEmail(paramsWithNullCounts);

      expect(result.success).to.be.true;
      const fetchCall = global.fetch.getCall(0);
      const { body } = fetchCall.args[1];
      // formatNumber should return '0' for null/undefined
      expect(body).to.include('0');
    });
  });
});
