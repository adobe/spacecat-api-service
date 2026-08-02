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
import OpportunityValidationController from '../../../../src/controllers/llmo/opportunities/opportunity-validation-controller.js';

use(sinonChai);

const SITE_ID = 'a4a6055c-de4b-4552-bc0c-01fdb45b98d5';
const OPPORTUNITY_ID = 'a92e2a5e-7b3d-42f0-b3f0-6edd3746a932';
const OTHER_SITE_ID = 'b56ef8d6-996b-4d5c-b308-8e0b0a95e1b6';

function createMockOpportunity({
  id = OPPORTUNITY_ID, siteId = SITE_ID, type = 'prerender',
} = {}) {
  return {
    getId: () => id,
    getSiteId: () => siteId,
    getType: () => type,
  };
}

function createMockSite({ id = SITE_ID } = {}) {
  return { getId: () => id };
}

describe('OpportunityValidationController', () => {
  let sandbox;
  let controller;
  let mockContext;
  let mockConfiguration;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockConfiguration = {
      getQueues: sandbox.stub().returns({ imports: 'imports-queue-url' }),
    };

    mockContext = {
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { urls: ['https://example.com/page-1', 'https://example.com/page-2'] },
      dataAccess: {
        Site: { findById: sandbox.stub().resolves(createMockSite()) },
        Opportunity: { findById: sandbox.stub().resolves(createMockOpportunity()) },
        Configuration: { findLatest: sandbox.stub().resolves(mockConfiguration) },
      },
      sqs: { sendMessage: sandbox.stub().resolves() },
      log: {
        info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(),
      },
    };

    controller = OpportunityValidationController();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('enqueues a validation message and returns 202 on the happy path', async () => {
    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(202);
    const body = await result.json();
    expect(body).to.deep.equal({
      siteId: SITE_ID, opportunityId: OPPORTUNITY_ID, status: 'queued', urlCount: 2,
    });

    expect(mockContext.sqs.sendMessage).to.have.been.calledOnceWith('imports-queue-url', {
      type: 'optimize-at-edge-enabled-marking',
      siteId: SITE_ID,
      validateOnly: true,
      opportunityId: OPPORTUNITY_ID,
      urls: ['https://example.com/page-1', 'https://example.com/page-2'],
    });
  });

  it('returns 400 when siteId is not a valid UUID', async () => {
    mockContext.params.siteId = 'not-a-uuid';

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
    expect(mockContext.dataAccess.Site.findById).not.to.have.been.called;
  });

  it('returns 404 when the site is not found', async () => {
    mockContext.dataAccess.Site.findById.resolves(null);

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(404);
  });

  it('returns 400 when opportunityId is not a valid UUID', async () => {
    mockContext.params.opportunityId = 'not-a-uuid';

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
    expect(mockContext.dataAccess.Opportunity.findById).not.to.have.been.called;
  });

  it('returns 404 when the opportunity is not found', async () => {
    mockContext.dataAccess.Opportunity.findById.resolves(null);

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(404);
  });

  it('returns 404 when the opportunity belongs to a different site', async () => {
    mockContext.dataAccess.Opportunity.findById.resolves(
      createMockOpportunity({ siteId: OTHER_SITE_ID }),
    );

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(404);
  });

  it('returns 400 when the opportunity type is not prerender', async () => {
    mockContext.dataAccess.Opportunity.findById.resolves(
      createMockOpportunity({ type: 'content' }),
    );

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.match(/not supported for opportunity type 'content'/);
  });

  it('returns 400 when no data is provided', async () => {
    mockContext.data = undefined;

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
  });

  it('returns 400 when urls is missing', async () => {
    mockContext.data = {};

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
  });

  it('returns 400 when urls is an empty array', async () => {
    mockContext.data = { urls: [] };

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
  });

  it('returns 400 when urls is not an array', async () => {
    mockContext.data = { urls: 'https://example.com' };

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
  });

  it('returns 400 when urls contains a non-string entry', async () => {
    mockContext.data = { urls: ['https://example.com', 42] };

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
  });

  it('returns 400 when urls contains an invalid URL string', async () => {
    mockContext.data = { urls: ['not a url'] };

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
  });

  it('returns 400 when urls exceeds the 200-URL cap', async () => {
    mockContext.data = { urls: Array.from({ length: 201 }, (_, i) => `https://example.com/${i}`) };

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.match(/max 200 per request/);
    expect(mockContext.sqs.sendMessage).not.to.have.been.called;
  });

  it('accepts exactly 200 urls', async () => {
    mockContext.data = { urls: Array.from({ length: 200 }, (_, i) => `https://example.com/${i}`) };

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(202);
  });
});
