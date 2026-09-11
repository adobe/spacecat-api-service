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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import OaeValidationController from '../../src/controllers/oae-validation.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(sinonChai);
use(chaiAsPromised);

describe('OaeValidation Controller', () => {
  const sandbox = sinon.createSandbox();
  const siteId = '123e4567-e89b-12d3-a456-426614174000';
  const otherSiteId = '923e4567-e89b-12d3-a456-426614174009';
  const suggestionId1 = '223e4567-e89b-12d3-a456-426614174001';
  const suggestionId2 = '323e4567-e89b-12d3-a456-426614174002';
  const jobId = '423e4567-e89b-12d3-a456-426614174003';

  const opportunityId = '523e4567-e89b-12d3-a456-426614174004';

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
      Suggestion: {
        findById: sandbox.stub(),
        batchGetByKeys: sandbox.stub().callsFake(async (keys) => ({
          data: keys.map(() => ({ getOpportunityId: () => opportunityId })),
        })),
      },
      Opportunity: { findById: sandbox.stub() },
      Site: { findById: sandbox.stub().resolves({ getId: () => siteId }) },
    };

    ctx = { dataAccess, sqs };

    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);

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

  describe('createJob (internal, called directly by in-process callers e.g. suggestions.js)', () => {
    it('throws when data is missing', async () => {
      await expect(controller.createJob(undefined)).to.be.rejectedWith('Invalid request: missing application/json data');
    });

    it('throws when siteId is not a valid UUID', async () => {
      await expect(controller.createJob({
        siteId: 'not-a-uuid', opportunityId, type: 'routing', suggestionIds: [suggestionId1],
      })).to.be.rejectedWith('Invalid request: siteId must be a valid UUID');
    });
  });

  describe('createValidationJob', () => {
    let authCtx;
    beforeEach(() => {
      authCtx = {
        params: { siteId },
        dataAccess,
        attributes: { authInfo: { type: 'jwt' } },
        pathInfo: { headers: {} },
      };
    });

    it('returns 400 when siteId param is missing', async () => {
      const response = await controller.createValidationJob({
        params: {},
        data: {
          opportunityId, type: 'routing', suggestionIds: [suggestionId1],
        },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when siteId param is not a valid UUID', async () => {
      const response = await controller.createValidationJob({
        params: { siteId: 'not-a-uuid' },
        data: {
          opportunityId, type: 'routing', suggestionIds: [suggestionId1],
        },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 403 when the caller does not have access to the site', async () => {
      AccessControlUtil.prototype.hasAccess.resolves(false);

      const response = await controller.createValidationJob({
        ...authCtx,
        data: {
          opportunityId, type: 'routing', suggestionIds: [suggestionId1],
        },
      });

      expect(response.status).to.equal(403);
      expect(sqs.sendMessage).to.not.have.been.called;
    });

    it('returns 403 when the site cannot be found', async () => {
      dataAccess.Site.findById.resolves(undefined);

      const response = await controller.createValidationJob({
        ...authCtx,
        data: {
          opportunityId, type: 'routing', suggestionIds: [suggestionId1],
        },
      });

      expect(response.status).to.equal(403);
      expect(sqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when opportunityId is missing', async () => {
      const response = await controller.createValidationJob({
        ...authCtx,
        data: { type: 'routing', suggestionIds: [suggestionId1] },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when opportunityId is not a valid UUID', async () => {
      const response = await controller.createValidationJob({
        ...authCtx,
        data: { opportunityId: 'not-a-uuid', type: 'routing', suggestionIds: [suggestionId1] },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when type is missing', async () => {
      const response = await controller.createValidationJob({
        ...authCtx,
        data: { opportunityId, suggestionIds: [suggestionId1] },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when type is not a recognized validation type', async () => {
      const response = await controller.createValidationJob({
        ...authCtx,
        data: { opportunityId, type: 'bogus-type', suggestionIds: [suggestionId1] },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when suggestionIds is missing', async () => {
      const response = await controller.createValidationJob({
        ...authCtx,
        data: { opportunityId, type: 'routing' },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when suggestionIds is empty', async () => {
      const response = await controller.createValidationJob({
        ...authCtx,
        data: {
          opportunityId, type: 'routing', suggestionIds: [],
        },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when a suggestionId is not a valid UUID', async () => {
      const response = await controller.createValidationJob({
        ...authCtx,
        data: { opportunityId, type: 'routing', suggestionIds: ['not-a-uuid'] },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when a suggestionId does not belong to opportunityId', async () => {
      dataAccess.Suggestion.batchGetByKeys.resolves({
        data: [{ getOpportunityId: () => 'some-other-opportunity-id' }],
      });

      const response = await controller.createValidationJob({
        ...authCtx,
        data: { opportunityId, type: 'routing', suggestionIds: [suggestionId1] },
      });

      expect(response.status).to.equal(400);
      expect(sqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when a suggestionId no longer resolves at all', async () => {
      dataAccess.Suggestion.batchGetByKeys.resolves({ data: [] });

      const response = await controller.createValidationJob({
        ...authCtx,
        data: { opportunityId, type: 'routing', suggestionIds: [suggestionId1] },
      });

      expect(response.status).to.equal(400);
      expect(sqs.sendMessage).to.not.have.been.called;
    });

    it('sends one SQS message and returns 202 with a generated jobId', async () => {
      const response = await controller.createValidationJob({
        ...authCtx,
        data: {
          opportunityId, type: 'routing', suggestionIds: [suggestionId1, suggestionId2],
        },
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

    it('ignores a stale siteId in the body, always using the URL param', async () => {
      const response = await controller.createValidationJob({
        ...authCtx,
        data: {
          siteId: otherSiteId, opportunityId, type: 'routing', suggestionIds: [suggestionId1],
        },
      });

      expect(response.status).to.equal(202);
      expect(sqs.sendMessage).to.have.been.calledWith(
        'https://sqs.example.com/imports',
        sinon.match({ siteId }),
      );
    });

    it('returns 500 when sending the SQS message fails', async () => {
      sqs.sendMessage.rejects(new Error('SQS unavailable'));

      const response = await controller.createValidationJob({
        ...authCtx,
        data: { opportunityId, type: 'routing', suggestionIds: [suggestionId1] },
      });

      expect(response.status).to.equal(500);
    });
  });

  describe('getValidationJob', () => {
    let validParams;
    beforeEach(() => {
      validParams = { jobId, siteId };
    });

    it('returns 400 when jobId is not a valid UUID', async () => {
      const response = await controller.getValidationJob({ params: { jobId: 'not-a-uuid', siteId } });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when siteId param is not a valid UUID', async () => {
      const response = await controller.getValidationJob({ params: { jobId, siteId: 'not-a-uuid' } });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when no rows exist for the job', async () => {
      dataAccess.OaeValidation.allByJobId.resolves([]);

      const response = await controller.getValidationJob({
        params: validParams,
        dataAccess,
        attributes: { authInfo: { type: 'jwt' } },
        pathInfo: { headers: {} },
      });

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
      dataAccess.Suggestion.findById.resolves({ getOpportunityId: () => opportunityId });
      dataAccess.Opportunity.findById.resolves({ getSiteId: () => siteId });
      dataAccess.Site.findById.resolves({ getId: () => siteId });

      const response = await controller.getValidationJob({
        params: validParams,
        dataAccess,
        attributes: { authInfo: { type: 'jwt' } },
        pathInfo: { headers: {} },
      });

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
      expect(dataAccess.Suggestion.findById).to.have.been.calledOnceWith(suggestionId1);
      expect(dataAccess.Opportunity.findById).to.have.been.calledOnceWith(opportunityId);
      expect(dataAccess.Site.findById).to.have.been.calledOnceWith(siteId);
    });

    it('returns 404 when the job\'s owning suggestion can no longer be found', async () => {
      dataAccess.OaeValidation.allByJobId.resolves([{
        getSuggestionId: () => suggestionId1,
        getStatus: () => 'COMPLETE',
        getOutcome: () => 'true',
        getCompletedAt: () => '2026-01-01T00:00:00.000Z',
        getMetadata: () => ({}),
      }]);
      dataAccess.Suggestion.findById.resolves(undefined);

      const response = await controller.getValidationJob({
        params: validParams,
        dataAccess,
        attributes: { authInfo: { type: 'jwt' } },
        pathInfo: { headers: {} },
      });

      expect(response.status).to.equal(404);
      expect(dataAccess.Opportunity.findById).to.not.have.been.called;
    });

    it('returns 404 when the suggestion\'s opportunity can no longer be found', async () => {
      dataAccess.OaeValidation.allByJobId.resolves([{
        getSuggestionId: () => suggestionId1,
        getStatus: () => 'COMPLETE',
        getOutcome: () => 'true',
        getCompletedAt: () => '2026-01-01T00:00:00.000Z',
        getMetadata: () => ({}),
      }]);
      dataAccess.Suggestion.findById.resolves({ getOpportunityId: () => opportunityId });
      dataAccess.Opportunity.findById.resolves(undefined);

      const response = await controller.getValidationJob({
        params: validParams,
        dataAccess,
        attributes: { authInfo: { type: 'jwt' } },
        pathInfo: { headers: {} },
      });

      expect(response.status).to.equal(404);
      expect(dataAccess.Site.findById).to.not.have.been.called;
    });

    it('returns 404 when the opportunity\'s site can no longer be found', async () => {
      dataAccess.OaeValidation.allByJobId.resolves([{
        getSuggestionId: () => suggestionId1,
        getStatus: () => 'COMPLETE',
        getOutcome: () => 'true',
        getCompletedAt: () => '2026-01-01T00:00:00.000Z',
        getMetadata: () => ({}),
      }]);
      dataAccess.Suggestion.findById.resolves({ getOpportunityId: () => opportunityId });
      dataAccess.Opportunity.findById.resolves({ getSiteId: () => siteId });
      dataAccess.Site.findById.resolves(undefined);

      const response = await controller.getValidationJob({
        params: validParams,
        dataAccess,
        attributes: { authInfo: { type: 'jwt' } },
        pathInfo: { headers: {} },
      });

      expect(response.status).to.equal(404);
      expect(AccessControlUtil.prototype.hasAccess).to.not.have.been.called;
    });

    it('returns 404 when the job\'s real site does not match the URL\'s siteId', async () => {
      dataAccess.OaeValidation.allByJobId.resolves([{
        getSuggestionId: () => suggestionId1,
        getStatus: () => 'COMPLETE',
        getOutcome: () => 'true',
        getCompletedAt: () => '2026-01-01T00:00:00.000Z',
        getMetadata: () => ({}),
      }]);
      dataAccess.Suggestion.findById.resolves({ getOpportunityId: () => opportunityId });
      dataAccess.Opportunity.findById.resolves({ getSiteId: () => otherSiteId });
      dataAccess.Site.findById.resolves({ getId: () => otherSiteId });

      const response = await controller.getValidationJob({
        params: validParams,
        dataAccess,
        attributes: { authInfo: { type: 'jwt' } },
        pathInfo: { headers: {} },
      });

      expect(response.status).to.equal(404);
      expect(AccessControlUtil.prototype.hasAccess).to.not.have.been.called;
    });

    it('returns 403 when the caller does not have access to the job\'s site', async () => {
      dataAccess.OaeValidation.allByJobId.resolves([{
        getSuggestionId: () => suggestionId1,
        getStatus: () => 'COMPLETE',
        getOutcome: () => 'true',
        getCompletedAt: () => '2026-01-01T00:00:00.000Z',
        getMetadata: () => ({}),
      }]);
      dataAccess.Suggestion.findById.resolves({ getOpportunityId: () => opportunityId });
      dataAccess.Opportunity.findById.resolves({ getSiteId: () => siteId });
      dataAccess.Site.findById.resolves({ getId: () => siteId });
      AccessControlUtil.prototype.hasAccess.resolves(false);

      const response = await controller.getValidationJob({
        params: validParams,
        dataAccess,
        attributes: { authInfo: { type: 'jwt' } },
        pathInfo: { headers: {} },
      });

      expect(response.status).to.equal(403);
    });

    it('returns 500 when the query fails', async () => {
      dataAccess.OaeValidation.allByJobId.rejects(new Error('DB unavailable'));

      const response = await controller.getValidationJob({
        params: validParams,
        dataAccess,
        attributes: { authInfo: { type: 'jwt' } },
        pathInfo: { headers: {} },
      });

      expect(response.status).to.equal(500);
    });
  });
});
