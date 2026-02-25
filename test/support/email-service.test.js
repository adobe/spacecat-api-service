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
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('email-service', () => {
  let sendEmail;
  let buildTemplateEmailPayload;
  let escapeXml;
  let mockContext;
  let fetchStub;
  let imsClientInstance;
  let ImsClientStub;

  before(async () => {
    imsClientInstance = {
      getServiceAccessToken: sinon.stub().resolves({ access_token: 'test-token' }),
    };
    ImsClientStub = sinon.stub().returns(imsClientInstance);

    const emailService = await esmock('../../src/support/email-service.js', {
      '@adobe/spacecat-shared-ims-client': {
        ImsClient: ImsClientStub,
      },
    });

    sendEmail = emailService.sendEmail;
    buildTemplateEmailPayload = emailService.buildTemplateEmailPayload;
    escapeXml = emailService.escapeXml;
  });

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
    ImsClientStub.resetHistory();
    imsClientInstance.getServiceAccessToken.reset();
    imsClientInstance.getServiceAccessToken.resolves({ access_token: 'test-token' });

    mockContext = {
      env: {
        IMS_HOST: 'https://ims.example.com',
        EMAIL_IMS_CLIENT_ID: 'client-id',
        EMAIL_IMS_CLIENT_CODE: 'client-code',
        EMAIL_IMS_CLIENT_SECRET: 'client-secret',
        EMAIL_IMS_SCOPE: 'email-scope',
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

  describe('escapeXml', () => {
    it('should escape XML special characters', () => {
      expect(escapeXml('a & b < c > d " e \' f')).to.equal('a &amp; b &lt; c &gt; d &quot; e &apos; f');
    });

    it('should return empty string for non-string input', () => {
      expect(escapeXml(null)).to.equal('');
      expect(escapeXml(undefined)).to.equal('');
      expect(escapeXml(123)).to.equal('');
    });

    it('should return the same string when no special characters', () => {
      expect(escapeXml('hello world')).to.equal('hello world');
    });
  });

  describe('buildTemplateEmailPayload', () => {
    it('should build XML with single recipient and no template data', () => {
      const xml = buildTemplateEmailPayload(['test@example.com']);
      expect(xml).to.include('<toList>test@example.com</toList>');
      expect(xml).to.include('<sendTemplateEmailReq>');
      expect(xml).to.not.include('<templateData>');
    });

    it('should build XML with multiple recipients', () => {
      const xml = buildTemplateEmailPayload(['a@example.com', 'b@example.com']);
      expect(xml).to.include('<toList>a@example.com</toList>');
      expect(xml).to.include('<toList>b@example.com</toList>');
    });

    it('should build XML with template data', () => {
      const xml = buildTemplateEmailPayload(['test@example.com'], {
        site_id: 'site-123',
        status: 'active',
      });
      expect(xml).to.include('<templateData>');
      expect(xml).to.include('<key>site_id</key>');
      expect(xml).to.include('<value>site-123</value>');
      expect(xml).to.include('<key>status</key>');
      expect(xml).to.include('<value>active</value>');
    });

    it('should escape special characters in template data', () => {
      const xml = buildTemplateEmailPayload(['test@example.com'], {
        name: 'A & B <Corp>',
      });
      expect(xml).to.include('<value>A &amp; B &lt;Corp&gt;</value>');
    });
  });

  describe('sendEmail', () => {
    it('should send email successfully', async () => {
      fetchStub.resolves({ status: 200, text: async () => 'OK' });

      const result = await sendEmail(mockContext, {
        recipients: ['test@example.com'],
        templateName: 'test-template',
        templateData: { key: 'value' },
      });

      expect(result.success).to.be.true;
      expect(result.statusCode).to.equal(200);
      expect(result.templateUsed).to.equal('test-template');
      expect(fetchStub).to.have.been.calledOnce;

      const [url, options] = fetchStub.firstCall.args;
      expect(url).to.include('postoffice.example.com');
      expect(url).to.include('templateName=test-template');
      expect(options.method).to.equal('POST');
      expect(options.headers.Authorization).to.equal('IMS test-token');
    });

    it('should create ImsClient with email-specific credentials', async () => {
      fetchStub.resolves({ status: 200, text: async () => 'OK' });

      await sendEmail(mockContext, {
        recipients: ['test@example.com'],
        templateName: 'test-template',
      });

      expect(ImsClientStub).to.have.been.calledOnce;
      const ctorArgs = ImsClientStub.firstCall.args[0];
      expect(ctorArgs.clientId).to.equal('client-id');
      expect(ctorArgs.clientCode).to.equal('client-code');
      expect(ctorArgs.clientSecret).to.equal('client-secret');
      expect(ctorArgs.scope).to.equal('email-scope');
    });

    it('should return error when no recipients provided', async () => {
      const result = await sendEmail(mockContext, {
        recipients: [],
        templateName: 'test-template',
      });

      expect(result.success).to.be.false;
      expect(result.error).to.equal('No recipients provided');
      expect(fetchStub).to.not.have.been.called;
    });

    it('should return error when ADOBE_POSTOFFICE_ENDPOINT is not configured', async () => {
      delete mockContext.env.ADOBE_POSTOFFICE_ENDPOINT;

      const result = await sendEmail(mockContext, {
        recipients: ['test@example.com'],
        templateName: 'test-template',
      });

      expect(result.success).to.be.false;
      expect(result.error).to.equal('ADOBE_POSTOFFICE_ENDPOINT is not configured');
    });

    it('should handle non-200 Post Office response', async () => {
      fetchStub.resolves({
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const result = await sendEmail(mockContext, {
        recipients: ['test@example.com'],
        templateName: 'test-template',
      });

      expect(result.success).to.be.false;
      expect(result.statusCode).to.equal(500);
      expect(result.error).to.include('Post Office returned 500');
      expect(mockContext.log.error).to.have.been.called;
    });

    it('should handle fetch errors gracefully (never throw)', async () => {
      fetchStub.rejects(new Error('Network failure'));

      const result = await sendEmail(mockContext, {
        recipients: ['test@example.com'],
        templateName: 'test-template',
      });

      expect(result.success).to.be.false;
      expect(result.error).to.equal('Network failure');
      expect(mockContext.log.error).to.have.been.called;
    });

    it('should handle IMS token failure gracefully', async () => {
      imsClientInstance.getServiceAccessToken.rejects(new Error('IMS unavailable'));

      const result = await sendEmail(mockContext, {
        recipients: ['test@example.com'],
        templateName: 'test-template',
      });

      expect(result.success).to.be.false;
      expect(result.error).to.equal('IMS unavailable');
    });

    it('should use custom locale when provided', async () => {
      fetchStub.resolves({ status: 200, text: async () => 'OK' });

      await sendEmail(mockContext, {
        recipients: ['test@example.com'],
        templateName: 'test-template',
        locale: 'de-de',
      });

      const [url] = fetchStub.firstCall.args;
      expect(url).to.include('locale=de-de');
    });
  });
});
