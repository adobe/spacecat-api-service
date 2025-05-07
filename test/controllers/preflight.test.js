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
import PreflightController from '../../src/controllers/preflight.js';

use(chaiAsPromised);
use(sinonChai);

describe('Preflight Controller', () => {
  const sandbox = sinon.createSandbox();

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
  };

  const MOCK_JOB_ID = '9d222c6d-893e-4e79-8201-3c9ca16a0f39';

  let preflightController;

  beforeEach(() => {
    preflightController = PreflightController({ dataAccess: { test: 'property' } }, loggerStub, { test: 'env' });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws an error if context is not an object', () => {
    expect(() => PreflightController(null, loggerStub, { test: 'env' })).to.throw('Context required');
  });

  it('throws an error if dataAccess is not an object', () => {
    expect(() => PreflightController({ dataAccess: null }, loggerStub, { test: 'env' })).to.throw('Data access required');
  });

  it('throws an error if env is not object', () => {
    expect(() => PreflightController({ dataAccess: { test: 'property' } }, loggerStub, null)).to.throw('Environment object required');
  });

  describe('createPreflightJob', () => {
    it('creates a preflight job successfully', async () => {
      const url = 'https://example.com';
      const context = {
        data: {
          pageUrl: url,
        },
        func: {
          version: 'ci',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(loggerStub.info).to.have.been.calledWith(`Creating preflight job for pageUrl: ${url}`);
      expect(response.status).to.equal(200);

      const jobResult = await response.json();
      expect(jobResult).to.deep.equal({
        jobId: MOCK_JOB_ID,
        status: 'IN_PROGRESS',
        createdAt: '2019-08-24T14:15:22Z',
        pollUrl: 'https://spacecat.experiencecloud.live/api/ci/preflight/jobs/9d222c6d-893e-4e79-8201-3c9ca16a0f39',
      });
    });

    it('returns correct pollUrl for non-ci version', async () => {
      const url = 'https://example.com';
      const context = {
        data: {
          pageUrl: url,
        },
        func: {
          version: 'v1',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(loggerStub.info).to.have.been.calledWith(`Creating preflight job for pageUrl: ${url}`);
      expect(response.status).to.equal(200);

      const jobResult = await response.json();
      expect(jobResult).to.deep.equal({
        jobId: MOCK_JOB_ID,
        status: 'IN_PROGRESS',
        createdAt: '2019-08-24T14:15:22Z',
        pollUrl: 'https://spacecat.experiencecloud.live/api/v1/preflight/jobs/9d222c6d-893e-4e79-8201-3c9ca16a0f39',
      });
    });

    it('returns bad request for missing request data', async () => {
      const context = {
        data: {},
        func: {
          version: 'ci',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(loggerStub.error).to.have.been.calledWith('Failed to create preflight job: Invalid request: missing application/json data');
      expect(response.status).to.equal(400);

      const errorResult = await response.json();
      expect(errorResult).to.deep.equal({ message: 'Invalid request: missing application/json data' });
    });

    it('returns bad request for missing pageUrl in request data', async () => {
      const context = {
        data: {
          wrongKey: 'wrongValue',
        },
        func: {
          version: 'ci',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(loggerStub.error).to.have.been.calledWith('Failed to create preflight job: Invalid request: missing pageUrl in request data');
      expect(response.status).to.equal(400);

      const errorResult = await response.json();
      expect(errorResult).to.deep.equal({ message: 'Invalid request: missing pageUrl in request data' });
    });

    it('returns bad request for invalid pageUrl in request data', async () => {
      const context = {
        data: {
          pageUrl: 123,
        },
        func: {
          version: 'ci',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(loggerStub.error).to.have.been.calledWith('Failed to create preflight job: Invalid request: missing pageUrl in request data');
      expect(response.status).to.equal(400);

      const errorResult = await response.json();
      expect(errorResult).to.deep.equal({ message: 'Invalid request: missing pageUrl in request data' });
    });
  });

  describe('getPreflightJobStatusAndResult', () => {
    it('gets preflight job status and result successfully', async () => {
      const context = {
        params: {
          jobId: MOCK_JOB_ID,
        },
      };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(loggerStub.info).to.have.been.calledWith(`Getting preflight job status for jobId: ${MOCK_JOB_ID}`);
      expect(response.status).to.equal(200);

      const jobResult = await response.json();
      expect(jobResult).to.deep.equal({
        jobId: MOCK_JOB_ID,
        status: 'COMPLETED',
        createdAt: '2019-08-24T14:15:22Z',
        updatedAt: '2019-08-24T14:15:22Z',
        startedAt: '2019-08-24T14:15:22Z',
        endedAt: '2019-08-24T14:15:22Z',
        recordExpiresAt: 0,
        result: {
          audits: [
            {
              name: 'metatags',
              type: 'seo',
              opportunities: [
                {
                  tagName: 'description',
                  tagContent: 'Enjoy.',
                  issue: 'Description too short',
                  issueDetails: '94 chars below limit',
                  seoImpact: 'Moderate',
                  seoRecommendation: '140-160 characters long',
                  aiSuggestion: 'Enjoy the best of Adobe Creative Cloud.',
                  aiRationale: "Short descriptions can be less informative and may not attract users' attention.",
                },
                {
                  tagName: 'title',
                  tagContent: 'Adobe',
                  issue: 'Title too short',
                  issueDetails: '20 chars below limit',
                  seoImpact: 'Moderate',
                  seoRecommendation: '40-60 characters long',
                  aiSuggestion: 'Adobe Creative Cloud: Your All-in-One Solution',
                  aiRationale: "Short titles can be less informative and may not attract users' attention.",
                },
              ],
            },
            {
              name: 'canonical',
              type: 'seo',
              opportunities: [
                {
                  check: 'canonical-url-4xx',
                  explanation: 'The canonical URL returns a 4xx error, indicating it is inaccessible, which can harm SEO visibility.',
                },
              ],
            },
          ],
        },
        error: {
          code: 'string',
          message: 'string',
          details: {},
        },
        metadata: {
          pageUrl: 'https://main--cc--adobecom.aem.page/drafts/narcis/creativecloud',
          submittedBy: 'string',
          tags: [
            'string',
          ],
        },
      });
    });

    it('returns not found for invalid jobId', async () => {
      const invalidJobId = 'D6918A5E-D760-4C4D-A585-47BBB2165B84';
      const context = {
        params: {
          jobId: invalidJobId,
        },
      };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(404);

      const errorResult = await response.json();
      expect(errorResult).to.deep.equal({ message: `Job with ID ${invalidJobId} not found` });
    });

    it('returns badRequest for invalid jobId format', async () => {
      const invalidJobId = 'invalid-job-id';
      const context = {
        params: {
          jobId: invalidJobId,
        },
      };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(400);

      const errorResult = await response.json();
      expect(errorResult).to.deep.equal({ message: 'Invalid jobId' });
    });
  });
});
