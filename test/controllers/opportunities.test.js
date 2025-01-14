/*
 * Copyright 2023 Adobe. All rights reserved.
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
import sinon from 'sinon';

import { ValidationError } from '@adobe/spacecat-shared-data-access';
import OpportunitiesController from '../../src/controllers/opportunities.js';

use(chaiAsPromised);

describe('Opportunities Controller', () => {
  const sandbox = sinon.createSandbox();

  const OPPORTUNITY_ID = '3f1c3ab1-9ad0-4231-ac87-8159acf52cb6';
  const SITE_ID = 'b9395f92-1c2f-4904-a8f0-e45f30098f9e';

  const opptys = [
    {
      id: OPPORTUNITY_ID,
      siteId: SITE_ID,
      auditId: 'audit001',
      title: 'Test Opportunity',
      description: 'This is a test opportunity.',
      runbook: 'http://runbook.url',
      guidance: 'Follow these steps.',
      type: 'SEO',
      status: 'NEW',
      origin: 'ESS_OPS',
      tags: ['tag1', 'tag2'],
      data: {
        additionalInfo: 'info',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  const mockOpptyEntity = {
    getId() {
      return opptys[0].id;
    },
    setId(value) {
      opptys[0].id = value;
    },
    getSiteId() {
      return opptys[0].siteId;
    },
    setSiteId(value) {
      opptys[0].siteId = value;
    },
    getAuditId() {
      return opptys[0].auditId;
    },
    setAuditId(value) {
      opptys[0].auditId = value;
    },
    getTitle() {
      return opptys[0].title;
    },
    setTitle(value) {
      opptys[0].title = value;
    },
    getDescription() {
      return opptys[0].description;
    },
    setDescription(value) {
      opptys[0].description = value;
    },
    getRunbook() {
      return opptys[0].runbook;
    },
    setRunbook(value) {
      opptys[0].runbook = value;
    },
    getGuidance() {
      return opptys[0].guidance;
    },
    setGuidance(value) {
      opptys[0].guidance = value;
    },
    getType() {
      return opptys[0].type;
    },
    setType(value) {
      opptys[0].type = value;
    },
    getStatus() {
      return opptys[0].status;
    },
    setStatus(value) {
      opptys[0].status = value;
    },
    getOrigin() {
      return opptys[0].origin;
    },
    setOrigin(value) {
      opptys[0].origin = value;
    },
    getTags() {
      return opptys[0].tags;
    },
    setTags(value) {
      opptys[0].tags = value;
    },
    getData() {
      return opptys[0].data;
    },
    setData(value) {
      opptys[0].data = value;
    },
    getCreatedAt() {
      return opptys[0].createdAt;
    },
    getUpdatedAt() {
      return opptys[0].updatedAt;
    },
    setCreatedAt(value) {
      opptys[0].createdAt = value;
    },
    setUpdatedAt(value) {
      opptys[0].updateddAt = value;
    },
    save() {
      return mockOpptyEntity;
    },
    remove() {
    },
    getSuggestions() {
      return [];
    },
  };

  const opportunitiesFunctions = [
    'getAllForSite',
    'getByStatus',
    'getByID',
    'createOpportunity',
    'patchOpportunity',
    'removeOpportunity',
  ];

  let mockOpportunityDataAccess;
  let mockOpportunity;
  let opportunitiesController;

  beforeEach(() => {
    opptys[0] = {
      id: OPPORTUNITY_ID,
      siteId: SITE_ID,
      auditId: 'audit001',
      title: 'Test Opportunity',
      description: 'This is a test opportunity.',
      runbook: 'http://runbook.url',
      guidance: { tip: 'Follow these steps.' },
      type: 'SEO',
      status: 'NEW',
      origin: 'ESS_OPS',
      tags: ['tag1', 'tag2'],
      data: {
        additionalInfo: 'info',
      },
    };

    mockOpportunity = {
      allBySiteId: sandbox.stub().resolves([mockOpptyEntity]),
      allBySiteIdAndStatus: sandbox.stub().resolves([mockOpptyEntity]),
      findById: sandbox.stub().resolves(mockOpptyEntity),
      create: sandbox.stub().resolves(mockOpptyEntity),
    };

    mockOpportunityDataAccess = {
      Opportunity: mockOpportunity,
    };

    opportunitiesController = OpportunitiesController(mockOpportunityDataAccess);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    opportunitiesFunctions.forEach((funcName) => {
      expect(opportunitiesController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(opportunitiesController).forEach((funcName) => {
      expect(opportunitiesFunctions).to.include(funcName);
    });
  });

  it('throws an error if data access is not an object', () => {
    expect(() => OpportunitiesController()).to.throw('Data access required');
  });

  it('throws an error if data access cannot be destructured to Opportunity', () => {
    expect(() => OpportunitiesController({ test: {} })).to.throw('Opportunity Collection not available');
  });

  it('gets all opportunities for a site', async () => {
    const response = await opportunitiesController.getAllForSite({ params: { siteId: SITE_ID } });
    expect(mockOpportunityDataAccess.Opportunity.allBySiteId.calledOnce).to.be.true;
    expect(response.status).to.equal(200);
    const opportunities = await response.json();
    expect(opportunities).to.be.an('array').with.lengthOf(1);
    expect(opportunities[0]).to.have.property('id', OPPORTUNITY_ID);
  });

  it('gets all opportunities for a site returns bad request if no site ID is passed', async () => {
    const response = await opportunitiesController.getAllForSite({ params: {} });
    expect(mockOpportunityDataAccess.Opportunity.allBySiteId.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets all opportunities for a site by status', async () => {
    const response = await opportunitiesController.getByStatus({ params: { siteId: SITE_ID, status: 'NEW' } });
    expect(mockOpportunityDataAccess.Opportunity.allBySiteIdAndStatus.calledOnce).to.be.true;
    expect(response.status).to.equal(200);
    const opportunities = await response.json();
    expect(opportunities).to.be.an('array').with.lengthOf(1);
    expect(opportunities[0]).to.have.property('id', OPPORTUNITY_ID);
  });

  it('gets opportunity by ID', async () => {
    const response = await opportunitiesController.getByID({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
    });
    expect(mockOpportunityDataAccess.Opportunity.findById.calledOnce).to.be.true;
    expect(response.status).to.equal(200);
    const opportunity = await response.json();
    expect(opportunity).to.have.property('id', OPPORTUNITY_ID);
  });

  it('gets all opportunities for a site by status returns bad request if no site ID is passed', async () => {
    const response = await opportunitiesController.getByStatus({ params: {} });
    expect(mockOpportunityDataAccess.Opportunity.allBySiteIdAndStatus.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets all opportunities for a site by status returns bad request if no status is passed', async () => {
    const response = await opportunitiesController.getByStatus({ params: { siteId: SITE_ID } });
    expect(mockOpportunityDataAccess.Opportunity.allBySiteIdAndStatus.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Status required');
  });

  it('gets opportunity by ID returns bad request if no site ID is passed', async () => {
    const response = await opportunitiesController.getByID({ params: {} });
    expect(mockOpportunityDataAccess.Opportunity.findById.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets opportunity by ID returns bad request if no opportunity ID is passed', async () => {
    const response = await opportunitiesController.getByID({ params: { siteId: SITE_ID } });
    expect(mockOpportunityDataAccess.Opportunity.findById.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('gets opportunity by ID returns not found if opportunity is not found', async () => {
    mockOpportunity.findById.resolves(null);
    const response = await opportunitiesController.getByID({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
    });
    expect(mockOpportunityDataAccess.Opportunity.findById.calledOnce).to.be.true;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
  });

  // TODO: Complete tests for OpportunitiesController
  it('creates an opportunity', async () => {
    const response = await opportunitiesController.createOpportunity({
      params: { siteId: SITE_ID },
      data: opptys[0],
    });
    expect(mockOpportunityDataAccess.Opportunity.create.calledOnce).to.be.true;
    expect(response.status).to.equal(201);

    const opportunity = await response.json();
    expect(opportunity).to.have.property('id', OPPORTUNITY_ID);
    expect(opportunity).to.have.property('siteId', SITE_ID);
  });

  it('updates an opportunity', async () => {
    const response = await opportunitiesController.patchOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: {
        auditId: 'Audit ID NEW',
        title: 'Test Opportunity NEW',
        description: 'This is a test opportunity NEW',
        runbook: 'http://runbook.url/new',
        guidance: { tip: 'Follow these steps. NEW' },
        type: 'SEO NEW',
        status: 'APPROVED',
        data: {
          additionalInfo: 'info NEW',
        },
        tags: ['tag1', 'tag2', 'NEW'],
      },
    });

    // Validate updated values
    expect(mockOpptyEntity.getAuditId()).to.be.equals('Audit ID NEW');
    expect(mockOpptyEntity.getStatus()).to.be.equals('APPROVED');

    expect(response.status).to.equal(200);

    const updatedOppty = await response.json();
    expect(updatedOppty).to.have.property('siteId', SITE_ID);
    expect(updatedOppty).to.have.property('id', OPPORTUNITY_ID);
    expect(updatedOppty).to.have.property('auditId', 'Audit ID NEW');
    expect(updatedOppty).to.have.property('status', 'APPROVED');
  });

  it('returns bad request when creating an opportunity if site not provided', async () => {
    // eslint-disable-next-line max-len
    const response = await opportunitiesController.createOpportunity({ params: {}, data: opptys[0] });
    expect(mockOpportunityDataAccess.Opportunity.create.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns bad request when creating an opportunity if no data is provided', async () => {
    // eslint-disable-next-line max-len
    const response = await opportunitiesController.createOpportunity({ params: { siteId: SITE_ID }, data: {} });
    expect(mockOpportunityDataAccess.Opportunity.create.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No data provided');
  });

  it('returns bad request when creating an opportunity if there is a validation error', async () => {
    mockOpportunity.create.throws(new ValidationError('Validation error'));
    const response = await opportunitiesController.createOpportunity({
      params: { siteId: SITE_ID },
      data: opptys[0],
    });
    expect(mockOpportunityDataAccess.Opportunity.create.calledOnce).to.be.true;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Validation error');
  });

  it('returns bad request when updating an opportunity if site not provided', async () => {
    // eslint-disable-next-line max-len
    const response = await opportunitiesController.patchOpportunity({ params: {}, data: opptys[0] });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns bad request when updating an opportunity if no opportunity id is provided', async () => {
    // eslint-disable-next-line max-len
    const response = await opportunitiesController.patchOpportunity({ params: { siteId: SITE_ID }, data: {} });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('returns bad request when updating an opportunity if no data is provided', async () => {
    // eslint-disable-next-line max-len
    const response = await opportunitiesController.patchOpportunity({ params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID }, data: {} });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('returns not found when updating an opportunity if opportunity is not found', async () => {
    mockOpportunity.findById.resolves(null);
    const response = await opportunitiesController.patchOpportunity({
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'APPROVED' },
    });
    expect(mockOpportunityDataAccess.Opportunity.findById.calledOnce).to.be.true;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
  });

  it('returns bad request when updating an opportunity without sending any request body', async () => {
    const response = await opportunitiesController.patchOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: {},
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('returns bad request when updating an opportunity if there is a validation error', async () => {
    mockOpptyEntity.save = async () => {
      throw new ValidationError('Validation error');
    };
    const response = await opportunitiesController.patchOpportunity({
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'APPROVED' },
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Validation error');
  });

  it('returns bad request when updating an opportunity if no updates are passed', async () => {
    const response = await opportunitiesController.patchOpportunity({
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'NEW' },
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('removes an opportunity', async () => {
    const response = await opportunitiesController.removeOpportunity({
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
    });
    expect(response.status).to.equal(204);
  });

  it('returns bad request when removing an opportunity if site not provided', async () => {
    const response = await opportunitiesController.removeOpportunity({ params: {}, data: {} });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns bad request when removing an opportunity if opportunity id not provided', async () => {
    const response = await opportunitiesController.removeOpportunity({
      params: { siteId: SITE_ID },
      data: {},
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('returns not found when removing an opportunity if opportunity is not found', async () => {
    mockOpportunity.findById.resolves(null);
    const response = await opportunitiesController.removeOpportunity({
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: {},
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
  });

  it('returns 500 when removing an opportunity if there is a data access layer error', async () => {
    const mockOpptyEntityError = mockOpptyEntity;
    mockOpptyEntityError.remove = () => {
      throw new Error('internal error not exposed to the client');
    };
    const response = await opportunitiesController.removeOpportunity({
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: {},
    });
    expect(response.status).to.equal(500);
    const error = await response.json();
    expect(error).to.have.property('message', 'Error removing opportunity');
  });
});
