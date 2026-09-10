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

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import OaeValidationController from '../../src/controllers/oae-validation.js';

use(sinonChai);

describe('OaeValidation Controller', () => {
  const sandbox = sinon.createSandbox();
  const siteId = '123e4567-e89b-12d3-a456-426614174000';
  const suggestionId1 = '223e4567-e89b-12d3-a456-426614174001';
  const suggestionId2 = '323e4567-e89b-12d3-a456-426614174002';
  const jobId = '423e4567-e89b-12d3-a456-426614174003';

  let log;
  let sqs;
  let dataAccess;
  let configuration;
  let controller;
  let ctx;

  beforeEach(() => {
    log = {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
    };

    sqs = { sendMessage: sandbox.stub().resolves() };

    configuration = { getQueues: () => ({ imports: 'https://sqs.example.com/imports' }) };

    dataAccess = {
      Configuration: { findLatest: sandbox.stub().resolves(configuration) },
      OaeValidation: { allByJobId: sandbox.stub() },
    };

    ctx = { dataAccess, sqs };

    controller = OaeValidationController(ctx, log, { AWS_ENV: 'dev' });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('constructor', () => {
    it('throws when context is missing', () => {
      expect(() => OaeValidationController(null, log, {})).to.throw('Context required');
    });

    it('throws when dataAccess is missing', () => {
      expect(() => OaeValidationController({ sqs }, log, {})).to.throw('Data access required');
    });

    it('throws when sqs is missing', () => {
      expect(() => OaeValidationController({ dataAccess }, log, {})).to.throw('SQS client required');
    });

    it('throws when env is missing', () => {
      expect(() => OaeValidationController(ctx, log, null)).to.throw('Environment object required');
    });
  });

  describe('createValidationJob', () => {
    it('returns 400 when data is missing', async () => {
      const response = await controller.createValidationJob({ data: undefined });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when siteId is not a valid UUID', async () => {
      const response = await controller.createValidationJob({
        data: { siteId: 'not-a-uuid', type: 'routing', suggestionIds: [suggestionId1] },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when type is missing', async () => {
      const response = await controller.createValidationJob({
        data: { siteId, suggestionIds: [suggestionId1] },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when suggestionIds is missing', async () => {
      const response = await controller.createValidationJob({
        data: { siteId, type: 'routing' },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when suggestionIds is empty', async () => {
      const response = await controller.createValidationJob({
        data: { siteId, type: 'routing', suggestionIds: [] },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when a suggestionId is not a valid UUID', async () => {
      const response = await controller.createValidationJob({
        data: { siteId, type: 'routing', suggestionIds: ['not-a-uuid'] },
      });
      expect(response.status).to.equal(400);
    });

    it('sends one SQS message and returns 202 with a generated jobId', async () => {
      const response = await controller.createValidationJob({
        data: { siteId, type: 'routing', suggestionIds: [suggestionId1, suggestionId2] },
      });

      expect(response.status).to.equal(202);
      const body = await response.json();
      expect(body.jobId).to.be.a('string');

      expect(sqs.sendMessage).to.have.been.calledOnceWith(
        'https://sqs.example.com/imports',
        {
          type: 'oae-validation',
          jobId: body.jobId,
          siteId,
          validationType: 'routing',
          suggestionIds: [suggestionId1, suggestionId2],
        },
      );
    });

    it('returns 500 when sending the SQS message fails', async () => {
      sqs.sendMessage.rejects(new Error('SQS unavailable'));

      const response = await controller.createValidationJob({
        data: { siteId, type: 'routing', suggestionIds: [suggestionId1] },
      });

      expect(response.status).to.equal(500);
    });
  });

  describe('getValidationJob', () => {
    it('returns 400 when jobId is not a valid UUID', async () => {
      const response = await controller.getValidationJob({ params: { jobId: 'not-a-uuid' } });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when no rows exist for the job', async () => {
      dataAccess.OaeValidation.allByJobId.resolves([]);

      const response = await controller.getValidationJob({ params: { jobId } });

      expect(response.status).to.equal(404);
    });

    it('returns 200 with the per-suggestion data for the job', async () => {
      const row1 = {
        getSuggestionId: () => suggestionId1,
        getStatus: () => 'COMPLETE',
        getOutcome: () => 'true',
        getCompletedAt: () => '2026-01-01T00:00:00.000Z',
        getMetadata: () => ({}),
      };
      const row2 = {
        getSuggestionId: () => suggestionId2,
        getStatus: () => 'IN_PROGRESS',
        getOutcome: () => null,
        getCompletedAt: () => null,
        getMetadata: () => null,
      };
      dataAccess.OaeValidation.allByJobId.resolves([row1, row2]);

      const response = await controller.getValidationJob({ params: { jobId } });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.deep.equal({
        jobId,
        suggestions: [
          {
            suggestionId: suggestionId1, status: 'COMPLETE', outcome: 'true', completedAt: '2026-01-01T00:00:00.000Z', metadata: {},
          },
          {
            suggestionId: suggestionId2, status: 'IN_PROGRESS', outcome: null, completedAt: null, metadata: null,
          },
        ],
      });
    });

    it('returns 500 when the query fails', async () => {
      dataAccess.OaeValidation.allByJobId.rejects(new Error('DB unavailable'));

      const response = await controller.getValidationJob({ params: { jobId } });

      expect(response.status).to.equal(500);
    });
  });
});
