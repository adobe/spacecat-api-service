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
  const jobId = '123e4567-e89b-12d3-a456-426614174000';

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
  };

  const mockJob = {
    getId: () => jobId,
    getStatus: () => 'IN_PROGRESS',
    getCreatedAt: () => '2024-03-20T10:00:00Z',
    getUpdatedAt: () => '2024-03-20T10:00:00Z',
    getStartedAt: () => '2024-03-20T10:00:00Z',
    getEndedAt: () => null,
    getRecordExpiresAt: () => 1710936000,
    getResultLocation: () => null,
    getResultType: () => null,
    getResult: () => null,
    getError: () => null,
    getMetadata: () => ({
      payload: {
        pageUrl: 'https://example.com',
      },
      jobType: 'preflight',
      tags: ['preflight'],
    }),
  };

  const mockDataAccess = {
    AsyncJob: {
      create: sandbox.stub().resolves(mockJob),
      findById: sandbox.stub().resolves(mockJob),
    },
  };

  let preflightController;

  beforeEach(() => {
    preflightController = PreflightController({ dataAccess: mockDataAccess }, loggerStub, { test: 'env' });
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
    it('creates a preflight job successfully in production environment', async () => {
      const context = {
        data: {
          pageUrl: 'https://example.com',
        },
        func: {
          version: 'v1',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(200);

      const result = await response.json();
      expect(result).to.deep.equal({
        jobId,
        status: 'IN_PROGRESS',
        createdAt: '2024-03-20T10:00:00Z',
        pollUrl: `https://spacecat.experiencecloud.live/api/v1/preflight/jobs/${jobId}`,
      });

      expect(mockDataAccess.AsyncJob.create).to.have.been.calledWith({
        status: 'IN_PROGRESS',
        metadata: {
          payload: {
            pageUrl: 'https://example.com',
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });
    });

    it('creates a preflight job successfully in CI environment', async () => {
      const context = {
        data: {
          pageUrl: 'https://example.com',
        },
        func: {
          version: 'ci123',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(200);

      const result = await response.json();
      expect(result).to.deep.equal({
        jobId,
        status: 'IN_PROGRESS',
        createdAt: '2024-03-20T10:00:00Z',
        pollUrl: `https://spacecat.experiencecloud.live/api/ci/preflight/jobs/${jobId}`,
      });

      expect(mockDataAccess.AsyncJob.create).to.have.been.calledWith({
        status: 'IN_PROGRESS',
        metadata: {
          payload: {
            pageUrl: 'https://example.com',
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });
    });

    it('returns 400 Bad Request if data is missing', async () => {
      const context = {
        data: {},
        func: {
          version: 'v1',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: missing application/json data',
      });
    });

    it('returns 400 Bad Request for empty pageUrl', async () => {
      const context = {
        data: {
          pageUrl: '',
        },
        func: {
          version: 'v1',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: missing pageUrl in request data',
      });
    });

    it('returns 400 Bad Request for whitespace pageUrl', async () => {
      const context = {
        data: {
          pageUrl: ' ',
        },
        func: {
          version: 'v1',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: missing pageUrl in request data',
      });
    });

    it('handles errors during job creation', async () => {
      mockDataAccess.AsyncJob.create.rejects(new Error('Something went wrong'));

      const context = {
        data: {
          pageUrl: 'https://example.com',
        },
        func: {
          version: 'v1',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Something went wrong',
      });
    });
  });

  describe('getPreflightJobStatusAndResult', () => {
    it('gets preflight job status successfully', async () => {
      const context = {
        params: {
          jobId,
        },
      };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(200);

      const result = await response.json();
      expect(result).to.deep.equal({
        jobId,
        status: 'IN_PROGRESS',
        createdAt: '2024-03-20T10:00:00Z',
        updatedAt: '2024-03-20T10:00:00Z',
        startedAt: '2024-03-20T10:00:00Z',
        endedAt: null,
        recordExpiresAt: 1710936000,
        resultLocation: null,
        resultType: null,
        result: null,
        error: null,
        metadata: {
          payload: {
            pageUrl: 'https://example.com',
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });
    });

    it('returns 400 Bad Request for invalid job ID', async () => {
      const context = {
        params: {
          jobId: 'invalid-uuid',
        },
      };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid jobId',
      });
    });

    it('returns 404 Not Found for non-existent job', async () => {
      mockDataAccess.AsyncJob.findById.resolves(null);

      const context = {
        params: {
          jobId,
        },
      };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(404);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: `Job with ID ${jobId} not found`,
      });
    });

    it('handles errors during job retrieval', async () => {
      mockDataAccess.AsyncJob.findById.rejects(new Error('Something went wrong'));

      const context = {
        params: {
          jobId,
        },
      };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(500);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Something went wrong',
      });
    });
  });
});
