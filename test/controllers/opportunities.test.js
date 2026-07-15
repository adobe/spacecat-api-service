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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { ValidationError } from '@adobe/spacecat-shared-data-access';
import esmock from 'esmock';
import OpportunitiesController from '../../src/controllers/opportunities.js';

use(chaiAsPromised);
use(sinonChai);

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
    getLastAuditedAt() {
      return opptys[0].lastAuditedAt;
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
    'patchPrerenderValidation',
    'runPrerenderValidation',
    'removeOpportunity',
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

    // Reset the shared entity's save() each test — some tests reassign it to throw
    // and do not restore it, which would otherwise leak into subsequent tests.
    mockOpptyEntity.save = () => mockOpptyEntity;

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

  it('returns 400 for malformed locale on getAllForSite', async () => {
    const response = await opportunitiesController.getAllForSite({
      params: { siteId: SITE_ID },
      data: { locale: 'INVALID' },
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Invalid locale format');
  });

  it('returns 400 for malformed locale on getByStatus', async () => {
    const response = await opportunitiesController.getByStatus({
      params: { siteId: SITE_ID, status: 'NEW' },
      data: { locale: 'fr-FR' },
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Invalid locale format');
  });

  it('returns 400 for malformed locale on getByID', async () => {
    const response = await opportunitiesController.getByID({
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { locale: '123' },
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Invalid locale format');
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

  it('gets opportunity by ID invokes grant suggestions handler when Token is in dataAccess', async () => {
    const mockToken = {
      findBySiteIdAndTokenType: sandbox.stub().resolves({ getRemaining: () => 1 }),
    };
    const mockConfig = {
      findLatest: sandbox.stub().resolves({
        isHandlerEnabledForSite: sandbox.stub().returns(true),
      }),
    };
    const ctxWithToken = {
      ...mockContext,
      dataAccess: {
        ...mockOpportunityDataAccess,
        SuggestionGrant: {},
        Token: mockToken,
        Configuration: mockConfig,
      },
    };
    const controllerWithToken = OpportunitiesController(ctxWithToken);
    const previousType = opptys[0].type;
    opptys[0].type = 'cwv';
    try {
      const response = await controllerWithToken.getByID({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      });
      expect(response.status).to.equal(200);
      if (mockToken.findBySiteIdAndTokenType.called) {
        expect(mockToken.findBySiteIdAndTokenType).to.have.been.calledOnceWith(
          SITE_ID,
          'monthly_suggestion_cwv',
        );
      }
    } finally {
      opptys[0].type = previousType;
    }
  });

  it('getByID catches grant suggestions handler errors gracefully', async () => {
    const mockSuggestion = {
      allByOpportunityIdAndStatus: sandbox.stub()
        .rejects(new Error('db failure')),
    };
    const mockSuggestionGrant = {};
    const mockToken = {
      findBySiteIdAndTokenType: sandbox.stub(),
    };
    const mockConfig = {
      findLatest: sandbox.stub().resolves({
        isHandlerEnabledForSite: sandbox.stub().returns(true),
      }),
    };
    const mockSiteWithOrg = {
      findById: sandbox.stub().resolves({
        getId: () => SITE_ID,
        getOrganizationId: () => 'org-123',
      }),
    };
    const mockEntitlement = {
      findByOrganizationIdAndProductCode: sandbox.stub().resolves({
        getTier: () => 'PLG',
      }),
    };
    const ctxWithToken = {
      ...mockContext,
      dataAccess: {
        ...mockOpportunityDataAccess,
        Site: mockSiteWithOrg,
        Suggestion: mockSuggestion,
        SuggestionGrant: mockSuggestionGrant,
        Token: mockToken,
        Configuration: mockConfig,
        Entitlement: mockEntitlement,
      },
    };
    const controllerWithToken = OpportunitiesController(ctxWithToken);
    const previousType = opptys[0].type;
    opptys[0].type = 'cwv';
    try {
      const response = await controllerWithToken.getByID({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        pathInfo: { headers: { 'x-client-type': 'sites-optimizer-ui' } },
      });
      expect(response.status).to.equal(200);
      expect(mockContext.log.warn).to.have.been.calledOnce;
    } finally {
      opptys[0].type = previousType;
    }
  });

  it('getByID catches grant suggestions handler errors gracefully when error has no message', async () => {
    const mockSuggestion = {
      allByOpportunityIdAndStatus: sandbox.stub()
        // eslint-disable-next-line prefer-promise-reject-errors
        .callsFake(() => Promise.reject(null)),
    };
    const mockToken = {
      findBySiteIdAndTokenType: sandbox.stub(),
    };
    const mockSiteEntity = {
      getId: () => SITE_ID,
      getOrganizationId: () => 'org-123',
    };
    const mockConfig = {
      findLatest: sandbox.stub().resolves({
        isHandlerEnabledForSite: sandbox.stub().returns(true),
      }),
    };
    const mockEntitlement = {
      findByOrganizationIdAndProductCode: sandbox.stub().resolves({
        getTier: () => 'PLG',
      }),
    };
    const ctxWithToken = {
      ...mockContext,
      dataAccess: {
        ...mockOpportunityDataAccess,
        Site: { findById: sandbox.stub().resolves(mockSiteEntity) },
        Suggestion: mockSuggestion,
        SuggestionGrant: {},
        Token: mockToken,
        Configuration: mockConfig,
        Entitlement: mockEntitlement,
      },
    };
    const controllerWithToken = OpportunitiesController(ctxWithToken);
    const previousType = opptys[0].type;
    opptys[0].type = 'cwv';
    try {
      const response = await controllerWithToken.getByID({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        pathInfo: { headers: { 'x-client-type': 'sites-optimizer-ui' } },
      });
      expect(response.status).to.equal(200);
      expect(mockContext.log.warn).to.have.been.calledOnceWith(
        'Grant suggestions handler failed',
        null,
      );
    } finally {
      opptys[0].type = previousType;
    }
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

  it('merges prerender-validation status without clobbering other data fields', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress' },
    });

    expect(response.status).to.equal(200);
    // other data fields preserved
    expect(mockOpptyEntity.getData().additionalInfo).to.equal('info');
    expect(mockOpptyEntity.getData().prerenderValidation).to.deep.equal({ status: 'in_progress', reason: null });
    const updated = await response.json();
    expect(updated).to.have.property('id', OPPORTUNITY_ID);
    expect(updated).to.have.property('updatedBy', 'test@test.com');
  });

  it('sets prerender-validation when the opportunity has no existing data', async () => {
    opptys[0].data = undefined;
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress' },
    });

    expect(response.status).to.equal(200);
    expect(mockOpptyEntity.getData()).to.deep.equal({ prerenderValidation: { status: 'in_progress', reason: null } });
  });

  it('sets startedAt and completedAt when provided and merges with existing prerenderValidation', async () => {
    opptys[0].data = {
      additionalInfo: 'info',
      prerenderValidation: { status: 'in_progress', startedAt: '2026-07-03T10:00:00.000Z', completedAt: null },
    };
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'completed_success', completedAt: '2026-07-03T11:40:00.000Z' },
    });

    expect(response.status).to.equal(200);
    expect(mockOpptyEntity.getData().prerenderValidation).to.deep.equal({
      status: 'completed_success',
      startedAt: '2026-07-03T10:00:00.000Z',
      completedAt: '2026-07-03T11:40:00.000Z',
      reason: null,
    });
  });

  it('sets startedAt when provided', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress', startedAt: '2026-07-03T10:00:00.000Z', completedAt: null },
    });

    expect(response.status).to.equal(200);
    expect(mockOpptyEntity.getData().prerenderValidation).to.deep.equal({
      status: 'in_progress',
      startedAt: '2026-07-03T10:00:00.000Z',
      completedAt: null,
      reason: null,
    });
  });

  it('sets reason when provided (e.g. bot-block)', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'completed_fail', completedAt: '2026-07-03T11:40:00.000Z', reason: 'waf_block_homepage:cloudflare' },
    });

    expect(response.status).to.equal(200);
    expect(mockOpptyEntity.getData().prerenderValidation).to.deep.equal({
      status: 'completed_fail',
      completedAt: '2026-07-03T11:40:00.000Z',
      reason: 'waf_block_homepage:cloudflare',
    });
  });

  it('clears a stale reason from a previous failed run when the new run succeeds without one', async () => {
    opptys[0].data = {
      additionalInfo: 'info',
      prerenderValidation: {
        status: 'completed_fail', completedAt: '2026-07-03T09:00:00.000Z', reason: 'waf_block_homepage:cloudflare',
      },
    };
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'completed_success', completedAt: '2026-07-03T11:40:00.000Z' },
    });

    expect(response.status).to.equal(200);
    expect(mockOpptyEntity.getData().prerenderValidation).to.deep.equal({
      status: 'completed_success',
      completedAt: '2026-07-03T11:40:00.000Z',
      reason: null,
    });
  });

  it('defaults updatedBy to system when the profile has no email (api key)', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...apikeyAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'error' },
    });

    expect(response.status).to.equal(200);
    const updated = await response.json();
    expect(updated).to.have.property('updatedBy', 'system');
  });

  it('returns bad request for prerender-validation if site id is missing', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: {},
      data: { status: 'in_progress' },
    });
    expect(response.status).to.equal(400);
    expect((await response.json())).to.have.property('message', 'Site ID required');
  });

  it('returns bad request for prerender-validation if opportunity id is missing', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID },
      data: { status: 'in_progress' },
    });
    expect(response.status).to.equal(400);
    expect((await response.json())).to.have.property('message', 'Opportunity ID required');
  });

  it('returns not found for prerender-validation if site does not exist', async () => {
    mockSite.findById.resolves(null);
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress' },
    });
    expect(response.status).to.equal(404);
    expect((await response.json())).to.have.property('message', 'Site not found');
  });

  it('returns not found for prerender-validation if opportunity does not exist', async () => {
    mockOpportunity.findById.resolves(null);
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress' },
    });
    expect(response.status).to.equal(404);
    expect((await response.json())).to.have.property('message', 'Opportunity not found');
  });

  it('returns not found for prerender-validation if opportunity belongs to another site', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      // opportunity entity reports SITE_ID, but a different (valid) site id is requested
      params: { siteId: OPPORTUNITY_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress' },
    });
    expect(response.status).to.equal(404);
    expect((await response.json())).to.have.property('message', 'Opportunity not found');
  });

  it('returns bad request for prerender-validation if no body is provided', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: {},
    });
    expect(response.status).to.equal(400);
    expect((await response.json())).to.have.property('message', 'No updates provided');
  });

  it('returns bad request for prerender-validation if status is invalid', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'bogus' },
    });
    expect(response.status).to.equal(400);
    expect((await response.json()).message).to.match(/status must be one of/);
  });

  it('returns bad request for prerender-validation if startedAt is not a valid ISO date string', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress', startedAt: 'not-a-date' },
    });
    expect(response.status).to.equal(400);
    expect((await response.json())).to.have.property('message', 'startedAt must be a valid ISO 8601 date string or null');
  });

  it('returns bad request for prerender-validation if startedAt is not a string', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress', startedAt: 12345 },
    });
    expect(response.status).to.equal(400);
    expect((await response.json())).to.have.property('message', 'startedAt must be a valid ISO 8601 date string or null');
  });

  it('returns bad request for prerender-validation if completedAt is not a valid ISO date string', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'completed_success', completedAt: 'not-a-date' },
    });
    expect(response.status).to.equal(400);
    expect((await response.json())).to.have.property('message', 'completedAt must be a valid ISO 8601 date string or null');
  });

  it('returns bad request for prerender-validation if completedAt is not a string', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'completed_success', completedAt: 12345 },
    });
    expect(response.status).to.equal(400);
    expect((await response.json())).to.have.property('message', 'completedAt must be a valid ISO 8601 date string or null');
  });

  it('returns bad request for prerender-validation if startedAt is a non-ISO date-like string (e.g. a weekday name)', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress', startedAt: 'Tuesday' },
    });
    expect(response.status).to.equal(400);
    expect((await response.json())).to.have.property('message', 'startedAt must be a valid ISO 8601 date string or null');
  });

  it('returns bad request for prerender-validation if reason is not a string or null', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'completed_fail', reason: 12345 },
    });
    expect(response.status).to.equal(400);
    expect((await response.json())).to.have.property('message', 'reason must be a string or null');
  });

  it('returns bad request for prerender-validation if requestId is not a string or null', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress', requestId: 12345 },
    });
    expect(response.status).to.equal(400);
    expect((await response.json())).to.have.property('message', 'requestId must be a string or null');
  });

  it('sets requestId when provided at in_progress', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress', requestId: 'req-abc123' },
    });

    expect(response.status).to.equal(200);
    expect(mockOpptyEntity.getData().prerenderValidation).to.deep.equal({
      status: 'in_progress',
      requestId: 'req-abc123',
      reason: null,
    });
  });

  it('carries requestId over to a later update when not explicitly provided', async () => {
    opptys[0].data = {
      prerenderValidation: { status: 'in_progress', requestId: 'req-abc123' },
    };
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'completed_success' },
    });

    expect(response.status).to.equal(200);
    expect(mockOpptyEntity.getData().prerenderValidation).to.deep.equal({
      status: 'completed_success',
      requestId: 'req-abc123',
      reason: null,
    });
  });

  it('overwrites requestId when a new value is explicitly provided', async () => {
    opptys[0].data = {
      prerenderValidation: { status: 'completed_fail', requestId: 'req-old' },
    };
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress', requestId: 'req-new' },
    });

    expect(response.status).to.equal(200);
    expect(mockOpptyEntity.getData().prerenderValidation.requestId).to.equal('req-new');
  });

  it('accepts null for startedAt and completedAt', async () => {
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: {
        status: 'in_progress', startedAt: null, completedAt: null,
      },
    });
    expect(response.status).to.equal(200);
  });

  it('returns bad request for prerender-validation on a validation error', async () => {
    mockOpptyEntity.save = async () => {
      throw new ValidationError('Validation error');
    };
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress' },
    });
    expect(response.status).to.equal(400);
    expect((await response.json())).to.have.property('message', 'Validation error');
  });

  it('returns 500 for prerender-validation on a data access error', async () => {
    mockOpptyEntity.save = async () => {
      throw new Error('boom');
    };
    const response = await opportunitiesController.patchPrerenderValidation({
      ...defaultAuthAttributes,
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { status: 'in_progress' },
    });
    expect(response.status).to.equal(500);
    expect((await response.json())).to.have.property('message', 'Error updating prerender validation');
  });

  describe('runPrerenderValidation', () => {
    it('returns bad request if site id is missing', async () => {
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        params: {},
        pathInfo: { headers: { authorization: 'Bearer test-token' } },
      });
      expect(response.status).to.equal(400);
      expect((await response.json())).to.have.property('message', 'Site ID required');
    });

    it('returns bad request if opportunity id is missing', async () => {
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        params: { siteId: SITE_ID },
        pathInfo: { headers: { authorization: 'Bearer test-token' } },
      });
      expect(response.status).to.equal(400);
      expect((await response.json())).to.have.property('message', 'Opportunity ID required');
    });

    it('returns not found if site does not exist', async () => {
      mockSite.findById.resolves(null);
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        pathInfo: { headers: { authorization: 'Bearer test-token' } },
      });
      expect(response.status).to.equal(404);
      expect((await response.json())).to.have.property('message', 'Site not found');
    });

    it('returns not found if opportunity does not exist', async () => {
      mockOpportunity.findById.resolves(null);
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        pathInfo: { headers: { authorization: 'Bearer test-token' } },
      });
      expect(response.status).to.equal(404);
      expect((await response.json())).to.have.property('message', 'Opportunity not found');
    });

    it('returns not found if opportunity belongs to another site', async () => {
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        // opportunity entity reports SITE_ID, but a different (valid) site id is requested
        params: { siteId: OPPORTUNITY_ID, opportunityId: OPPORTUNITY_ID },
        pathInfo: { headers: { authorization: 'Bearer test-token' } },
      });
      expect(response.status).to.equal(404);
      expect((await response.json())).to.have.property('message', 'Opportunity not found');
    });

    it('returns 409 already_validated without calling tokowaka when status is completed_success', async () => {
      mockOpportunity.findById.resolves({
        getSiteId: () => SITE_ID,
        getData: () => ({ prerenderValidation: { status: 'completed_success' } }),
      });
      const fetchStub = sandbox.stub(global, 'fetch');
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        log: mockContext.log,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      });

      expect(response.status).to.equal(409);
      expect((await response.json())).to.deep.equal({
        error: 'Site already validated (completed_success)',
        reason: 'already_validated',
      });
      expect(fetchStub).to.not.have.been.called;
    });

    it('returns 409 in_progress without calling tokowaka when a run started less than 3 hours ago', async () => {
      mockOpportunity.findById.resolves({
        getSiteId: () => SITE_ID,
        getData: () => ({
          prerenderValidation: { status: 'in_progress', startedAt: new Date().toISOString() },
        }),
      });
      const fetchStub = sandbox.stub(global, 'fetch');
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        log: mockContext.log,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      });

      expect(response.status).to.equal(409);
      expect((await response.json())).to.deep.equal({
        error: 'Validation already in progress for this site',
        reason: 'in_progress',
      });
      expect(fetchStub).to.not.have.been.called;
    });

    it('proceeds to call tokowaka when an in_progress run started more than 3 hours ago (stale)', async () => {
      const fourHoursAgo = new Date(Date.now() - (4 * 60 * 60 * 1000)).toISOString();
      mockOpportunity.findById.resolves({
        getSiteId: () => SITE_ID,
        getData: () => ({
          prerenderValidation: { status: 'in_progress', startedAt: fourHoursAgo },
        }),
      });
      const fetchStub = sandbox.stub(global, 'fetch').resolves({
        status: 202,
        json: async () => ({ requestId: 'req-123' }),
      });
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        log: mockContext.log,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      });

      expect(response.status).to.equal(202);
      expect(fetchStub).to.have.been.calledOnce;
    });

    it('proceeds to call tokowaka when there is no prior prerenderValidation status', async () => {
      mockOpportunity.findById.resolves({
        getSiteId: () => SITE_ID,
        getData: () => ({}),
      });
      const fetchStub = sandbox.stub(global, 'fetch').resolves({
        status: 202,
        json: async () => ({ requestId: 'req-123' }),
      });
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        log: mockContext.log,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      });

      expect(response.status).to.equal(202);
      expect(fetchStub).to.have.been.calledOnce;
    });

    it('returns forbidden when user does not have access to the organization', async () => {
      const mockOrg = { getImsOrgId: () => 'test-org-id' };
      const mockSiteWithOrg = {
        id: SITE_ID,
        getOrganization: async () => mockOrg,
      };
      mockSiteWithOrg.constructor = { ENTITY_NAME: 'Site' };
      mockSite.findById.resolves(mockSiteWithOrg);

      const restrictedAuthInfo = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'user' }])
        .withProfile({ is_admin: false })
        .withAuthenticated(true);
      restrictedAuthInfo.claims = { organizations: [] };

      const restrictedContext = {
        dataAccess: mockOpportunityDataAccess,
        pathInfo: { headers: { 'x-product': 'abcd' } },
        attributes: { authInfo: restrictedAuthInfo },
        log: defaultAuthAttributes.log,
      };

      const restrictedController = OpportunitiesController(restrictedContext);
      const response = await restrictedController.runPrerenderValidation({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        pathInfo: { headers: { authorization: 'Bearer test-token' } },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(403);
      const error = await response.json();
      expect(error).to.have.property('message', 'Only users belonging to the organization of the site can trigger its opportunities');
    });

    it('forwards the request to the internal prerender-validation service without credentials, with fixed maxPages/enableAiAnalysis/checkAuditAge, and passes through a 202', async () => {
      const fetchStub = sandbox.stub(global, 'fetch').resolves({
        status: 202,
        json: async () => ({ requestId: 'req-123' }),
      });
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        log: mockContext.log,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { customUrls: ['https://example.com/a'] },
      });

      expect(response.status).to.equal(202);
      expect((await response.json())).to.deep.equal({ requestId: 'req-123' });
      expect(fetchStub).to.have.been.calledOnce;
      const [url, options] = fetchStub.getCall(0).args;
      expect(url).to.equal('https://sj1010010249075.corp.adobe.com/api/compare/run');
      expect(options.method).to.equal('POST');
      expect(options.headers).to.not.have.property('Authorization');
      expect(options.signal).to.be.an.instanceOf(AbortSignal);
      expect(JSON.parse(options.body)).to.deep.equal({
        siteId: SITE_ID,
        maxPages: 100,
        enableAiAnalysis: false,
        checkAuditAge: true,
        customUrls: ['https://example.com/a'],
      });
      expect(mockContext.log.info).to.have.been.called;
    });

    it('ignores caller-supplied maxPages/enableAiAnalysis/checkAuditAge and always sends the fixed values', async () => {
      const fetchStub = sandbox.stub(global, 'fetch').resolves({
        status: 202,
        json: async () => ({ requestId: 'req-123' }),
      });
      await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        log: mockContext.log,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: {
          maxPages: 5, checkAuditAge: false, enableAiAnalysis: true,
        },
      });

      expect(JSON.parse(fetchStub.getCall(0).args[1].body)).to.deep.equal({
        siteId: SITE_ID,
        maxPages: 100,
        enableAiAnalysis: false,
        checkAuditAge: true,
      });
    });

    it('uses PRERENDER_VALIDATION_RUN_BASE_URL from env when configured', async () => {
      const fetchStub = sandbox.stub(global, 'fetch').resolves({
        status: 202,
        json: async () => ({ requestId: 'req-123' }),
      });
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        log: mockContext.log,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        env: { PRERENDER_VALIDATION_RUN_BASE_URL: 'https://custom-host.example.com' },
      });

      expect(response.status).to.equal(202);
      const [url] = fetchStub.getCall(0).args;
      expect(url).to.equal('https://custom-host.example.com/api/compare/run');
    });

    it('passes through a non-2xx response from the upstream service (e.g. already validated)', async () => {
      sandbox.stub(global, 'fetch').resolves({
        status: 409,
        json: async () => ({ error: 'Site already validated', reason: 'already_validated' }),
      });
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        log: mockContext.log,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      });

      expect(response.status).to.equal(409);
      expect((await response.json())).to.deep.equal({ error: 'Site already validated', reason: 'already_validated' });
    });

    it('returns 502 and logs an error when the upstream service is unreachable', async () => {
      sandbox.stub(global, 'fetch').rejects(new Error('network error'));
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        log: mockContext.log,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      });

      expect(response.status).to.equal(502);
      const error = await response.json();
      expect(error).to.have.property('error', 'prerenderValidationServiceUnreachable');
      expect(error).to.have.property('message', 'network error');
      expect(mockContext.log.error).to.have.been.calledWithMatch('unreachable');
    });

    it('defaults to an empty body when the upstream response is not valid JSON', async () => {
      sandbox.stub(global, 'fetch').resolves({
        status: 202,
        json: async () => { throw new Error('not json'); },
      });
      const response = await opportunitiesController.runPrerenderValidation({
        ...defaultAuthAttributes,
        log: mockContext.log,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      });

      expect(response.status).to.equal(202);
      expect((await response.json())).to.deep.equal({});
    });
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
      mockSiteWithOrg.constructor = { ENTITY_NAME: 'Site' };
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
        mockSiteWithOrg.constructor = { ENTITY_NAME: 'Site' };
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
        mockSiteWithOrg.constructor = { ENTITY_NAME: 'Site' };
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
        mockSiteWithOrg.constructor = { ENTITY_NAME: 'Site' };
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
        mockSiteWithOrg.constructor = { ENTITY_NAME: 'Site' };
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

      it('returns forbidden when user does not have access to the organization for patchPrerenderValidation', async () => {
        const mockOrg = { getImsOrgId: () => 'test-org-id' };
        const mockSiteWithOrg = {
          id: SITE_ID,
          getOrganization: async () => mockOrg,
        };
        mockSiteWithOrg.constructor = { ENTITY_NAME: 'Site' };
        mockSite.findById.resolves(mockSiteWithOrg);

        const restrictedAuthInfo = new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'user' }])
          .withProfile({ is_admin: false })
          .withAuthenticated(true);
        restrictedAuthInfo.claims = { organizations: [] };

        const restrictedContext = {
          dataAccess: mockOpportunityDataAccess,
          pathInfo: { headers: { 'x-product': 'abcd' } },
          attributes: { authInfo: restrictedAuthInfo },
          log: defaultAuthAttributes.log,
        };

        const restrictedController = OpportunitiesController(restrictedContext);
        const response = await restrictedController.patchPrerenderValidation({
          params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
          data: { status: 'in_progress' },
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
        mockSiteWithOrg.constructor = { ENTITY_NAME: 'Site' };
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

  describe('Summit PLG filtering', () => {
    const createMockOpptyEntity = (type) => ({
      getId: () => `id-${type}`,
      getSiteId: () => SITE_ID,
      getAuditId: () => 'audit001',
      getRunbook: () => 'http://runbook.url',
      getType: () => type,
      getData: () => ({}),
      getOrigin: () => 'ESS_OPS',
      getTitle: () => `Title ${type}`,
      getDescription: () => `Desc ${type}`,
      getGuidance: () => ({}),
      getTags: () => [],
      getStatus: () => 'NEW',
      getCreatedAt: () => Date.now(),
      getUpdatedAt: () => Date.now(),
      getUpdatedBy: () => 'system',
      getLastAuditedAt: () => Date.now(),
    });

    const allTypes = ['broken-backlinks', 'cwv', 'alt-text', 'forms', 'consent-banner', 'rss'];
    const plgAllowedTypes = ['broken-backlinks', 'cwv', 'alt-text'];
    let mockEntities;

    beforeEach(() => {
      mockEntities = allTypes.map(createMockOpptyEntity);
      mockOpportunity.allBySiteId.resolves(mockEntities);
      mockOpportunity.allBySiteIdAndStatus.resolves(mockEntities);
    });

    it('filters opportunities to PLG-allowed types when summit PLG is enabled (getAllForSite)', async () => {
      const ControllerWithPlg = (await esmock('../../src/controllers/opportunities.js', {
        '../../src/support/utils.js': {
          getIsSummitPlgEnabled: sinon.stub().resolves(true),
        },
      })).default;

      const ctrl = ControllerWithPlg(mockContext);
      const response = await ctrl.getAllForSite({ params: { siteId: SITE_ID } });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(3);
      const types = opportunities.map((o) => o.type);
      expect(types).to.have.members(plgAllowedTypes);
    });

    it('returns all opportunities when summit PLG is not enabled (getAllForSite)', async () => {
      const ControllerWithPlg = (await esmock('../../src/controllers/opportunities.js', {
        '../../src/support/utils.js': {
          getIsSummitPlgEnabled: sinon.stub().resolves(false),
        },
      })).default;

      const ctrl = ControllerWithPlg(mockContext);
      const response = await ctrl.getAllForSite({ params: { siteId: SITE_ID } });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(allTypes.length);
    });

    it('filters opportunities to PLG-allowed types when summit PLG is enabled (getByStatus)', async () => {
      const ControllerWithPlg = (await esmock('../../src/controllers/opportunities.js', {
        '../../src/support/utils.js': {
          getIsSummitPlgEnabled: sinon.stub().resolves(true),
        },
      })).default;

      const ctrl = ControllerWithPlg(mockContext);
      const response = await ctrl.getByStatus({ params: { siteId: SITE_ID, status: 'NEW' } });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(3);
      const types = opportunities.map((o) => o.type);
      expect(types).to.have.members(plgAllowedTypes);
    });

    it('returns all opportunities when summit PLG is not enabled (getByStatus)', async () => {
      const ControllerWithPlg = (await esmock('../../src/controllers/opportunities.js', {
        '../../src/support/utils.js': {
          getIsSummitPlgEnabled: sinon.stub().resolves(false),
        },
      })).default;

      const ctrl = ControllerWithPlg(mockContext);
      const response = await ctrl.getByStatus({ params: { siteId: SITE_ID, status: 'NEW' } });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(allTypes.length);
    });

    it('passes request context to getIsSummitPlgEnabled for getAllForSite', async () => {
      const plgStub = sinon.stub().resolves(false);
      const ControllerWithPlg = (await esmock('../../src/controllers/opportunities.js', {
        '../../src/support/utils.js': {
          getIsSummitPlgEnabled: plgStub,
        },
      })).default;

      const ctrl = ControllerWithPlg(mockContext);
      const requestContext = { params: { siteId: SITE_ID } };
      await ctrl.getAllForSite(requestContext);

      expect(plgStub.calledOnce).to.be.true;
      expect(plgStub.firstCall.args[2]).to.equal(requestContext);
    });

    it('passes request context to getIsSummitPlgEnabled for getByStatus', async () => {
      const plgStub = sinon.stub().resolves(false);
      const ControllerWithPlg = (await esmock('../../src/controllers/opportunities.js', {
        '../../src/support/utils.js': {
          getIsSummitPlgEnabled: plgStub,
        },
      })).default;

      const ctrl = ControllerWithPlg(mockContext);
      const requestContext = { params: { siteId: SITE_ID, status: 'NEW' } };
      await ctrl.getByStatus(requestContext);

      expect(plgStub.calledOnce).to.be.true;
      expect(plgStub.firstCall.args[2]).to.equal(requestContext);
    });

    it('calls grantSuggestionsForOpportunity in getByID when summit PLG is enabled', async () => {
      const grantStub = sinon.stub().resolves();
      const ControllerWithPlg = (await esmock('../../src/controllers/opportunities.js', {
        '../../src/support/utils.js': {
          getIsSummitPlgEnabled: sinon.stub().resolves(true),
        },
        '../../src/support/grant-suggestions-handler.js': {
          grantSuggestionsForOpportunity: grantStub,
        },
      })).default;

      const ctrl = ControllerWithPlg(mockContext);
      const response = await ctrl.getByID({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      });

      expect(response.status).to.equal(200);
      expect(grantStub).to.have.been.calledOnce;
    });

    it('does not call grantSuggestionsForOpportunity in getByID when summit PLG is not enabled', async () => {
      const grantStub = sinon.stub().resolves();
      const ControllerWithPlg = (await esmock('../../src/controllers/opportunities.js', {
        '../../src/support/utils.js': {
          getIsSummitPlgEnabled: sinon.stub().resolves(false),
        },
        '../../src/support/grant-suggestions-handler.js': {
          grantSuggestionsForOpportunity: grantStub,
        },
      })).default;

      const ctrl = ControllerWithPlg(mockContext);
      const response = await ctrl.getByID({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      });

      expect(response.status).to.equal(200);
      expect(grantStub).not.to.have.been.called;
    });

    it('passes request context to getIsSummitPlgEnabled for getByID', async () => {
      const plgStub = sinon.stub().resolves(false);
      const ControllerWithPlg = (await esmock('../../src/controllers/opportunities.js', {
        '../../src/support/utils.js': {
          getIsSummitPlgEnabled: plgStub,
        },
      })).default;

      const ctrl = ControllerWithPlg(mockContext);
      const requestContext = { params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID } };
      await ctrl.getByID(requestContext);

      expect(plgStub.calledOnce).to.be.true;
      expect(plgStub.firstCall.args[2]).to.equal(requestContext);
    });
  });
});
