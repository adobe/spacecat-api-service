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
  let mockContext;
  let fetchStub;
  let imsClientInstance;
  let ImsClientStub;

  before(async () => {
    imsClientInstance = {
      getServiceAccessToken: sinon.stub().resolves({ access_token: 'test-token' }),
    };
    ImsClientStub = {
      createFrom: sinon.stub().returns(imsClientInstance),
    };

    const emailService = await esmock('../../src/support/email-service.js', {
      '@adobe/spacecat-shared-ims-client': {
        ImsClient: ImsClientStub,
      },
    });

    sendEmail = emailService.sendEmail;
  });

  beforeEach(() => {
    ImsClientStub.createFrom.resetHistory();
    imsClientInstance.getServiceAccessToken.reset();
    imsClientInstance.getServiceAccessToken.resolves({ access_token: 'test-token' });

    mockContext = {
      env: {
        IMS_HOST: 'https://ims.example.com',
        LLMO_EMAIL_IMS_CLIENT_ID: 'client-id',
        LLMO_EMAIL_IMS_CLIENT_CODE: 'client-code',
        LLMO_EMAIL_IMS_CLIENT_SECRET: 'client-secret',
        LLMO_EMAIL_IMS_SCOPE: 'email-scope',
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

  describe('sendEmail', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      fetchStub = sinon.stub();
      globalThis.fetch = fetchStub;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

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
      expect(url).to.include('locale=en_US');
      expect(options.method).to.equal('POST');
      expect(options.headers.Authorization).to.equal('IMS test-token');
      expect(options.headers['Content-Type']).to.equal('application/json');
      expect(options.headers.Accept).to.equal('application/json');
      const body = JSON.parse(options.body);
      expect(body).to.deep.equal({
        toList: 'test@example.com',
        templateData: { key: 'value' },
      });
    });

    it('should create ImsClient with email-specific credentials', async () => {
      fetchStub.resolves({ status: 200, text: async () => 'OK' });

      await sendEmail(mockContext, {
        recipients: ['test@example.com'],
        templateName: 'test-template',
      });

      expect(ImsClientStub.createFrom).to.have.been.calledOnce;
      const ctxArg = ImsClientStub.createFrom.firstCall.args[0];
      expect(ctxArg.env.IMS_CLIENT_ID).to.equal('client-id');
      expect(ctxArg.env.IMS_CLIENT_CODE).to.equal('client-code');
      expect(ctxArg.env.IMS_CLIENT_SECRET).to.equal('client-secret');
      expect(ctxArg.env.IMS_SCOPE).to.equal('email-scope');
      expect(ctxArg.env.IMS_HOST).to.equal('https://ims.example.com');
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

    it('should return error when templateName is missing', async () => {
      const result = await sendEmail(mockContext, {
        recipients: ['test@example.com'],
        templateName: null,
      });

      expect(result.success).to.be.false;
      expect(result.error).to.equal('templateName is required');
      expect(fetchStub).to.not.have.been.called;
      expect(imsClientInstance.getServiceAccessToken).to.not.have.been.called;
    });

    it('should skip token acquisition when accessToken is provided', async () => {
      fetchStub.resolves({ status: 200, text: async () => 'OK' });

      const result = await sendEmail(mockContext, {
        recipients: ['test@example.com'],
        templateName: 'test-template',
        accessToken: 'provided-token',
      });

      expect(result.success).to.be.true;
      expect(ImsClientStub.createFrom).to.not.have.been.called;
      const [, options] = fetchStub.firstCall.args;
      expect(options.headers.Authorization).to.equal('IMS provided-token');
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
        locale: 'de_DE',
      });

      const [url] = fetchStub.firstCall.args;
      expect(url).to.include('locale=de_DE');
    });

    it('should send JSON body with toList as comma-separated string for multiple recipients', async () => {
      fetchStub.resolves({ status: 200, text: async () => 'OK' });

      await sendEmail(mockContext, {
        recipients: ['a@example.com', 'b@example.com'],
        templateName: 'test-template',
      });

      const [, options] = fetchStub.firstCall.args;
      const body = JSON.parse(options.body);
      expect(body.toList).to.equal('a@example.com,b@example.com');
      expect(body.templateData).to.deep.equal({});
    });
  });
});
