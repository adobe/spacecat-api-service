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

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('DRS Client', () => {
  const sandbox = sinon.createSandbox();

  let DrsClient;
  let mockFetch;
  let context;

  beforeEach(async () => {
    mockFetch = sandbox.stub();

    DrsClient = await esmock('../../src/support/drs-client.js', {
      '@adobe/spacecat-shared-utils': {
        tracingFetch: mockFetch,
      },
    });

    context = {
      env: {
        DRS_API_URL: 'https://drs-api.example.com/api/v1',
        DRS_API_KEY: 'test-api-key',
        USER_API_KEY: 'test-callback-api-key',
        SPACECAT_API_URL: 'https://spacecat.example.com',
      },
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('isConfigured', () => {
    it('returns true when DRS_API_URL and DRS_API_KEY are set', () => {
      const client = DrsClient(context);
      expect(client.isConfigured()).to.be.true;
    });

    it('returns false when DRS_API_URL is missing', () => {
      delete context.env.DRS_API_URL;
      const client = DrsClient(context);
      expect(client.isConfigured()).to.be.false;
    });

    it('returns false when DRS_API_KEY is missing', () => {
      delete context.env.DRS_API_KEY;
      const client = DrsClient(context);
      expect(client.isConfigured()).to.be.false;
    });

    it('returns false when both are missing', () => {
      delete context.env.DRS_API_URL;
      delete context.env.DRS_API_KEY;
      const client = DrsClient(context);
      expect(client.isConfigured()).to.be.false;
    });
  });

  describe('submitPromptGenerationJob', () => {
    const jobParams = {
      baseUrl: 'https://example.com',
      brandName: 'TestBrand',
      audience: 'general audience',
      region: 'US',
      numPrompts: 40,
      siteId: 'site-uuid-123',
      imsOrgId: 'org@AdobeOrg',
    };

    it('successfully submits a prompt generation job', async () => {
      const mockResponse = {
        ok: true,
        json: sandbox.stub().resolves({ job_id: 'job-abc123', status: 'QUEUED' }),
      };
      mockFetch.resolves(mockResponse);

      const client = DrsClient(context);
      const result = await client.submitPromptGenerationJob(jobParams);

      expect(result.job_id).to.equal('job-abc123');
      expect(mockFetch).to.have.been.calledOnce;

      const [url, options] = mockFetch.firstCall.args;
      expect(url).to.equal('https://drs-api.example.com/api/v1/jobs');
      expect(options.method).to.equal('POST');
      expect(options.headers['Content-Type']).to.equal('application/json');
      expect(options.headers['x-api-key']).to.equal('test-api-key');

      const body = JSON.parse(options.body);
      expect(body.provider_id).to.equal('prompt_generation_base_url');
      expect(body.parameters.base_url).to.equal('https://example.com');
      expect(body.parameters.brand_name).to.equal('TestBrand');
      expect(body.parameters.audience).to.equal('general audience');
      expect(body.parameters.region).to.equal('US');
      expect(body.parameters.num_prompts).to.equal(40);
      expect(body.webhook_url).to.equal('https://spacecat.example.com/hooks/drs/prompt-generation');
      expect(body.webhook_api_key).to.equal('test-callback-api-key');
      expect(body.metadata.site_id).to.equal('site-uuid-123');
      expect(body.metadata.imsOrgId).to.equal('org@AdobeOrg');
    });

    it('includes both webhook_url and webhook_api_key when configured', async () => {
      const mockResponse = {
        ok: true,
        json: sandbox.stub().resolves({ job_id: 'job-abc123' }),
      };
      mockFetch.resolves(mockResponse);

      const client = DrsClient(context);
      await client.submitPromptGenerationJob(jobParams);

      const body = JSON.parse(mockFetch.firstCall.args[1].body);
      expect(body.webhook_url).to.equal('https://spacecat.example.com/hooks/drs/prompt-generation');
      expect(body.webhook_api_key).to.equal('test-callback-api-key');
    });

    it('omits webhook fields when USER_API_KEY is not configured', async () => {
      delete context.env.USER_API_KEY;

      const mockResponse = {
        ok: true,
        json: sandbox.stub().resolves({ job_id: 'job-abc123' }),
      };
      mockFetch.resolves(mockResponse);

      const client = DrsClient(context);
      await client.submitPromptGenerationJob(jobParams);

      const body = JSON.parse(mockFetch.firstCall.args[1].body);
      expect(body.webhook_url).to.be.undefined;
      expect(body.webhook_api_key).to.be.undefined;
      expect(context.log.warn).to.have.been.calledWith('USER_API_KEY not configured, webhook notifications will not be sent');
    });

    it('omits webhook_url when SPACECAT_API_URL is not configured', async () => {
      delete context.env.SPACECAT_API_URL;

      const mockResponse = {
        ok: true,
        json: sandbox.stub().resolves({ job_id: 'job-abc123' }),
      };
      mockFetch.resolves(mockResponse);

      const client = DrsClient(context);
      await client.submitPromptGenerationJob(jobParams);

      const body = JSON.parse(mockFetch.firstCall.args[1].body);
      expect(body.webhook_url).to.be.undefined;
    });

    it('uses default values for optional parameters', async () => {
      const mockResponse = {
        ok: true,
        json: sandbox.stub().resolves({ job_id: 'job-abc123' }),
      };
      mockFetch.resolves(mockResponse);

      const client = DrsClient(context);
      await client.submitPromptGenerationJob({
        baseUrl: 'https://example.com',
        brandName: 'TestBrand',
        audience: 'general audience',
        siteId: 'site-uuid-123',
        imsOrgId: 'org@AdobeOrg',
        // region and numPrompts not provided - should use defaults
      });

      const body = JSON.parse(mockFetch.firstCall.args[1].body);
      expect(body.parameters.region).to.equal('US');
      expect(body.parameters.num_prompts).to.equal(40);
    });

    it('throws error when DRS is not configured', async () => {
      delete context.env.DRS_API_URL;

      const client = DrsClient(context);

      try {
        await client.submitPromptGenerationJob(jobParams);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('DRS client is not configured');
      }
    });

    it('throws error when API returns non-OK response', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        text: sandbox.stub().resolves('Invalid parameters'),
      };
      mockFetch.resolves(mockResponse);

      const client = DrsClient(context);

      try {
        await client.submitPromptGenerationJob(jobParams);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('DRS job submission failed: 400 - Invalid parameters');
      }
    });

    it('throws error when API returns 500 error', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        text: sandbox.stub().resolves('Internal server error'),
      };
      mockFetch.resolves(mockResponse);

      const client = DrsClient(context);

      try {
        await client.submitPromptGenerationJob(jobParams);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('DRS job submission failed: 500');
      }
    });

    it('logs appropriate messages on success', async () => {
      const mockResponse = {
        ok: true,
        json: sandbox.stub().resolves({ job_id: 'job-abc123' }),
      };
      mockFetch.resolves(mockResponse);

      const client = DrsClient(context);
      await client.submitPromptGenerationJob(jobParams);

      expect(context.log.info).to.have.been.calledWith(
        sinon.match('Submitting DRS prompt generation job'),
      );
      expect(context.log.info).to.have.been.calledWith(
        sinon.match('DRS job submitted successfully'),
      );
    });
  });
});
