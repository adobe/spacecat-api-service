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
const GEO_EXPERIMENT_ID = 'e3c4a7a2-8b5b-4e3c-9d5a-8c3d4e5f6a7b';

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

function createMockGeoExperiment({
  id = GEO_EXPERIMENT_ID, siteId = SITE_ID, opportunityId = null,
} = {}) {
  return {
    getId: () => id,
    getSiteId: () => siteId,
    getOpportunityId: () => opportunityId,
  };
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
      data: { geoExperimentId: GEO_EXPERIMENT_ID },
      dataAccess: {
        Site: { findById: sandbox.stub().resolves(createMockSite()) },
        Opportunity: { findById: sandbox.stub().resolves(createMockOpportunity()) },
        GeoExperiment: { findById: sandbox.stub().resolves(createMockGeoExperiment()) },
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
      siteId: SITE_ID,
      opportunityId: OPPORTUNITY_ID,
      geoExperimentId: GEO_EXPERIMENT_ID,
      status: 'queued',
    });

    expect(mockContext.sqs.sendMessage).to.have.been.calledOnceWith('imports-queue-url', {
      type: 'optimize-at-edge-enabled-marking',
      siteId: SITE_ID,
      validateOnly: true,
      geoExperimentId: GEO_EXPERIMENT_ID,
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

  it('returns 400 when geoExperimentId is missing', async () => {
    mockContext.data = {};

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
  });

  it('returns 400 when geoExperimentId is not a valid UUID', async () => {
    mockContext.data = { geoExperimentId: 'not-a-uuid' };

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
    expect(mockContext.sqs.sendMessage).not.to.have.been.called;
  });

  it('returns 400 when geoExperimentId is not a string', async () => {
    mockContext.data = { geoExperimentId: 12345 };

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(400);
  });

  it('returns 404 when the geoExperiment is not found', async () => {
    mockContext.dataAccess.GeoExperiment.findById.resolves(null);

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(404);
    expect(mockContext.sqs.sendMessage).not.to.have.been.called;
  });

  it('returns 404 when the geoExperiment belongs to a different site', async () => {
    mockContext.dataAccess.GeoExperiment.findById.resolves(
      createMockGeoExperiment({ siteId: OTHER_SITE_ID }),
    );

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(404);
    expect(mockContext.sqs.sendMessage).not.to.have.been.called;
  });

  it('returns 404 when the geoExperiment belongs to a different opportunity', async () => {
    mockContext.dataAccess.GeoExperiment.findById.resolves(
      createMockGeoExperiment({ opportunityId: 'f4d5b8b3-9c6c-4f4d-a6b1-9d4e5f6a7b8c' }),
    );

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(404);
    expect(mockContext.sqs.sendMessage).not.to.have.been.called;
  });

  it('accepts a geoExperiment whose opportunityId matches this opportunity', async () => {
    mockContext.dataAccess.GeoExperiment.findById.resolves(
      createMockGeoExperiment({ opportunityId: OPPORTUNITY_ID }),
    );

    const result = await controller.triggerValidation(mockContext);

    expect(result.status).to.equal(202);
  });
});
