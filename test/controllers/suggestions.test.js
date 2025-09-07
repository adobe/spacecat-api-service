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
/* eslint-disable no-param-reassign */
import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

import { ValidationError, Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import SuggestionsController from '../../src/controllers/suggestions.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Suggestions Controller', () => {
  const sandbox = sinon.createSandbox();
  const authContext = {
    attributes: {
      authInfo: new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'admin' }])
        .withProfile({ is_admin: true })
        .withAuthenticated(true)
      ,
    },
  };

  const SUGGESTION_IDS = [
    'a4a6055c-de4b-4552-bc0c-01fdb45b98d5',
    '930f8070-508a-4d94-a46c-279d4de2adfb',
    'a9807173-8e8e-4e8c-96f7-0a22d9dc90b8',
  ];

  const OPPORTUNITY_ID = 'a92e2a5e-7b3d-42f0-b3f0-6edd3746a932';
  const OPPORTUNITY_ID_NOT_FOUND = 'b56ef8d6-996b-4d5c-b308-8e0b0a95e1b6';
  const OPPORTUNITY_ID_NOT_ENABLED = '7a924451-c461-433c-a5fe-c3d2929ec9fa';

  const SITE_ID = 'f964a7f8-5402-4b01-bd5b-1ab499bcf797';
  const SITE_ID_NOT_FOUND = '3c677e57-9a6a-441c-a556-262eb8b4fc0e';
  const SITE_ID_NOT_ENABLED = '07efc218-79f6-48b5-970e-deb0f88ce01b';

  const mockSuggestionEntity = (suggData, removeStub) => ({
    getId() {
      return suggData.id;
    },
    setId(value) {
      suggData.id = value;
    },
    getOpportunityId() {
      return suggData.opportunityId;
    },
    setOpportunityId(value) {
      suggData.opportunityId = value;
    },
    getType() {
      return suggData.type;
    },
    setType(value) {
      suggData.type = value;
    },
    getStatus() {
      return suggData.status;
    },
    setStatus(value) {
      if (value === 'throw-error') {
        throw new ValidationError('Validation error');
      }
      suggData.status = value;
    },
    getRank() {
      return suggData.rank;
    },
    setRank(value) {
      if (value === 'throw-error') {
        throw new ValidationError('Validation error');
      }
      suggData.rank = value;
    },
    getData() {
      return suggData.data;
    },
    setData(value) {
      suggData.data = value;
    },
    getKpiDeltas() {
      return suggData.kpiDeltas;
    },
    setKpiDeltas(value) {
      suggData.kpiDeltas = value;
    },
    getCreatedAt() {
      return suggData.createdAt;
    },
    getUpdatedAt() {
      return suggData.updatedAt;
    },
    setCreatedAt(value) {
      suggData.createdAt = value;
    },
    setUpdatedAt(value) {
      suggData.updateddAt = value;
    },
    getOpportunity() {
      return {
        getSiteId() {
          return SITE_ID;
        },
      };
    },
    save() {
      if (suggData.throwValidationError) {
        throw new ValidationError('Validation error');
      }
      if (suggData.throwError) {
        throw new Error('Unknown error');
      }
      return this;
    },
    getUpdatedBy() {
      return suggData.updatedBy;
    },
    setUpdatedBy(value) {
      suggData.updatedBy = value;
    },
    remove: removeStub,
  });

  const suggestionsFunctions = [
    'autofixSuggestions',
    'createSuggestions',
    'getAllForOpportunity',
    'getByID',
    'getByStatus',
    'getSuggestionFixes',
    'patchSuggestion',
    'patchSuggestionsStatus',
    'removeSuggestion',
  ];

  let mockSuggestionDataAccess;
  let mockSuggestion;
  let mockOpportunity;
  let mockSite;
  let mockConfiguration;
  let suggestionsController;
  let mockSqs;
  let opportunity;
  let site;
  let siteNotEnabled;
  let opportunityNotEnabled;
  let removeStub;
  let suggs;
  let altTextSuggs;
  let context;
  let apikeyAuthAttributes;

  beforeEach(() => {
    context = {
      dataAccess: mockSuggestionDataAccess,
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true, email: 'test@test.com' })
          .withAuthenticated(true),
      },
    };
    apikeyAuthAttributes = {
      attributes: {
        authInfo: new AuthInfo()
          .withType('apikey')
          .withScopes([{ name: 'admin' }])
          .withProfile({ name: 'api-key' })
          .withAuthenticated(true),
      },
    };
    opportunity = {
      getId: sandbox.stub().returns(OPPORTUNITY_ID),
      getSiteId: sandbox.stub().returns(SITE_ID),
      getType: sandbox.stub().returns('broken-backlinks'),
    };
    opportunityNotEnabled = {
      getId: sandbox.stub().returns(OPPORTUNITY_ID_NOT_ENABLED),
      getSiteId: sandbox.stub().returns(SITE_ID_NOT_ENABLED),
      getType: sandbox.stub().returns('broken-backlinks'),
    };
    site = {
      getId: sandbox.stub().returns(SITE_ID),
      getDeliveryType: sandbox.stub().returns(SiteModel.DELIVERY_TYPES.AEM_EDGE),
    };
    siteNotEnabled = {
      getId: sandbox.stub().returns(SITE_ID_NOT_ENABLED),
    };

    removeStub = sandbox.stub().resolves();

    suggs = [
      {
        id: SUGGESTION_IDS[0],
        opportunityId: OPPORTUNITY_ID,
        type: 'CODE_CHANGE',
        status: 'NEW',
        rank: 1,
        data: {
          info: 'sample data',
          url: 'https://example.com',
        },
        kpiDeltas: {
          conversionRate: 0.05,
        },
        updatedBy: 'test@test.com',
        updatedAt: new Date(),
      },
      {
        id: SUGGESTION_IDS[1],
        opportunityId: OPPORTUNITY_ID,
        type: 'FIX_LINK',
        status: 'APPROVED',
        rank: 2,
        data: {
          url_from: 'https://example.com/old-link',
          info: 'broken back link data',
        },
        kpiDeltas: {
          conversionRate: 0.02,
        },
        updatedBy: 'test@test.com',
        updatedAt: new Date(),
      },
      {
        id: SUGGESTION_IDS[2],
        opportunityId: OPPORTUNITY_ID,
        type: 'FIX_LINK',
        status: 'NEW',
        rank: 2,
        data: {
          info: 'broken back link data',
        },
        kpiDeltas: {
          conversionRate: 0.02,
        },
        updatedBy: 'test@test.com',
        updatedAt: new Date(),
      },

    ];

    altTextSuggs = [
      {
        id: SUGGESTION_IDS[0],
        opportunityId: OPPORTUNITY_ID,
        type: 'CONTENT_UPDATE',
        rank: 1,
        status: 'NEW',
        data: {
          recommendations: [
            {
              pageUrl: 'https://example.com/example-page',
              id: '1398acaa-99a8-4417-a8ee-a2e71d98028b',
              altText: 'A description of the image',
              imageUrl: 'https://image.example.com/image1.png',
            },
          ],
        },
        updatedAt: new Date(),
      },
      {
        id: SUGGESTION_IDS[1],
        opportunityId: OPPORTUNITY_ID,
        type: 'CONTENT_UPDATE',
        rank: 2,
        status: 'NEW',
        data: {
          recommendations: [
            {
              pageUrl: 'https://example.com/another-page',
              id: '2398acaa-99a8-4417-a8ee-a2e71d98028c',
              altText: 'Another description of the image',
              imageUrl: 'https://image.example.com/image2.png',
            },
          ],
        },
        updatedAt: new Date(),
      },
    ];

    const isHandlerEnabledForSite = sandbox.stub();
    isHandlerEnabledForSite.withArgs('broken-backlinks-auto-fix', site).returns(true);
    isHandlerEnabledForSite.withArgs('alt-text-auto-fix', site).returns(true);
    isHandlerEnabledForSite.withArgs('meta-tags-auto-fix', site).returns(true);
    isHandlerEnabledForSite.withArgs('broken-backlinks-auto-fix', siteNotEnabled).returns(false);
    mockOpportunity = {
      findById: sandbox.stub(),
    };

    mockSite = {
      findById: sandbox.stub(),
    };

    mockConfiguration = {
      findLatest: sandbox.stub().resolves({
        isHandlerEnabledForSite,
      }),
    };
    mockSite.findById.withArgs(SITE_ID).resolves(site);
    mockSite.findById.withArgs(SITE_ID_NOT_ENABLED).resolves(siteNotEnabled);
    mockSite.findById.withArgs(SITE_ID_NOT_FOUND).resolves(null);
    mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(opportunity);
    mockOpportunity.findById.withArgs(OPPORTUNITY_ID_NOT_ENABLED).resolves(opportunityNotEnabled);
    mockOpportunity.findById.withArgs(OPPORTUNITY_ID_NOT_FOUND).resolves(null);

    mockSuggestion = {
      allByOpportunityId: sandbox.stub().resolves([mockSuggestionEntity(suggs[0])]),
      allByOpportunityIdAndStatus: sandbox.stub().resolves([mockSuggestionEntity(suggs[0])]),
      findById: sandbox.stub().callsFake((id) => {
        const suggestion = suggs.find((s) => s.id === id);
        return Promise.resolve(suggestion ? mockSuggestionEntity(suggestion, removeStub) : null);
      }),
      bulkUpdateStatus: sandbox.stub(),
      create: sandbox.stub().callsFake((suggData) => {
        if (suggData.throwValidationError) {
          throw new ValidationError('Validation error');
        }
        if (suggData.throwError) {
          throw new Error('Unknown error');
        }
        return Promise.resolve(mockSuggestionEntity(suggData));
      }),
    };

    mockSuggestionDataAccess = {
      Opportunity: mockOpportunity,
      Suggestion: mockSuggestion,
      Site: mockSite,
      Configuration: mockConfiguration,
    };
    mockSqs = {
      sendMessage: sandbox.stub().resolves(),
    };

    suggestionsController = SuggestionsController({ dataAccess: mockSuggestionDataAccess, ...authContext }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    suggestionsFunctions.forEach((funcName) => {
      expect(suggestionsController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(suggestionsController).forEach((funcName) => {
      expect(suggestionsFunctions).to.include(funcName);
    });
  });

  it('throws an error if context is not an object', () => {
    expect(() => SuggestionsController()).to.throw('Context required');
  });

  it('throws an error if data access is not an object', () => {
    expect(() => SuggestionsController({ test: {} })).to.throw('Data access required');
  });

  it('throws an error if data access cannot be destructured to Opportunity', () => {
    expect(() => SuggestionsController({ dataAccess: { Opportunity: '' } })).to.throw('Data access required');
  });

  it('throws an error if data access cannot be destructured to Suggestion', () => {
    expect(() => SuggestionsController({ dataAccess: { Opportunity: {}, Suggestion: '' } })).to.throw('Data access required');
  });

  it('gets all suggestions for an opportunity and a site', async () => {
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityId.calledOnce).to.be.true;
    expect(response.status).to.equal(200);
    const suggestions = await response.json();
    expect(suggestions).to.be.an('array').with.lengthOf(1);
    expect(suggestions[0]).to.have.property('opportunityId', OPPORTUNITY_ID);
  });

  it('gets all suggestions for an opportunity and a site for non belonging to the organization', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityId.calledOnce).to.be.false;
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'User does not belong to the organization');
  });

  it('gets all suggestions for an opportunity returns bad request if no site ID is passed', async () => {
    const response = await suggestionsController.getAllForOpportunity(
      { params: {}, ...context },
    );
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityId.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets all suggestions for an opportunity returns bad request if no opportunity ID is passed', async () => {
    const response = await suggestionsController.getAllForOpportunity({
      params: { siteId: SITE_ID },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityId.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('gets all suggestions for an opportunity returns not found if passed site ID does not match opportunity site id', async () => {
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID_NOT_ENABLED, // id does not exist
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityId.calledOnce).to.be.true;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
  });

  it('gets all suggestions for an opportunity returns not found if passed site ID does not exist', async () => {
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID_NOT_FOUND,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityId.calledOnce).to.be.false;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site not found');
  });

  it('gets all suggestions for an opportunity by status', async () => {
    const response = await suggestionsController.getByStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.true;
    expect(response.status).to.equal(200);
    const suggestions = await response.json();
    expect(suggestions).to.be.an('array').with.lengthOf(1);
    expect(suggestions[0]).to.have.property('opportunityId', OPPORTUNITY_ID);
  });

  it('gets all suggestions for an opportunity by status returns bad request if no Site ID is passed', async () => {
    const response = await suggestionsController.getByStatus({
      params: {
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets all suggestions for an opportunity by status returns bad request if no opportunity ID is passed', async () => {
    const response = await suggestionsController.getByStatus({
      params: { siteId: SITE_ID, status: 'NEW' },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('gets all suggestions for an opportunity by status returns bad request if no status is passed', async () => {
    const response = await suggestionsController.getByStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Status is required');
  });

  it('gets all suggestions for a site does not exist', async () => {
    const response = await suggestionsController.getByStatus({
      params: {
        siteId: SITE_ID_NOT_FOUND,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.false;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site not found');
  });

  it('gets all suggestions for a non belonging to the organization', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const response = await suggestionsController.getByStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.false;
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'User does not belong to the organization');
  });

  it('gets all suggestions for an opportunity by status returns not found if site ID passed does not match opportunity site id', async () => {
    const response = await suggestionsController.getByStatus({
      params: {
        siteId: SITE_ID_NOT_ENABLED, // id does not exist
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.true;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
  });

  it('gets suggestion by ID', async () => {
    const response = await suggestionsController.getByID({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.true;
    expect(response.status).to.equal(200);
    const suggestion = await response.json();
    expect(suggestion).to.have.property('id', SUGGESTION_IDS[0]);
  });

  it('gets suggestion by ID for non existing site', async () => {
    const response = await suggestionsController.getByID({
      params: {
        siteId: SITE_ID_NOT_FOUND,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.false;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site not found');
  });

  it('gets suggestion by ID for non belonging to the organization', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const response = await suggestionsController.getByID({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.false;
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'User does not belong to the organization');
  });

  it('gets suggestion by ID returns bad request if no site ID is passed', async () => {
    const response = await suggestionsController.getByID({
      params: {
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets suggestion by ID returns bad request if no opportunity ID is passed', async () => {
    const response = await suggestionsController.getByID({
      params: {
        siteId: SITE_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('gets suggestion by ID returns bad request if no suggestion ID is passed', async () => {
    const response = await suggestionsController.getByID({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion ID required');
  });

  it('gets suggestion by ID returns not found if suggestion is not found', async () => {
    mockSuggestion.findById.resolves(null);
    const response = await suggestionsController.getByID({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.true;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion not found');
  });

  it('gets suggestion by ID returns not found if suggestion is not associated with the opportunity', async () => {
    const response = await suggestionsController.getByID({
      params: {
        siteId: SITE_ID,
        opportunityId: 'cd43d166-cebd-40cc-98bd-23777a8608c0', // id does not exist
        suggestionId: SUGGESTION_IDS[0],
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.true;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion not found');
  });

  it('gets suggestion by ID returns not found if site id is not associated with the opportunity', async () => {
    const response = await suggestionsController.getByID({
      params: {
        siteId: SITE_ID_NOT_ENABLED, // id does not exist
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.true;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'not found');
  });

  it('creates 2 suggestions success', async () => {
    const response = await suggestionsController.createSuggestions({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [suggs[0], suggs[1]],
      ...context,
    });
    expect(response.status).to.equal(207);
    const createResponse = await response.json();
    expect(createResponse).to.have.property('suggestions');
    expect(createResponse).to.have.property('metadata');
    expect(createResponse.metadata).to.have.property('total', 2);
    expect(createResponse.metadata).to.have.property('success', 2);
    expect(createResponse.metadata).to.have.property('failed', 0);
    expect(createResponse.suggestions).to.have.property('length', 2);
    expect(createResponse.suggestions[0]).to.have.property('index', 0);
    expect(createResponse.suggestions[1]).to.have.property('index', 1);
    expect(createResponse.suggestions[0]).to.have.property('statusCode', 201);
    expect(createResponse.suggestions[1]).to.have.property('statusCode', 201);
    expect(createResponse.suggestions[0].suggestion).to.exist;
    expect(createResponse.suggestions[1].suggestion).to.exist;
    expect(createResponse.suggestions[0].suggestion).to.have.property('id', SUGGESTION_IDS[0]);
    expect(createResponse.suggestions[1].suggestion).to.have.property('id', SUGGESTION_IDS[1]);
  });

  it('creates bulk suggestion returns 400 and 500 error', async () => {
    suggs[0].throwError = true;
    suggs[1].throwValidationError = true;
    const response = await suggestionsController.createSuggestions({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [suggs[0], suggs[1]],
      ...context,
    });
    expect(response.status).to.equal(207);
    const createResponse = await response.json();
    expect(createResponse).to.have.property('suggestions');
    expect(createResponse).to.have.property('metadata');
    expect(createResponse.metadata).to.have.property('total', 2);
    expect(createResponse.metadata).to.have.property('success', 0);
    expect(createResponse.metadata).to.have.property('failed', 2);
    expect(createResponse.suggestions).to.have.property('length', 2);
    expect(createResponse.suggestions[0]).to.have.property('index', 0);
    expect(createResponse.suggestions[1]).to.have.property('index', 1);
    expect(createResponse.suggestions[0]).to.have.property('statusCode', 500);
    expect(createResponse.suggestions[1]).to.have.property('statusCode', 400);
    expect(createResponse.suggestions[0].suggestion).to.not.exist;
    expect(createResponse.suggestions[1].suggestion).to.not.exist;
    expect(createResponse.suggestions[0]).to.have.property('message', 'Unknown error');
    expect(createResponse.suggestions[1]).to.have.property('message', 'Validation error');
  });

  it('creates a suggestion returns bad request if no site ID is passed', async () => {
    const response = await suggestionsController.createSuggestions({
      params: { opportunityId: OPPORTUNITY_ID },
      data: suggs,
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.create.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('creates a suggestion returns bad request if no opportunity ID is passed', async () => {
    const response = await suggestionsController.createSuggestions({
      params: { siteId: SITE_ID },
      data: suggs,
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.create.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('creates a suggestion for non existing site', async () => {
    const response = await suggestionsController.createSuggestions({
      params: { siteId: SITE_ID_NOT_FOUND, opportunityId: OPPORTUNITY_ID },
      data: suggs,
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.create.calledOnce).to.be.false;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site not found');
  });

  it('creates a suggestion for non belonging to the organization', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const response = await suggestionsController.createSuggestions({
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: suggs,
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.create.calledOnce).to.be.false;
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'User does not belong to the organization');
  });

  it('creates a suggestion returns bad request if no data is passed', async () => {
    const response = await suggestionsController.createSuggestions({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.create.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('creates a suggestion returns bad request if passed data is not an array', async () => {
    const response = await suggestionsController.createSuggestions({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: 'not an array',
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.create.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Request body must be an array');
  });

  it('patches a suggestion', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        rank, data, kpiDeltas, updatedBy: 'test@test.com', updatedAt: new Date(),
      },
      ...context,
    });

    expect(response.status).to.equal(200);

    const updatedSuggestion = await response.json();
    expect(updatedSuggestion).to.have.property('opportunityId', OPPORTUNITY_ID);
    expect(updatedSuggestion).to.have.property('id', SUGGESTION_IDS[0]);
    expect(updatedSuggestion).to.have.property('rank', 2);
  });

  it('patches a suggestion with api key', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        rank, data, kpiDeltas, updatedBy: 'test@test.com', updatedAt: new Date(),
      },
      ...apikeyAuthAttributes,
    });

    expect(response.status).to.equal(200);

    const updatedSuggestion = await response.json();
    expect(updatedSuggestion).to.have.property('opportunityId', OPPORTUNITY_ID);
    expect(updatedSuggestion).to.have.property('id', SUGGESTION_IDS[0]);
    expect(updatedSuggestion).to.have.property('rank', 2);
    expect(updatedSuggestion).to.have.property('updatedBy', 'system');
  });

  it('patches a suggestion for non existing site', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID_NOT_FOUND,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: { rank: 2, data: 'test', kpiDeltas: [] },
      ...context,
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site not found');
  });

  it('patches a suggestion for non belonging to the organization', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const response = await suggestionsController.patchSuggestion({
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID, suggestionId: SUGGESTION_IDS[0] },
      data: { rank: 2, data: 'test', kpiDeltas: [] },
      ...context,
    });
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'User does not belong to the organization');
  });

  it('patches a suggestion returns bad request if no site ID is passed', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: { rank, data, kpiDeltas },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('patches a suggestion returns bad request if no opportunity ID is passed', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: { rank, data, kpiDeltas },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('patches a suggestion returns bad request if no suggestion ID is passed', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: { rank, data, kpiDeltas },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion ID required');
  });

  it('patches a suggestion returns not found if suggestion is not found', async () => {
    mockSuggestion.findById.resolves(null);
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: { rank, data, kpiDeltas },
      ...context,
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion not found');
  });

  it('patches a suggestion returns not found if suggestion is not associated with the opportunity', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: 'cd43d166-cebd-40cc-98bd-23777a8608c0', // id does not exist
        suggestionId: SUGGESTION_IDS[0],
      },
      data: { rank, data, kpiDeltas },
      ...context,
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion not found');
  });

  it('patches a suggestion returns not found if site id is not associated with the opportunity', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID_NOT_ENABLED, // id does not exist
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: { rank, data, kpiDeltas },
      ...context,
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion not found');
  });

  it('patches a suggestion returns bad request if no data is passed', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('patches a suggestion returns bad request if passed data is not an object', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: 'not an object',
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('patches a suggestion returns bad request if there is a validation error', async () => {
    const { data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: { rank: 'throw-error', data, kpiDeltas },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Validation error');
  });

  it('patches a suggestion returns 500 error if there is an error other than validation', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    suggs[0].throwError = true;
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: { rank, data, kpiDeltas },
      ...context,
    });
    expect(response.status).to.equal(500);
    const error = await response.json();
    expect(error).to.have.property('message', 'Error updating suggestion');
  });

  it('bulk patches suggestion status 2 successes', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [{ id: SUGGESTION_IDS[0], status: 'NEW-updated' }, { id: SUGGESTION_IDS[1], status: 'APPROVED-updated' }],
      ...context,
    });

    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse).to.have.property('suggestions');
    expect(bulkPatchResponse).to.have.property('metadata');
    expect(bulkPatchResponse.metadata).to.have.property('total', 2);
    expect(bulkPatchResponse.metadata).to.have.property('success', 2);
    expect(bulkPatchResponse.metadata).to.have.property('failed', 0);
    expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 200);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 200);
    expect(bulkPatchResponse.suggestions[0].suggestion).to.exist;
    expect(bulkPatchResponse.suggestions[1].suggestion).to.exist;
    expect(bulkPatchResponse.suggestions[0].suggestion).to.have.property('status', 'NEW-updated');
    expect(bulkPatchResponse.suggestions[1].suggestion).to.have.property('status', 'APPROVED-updated');
  });

  it('bulk patches suggestion for non existing site ', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: { siteId: SITE_ID_NOT_FOUND, opportunityId: OPPORTUNITY_ID },
      data: [{ id: SUGGESTION_IDS[0], status: 'NEW-NEW' }, { id: SUGGESTION_IDS[1], status: 'NEW-APPROVED' }],
      ...context,
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site not found');
  });

  it('bulk patches suggestion for non belonging to the organization', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const response = await suggestionsController.patchSuggestionsStatus({
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: [{ id: SUGGESTION_IDS[0], status: 'NEW-NEW' }, { id: SUGGESTION_IDS[1], status: 'NEW-APPROVED' }],
      ...context,
    });
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'User does not belong to the organization');
  });

  it('bulk patches suggestion status returns bad request if no site ID is passed', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        opportunityId: OPPORTUNITY_ID,
      },
      data: [{ id: SUGGESTION_IDS[0], status: 'NEW-NEW' }, { id: SUGGESTION_IDS[1], status: 'NEW-APPROVED' }],
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('bulk patches suggestion status returns bad request if no opportunity ID is passed', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
      },
      data: [{ id: SUGGESTION_IDS[0], status: 'NEW-NEW' }, { id: SUGGESTION_IDS[1], status: 'NEW-APPROVED' }],
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('bulk patches suggestion status returns bad request if no data is passed', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('bulk patches suggestion status returns bad request if passed data is not an array', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: 'not an array',
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Request body must be an array of [{ id: <suggestion id>, status: <suggestion status> },...]');
  });

  it('bulk patches suggestion status 1 fails passed data does not have id', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [{ id: SUGGESTION_IDS[1], status: 'NEW-APPROVED' }, { status: 'NEW-APPROVED' }],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse).to.have.property('suggestions');
    expect(bulkPatchResponse).to.have.property('metadata');
    expect(bulkPatchResponse.metadata).to.have.property('total', 2);
    expect(bulkPatchResponse.metadata).to.have.property('success', 1);
    expect(bulkPatchResponse.metadata).to.have.property('failed', 1);
    expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 200);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 400);
    expect(bulkPatchResponse.suggestions[0].suggestion).to.exist;
    expect(bulkPatchResponse.suggestions[1].suggestion).to.not.exist;
    expect(bulkPatchResponse.suggestions[0].message).to.not.exist;
    expect(bulkPatchResponse.suggestions[1]).to.have.property('message', 'suggestion id is required');
  });

  it('bulk patches suggestion status fails if site ID does not match site id of the opportunity', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID_NOT_ENABLED, // id does not exist
        opportunityId: OPPORTUNITY_ID,
      },
      data: [{ id: SUGGESTION_IDS[1], status: 'NEW-APPROVED' }, { id: SUGGESTION_IDS[0], status: 'NEW-APPROVED' }],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse).to.have.property('suggestions');
    expect(bulkPatchResponse).to.have.property('metadata');
    expect(bulkPatchResponse.metadata).to.have.property('total', 2);
    expect(bulkPatchResponse.metadata).to.have.property('success', 0);
    expect(bulkPatchResponse.metadata).to.have.property('failed', 2);
    expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 404);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 404);
    expect(bulkPatchResponse.suggestions[0].suggestion).to.not.exist;
    expect(bulkPatchResponse.suggestions[1].suggestion).to.not.exist;
    expect(bulkPatchResponse.suggestions[0]).to.have.property('message', 'Suggestion not found');
    expect(bulkPatchResponse.suggestions[1]).to.have.property('message', 'Suggestion not found');
  });

  it('bulk patches suggestion status 1 fails passed data does not have status', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [{ id: SUGGESTION_IDS[1], status: 'NEW-APPROVED' }, { id: SUGGESTION_IDS[0] }],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse).to.have.property('suggestions');
    expect(bulkPatchResponse).to.have.property('metadata');
    expect(bulkPatchResponse.metadata).to.have.property('total', 2);
    expect(bulkPatchResponse.metadata).to.have.property('success', 1);
    expect(bulkPatchResponse.metadata).to.have.property('failed', 1);
    expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 200);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 400);
    expect(bulkPatchResponse.suggestions[0].suggestion).to.exist;
    expect(bulkPatchResponse.suggestions[1].suggestion).to.not.exist;
    expect(bulkPatchResponse.suggestions[0].message).to.not.exist;
    expect(bulkPatchResponse.suggestions[1]).to.have.property('message', 'status is required');
  });

  it('bulk patches suggestion status fails passed suggestions not found', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [{ id: 'wrong-sugg-id', status: 'NEW-NEW' }, { id: SUGGESTION_IDS[0], status: 'NEW-APPROVED' }],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse).to.have.property('suggestions');
    expect(bulkPatchResponse).to.have.property('metadata');
    expect(bulkPatchResponse.metadata).to.have.property('total', 2);
    expect(bulkPatchResponse.metadata).to.have.property('success', 1);
    expect(bulkPatchResponse.metadata).to.have.property('failed', 1);
    expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 404);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 200);
    expect(bulkPatchResponse.suggestions[0].suggestion).to.not.exist;
    expect(bulkPatchResponse.suggestions[1].suggestion).to.exist;
    expect(bulkPatchResponse.suggestions[0]).to.have.property('message', 'Suggestion not found');
    expect(bulkPatchResponse.suggestions[1]).to.exist;
  });

  it('bulk patches suggestion status fails passed suggestions no status updates', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [{ id: SUGGESTION_IDS[0], status: 'NEW' }, { id: SUGGESTION_IDS[1], status: 'APPROVED' }],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse).to.have.property('suggestions');
    expect(bulkPatchResponse).to.have.property('metadata');
    expect(bulkPatchResponse.metadata).to.have.property('total', 2);
    expect(bulkPatchResponse.metadata).to.have.property('success', 0);
    expect(bulkPatchResponse.metadata).to.have.property('failed', 2);
    expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 400);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 400);
    expect(bulkPatchResponse.suggestions[0].suggestion).to.not.exist;
    expect(bulkPatchResponse.suggestions[1].suggestion).to.not.exist;
    expect(bulkPatchResponse.suggestions[0]).to.have.property('message', 'No updates provided');
    expect(bulkPatchResponse.suggestions[1]).to.have.property('message', 'No updates provided');
  });

  it('bulk patches suggestion status fails if validation error in set status', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [{ id: SUGGESTION_IDS[0], status: 'throw-error' }, { id: SUGGESTION_IDS[1], status: 'throw-error' }],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse).to.have.property('suggestions');
    expect(bulkPatchResponse).to.have.property('metadata');
    expect(bulkPatchResponse.metadata).to.have.property('total', 2);
    expect(bulkPatchResponse.metadata).to.have.property('success', 0);
    expect(bulkPatchResponse.metadata).to.have.property('failed', 2);
    expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 400);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 400);
    expect(bulkPatchResponse.suggestions[0].suggestion).to.not.exist;
    expect(bulkPatchResponse.suggestions[1].suggestion).to.not.exist;
    expect(bulkPatchResponse.suggestions[0]).to.have.property('message', 'Validation error');
    expect(bulkPatchResponse.suggestions[1]).to.have.property('message', 'Validation error');
  });

  it('bulk patches suggestion status fails if validation error in save', async () => {
    suggs[0].throwError = true;
    suggs[1].throwValidationError = true;
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [{ id: SUGGESTION_IDS[0], status: 'NEW updated' }, { id: SUGGESTION_IDS[1], status: 'APPROVED updated' }],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse).to.have.property('suggestions');
    expect(bulkPatchResponse).to.have.property('metadata');
    expect(bulkPatchResponse.metadata).to.have.property('total', 2);
    expect(bulkPatchResponse.metadata).to.have.property('success', 0);
    expect(bulkPatchResponse.metadata).to.have.property('failed', 2);
    expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
    expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 500);
    expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 400);
    expect(bulkPatchResponse.suggestions[0].suggestion).to.not.exist;
    expect(bulkPatchResponse.suggestions[1].suggestion).to.not.exist;
    expect(bulkPatchResponse.suggestions[0]).to.have.property('message', 'Unknown error');
    expect(bulkPatchResponse.suggestions[1]).to.have.property('message', 'Validation error');
  });

  describe('auto-fix suggestions', () => {
    it('triggers autofixSuggestion and sets suggestions to in-progress', async () => {
      opportunity.getType = sandbox.stub().returns('meta-tags');
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(suggs[0]),
          mockSuggestionEntity(suggs[2])],
      );
      mockSuggestion.bulkUpdateStatus.resolves([mockSuggestionEntity({ ...suggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...suggs[2], status: 'IN_PROGRESS' })]);
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]] },
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse).to.have.property('suggestions');
      expect(bulkPatchResponse).to.have.property('metadata');
      expect(bulkPatchResponse.metadata).to.have.property('total', 2);
      expect(bulkPatchResponse.metadata).to.have.property('success', 2);
      expect(bulkPatchResponse.metadata).to.have.property('failed', 0);
      expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[0].suggestion).to.exist;
      expect(bulkPatchResponse.suggestions[1].suggestion).to.exist;
      expect(bulkPatchResponse.suggestions[0].suggestion).to.have.property('status', 'IN_PROGRESS');
      expect(bulkPatchResponse.suggestions[1].suggestion).to.have.property('status', 'IN_PROGRESS');
    });

    it('triggers autofixSuggestion and sets suggestions to in-progress for alt-text', async () => {
      opportunity.getType = sandbox.stub().returns('alt-text');
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(altTextSuggs[0]),
          mockSuggestionEntity(altTextSuggs[1])],
      );
      mockSuggestion.bulkUpdateStatus.resolves([mockSuggestionEntity({ ...altTextSuggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...altTextSuggs[1], status: 'IN_PROGRESS' })]);
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse).to.have.property('suggestions');
      expect(bulkPatchResponse).to.have.property('metadata');
      expect(bulkPatchResponse.metadata).to.have.property('total', 2);
      expect(bulkPatchResponse.metadata).to.have.property('success', 2);
      expect(bulkPatchResponse.metadata).to.have.property('failed', 0);
      expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[0].suggestion).to.exist;
      expect(bulkPatchResponse.suggestions[1].suggestion).to.exist;
      expect(bulkPatchResponse.suggestions[0].suggestion).to.have.property('status', 'IN_PROGRESS');
      expect(bulkPatchResponse.suggestions[1].suggestion).to.have.property('status', 'IN_PROGRESS');
    });

    it('auto-fix suggestions status returns bad request if no site ID is passed', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: {
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]] },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site ID required');
    });

    it('auto-fix suggestions status returns bad request if no opportunity ID is passed', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]] },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Opportunity ID required');
    });

    it('auto-fix suggestions status returns bad request if no data is passed', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'No updates provided');
    });

    it('auto-fix suggestions returns bad request if passed data is not an array', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: 'not an array' },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Request body must be an array of suggestionIds');
    });

    it('auto-fix suggestions returns 404 if site not found', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID_NOT_FOUND,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]] },
        ...context,
      });
      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site not found');
    });

    it('auto-fix suggestions returns 404 if opportunity not found', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID_NOT_FOUND,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]] },
        ...context,
      });
      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Opportunity not found');
    });

    it('auto-fix suggestions returns 400 if site not enabled for autofix', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID_NOT_ENABLED,
          opportunityId: OPPORTUNITY_ID_NOT_ENABLED,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]] },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Handler is not enabled for site 07efc218-79f6-48b5-970e-deb0f88ce01b autofix type broken-backlinks');
    });

    it('does not set IN_PROGRESS if no valid suggestions', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: ['not-found'] },
        ...context,
      });
      expect(response.status).to.equal(207);
      expect(mockSuggestion.bulkUpdateStatus).to.not.have.been.called;
    });

    it('auto-fix suggestions status fails passed suggestions not found', async () => {
      mockSuggestion.allByOpportunityId.resolves([
        mockSuggestionEntity(suggs[2])]);
      mockSuggestion.bulkUpdateStatus.resolves([mockSuggestionEntity({ ...suggs[2], status: 'IN_PROGRESS' })]);
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: ['not-found', SUGGESTION_IDS[2]] },
        ...context,
      });
      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse).to.have.property('suggestions');
      expect(bulkPatchResponse).to.have.property('metadata');
      expect(bulkPatchResponse.metadata).to.have.property('total', 2);
      expect(bulkPatchResponse.metadata).to.have.property('success', 1);
      expect(bulkPatchResponse.metadata).to.have.property('failed', 1);
      expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 404);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[0].suggestion).to.not.exist;
      expect(bulkPatchResponse.suggestions[1].suggestion).to.exist;
      expect(bulkPatchResponse.suggestions[0]).to.have.property('message', 'Suggestion not found');
    });

    it('autofix suggestion patches suggestion status fails passed suggestions not new', async () => {
      mockSuggestion.allByOpportunityId.resolves([mockSuggestionEntity(suggs[0]),
        mockSuggestionEntity(suggs[1])]);
      mockSuggestion.bulkUpdateStatus.resolves([mockSuggestionEntity({ ...suggs[0], status: 'IN_PROGRESS' })]);
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
        ...context,
      });
      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse).to.have.property('suggestions');
      expect(bulkPatchResponse).to.have.property('metadata');
      expect(bulkPatchResponse.metadata).to.have.property('total', 2);
      expect(bulkPatchResponse.metadata).to.have.property('success', 1);
      expect(bulkPatchResponse.metadata).to.have.property('failed', 1);
      expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 400);
      expect(bulkPatchResponse.suggestions[0].suggestion).to.exist;
      expect(bulkPatchResponse.suggestions[1].suggestion).to.not.exist;
      expect(bulkPatchResponse.suggestions[1]).to.have.property('message', 'Suggestion is not in NEW status');
    });
  });

  describe('auto-fix suggestions for CS', () => {
    let spySqs;
    let sqsSpy;
    let imsPromiseClient;
    let suggestionsControllerWithIms;

    beforeEach(async () => {
      site.getDeliveryType = sandbox.stub().returns(SiteModel.DELIVERY_TYPES.AEM_CS);

      sqsSpy = sandbox.spy();

      spySqs = {
        sendMessage: sqsSpy,
      };

      imsPromiseClient = {
        createFrom: () => ({
          getPromiseToken: sandbox.stub().returns({
            promise_token: 'promiseTokenExample',
            expires_in: 14399,
            token_type: 'promise_token',
          }),
        }),
        CLIENT_TYPE: {
          EMITTER: 'emitter',
        },
      };
      const SuggestionsControllerWithIms = await esmock('../../src/controllers/suggestions.js', {}, {
        '@adobe/spacecat-shared-ims-client': {
          ImsPromiseClient: imsPromiseClient,
        },
      });
      suggestionsControllerWithIms = SuggestionsControllerWithIms({
        dataAccess: mockSuggestionDataAccess,
        ...authContext,
      }, spySqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    });

    it('triggers autofixSuggestion and sets suggestions to in-progress for CS', async () => {
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(suggs[0]),
          mockSuggestionEntity(suggs[2])],
      );
      mockSuggestion.bulkUpdateStatus.resolves([mockSuggestionEntity({ ...suggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...suggs[2], status: 'IN_PROGRESS' })]);
      const response = await suggestionsControllerWithIms.autofixSuggestions({
        env: {
          AUTOFIX_CRYPT_SECRET: 'superSecret',
          AUTOFIX_CRYPT_SALT: 'salt',
        },
        pathInfo: {
          headers: {
            authorization: 'Bearer token123',
          },
        },
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]] },
      });

      expect(response.status).to.equal(207);
      expect(sqsSpy.firstCall.args[1]).to.have.property('promiseToken');
      expect(sqsSpy.firstCall.args[1].promiseToken).to.have.property('promise_token');

      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse).to.have.property('suggestions');
      expect(bulkPatchResponse).to.have.property('metadata');
      expect(bulkPatchResponse.metadata).to.have.property('total', 2);
      expect(bulkPatchResponse.metadata).to.have.property('success', 2);
      expect(bulkPatchResponse.metadata).to.have.property('failed', 0);
      expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('index', 0);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('index', 1);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[0].suggestion).to.exist;
      expect(bulkPatchResponse.suggestions[1].suggestion).to.exist;
      expect(bulkPatchResponse.suggestions[0].suggestion).to.have.property('status', 'IN_PROGRESS');
      expect(bulkPatchResponse.suggestions[1].suggestion).to.have.property('status', 'IN_PROGRESS');
    });

    it('triggers autofixSuggestion without encryption secrets', async () => {
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(suggs[0]),
          mockSuggestionEntity(suggs[2])],
      );
      mockSuggestion.bulkUpdateStatus.resolves([mockSuggestionEntity({ ...suggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...suggs[2], status: 'IN_PROGRESS' })]);
      const response = await suggestionsControllerWithIms.autofixSuggestions({
        pathInfo: {
          headers: {
            authorization: 'Bearer token123',
          },
        },
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]] },
      });

      expect(response.status).to.equal(207);
      expect(sqsSpy.firstCall.args[1]).to.have.property('promiseToken');
      expect(sqsSpy.firstCall.args[1].promiseToken).to.have.property('promise_token', 'promiseTokenExample');
    });

    it('auto-fix suggestions returns 400 without authorization header', async () => {
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(suggs[0]),
          mockSuggestionEntity(suggs[2])],
      );
      mockSuggestion.bulkUpdateStatus.resolves([mockSuggestionEntity({ ...suggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...suggs[2], status: 'IN_PROGRESS' })]);
      const response = await suggestionsControllerWithIms.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]] },
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Missing Authorization header');
    });

    it('auto-fix suggestions throws error for failed IMS client creation', async () => {
      const failedImsClient = {
        createFrom: () => (null),
        CLIENT_TYPE: {
          EMITTER: 'emitter',
        },
      };
      const SuggestionsControllerWithFailedIms = await esmock('../../src/controllers/suggestions.js', {}, {
        '@adobe/spacecat-shared-ims-client': {
          ImsPromiseClient: failedImsClient,
        },
      });
      const suggestionsControllerWithFailedIms = SuggestionsControllerWithFailedIms({
        dataAccess: mockSuggestionDataAccess,
        ...authContext,
      }, spySqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(suggs[0]),
          mockSuggestionEntity(suggs[2])],
      );
      mockSuggestion.bulkUpdateStatus.resolves([mockSuggestionEntity({ ...suggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...suggs[2], status: 'IN_PROGRESS' })]);
      const response = await suggestionsControllerWithFailedIms.autofixSuggestions({
        pathInfo: {
          headers: {
            authorization: 'Bearer token123',
          },
        },
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]] },
      });
      expect(response.status).to.equal(500);
      const error = await response.json();
      expect(error).to.have.property('message', 'Error getting promise token');
    });
  });

  describe('removeSuggestion', () => {
    /* create unit test suite for this code:

  const removeSuggestion = async (context) => {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;
    const suggestionId = context.params?.opportunityId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    if (!isValidUUID(suggestionId)) {
      return badRequest('Suggestion ID required');
    }

    const opportunity = await Opportunities.findById(siteId, opportunityId);

    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    const suggestion = await Suggestion.findById(suggestionId);

    if (!suggestion || suggestion.getOpportunityId() !== opportunityId) {
      return notFound('Suggestion not found');
    }

    try {
      await suggestion.remove();
      return noContent();
    } catch (e) {
      return createResponse({ message: 'Error removing suggestion' }, 500);
    }
  };
     */

    it('returns bad request if no site ID is passed', async () => {
      const response = await suggestionsController.removeSuggestion({
        params: {
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site ID required');
    });

    it('returns bad request if site ID is not valid', async () => {
      const response = await suggestionsController.removeSuggestion({
        params: {
          siteId: SITE_ID_NOT_FOUND,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site not found');
    });

    it('returns forbidden if user does not belong to the organization ', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
      const response = await suggestionsController.removeSuggestion({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(403);
      const error = await response.json();
      expect(error).to.have.property('message', 'User does not belong to the organization');
    });

    it('returns bad request if no opportunity ID is passed', async () => {
      const response = await suggestionsController.removeSuggestion({
        params: {
          siteId: SITE_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Opportunity ID required');
    });

    it('returns bad request if no suggestion ID is passed', async () => {
      const response = await suggestionsController.removeSuggestion({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Suggestion ID required');
    });

    it('returns not found if opportunity is not found', async () => {
      const response = await suggestionsController.removeSuggestion({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID_NOT_FOUND,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Opportunity not found');
    });

    it('returns not found if suggestion is not found', async () => {
      mockSuggestion.findById.resolves(null);
      const response = await suggestionsController.removeSuggestion({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Suggestion not found');
    });

    it('returns internal server error if remove fails', async () => {
      const error = new Error('remove error');
      removeStub.rejects(error);
      const response = await suggestionsController.removeSuggestion({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(500);
      const errorResponse = await response.json();
      expect(errorResponse).to.have.property('message', 'Error removing suggestion');
    });

    it('removes a suggestion', async () => {
      suggs[0].remove = sandbox.stub().resolves();
      const response = await suggestionsController.removeSuggestion({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(204);
      expect(mockSuggestionDataAccess.Suggestion.findById).to.have.been.calledOnce;
      expect(mockSuggestionDataAccess.Opportunity.findById).to.have.been.calledOnce;
      expect(removeStub).to.have.been.calledOnce;
    });
  });

  describe('getSuggestionFixes', () => {
    const FIX_ENTITY_ID = 'fix-entity-123';
    const SUGGESTION_ID = SUGGESTION_IDS[0];

    let mockFixEntity;
    let mockSuggestionWithFix;
    let mockSuggestionWithoutFix;

    beforeEach(() => {
      // Mock FixEntity
      mockFixEntity = {
        findById: sandbox.stub(),
      };

      // Add FixEntity to mockSuggestionDataAccess
      mockSuggestionDataAccess.FixEntity = mockFixEntity;

      // Mock suggestion with fix entity
      mockSuggestionWithFix = mockSuggestionEntity({
        id: SUGGESTION_ID,
        opportunityId: OPPORTUNITY_ID,
        type: 'METADATA_UPDATE',
        rank: 1,
        data: { test: 'data' },
        status: 'NEW',
        fixEntityId: FIX_ENTITY_ID,
      });
      mockSuggestionWithFix.getFixEntityId = sandbox.stub().returns(FIX_ENTITY_ID);
      mockSuggestionWithFix.getOpportunity = sandbox.stub().resolves({
        getSiteId: () => SITE_ID,
      });

      // Mock suggestion without fix entity
      mockSuggestionWithoutFix = mockSuggestionEntity({
        id: SUGGESTION_ID,
        opportunityId: OPPORTUNITY_ID,
        type: 'METADATA_UPDATE',
        rank: 1,
        data: { test: 'data' },
        status: 'NEW',
        fixEntityId: null,
      });
      mockSuggestionWithoutFix.getFixEntityId = sandbox.stub().returns(null);
      mockSuggestionWithoutFix.getOpportunity = sandbox.stub().resolves({
        getSiteId: () => SITE_ID,
      });

      // Mock the fix entity
      const mockFixEntityInstance = {
        getId: () => FIX_ENTITY_ID,
        getOpportunityId: () => OPPORTUNITY_ID,
        getType: () => 'METADATA_UPDATE',
        getCreatedAt: () => '2023-01-01T00:00:00.000Z',
        getExecutedBy: () => 'test@example.com',
        getExecutedAt: () => '2023-01-01T01:00:00.000Z',
        getPublishedAt: () => '2023-01-01T02:00:00.000Z',
        getChangeDetails: () => ({ test: 'data' }),
        getStatus: () => 'COMPLETED',
      };

      mockFixEntity.findById.withArgs(FIX_ENTITY_ID).resolves(mockFixEntityInstance);
      mockFixEntity.findById.withArgs('non-existent-fix').resolves(null);
    });

    it('returns 400 if site ID is not a valid UUID', async () => {
      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: 'invalid-uuid',
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_ID,
        },
        ...context,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site ID required');
    });

    it('returns 400 if opportunity ID is not a valid UUID', async () => {
      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: 'invalid-uuid',
          suggestionId: SUGGESTION_ID,
        },
        ...context,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Opportunity ID required');
    });

    it('returns 400 if suggestion ID is not a valid UUID', async () => {
      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: 'invalid-uuid',
        },
        ...context,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Suggestion ID required');
    });

    it('returns 404 if site is not found', async () => {
      mockSite.findById.withArgs(SITE_ID_NOT_FOUND).resolves(null);

      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID_NOT_FOUND,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_ID,
        },
        ...context,
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site not found');
    });

    it('returns 403 if user does not have access to the site', async () => {
      const accessControlStub = sandbox.stub(AccessControlUtil.prototype, 'hasAccess');
      accessControlStub.resolves(false);

      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_ID,
        },
        ...context,
      });

      expect(response.status).to.equal(403);
      const error = await response.json();
      expect(error).to.have.property('message', 'User does not belong to the organization');
    });

    it('returns 404 if suggestion is not found', async () => {
      const nonExistentSuggestionId = 'b4b6055c-de4b-4552-bc0c-01fdb45b98d5';
      mockSuggestion.findById.withArgs(nonExistentSuggestionId).resolves(null);

      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: nonExistentSuggestionId,
        },
        ...context,
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Suggestion not found');
    });

    it('returns 404 if suggestion does not belong to the opportunity', async () => {
      const wrongOpportunitySuggestion = mockSuggestionEntity({
        id: SUGGESTION_ID,
        opportunityId: 'different-opportunity-id',
        type: 'METADATA_UPDATE',
        rank: 1,
        data: { test: 'data' },
        status: 'NEW',
      });

      mockSuggestion.findById.withArgs(SUGGESTION_ID).resolves(wrongOpportunitySuggestion);

      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_ID,
        },
        ...context,
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Suggestion not found');
    });

    it('returns 404 if opportunity does not belong to the site', async () => {
      const suggestionWithWrongSite = mockSuggestionEntity({
        id: SUGGESTION_ID,
        opportunityId: OPPORTUNITY_ID,
        type: 'METADATA_UPDATE',
        rank: 1,
        data: { test: 'data' },
        status: 'NEW',
      });
      suggestionWithWrongSite.getOpportunity = sandbox.stub().resolves({
        getSiteId: () => 'different-site-id',
      });

      mockSuggestion.findById.withArgs(SUGGESTION_ID).resolves(suggestionWithWrongSite);

      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_ID,
        },
        ...context,
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Suggestion not found');
    });

    it('returns empty array if suggestion has no associated fix entity', async () => {
      mockSuggestion.findById.withArgs(SUGGESTION_ID).resolves(mockSuggestionWithoutFix);

      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_ID,
        },
        ...context,
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.be.an('array').that.is.empty;
    });

    it('returns empty array if fix entity is not found', async () => {
      const suggestionWithNonExistentFix = mockSuggestionEntity({
        id: SUGGESTION_ID,
        opportunityId: OPPORTUNITY_ID,
        type: 'METADATA_UPDATE',
        rank: 1,
        data: { test: 'data' },
        status: 'NEW',
      });
      suggestionWithNonExistentFix.getFixEntityId = sandbox.stub().returns('non-existent-fix');
      suggestionWithNonExistentFix.getOpportunity = sandbox.stub().resolves({
        getSiteId: () => SITE_ID,
      });

      mockSuggestion.findById.withArgs(SUGGESTION_ID).resolves(suggestionWithNonExistentFix);

      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_ID,
        },
        ...context,
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.be.an('array').that.is.empty;
    });

    it('successfully returns array of fix entities when all conditions are met', async () => {
      mockSuggestion.findById.withArgs(SUGGESTION_ID).resolves(mockSuggestionWithFix);

      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_ID,
        },
        ...context,
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0]).to.deep.equal({
        id: FIX_ENTITY_ID,
        opportunityId: OPPORTUNITY_ID,
        type: 'METADATA_UPDATE',
        createdAt: '2023-01-01T00:00:00.000Z',
        executedBy: 'test@example.com',
        executedAt: '2023-01-01T01:00:00.000Z',
        publishedAt: '2023-01-01T02:00:00.000Z',
        changeDetails: { test: 'data' },
        status: 'COMPLETED',
      });

      // Verify that the FixEntity was queried with the correct ID
      expect(mockFixEntity.findById).to.have.been.calledWith(FIX_ENTITY_ID);
    });

    it('verifies all method calls are made in correct order', async () => {
      mockSuggestion.findById.withArgs(SUGGESTION_ID).resolves(mockSuggestionWithFix);

      await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_ID,
        },
        ...context,
      });

      // Verify the sequence of calls
      expect(mockSite.findById).to.have.been.calledWith(SITE_ID);
      expect(mockSuggestion.findById).to.have.been.calledWith(SUGGESTION_ID);
      expect(mockSuggestionWithFix.getOpportunity).to.have.been.called;
      expect(mockSuggestionWithFix.getFixEntityId).to.have.been.called;
      expect(mockFixEntity.findById).to.have.been.calledWith(FIX_ENTITY_ID);
    });

    it('returns array structure ready for future many-to-many relationship', async () => {
      mockSuggestion.findById.withArgs(SUGGESTION_ID).resolves(mockSuggestionWithFix);

      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_ID,
        },
        ...context,
      });

      expect(response.status).to.equal(200);
      const result = await response.json();

      // Verify it's an array (ready for future many-to-many)
      expect(result).to.be.an('array');
      expect(result).to.have.lengthOf(1);

      // Verify array contains proper fix entity structure
      expect(result[0]).to.have.property('id', FIX_ENTITY_ID);
      expect(result[0]).to.have.property('opportunityId', OPPORTUNITY_ID);
      expect(result[0]).to.have.property('type', 'METADATA_UPDATE');
      expect(result[0]).to.have.property('status', 'COMPLETED');
    });
  });

  describe('autofixSuggestions access control', () => {
    it('returns forbidden when user does not have auto_fix permission', async () => {
      // Mock site and opportunity
      const testSite = {
        id: SITE_ID,
        getImsOrgId: () => 'test-org-id',
        getDeliveryType: () => 'aem_edge',
        getId: () => SITE_ID,
        getBaseURL: () => 'https://test.com',
      };

      // Setup mocks using existing mockSuggestionDataAccess
      mockSuggestionDataAccess.Site.findById.resolves(testSite);
      mockSuggestionDataAccess.Opportunity.findById.resolves({
        getSiteId: () => SITE_ID,
        getType: () => 'broken-backlinks',
      });

      // Mock AccessControlUtil to specifically deny auto_fix permission
      const accessControlStub = sandbox.stub(AccessControlUtil.prototype, 'hasAccess');
      accessControlStub.callsFake((testEntity, permission) => {
        if (permission === 'auto_fix') {
          return false;
        }
        return true;
      });

      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(403);
      const error = await response.json();
      // Split long line into multiple lines
      expect(error).to.have.property(
        'message',
        'User does not belong to the organization or does not have sufficient permissions',
      );

      // Verify the access control was called with auto_fix permission
      expect(accessControlStub).to.have.been.calledWith(
        sinon.match.has('getId', sinon.match.func),
        'auto_fix',
      );
    });

    it('allows autofix when user has auto_fix permission', async () => {
      // Mock site and opportunity
      const testSite = {
        id: SITE_ID,
        getImsOrgId: () => 'test-org-id',
        getDeliveryType: () => 'aem_edge',
        getId: () => SITE_ID,
        getBaseURL: () => 'https://test.com',
      };

      // Setup mocks using existing mockSuggestionDataAccess
      mockSuggestionDataAccess.Site.findById.resolves(testSite);
      mockSuggestionDataAccess.Opportunity.findById.resolves({
        getSiteId: () => SITE_ID,
        getType: () => 'broken-backlinks',
      });
      mockSuggestionDataAccess.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
      });
      mockSuggestion.allByOpportunityId.resolves([]);

      // Mock AccessControlUtil to allow auto_fix permission
      const accessControlStub = sandbox.stub(AccessControlUtil.prototype, 'hasAccess');
      accessControlStub.callsFake((testEntity, permission) => {
        if (permission === 'auto_fix') {
          return true;
        }
        return true;
      });

      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      // Should proceed to next checks (not forbidden)
      expect(response.status).to.equal(207);

      // Verify the access control was called with auto_fix permission
      expect(accessControlStub).to.have.been.calledWith(
        sinon.match.has('getId', sinon.match.func),
        'auto_fix',
      );
    });
  });
});
