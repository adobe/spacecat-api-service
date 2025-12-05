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

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { ValidationError, Site } from '@adobe/spacecat-shared-data-access';
import OpportunitiesController from '../../src/controllers/opportunities.js';

use(chaiAsPromised);

describe('Opportunities Controller', () => {
  const sandbox = sinon.createSandbox();

  const OPPORTUNITY_ID = '3f1c3ab1-9ad0-4231-ac87-8159acf52cb6';
  const SITE_ID = 'b9395f92-1c2f-4904-a8f0-e45f30098f9e';

  // Add common auth attributes
  const defaultAuthAttributes = {
    attributes: {
      authInfo: new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'admin' }])
        .withProfile({ is_admin: true, email: 'test@test.com' })
        .withAuthenticated(true),
    },
  };

  const apikeyAuthAttributes = {
    attributes: {
      authInfo: new AuthInfo()
        .withType('apikey')
        .withScopes([{ name: 'admin' }])
        .withProfile({ name: 'api-key' }),
    },
  };

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
    getUpdatedBy() {
      return opptys[0].updatedBy;
    },
    setUpdatedBy(value) {
      opptys[0].updatedBy = value;
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
    'getTopPaidOpportunities',
  ];

  let mockOpportunityDataAccess;
  let mockOpportunity;
  let opportunitiesController;
  let mockSite;
  let mockContext;

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

    // Add mock logger
    const mockLogger = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
    };

    mockOpportunity = {
      allBySiteId: sandbox.stub().resolves([mockOpptyEntity]),
      allBySiteIdAndStatus: sandbox.stub().resolves([mockOpptyEntity]),
      findById: sandbox.stub().resolves(mockOpptyEntity),
      create: sandbox.stub().resolves(mockOpptyEntity),
    };

    mockSite = {
      findById: sandbox.stub().resolves({
        id: SITE_ID,
      }),
    };

    mockOpportunityDataAccess = {
      Opportunity: mockOpportunity,
      Site: mockSite,
    };

    mockContext = {
      dataAccess: mockOpportunityDataAccess,
      log: mockLogger,
      pathInfo: {
        headers: { 'x-product': 'abcd' },
      },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    };

    opportunitiesController = OpportunitiesController(mockContext);
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

  it('throws an error if context is not an object', () => {
    expect(() => OpportunitiesController()).to.throw('Context required');
  });

  it('throws an error if data access is not an object', () => {
    expect(() => OpportunitiesController({ dataAccess: {} })).to.throw('Data access required');
  });

  it('throws an error if data access cannot be destructured to Opportunity', () => {
    expect(() => OpportunitiesController({ dataAccess: { Site: {} } })).to.throw('Opportunity Collection not available');
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
  it('creates an opportunity with hardcoded tags merged with existing tags', async () => {
    // Reset the stub to track calls
    mockOpportunity.create.resetHistory();

    const response = await opportunitiesController.createOpportunity({
      params: { siteId: SITE_ID },
      data: opptys[0], // This has tags: ['tag1', 'tag2']
    });
    expect(mockOpportunityDataAccess.Opportunity.create.calledOnce).to.be.true;
    expect(response.status).to.equal(201);

    const opportunity = await response.json();
    expect(opportunity).to.have.property('id', OPPORTUNITY_ID);
    expect(opportunity).to.have.property('siteId', SITE_ID);

    // Verify that hardcoded tags were added to the create call
    const createCallData = mockOpportunity.create.getCall(0).args[0];
    expect(createCallData).to.have.property('tags').that.includes('automated');
    expect(createCallData).to.have.property('tags').that.includes('spacecat');
    expect(createCallData).to.have.property('tags').that.includes('tag1');
    expect(createCallData).to.have.property('tags').that.includes('tag2');
  });

  it('creates an opportunity with hardcoded tags when no tags exist', async () => {
    // Reset the stub to track calls
    mockOpportunity.create.resetHistory();

    // Create a copy of the opportunity data without tags
    const opptyWithoutTags = { ...opptys[0] };
    delete opptyWithoutTags.tags;

    const response = await opportunitiesController.createOpportunity({
      params: { siteId: SITE_ID },
      data: opptyWithoutTags,
    });
    expect(mockOpportunityDataAccess.Opportunity.create.calledOnce).to.be.true;
    expect(response.status).to.equal(201);

    // Verify that only hardcoded tags were added to the create call
    const createCallData = mockOpportunity.create.getCall(0).args[0];
    expect(createCallData).to.have.property('tags').that.includes('automated');
    expect(createCallData).to.have.property('tags').that.includes('spacecat');
    expect(createCallData.tags).to.have.lengthOf(2); // Only the hardcoded tags
  });

  it('updates an opportunity and preserves hardcoded tags', async () => {
    // Create a spy for the setTags method
    const setTagsSpy = sandbox.spy(mockOpptyEntity, 'setTags');

    const response = await opportunitiesController.patchOpportunity({
      ...defaultAuthAttributes,
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
        updatedBy: 'test@test.com',
      },
    });

    // Verify that setTags was called
    expect(setTagsSpy.called).to.be.true;

    // Verify the tags argument contains the expected values
    const tagsArgument = setTagsSpy.firstCall.args[0];
    expect(tagsArgument).to.include('automated');
    expect(tagsArgument).to.include('spacecat');
    expect(tagsArgument).to.include('tag1');
    expect(tagsArgument).to.include('tag2');
    expect(tagsArgument).to.include('NEW');

    setTagsSpy.restore();

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

  it('updates an opportunity with api key', async () => {
    const response = await opportunitiesController.patchOpportunity({
      ...apikeyAuthAttributes,
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
    expect(updatedOppty).to.have.property('updatedBy', 'system');
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
    const response = await opportunitiesController.patchOpportunity({
      ...defaultAuthAttributes,
      params: {},
      data: opptys[0],
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns bad request when updating an opportunity if no opportunity id is provided', async () => {
    const response = await opportunitiesController.patchOpportunity({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID },
      data: {},
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('returns bad request when updating an opportunity if no data is provided', async () => {
    const response = await opportunitiesController.patchOpportunity({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: {},
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('returns not found when updating an opportunity if opportunity is not found', async () => {
    mockOpportunity.findById.resolves(null);
    const response = await opportunitiesController.patchOpportunity({
      ...defaultAuthAttributes,
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
      ...defaultAuthAttributes,
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
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'APPROVED' },
      log: mockContext.log,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Validation error');
  });

  it('returns bad request when updating an opportunity if no updates are passed', async () => {
    const response = await opportunitiesController.patchOpportunity({
      ...defaultAuthAttributes,
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

  describe('Access Control', () => {
    it('returns not found when site does not exist', async () => {
      // Mock Site.findById to return null
      mockSite.findById.resolves(null);

      const response = await opportunitiesController.getAllForSite({
        params: {
          siteId: SITE_ID,
        },
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site not found');
      expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
    });

    it('returns forbidden when user does not have access to the organization', async () => {
      // Mock Site with Organization
      const mockOrg = {
        getImsOrgId: () => 'test-org-id',
      };

      const mockSiteWithOrg = {
        id: SITE_ID,
        getOrganization: async () => mockOrg,
      };
      Object.setPrototypeOf(mockSiteWithOrg, Site.prototype);
      mockSite.findById.resolves(mockSiteWithOrg);

      // Create context with non-admin user without org access
      const restrictedAuthInfo = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'user' }])
        .withProfile({ is_admin: false })
        .withAuthenticated(true);

      // Set organizations claim directly
      restrictedAuthInfo.claims = {
        organizations: [],
      };

      const restrictedContext = {
        dataAccess: mockOpportunityDataAccess,
        pathInfo: {
          headers: { 'x-product': 'abcd' },
        },
        attributes: {
          authInfo: restrictedAuthInfo,
        },
      };

      const restrictedController = OpportunitiesController(restrictedContext);
      const response = await restrictedController.getAllForSite({
        params: {
          siteId: SITE_ID,
        },
      });

      expect(response.status).to.equal(403);
      const error = await response.json();
      expect(error).to.have.property('message', 'Only users belonging to the organization of the site can view its opportunities');
      expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
    });

    describe('getByStatus access control', () => {
      it('returns not found when site does not exist for getByStatus', async () => {
        // Mock Site.findById to return null
        mockSite.findById.resolves(null);

        const response = await opportunitiesController.getByStatus({
          params: {
            siteId: SITE_ID,
            status: 'NEW',
          },
        });

        expect(response.status).to.equal(404);
        const error = await response.json();
        expect(error).to.have.property('message', 'Site not found');
        expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
      });

      it('returns forbidden when user does not have access to the organization for getByStatus', async () => {
        // Mock Site with Organization
        const mockOrg = {
          getImsOrgId: () => 'test-org-id',
        };

        const mockSiteWithOrg = {
          id: SITE_ID,
          getOrganization: async () => mockOrg,
        };
        Object.setPrototypeOf(mockSiteWithOrg, Site.prototype);
        mockSite.findById.resolves(mockSiteWithOrg);

        // Create context with non-admin user without org access
        const restrictedAuthInfo = new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'user' }])
          .withProfile({ is_admin: false })
          .withAuthenticated(true);

        // Set organizations claim directly
        restrictedAuthInfo.claims = {
          organizations: [],
        };

        const restrictedContext = {
          dataAccess: mockOpportunityDataAccess,
          pathInfo: {
            headers: { 'x-product': 'abcd' },
          },
          attributes: {
            authInfo: restrictedAuthInfo,
          },
        };

        const restrictedController = OpportunitiesController(restrictedContext);
        const response = await restrictedController.getByStatus({
          params: {
            siteId: SITE_ID,
            status: 'NEW',
          },
        });

        expect(response.status).to.equal(403);
        const error = await response.json();
        expect(error).to.have.property('message', 'Only users belonging to the organization of the site can view its opportunities');
        expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
      });
    });

    describe('getByID access control', () => {
      it('returns not found when site does not exist for getByID', async () => {
        // Mock Site.findById to return null
        mockSite.findById.resolves(null);

        const response = await opportunitiesController.getByID({
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
        });

        expect(response.status).to.equal(404);
        const error = await response.json();
        expect(error).to.have.property('message', 'Site not found');
        expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
      });

      it('returns forbidden when user does not have access to the organization for getByID', async () => {
        // Mock Site with Organization
        const mockOrg = {
          getImsOrgId: () => 'test-org-id',
        };

        const mockSiteWithOrg = {
          id: SITE_ID,
          getOrganization: async () => mockOrg,
        };
        Object.setPrototypeOf(mockSiteWithOrg, Site.prototype);
        mockSite.findById.resolves(mockSiteWithOrg);

        // Create context with non-admin user without org access
        const restrictedAuthInfo = new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'user' }])
          .withProfile({ is_admin: false })
          .withAuthenticated(true);

        // Set organizations claim directly
        restrictedAuthInfo.claims = {
          organizations: [],
        };

        const restrictedContext = {
          dataAccess: mockOpportunityDataAccess,
          pathInfo: {
            headers: { 'x-product': 'abcd' },
          },
          attributes: {
            authInfo: restrictedAuthInfo,
          },
        };

        const restrictedController = OpportunitiesController(restrictedContext);
        const response = await restrictedController.getByID({
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
        });

        expect(response.status).to.equal(403);
        const error = await response.json();
        expect(error).to.have.property('message', 'Only users belonging to the organization of the site can view its opportunities');
        expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
      });
    });

    describe('createOpportunity access control', () => {
      it('returns not found when site does not exist for createOpportunity', async () => {
        // Mock Site.findById to return null
        mockSite.findById.resolves(null);

        const response = await opportunitiesController.createOpportunity({
          params: {
            siteId: SITE_ID,
          },
          data: {
            title: 'Test Opportunity',
            description: 'Test Description',
          },
        });

        expect(response.status).to.equal(404);
        const error = await response.json();
        expect(error).to.have.property('message', 'Site not found');
        expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
      });

      it('returns forbidden when user does not have access to the organization for createOpportunity', async () => {
        // Mock Site with Organization
        const mockOrg = {
          getImsOrgId: () => 'test-org-id',
        };

        const mockSiteWithOrg = {
          id: SITE_ID,
          getOrganization: async () => mockOrg,
        };
        Object.setPrototypeOf(mockSiteWithOrg, Site.prototype);
        mockSite.findById.resolves(mockSiteWithOrg);

        // Create context with non-admin user without org access
        const restrictedAuthInfo = new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'user' }])
          .withProfile({ is_admin: false })
          .withAuthenticated(true);

        // Set organizations claim directly
        restrictedAuthInfo.claims = {
          organizations: [],
        };

        const restrictedContext = {
          dataAccess: mockOpportunityDataAccess,
          pathInfo: {
            headers: { 'x-product': 'abcd' },
          },
          attributes: {
            authInfo: restrictedAuthInfo,
          },
        };

        const restrictedController = OpportunitiesController(restrictedContext);
        const response = await restrictedController.createOpportunity({
          params: {
            siteId: SITE_ID,
          },
          data: {
            title: 'Test Opportunity',
            description: 'Test Description',
          },
        });

        expect(response.status).to.equal(403);
        const error = await response.json();
        expect(error).to.have.property('message', 'Only users belonging to the organization of the site can create its opportunities');
        expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
      });
    });

    describe('patchOpportunity access control', () => {
      it('returns not found when site does not exist for patchOpportunity', async () => {
        // Mock Site.findById to return null
        mockSite.findById.resolves(null);

        const response = await opportunitiesController.patchOpportunity({
          ...defaultAuthAttributes,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            title: 'Updated Test Opportunity',
            description: 'Updated Test Description',
          },
        });

        expect(response.status).to.equal(404);
        const error = await response.json();
        expect(error).to.have.property('message', 'Site not found');
        expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
      });

      it('returns forbidden when user does not have access to the organization for patchOpportunity', async () => {
        // Mock Site with Organization
        const mockOrg = {
          getImsOrgId: () => 'test-org-id',
        };

        const mockSiteWithOrg = {
          id: SITE_ID,
          getOrganization: async () => mockOrg,
        };
        Object.setPrototypeOf(mockSiteWithOrg, Site.prototype);
        mockSite.findById.resolves(mockSiteWithOrg);

        // Create context with non-admin user without org access
        const restrictedAuthInfo = new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'user' }])
          .withProfile({ is_admin: false })
          .withAuthenticated(true);

        // Set organizations claim directly
        restrictedAuthInfo.claims = {
          organizations: [],
        };

        const restrictedContext = {
          dataAccess: mockOpportunityDataAccess,
          pathInfo: {
            headers: { 'x-product': 'abcd' },
          },
          attributes: {
            authInfo: restrictedAuthInfo,
          },
          log: defaultAuthAttributes.log,
        };

        const restrictedController = OpportunitiesController(restrictedContext);
        const response = await restrictedController.patchOpportunity({
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            title: 'Updated Test Opportunity',
            description: 'Updated Test Description',
          },
          ...defaultAuthAttributes,
        });

        expect(response.status).to.equal(403);
        const error = await response.json();
        expect(error).to.have.property('message', 'Only users belonging to the organization of the site can edit its opportunities');
        expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
      });
    });

    describe('removeOpportunity access control', () => {
      it('returns not found when site does not exist for removeOpportunity', async () => {
        // Mock Site.findById to return null
        mockSite.findById.resolves(null);

        const response = await opportunitiesController.removeOpportunity({
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
        });

        expect(response.status).to.equal(404);
        const error = await response.json();
        expect(error).to.have.property('message', 'Site not found');
        expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
      });

      it('returns forbidden when user does not have access to the organization for removeOpportunity', async () => {
        // Mock Site with Organization
        const mockOrg = {
          getImsOrgId: () => 'test-org-id',
        };

        const mockSiteWithOrg = {
          id: SITE_ID,
          getOrganization: async () => mockOrg,
        };
        Object.setPrototypeOf(mockSiteWithOrg, Site.prototype);
        mockSite.findById.resolves(mockSiteWithOrg);

        // Create context with non-admin user without org access
        const restrictedAuthInfo = new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'user' }])
          .withProfile({ is_admin: false })
          .withAuthenticated(true);

        // Set organizations claim directly
        restrictedAuthInfo.claims = {
          organizations: [],
        };

        const restrictedContext = {
          dataAccess: mockOpportunityDataAccess,
          pathInfo: {
            headers: { 'x-product': 'abcd' },
          },
          attributes: {
            authInfo: restrictedAuthInfo,
          },
        };

        const restrictedController = OpportunitiesController(restrictedContext);
        const response = await restrictedController.removeOpportunity({
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
        });

        expect(response.status).to.equal(403);
        const error = await response.json();
        expect(error).to.have.property('message', 'Only users belonging to the organization of the site can remove its opportunities');
        expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
      });
    });
  });

  describe('getTopPaidOpportunities', () => {
    let mockSuggestion;

    beforeEach(() => {
      mockSuggestion = {
        allByOpportunityId: sandbox.stub(),
      };

      mockOpportunityDataAccess.Suggestion = mockSuggestion;
      opportunitiesController = OpportunitiesController(mockContext);
    });

    it('returns top paid opportunities with NEW and IN_PROGRESS status', async () => {
      const paidOppty1 = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Paid Media Opportunity',
        getDescription: () => 'Description for paid media',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 5000 }),
      };

      const paidOppty2 = {
        getId: () => 'oppty-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Traffic Acquisition Opportunity',
        getDescription: () => 'Description for traffic acquisition',
        getType: () => 'content-optimization',
        getStatus: () => 'IN_PROGRESS',
        getTags: () => ['traffic acquisition'],
        getData: () => ({ projectedTrafficLost: 2000, projectedTrafficValue: 8000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([paidOppty1])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([paidOppty2]);

      const mockSuggestions = [
        {
          getData: () => ({ url_from: 'https://example.com/page1' }),
          getRank: () => 100,
        },
      ];

      mockSuggestion.allByOpportunityId.resolves(mockSuggestions);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(2);
      // Should be sorted by projectedTrafficValue descending
      expect(opportunities[0].projectedTrafficValue).to.equal(8000);
      expect(opportunities[1].projectedTrafficValue).to.equal(5000);
      expect(opportunities[0]).to.have.property('status', 'IN_PROGRESS');
      expect(opportunities[1]).to.have.property('status', 'NEW');
    });

    it('filters out opportunities without description', async () => {
      const withDescription = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Valid Opportunity',
        getDescription: () => 'Has description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 5000 }),
      };

      const withoutDescription = {
        getId: () => 'oppty-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Invalid Opportunity',
        getDescription: () => '',
        getType: () => 'content-optimization',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 2000, projectedTrafficValue: 8000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([withDescription, withoutDescription])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityId.resolves([]);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].name).to.equal('Valid Opportunity');
    });

    it('filters out opportunities with "report" in title', async () => {
      const validOppty = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Valid Opportunity',
        getDescription: () => 'Has description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 5000 }),
      };

      const reportOppty = {
        getId: () => 'oppty-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Monthly Report Opportunity',
        getDescription: () => 'Has description',
        getType: () => 'content-optimization',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 2000, projectedTrafficValue: 8000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([validOppty, reportOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityId.resolves([]);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].name).to.equal('Valid Opportunity');
    });

    it('filters out opportunities with 0 projected traffic value', async () => {
      const validOppty = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Valid Opportunity',
        getDescription: () => 'Has description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 5000 }),
      };

      const zeroValueOppty = {
        getId: () => 'oppty-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Zero Value Opportunity',
        getDescription: () => 'Has description',
        getType: () => 'content-optimization',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 0, projectedTrafficValue: 0 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([validOppty, zeroValueOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityId.resolves([]);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].name).to.equal('Valid Opportunity');
      expect(opportunities[0].projectedTrafficValue).to.equal(5000);
    });

    it('filters by target tags (case-insensitive)', async () => {
      const paidMediaOppty = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Paid Media Opportunity',
        getDescription: () => 'Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['Paid Media'], // Different case
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 5000 }),
      };

      const engagementOppty = {
        getId: () => 'oppty-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Engagement Opportunity',
        getDescription: () => 'Description',
        getType: () => 'content-optimization',
        getStatus: () => 'NEW',
        getTags: () => ['ENGAGEMENT'], // Different case
        getData: () => ({ projectedTrafficLost: 2000, projectedTrafficValue: 8000 }),
      };

      const otherOppty = {
        getId: () => 'oppty-3',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Other Opportunity',
        getDescription: () => 'Description',
        getType: () => 'other',
        getStatus: () => 'NEW',
        getTags: () => ['other-tag'],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([paidMediaOppty, engagementOppty, otherOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityId.resolves([]);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(2);
      expect(opportunities.map((o) => o.name)).to.include('Paid Media Opportunity');
      expect(opportunities.map((o) => o.name)).to.include('Engagement Opportunity');
      expect(opportunities.map((o) => o.name)).to.not.include('Other Opportunity');
    });

    it('limits URLs to 10', async () => {
      const oppty = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Opportunity with many URLs',
        getDescription: () => 'Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 5000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([oppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      // Create 15 suggestions with different URLs
      const manySuggestions = Array.from({ length: 15 }, (_, i) => ({
        getData: () => ({ url_from: `https://example.com/page${i + 1}` }),
        getRank: () => 100,
      }));

      mockSuggestion.allByOpportunityId.resolves(manySuggestions);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].urls).to.be.an('array').with.lengthOf(10);
    });

    it('returns 400 for invalid site ID', async () => {
      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: 'invalid-uuid' },
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site ID required');
    });

    it('returns 404 when site does not exist', async () => {
      mockSite.findById.resolves(null);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site not found');
    });

    it('includes type, description, status, system_type, and system_description in response', async () => {
      const oppty = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'System description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 5000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([oppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityId.resolves([]);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0]).to.have.property('type', null);
      expect(opportunities[0]).to.have.property('description', null);
      expect(opportunities[0]).to.have.property('status', 'NEW');
      expect(opportunities[0]).to.have.property('system_type', 'broken-backlinks');
      expect(opportunities[0]).to.have.property('system_description', 'System description');
    });

    it('aggregates page views from traffic_domain field', async () => {
      const oppty = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 5000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([oppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const suggestionsWithTrafficDomain = [
        {
          getData: () => ({ url_from: 'https://example.com/page1', traffic_domain: 500 }),
          getRank: () => 100,
        },
        {
          getData: () => ({ url_from: 'https://example.com/page2', traffic_domain: 300 }),
          getRank: () => 50,
        },
      ];

      mockSuggestion.allByOpportunityId.resolves(suggestionsWithTrafficDomain);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      // Should aggregate: rank (100 + 50) + traffic_domain (500 + 300) = 950
      expect(opportunities[0].pageViews).to.equal(950);
    });

    it('aggregates page views from trafficDomain field', async () => {
      const oppty = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 5000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([oppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const suggestionsWithTrafficDomain = [
        {
          getData: () => ({ url_from: 'https://example.com/page1', trafficDomain: 400 }),
          getRank: () => 100,
        },
        {
          getData: () => ({ url_from: 'https://example.com/page2', trafficDomain: 200 }),
          getRank: () => 50,
        },
      ];

      mockSuggestion.allByOpportunityId.resolves(suggestionsWithTrafficDomain);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      // Should aggregate: rank (100 + 50) + trafficDomain (400 + 200) = 750
      expect(opportunities[0].pageViews).to.equal(750);
    });

    it('returns 403 when user does not have access to site', async () => {
      // Mock Site with Organization
      const mockOrg = {
        getImsOrgId: () => 'test-org-id',
      };

      const mockSiteWithOrg = {
        id: SITE_ID,
        getOrganization: async () => mockOrg,
      };
      Object.setPrototypeOf(mockSiteWithOrg, Site.prototype);
      mockSite.findById.resolves(mockSiteWithOrg);

      // Create a restricted auth context
      const restrictedAuthInfo = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'user' }])
        .withProfile({ is_admin: false })
        .withAuthenticated(true);

      // Set organizations claim to empty array (no access)
      restrictedAuthInfo.claims = {
        organizations: [],
      };

      const restrictedContext = {
        dataAccess: mockOpportunityDataAccess,
        log: mockContext.log,
        pathInfo: {
          headers: { 'x-product': 'abcd' },
        },
        attributes: {
          authInfo: restrictedAuthInfo,
        },
      };

      const restrictedController = OpportunitiesController(restrictedContext);

      const response = await restrictedController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(403);
      const error = await response.json();
      expect(error).to.have.property('message', 'Only users belonging to the organization of the site can view its opportunities');
      expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
    });

    it('handles opportunities with null tags and title', async () => {
      const opptyWithNulls = {
        getId: () => 'oppty-null-1',
        getTitle: () => null,
        getDescription: () => 'Valid description',
        getStatus: () => 'NEW',
        getType: () => 'paid-media',
        getTags: () => null,
        getData: () => ({ projectedTrafficLost: 100, projectedTrafficValue: 500 }),
      };

      mockOpportunity.allBySiteIdAndStatus.withArgs(SITE_ID, 'NEW').resolves([opptyWithNulls]);
      mockOpportunity.allBySiteIdAndStatus.withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);
      mockSuggestion.allByOpportunityId.resolves([]);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      // Should be filtered out because null tags means no matching tags
      expect(opportunities).to.be.an('array').with.lengthOf(0);
    });

    it('handles suggestions with all URL field variations', async () => {
      const oppty = {
        getId: () => 'oppty-urls-1',
        getTitle: () => 'URL Test Opportunity',
        getDescription: () => 'Testing all URL fields',
        getStatus: () => 'NEW',
        getType: () => 'broken-backlinks',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 100, projectedTrafficValue: 500 }),
      };

      const suggestionsWithAllUrlFields = [
        {
          getId: () => 'sugg-1',
          getRank: () => 0,
          getData: () => ({ url_from: 'https://example.com/from1' }),
        },
        {
          getId: () => 'sugg-2',
          getRank: () => 0,
          getData: () => ({ url_to: 'https://example.com/to1' }),
        },
        {
          getId: () => 'sugg-3',
          getRank: () => 0,
          getData: () => ({ urlFrom: 'https://example.com/from2' }),
        },
        {
          getId: () => 'sugg-4',
          getRank: () => 0,
          getData: () => ({ urlTo: 'https://example.com/to2' }),
        },
        {
          getId: () => 'sugg-5',
          getRank: () => 0,
          getData: () => ({ url: 'https://example.com/url1' }),
        },
      ];

      mockOpportunity.allBySiteIdAndStatus.withArgs(SITE_ID, 'NEW').resolves([oppty]);
      mockOpportunity.allBySiteIdAndStatus.withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);
      mockSuggestion.allByOpportunityId.resolves(suggestionsWithAllUrlFields);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].urls).to.be.an('array').with.lengthOf(5);
      expect(opportunities[0].urls).to.include('https://example.com/from1');
      expect(opportunities[0].urls).to.include('https://example.com/to1');
      expect(opportunities[0].urls).to.include('https://example.com/from2');
      expect(opportunities[0].urls).to.include('https://example.com/to2');
      expect(opportunities[0].urls).to.include('https://example.com/url1');
    });

    it('handles opportunity with null type and description', async () => {
      const opptyWithNullTypeDesc = {
        getId: () => 'oppty-null-type-1',
        getTitle: () => 'Null Type Test',
        getDescription: () => null,
        getStatus: () => 'NEW',
        getType: () => null,
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 100, projectedTrafficValue: 500 }),
      };

      mockOpportunity.allBySiteIdAndStatus.withArgs(SITE_ID, 'NEW').resolves([opptyWithNullTypeDesc]);
      mockOpportunity.allBySiteIdAndStatus.withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);
      mockSuggestion.allByOpportunityId.resolves([]);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      // Should be filtered out because description is null
      expect(opportunities).to.be.an('array').with.lengthOf(0);
    });

    it('handles opportunity with null getData', async () => {
      const opptyWithNullData = {
        getId: () => 'oppty-null-data-1',
        getTitle: () => 'Null Data Test',
        getDescription: () => 'Valid description',
        getStatus: () => 'NEW',
        getType: () => 'paid-media',
        getTags: () => ['paid media'],
        getData: () => null,
      };

      mockOpportunity.allBySiteIdAndStatus.withArgs(SITE_ID, 'NEW').resolves([opptyWithNullData]);
      mockOpportunity.allBySiteIdAndStatus.withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);
      mockSuggestion.allByOpportunityId.resolves([]);

      const response = await opportunitiesController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      // Should be filtered out because projectedTrafficValue is 0
      expect(opportunities).to.be.an('array').with.lengthOf(0);
    });
  });
});
