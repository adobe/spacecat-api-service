/* eslint-disable */

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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

import { ValidationError, Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import TokowakaClient from '@adobe/spacecat-shared-tokowaka-client';
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
    'getAllForOpportunityPaged',
    'deploySuggestionToEdge',
    'rollbackSuggestionFromEdge',
    'previewSuggestions',
    'fetchFromEdge',
    'getByID',
    'getByStatus',
    'getByStatusPaged',
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
  let formAccessibilitySuggs;
  let context;
  let apikeyAuthAttributes;

  let mockSuggestionResults;

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
      getData: sandbox.stub().returns({}),
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

    formAccessibilitySuggs = [
      {
        id: SUGGESTION_IDS[0],
        opportunityId: OPPORTUNITY_ID,
        type: 'CODE_CHANGE',
        rank: 1,
        status: 'NEW',
        data: {
          isCodeChangeAvailable: true,
          diffContent: 'diff --git ...',
          source: 'form',
          type: 'url',
          issues: [
            {
              wcagLevel: 'AA',
              severity: 'serious',
              occurrences: 1,
              htmlWithIssues: [
                {
                  targetSelector: 'label[for="country"] > span',
                  updateFrom: '<span>(Optional)</span>',
                },
              ],
              failureSummary: 'Fix any of the following:\n  Element has insufficient color contrast',
              wcagRule: '1.4.3 Contrast (Minimum)',
              understandingUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
              description: 'Elements must meet minimum color contrast ratio thresholds',
              type: 'color-contrast',
            },
          ],
          url: 'https://www.sunstar.com/contact',
        },
        createdAt: '2025-09-11T06:09:32.472Z',
        updatedAt: '2025-10-08T06:31:21.459Z',
        updatedBy: 'system',
      },
      {
        id: SUGGESTION_IDS[1],
        opportunityId: OPPORTUNITY_ID,
        type: 'CODE_CHANGE',
        rank: 2,
        status: 'NEW',
        data: {
          isCodeChangeAvailable: true,
          diffContent: 'diff --git ...',
          source: 'form',
          type: 'url',
          issues: [
            {
              wcagLevel: 'AA',
              severity: 'serious',
              occurrences: 1,
              htmlWithIssues: [
                {
                  targetSelector: 'input[type="email"]',
                  updateFrom: '<input type="email" />',
                },
              ],
              failureSummary: 'Form elements must have labels',
              wcagRule: '1.3.1 Info and Relationships',
              understandingUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html',
              description: 'Form elements must have labels',
              type: 'label',
            },
          ],
          url: 'https://www.sunstar.com/contact',
        },
        createdAt: '2025-09-11T06:09:32.472Z',
        updatedAt: '2025-10-08T06:31:21.459Z',
        updatedBy: 'system',
      },
    ];

    const isHandlerEnabledForSite = sandbox.stub();
    isHandlerEnabledForSite.withArgs('broken-backlinks-auto-fix', site).returns(true);
    isHandlerEnabledForSite.withArgs('alt-text-auto-fix', site).returns(true);
    isHandlerEnabledForSite.withArgs('meta-tags-auto-fix', site).returns(true);
    isHandlerEnabledForSite.withArgs('form-accessibility-auto-fix', site).returns(true);
    isHandlerEnabledForSite.withArgs('product-metatags-auto-fix', site).returns(true);
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

    mockSuggestionResults = {
      data: [mockSuggestionEntity(suggs[0])],
      cursor: undefined,
    };

    mockSuggestion = {
      allByOpportunityId: sandbox.stub().callsFake((opptyId, options) => {
        // If options are provided (paged call), return object with data and cursor
        if (options) {
          return Promise.resolve(mockSuggestionResults);
        }
        // Otherwise (non-paged call), return array directly
        return Promise.resolve([mockSuggestionEntity(suggs[0])]);
      }),

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
      getFixEntitiesBySuggestionId: sandbox.stub(),
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

    suggestionsController = SuggestionsController({
      dataAccess: mockSuggestionDataAccess,
      pathInfo: { headers: { 'x-product': 'llmo' } },
      ...authContext,
    }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
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

  it('gets paged suggestions returns bad request if limit is less than 1', async () => {
    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        limit: -1,
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Page size must be greater than 0');
  });

  it('gets paged suggestions returns bad request if site ID is missing', async () => {
    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets paged suggestions returns bad request if opportunity ID is missing', async () => {
    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID,
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('gets paged suggestions returns not found if site does not exist', async () => {
    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID_NOT_FOUND,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site not found');
  });

  it('gets paged suggestions returns forbidden if user does not have access', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'User does not belong to the organization');
  });

  it('gets paged suggestions returns not found if opportunity does not belong to site', async () => {
    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID_NOT_ENABLED,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
  });

  it('gets paged suggestions for an opportunity successfully', async () => {
    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        limit: 10,
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    const result = await response.json();
    expect(result).to.have.property('suggestions');
    expect(result.suggestions).to.be.an('array').with.lengthOf(1);
    expect(result).to.have.property('pagination');
    expect(result.pagination).to.have.property('limit', 10);
    expect(result.pagination).to.have.property('cursor', null);
    expect(result.pagination).to.have.property('hasMore', false);
  });

  it('gets paged suggestions returns empty array when no suggestions exist', async () => {
    const emptyResults = {
      data: [],
      cursor: undefined,
    };
    mockSuggestion.allByOpportunityId.resolves(emptyResults);
    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        limit: 10,
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    const result = await response.json();
    expect(result).to.have.property('suggestions');
    expect(result.suggestions).to.be.an('array').with.lengthOf(0);
    expect(result.pagination).to.have.property('limit', 10);
    expect(result.pagination).to.have.property('cursor', null);
    expect(result.pagination).to.have.property('hasMore', false);
  });

  it('gets paged suggestions successfully when parameters come as strings from URL', async () => {
    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        limit: '20',
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    const result = await response.json();
    expect(result).to.have.property('suggestions');
    expect(result.suggestions).to.be.an('array').with.lengthOf(1);
    expect(result).to.have.property('pagination');
    expect(result.pagination).to.have.property('limit', 20);
    expect(result.pagination).to.have.property('cursor', null);
    expect(result.pagination).to.have.property('hasMore', false);
  });

  it('gets paged suggestions with cursor for next page', async () => {
    const nextCursorToken = 'next-page-cursor-uuid-123e4567-e89b-12d3-a456-426614174000';
    const resultsWithCursor = {
      data: [mockSuggestionEntity(suggs[0])],
      cursor: nextCursorToken,
    };
    mockSuggestion.allByOpportunityId.resolves(resultsWithCursor);

    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        limit: 10,
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    const result = await response.json();
    expect(result).to.have.property('suggestions');
    expect(result.suggestions).to.be.an('array').with.lengthOf(1);
    expect(result).to.have.property('pagination');
    expect(result.pagination).to.have.property('limit', 10);
    expect(result.pagination).to.have.property('cursor', nextCursorToken);
    expect(result.pagination).to.have.property('hasMore', true);
  });

  it('gets paged suggestions passes cursor and limit to allByOpportunityId', async () => {
    const cursorValue = '123e4567-e89b-12d3-a456-426614174000';
    const resultsWithCursor = {
      data: [mockSuggestionEntity(suggs[0])],
      cursor: undefined,
    };
    mockSuggestion.allByOpportunityId.resolves(resultsWithCursor);

    await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        limit: 25,
        cursor: cursorValue,
      },
      ...context,
    });

    expect(mockSuggestion.allByOpportunityId).to.have.been.calledOnce;
    expect(mockSuggestion.allByOpportunityId).to.have.been.calledWith(OPPORTUNITY_ID, {
      limit: 25,
      cursor: cursorValue,
      returnCursor: true,
    });
  });

  it('gets paged suggestions returns not found when opportunity is null', async () => {
    const mockEntity = mockSuggestionEntity(suggs[0]);
    // Override getOpportunity to return null
    mockEntity.getOpportunity = () => null;

    const resultsWithNullOpportunity = {
      data: [mockEntity],
      cursor: undefined,
    };
    mockSuggestion.allByOpportunityId.resolves(resultsWithNullOpportunity);

    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        limit: 10,
      },
      ...context,
    });

    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
  });

  it('gets paged suggestions returns not found when opportunity belongs to different site', async () => {
    const wrongSiteId = '22222222-2222-2222-2222-222222222222';
    const mockEntity = mockSuggestionEntity(suggs[0]);
    // Override getOpportunity to return different siteId
    mockEntity.getOpportunity = () => ({
      getSiteId() {
        return wrongSiteId;
      },
    });

    const resultsWithWrongSite = {
      data: [mockEntity],
      cursor: undefined,
    };
    mockSuggestion.allByOpportunityId.resolves(resultsWithWrongSite);

    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        limit: 10,
      },
      ...context,
    });

    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
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

  it('gets paged suggestions by status returns bad request if site ID is missing', async () => {
    const response = await suggestionsController.getByStatusPaged({
      params: {
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets paged suggestions by status returns bad request if opportunity ID is missing', async () => {
    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('gets paged suggestions by status returns bad request if status is missing', async () => {
    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Status is required');
  });

  it('gets paged suggestions by status returns bad request if limit is less than 1', async () => {
    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
        limit: -1,
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Page size must be greater than 0');
  });

  it('gets paged suggestions by status returns not found if site does not exist', async () => {
    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID_NOT_FOUND,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site not found');
  });

  it('gets paged suggestions by status returns forbidden if user does not have access', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'User does not belong to the organization');
  });

  it('gets paged suggestions by status returns not found if opportunity does not belong to site', async () => {
    mockSuggestion.allByOpportunityIdAndStatus.callsFake((opptyId, status, options) => {
      if (options) {
        return Promise.resolve({
          data: [mockSuggestionEntity(suggs[0])],
          cursor: undefined,
        });
      }
      return Promise.resolve([mockSuggestionEntity(suggs[0])]);
    });
    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID_NOT_ENABLED,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
  });

  it('gets paged suggestions by status successfully', async () => {
    mockSuggestion.allByOpportunityIdAndStatus.callsFake((opptyId, status, options) => {
      if (options) {
        return Promise.resolve({
          data: [mockSuggestionEntity(suggs[0])],
          cursor: undefined,
        });
      }
      return Promise.resolve([mockSuggestionEntity(suggs[0])]);
    });
    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.true;
    expect(response.status).to.equal(200);
    const result = await response.json();
    expect(result).to.have.property('suggestions');
    expect(result.suggestions).to.be.an('array').with.lengthOf(1);
    expect(result).to.have.property('pagination');
    expect(result.pagination).to.deep.equal({
      limit: 100,
      cursor: null,
      hasMore: false,
    });
  });

  it('gets paged suggestions by status with empty results', async () => {
    mockSuggestion.allByOpportunityIdAndStatus.callsFake((opptyId, status, options) => {
      if (options) {
        return Promise.resolve({
          data: [],
          cursor: undefined,
        });
      }
      return Promise.resolve([]);
    });
    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    const result = await response.json();
    expect(result.suggestions).to.be.an('array').with.lengthOf(0);
    expect(result.pagination).to.deep.equal({
      limit: 100,
      cursor: null,
      hasMore: false,
    });
  });

  it('gets paged suggestions by status successfully when parameters come as strings from URL', async () => {
    mockSuggestion.allByOpportunityIdAndStatus.callsFake((opptyId, status, options) => {
      if (options) {
        return Promise.resolve({
          data: [mockSuggestionEntity(suggs[0])],
          cursor: 'next-cursor-value',
        });
      }
      return Promise.resolve([mockSuggestionEntity(suggs[0])]);
    });
    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
        limit: '50',
        cursor: 'some-cursor',
      },
      ...context,
    });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.true;
    expect(response.status).to.equal(200);
    const result = await response.json();
    expect(result.suggestions).to.be.an('array').with.lengthOf(1);
    expect(result.pagination).to.deep.equal({
      limit: 50,
      cursor: 'next-cursor-value',
      hasMore: true,
    });
  });

  it('gets paged suggestions by status with cursor parameter calls with correct options', async () => {
    mockSuggestion.allByOpportunityIdAndStatus.callsFake((opptyId, status, options) => {
      if (options) {
        return Promise.resolve({
          data: [mockSuggestionEntity(suggs[0])],
          cursor: 'next-cursor',
        });
      }
      return Promise.resolve([mockSuggestionEntity(suggs[0])]);
    });

    await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
        limit: 25,
        cursor: 'previous-cursor',
      },
      ...context,
    });

    expect(mockSuggestion.allByOpportunityIdAndStatus).to.have.been.calledWith(
      OPPORTUNITY_ID,
      'NEW',
      {
        limit: 25,
        cursor: 'previous-cursor',
        returnCursor: true,
      },
    );
  });

  it('gets paged suggestions by status handles null opportunity correctly', async () => {
    const mockSuggestionWithNullOpportunity = {
      ...mockSuggestionEntity(suggs[0]),
      getOpportunity: sandbox.stub().returns(null),
    };

    mockSuggestion.allByOpportunityIdAndStatus.callsFake((opptyId, status, options) => {
      if (options) {
        return Promise.resolve({
          data: [mockSuggestionWithNullOpportunity],
          cursor: null,
        });
      }
      return Promise.resolve([mockSuggestionWithNullOpportunity]);
    });

    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });

    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
  });

  it('gets paged suggestions by status handles opportunity with wrong site ID', async () => {
    const mockSuggestionWithWrongSite = {
      ...mockSuggestionEntity(suggs[0]),
      getOpportunity: sandbox.stub().returns({
        getSiteId: () => SITE_ID_NOT_ENABLED,
      }),
    };

    mockSuggestion.allByOpportunityIdAndStatus.callsFake((opptyId, status, options) => {
      if (options) {
        return Promise.resolve({
          data: [mockSuggestionWithWrongSite],
          cursor: null,
        });
      }
      return Promise.resolve([mockSuggestionWithWrongSite]);
    });

    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      ...context,
    });

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

  describe('getSuggestionFixes', () => {
    const FIX_IDS = [
      'fix-id-1',
      'fix-id-2',
      'fix-id-3',
    ];

    const mockFixEntities = [
      {
        getId: () => FIX_IDS[0],
        getOpportunityId: () => OPPORTUNITY_ID,
        getType: () => 'CODE_CHANGE',
        getCreatedAt: () => '2025-01-01T00:00:00.000Z',
        getUpdatedAt: () => '2025-01-01T00:00:00.000Z',
        getExecutedBy: () => 'test@test.com',
        getExecutedAt: () => '2025-01-01T01:00:00.000Z',
        getPublishedAt: () => '2025-01-01T02:00:00.000Z',
        getChangeDetails: () => ({ file: 'index.js', changes: 'updated' }),
        getStatus: () => 'COMPLETED',
        getOrigin: () => 'MANUAL',
      },
      {
        getId: () => FIX_IDS[1],
        getOpportunityId: () => OPPORTUNITY_ID,
        getType: () => 'CONTENT_UPDATE',
        getCreatedAt: () => '2025-01-02T00:00:00.000Z',
        getUpdatedAt: () => '2025-01-02T00:00:00.000Z',
        getExecutedBy: () => 'test@test.com',
        getExecutedAt: () => '2025-01-02T01:00:00.000Z',
        getPublishedAt: () => null,
        getChangeDetails: () => ({ content: 'new content' }),
        getStatus: () => 'IN_PROGRESS',
        getOrigin: () => 'MANUAL',
      },
    ];

    beforeEach(() => {
      mockSuggestion.getFixEntitiesBySuggestionId.resolves(mockFixEntities);
    });

    it('gets all fixes for a suggestion successfully', async () => {
      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.have.property('data');
      expect(result.data).to.be.an('array').with.lengthOf(2);
      expect(result.data[0]).to.have.property('id', FIX_IDS[0]);
      expect(result.data[0]).to.have.property('type', 'CODE_CHANGE');
      expect(result.data[0]).to.have.property('status', 'COMPLETED');
      expect(result.data[1]).to.have.property('id', FIX_IDS[1]);
      expect(result.data[1]).to.have.property('type', 'CONTENT_UPDATE');
      expect(mockSuggestion.getFixEntitiesBySuggestionId)
        .to.have.been.calledOnceWith(SUGGESTION_IDS[0]);
    });

    it('returns empty array when suggestion has no fixes', async () => {
      mockSuggestion.getFixEntitiesBySuggestionId.resolves([]);
      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.have.property('data');
      expect(result.data).to.be.an('array').with.lengthOf(0);
    });

    it('returns bad request if no site ID is passed', async () => {
      const response = await suggestionsController.getSuggestionFixes({
        params: {
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site ID required');
      expect(mockSuggestion.getFixEntitiesBySuggestionId).to.not.have.been.called;
    });

    it('returns bad request if no opportunity ID is passed', async () => {
      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Opportunity ID required');
      expect(mockSuggestion.getFixEntitiesBySuggestionId).to.not.have.been.called;
    });

    it('returns bad request if no suggestion ID is passed', async () => {
      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Suggestion ID required');
      expect(mockSuggestion.getFixEntitiesBySuggestionId).to.not.have.been.called;
    });

    it('returns not found if site does not exist', async () => {
      const response = await suggestionsController.getSuggestionFixes({
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
      expect(mockSuggestion.getFixEntitiesBySuggestionId).to.not.have.been.called;
    });

    it('returns forbidden if user does not belong to the organization', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
      const response = await suggestionsController.getSuggestionFixes({
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
      expect(mockSuggestion.getFixEntitiesBySuggestionId).to.not.have.been.called;
    });

    it('returns 500 error if getFixEntitiesBySuggestionId throws an error', async () => {
      mockSuggestion.getFixEntitiesBySuggestionId.rejects(new Error('Database error'));
      const response = await suggestionsController.getSuggestionFixes({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          suggestionId: SUGGESTION_IDS[0],
        },
        ...context,
      });
      expect(response.status).to.equal(500);
      const error = await response.json();
      expect(error).to.have.property('message', 'Error retrieving fixes for suggestion');
    });
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
    let suggestionsControllerWithMock;
    beforeEach(async () => {
      const mockPromiseToken = {
        promise_token: 'promiseTokenExample',
        expires_in: 14399,
        token_type: 'promise_token',
      };

      const suggestionControllerWithMock = await esmock('../../src/controllers/suggestions.js', {
        '../../src/support/utils.js': {
          getIMSPromiseToken: async () => mockPromiseToken,
        },
      });
      suggestionsControllerWithMock = suggestionControllerWithMock({
        dataAccess: mockSuggestionDataAccess,
        pathInfo: { headers: { 'x-product': 'abcd' } },
        ...authContext,
      }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('triggers autofixSuggestion and sets suggestions to in-progress', async () => {
      opportunity.getType = sandbox.stub().returns('meta-tags');
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(suggs[0]), mockSuggestionEntity(suggs[2])],
      );
      mockSuggestion.bulkUpdateStatus.resolves([mockSuggestionEntity({ ...suggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...suggs[2], status: 'IN_PROGRESS' }),
      ]);
      const response = await suggestionsControllerWithMock.autofixSuggestions({
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
      const response = await suggestionsControllerWithMock.autofixSuggestions({
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

    it('triggers autofixSuggestion for form-accessibility (non-grouped)', async () => {
      opportunity.getType = sandbox.stub().returns('form-accessibility');
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(formAccessibilitySuggs[0]),
          mockSuggestionEntity(formAccessibilitySuggs[1])],
      );
      mockSuggestion.bulkUpdateStatus.resolves([
        mockSuggestionEntity({ ...formAccessibilitySuggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...formAccessibilitySuggs[1], status: 'IN_PROGRESS' }),
      ]);
      const response = await suggestionsControllerWithMock.autofixSuggestions({
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
      expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[0].suggestion).to.have.property('status', 'IN_PROGRESS');
      expect(bulkPatchResponse.suggestions[1].suggestion).to.have.property('status', 'IN_PROGRESS');
      // Verify SQS was called once (non-grouped behavior)
      expect(mockSqs.sendMessage).to.have.been.calledOnce;
    });

    it('triggers autofixSuggestion for form-accessibility with multiple suggestions from same URL', async () => {
      opportunity.getType = sandbox.stub().returns('form-accessibility');
      // Both suggestions have the same URL
      const formSugg1 = { ...formAccessibilitySuggs[0] };
      const formSugg2 = {
        ...formAccessibilitySuggs[1],
        id: SUGGESTION_IDS[2],
        data: {
          ...formAccessibilitySuggs[1].data,
          url: 'https://www.sunstar.com/contact', // Same URL as first suggestion
        },
      };
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(formSugg1),
          mockSuggestionEntity(formSugg2)],
      );
      mockSuggestion.bulkUpdateStatus.resolves([
        mockSuggestionEntity({ ...formSugg1, status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...formSugg2, status: 'IN_PROGRESS' }),
      ]);
      const response = await suggestionsControllerWithMock.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]] },
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse.metadata).to.have.property('success', 2);
      // Verify SQS was called once with all suggestions, not grouped by URL
      expect(mockSqs.sendMessage).to.have.been.calledOnce;
    });

    it('triggers autofixSuggestion for product-metatags (non-grouped)', async () => {
      opportunity.getType = sandbox.stub().returns('product-metatags');
      const productMetatagsSuggs = [
        {
          id: SUGGESTION_IDS[0],
          opportunityId: OPPORTUNITY_ID,
          type: 'METADATA_UPDATE',
          rank: 1,
          status: 'NEW',
          data: {
            url: 'https://www.example.com/product1',
            metaTags: { description: 'Product description' },
          },
          updatedAt: new Date(),
        },
        {
          id: SUGGESTION_IDS[1],
          opportunityId: OPPORTUNITY_ID,
          type: 'METADATA_UPDATE',
          rank: 2,
          status: 'NEW',
          data: {
            url: 'https://www.example.com/product2',
            metaTags: { title: 'Product title' },
          },
          updatedAt: new Date(),
        },
      ];
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(productMetatagsSuggs[0]),
          mockSuggestionEntity(productMetatagsSuggs[1])],
      );
      mockSuggestion.bulkUpdateStatus.resolves([
        mockSuggestionEntity({ ...productMetatagsSuggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...productMetatagsSuggs[1], status: 'IN_PROGRESS' }),
      ]);
      const response = await suggestionsControllerWithMock.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse.metadata).to.have.property('total', 2);
      expect(bulkPatchResponse.metadata).to.have.property('success', 2);
      expect(bulkPatchResponse.metadata).to.have.property('failed', 0);
      expect(bulkPatchResponse.suggestions).to.have.property('length', 2);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[1]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[0].suggestion).to.have.property('status', 'IN_PROGRESS');
      expect(bulkPatchResponse.suggestions[1].suggestion).to.have.property('status', 'IN_PROGRESS');
      // Verify SQS was called once (non-grouped behavior)
      expect(mockSqs.sendMessage).to.have.been.calledOnce;
    });

    it('triggers autofixSuggestion with customData for non-grouped type', async () => {
      opportunity.getType = sandbox.stub().returns('product-metatags');
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(suggs[0]), mockSuggestionEntity(suggs[2])],
      );
      mockSuggestion.bulkUpdateStatus.resolves([
        mockSuggestionEntity({ ...suggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...suggs[2], status: 'IN_PROGRESS' }),
      ]);

      const customData = {
        workflowId: 'test-workflow-123',
        additionalParam: 'test-value',
      };

      const response = await suggestionsControllerWithMock.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]],
          customData,
        },
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse.metadata).to.have.property('success', 2);

      // Verify sendAutofixMessage was called with customData
      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const sqsCallArgs = mockSqs.sendMessage.firstCall.args;
      expect(sqsCallArgs[1]).to.have.property('customData');
      expect(sqsCallArgs[1].customData).to.deep.equal(customData);
    });

    it('triggers autofixSuggestion without customData for grouped type', async () => {
      opportunity.getType = sandbox.stub().returns('form-accessibility');
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(formAccessibilitySuggs[0])],
      );
      mockSuggestion.bulkUpdateStatus.resolves([
        mockSuggestionEntity({ ...formAccessibilitySuggs[0], status: 'IN_PROGRESS' }),
      ]);

      const response = await suggestionsControllerWithMock.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
          // No customData provided
        },
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse.metadata).to.have.property('success', 1);

      // Verify sendAutofixMessage was called without customData (undefined)
      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const sqsCallArgs = mockSqs.sendMessage.firstCall.args;
      expect(sqsCallArgs[1]).to.not.have.property('customData');
    });

    it('triggers autofixSuggestion with empty customData object for non-grouped type', async () => {
      opportunity.getType = sandbox.stub().returns('product-metatags');
      const productMetatagsSugg = {
        id: SUGGESTION_IDS[0],
        opportunityId: OPPORTUNITY_ID,
        type: 'METADATA_UPDATE',
        rank: 1,
        status: 'NEW',
        data: {
          url: 'https://www.example.com/product1',
          metaTags: { description: 'Product description' },
        },
        updatedAt: new Date(),
      };
      mockSuggestion.allByOpportunityId.resolves([mockSuggestionEntity(productMetatagsSugg)]);
      mockSuggestion.bulkUpdateStatus.resolves([
        mockSuggestionEntity({ ...productMetatagsSugg, status: 'IN_PROGRESS' }),
      ]);

      const response = await suggestionsControllerWithMock.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
          customData: {},
        },
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse.metadata).to.have.property('success', 1);

      // Verify sendAutofixMessage was called with empty customData object
      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const sqsCallArgs = mockSqs.sendMessage.firstCall.args;
      expect(sqsCallArgs[1]).to.have.property('customData');
      expect(sqsCallArgs[1].customData).to.deep.equal({});
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

    it('auto-fix suggestions status returns bad request if variations is not an array', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]], variations: 'not an array' },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'variations must be an array');
    });

    it('auto-fix suggestions status returns bad request if action is empty', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]], action: '' },
        ...context,
      });
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'action cannot be empty');
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
      const response = await suggestionsControllerWithMock.autofixSuggestions({
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
      const response = await suggestionsControllerWithMock.autofixSuggestions({
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
      const response = await suggestionsControllerWithMock.autofixSuggestions({
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

  describe('auto-fix suggestions for CS', function () {
    this.timeout(10000);
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
        pathInfo: { headers: { 'x-product': 'abcd' } },
        ...authContext,
      }, spySqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    });

    it('triggers autofixSuggestion and sets suggestions to in-progress for CS', async () => {
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(suggs[0]),
          mockSuggestionEntity(suggs[2]),
        ],
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
          mockSuggestionEntity(suggs[2]),
        ],
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
          mockSuggestionEntity(suggs[2]),
        ],
      );
      mockSuggestion.bulkUpdateStatus.resolves([mockSuggestionEntity({ ...suggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...suggs[2], status: 'IN_PROGRESS' }),
      ]);
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
        pathInfo: { headers: { 'x-product': 'abcd' } },
        ...authContext,
      }, spySqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(suggs[0]),
          mockSuggestionEntity(suggs[2]),
        ],
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

  describe('autofixSuggestions access control', () => {
    let suggestionsControllerWithMock;
    beforeEach(async () => {
      const mockPromiseToken = {
        promise_token: 'promiseTokenExample',
        expires_in: 14399,
        token_type: 'promise_token',
      };
      const suggestionControllerWithMock = await esmock('../../src/controllers/suggestions.js', {
        '../../src/support/utils.js': {
          getIMSPromiseToken: async () => mockPromiseToken,
        },
      });
      suggestionsControllerWithMock = suggestionControllerWithMock({
        dataAccess: mockSuggestionDataAccess,
        pathInfo: { headers: { 'x-product': 'abcd' } },
        ...authContext,
      }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    });

    afterEach(() => {
      sandbox.restore();
    });

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

      const response = await suggestionsControllerWithMock.autofixSuggestions({
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

  describe('deploySuggestionToEdge (Tokowaka)', () => {
    let s3ClientSendStub;
    let tokowakaSuggestions;
    let headingsOpportunity;

    beforeEach(() => {
      tokowakaSuggestions = [
        {
          getId: () => SUGGESTION_IDS[0],
          getType: () => 'headings',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 1,
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Heading Title',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1.test-selector',
            },
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        },
        {
          getId: () => SUGGESTION_IDS[1],
          getType: () => 'headings',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 2,
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Subtitle',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h2.test-selector',
            },
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        },
      ];

      headingsOpportunity = {
        getId: sandbox.stub().returns(OPPORTUNITY_ID),
        getSiteId: sandbox.stub().returns(SITE_ID),
        getType: sandbox.stub().returns('headings'),
      };

      site.getConfig = sandbox.stub().returns({
        getTokowakaConfig: () => ({ apiKey: 'test-api-key-123' }),
      });
      site.getBaseURL = sandbox.stub().returns('https://example.com');
      site.getId = sandbox.stub().returns(SITE_ID);
      mockOpportunity.findById.resetBehavior();
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(headingsOpportunity);
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID_NOT_ENABLED).resolves(opportunityNotEnabled);
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID_NOT_FOUND).resolves(null);
      mockSuggestion.allByOpportunityId.resetBehavior();
      mockSuggestion.allByOpportunityId.resolves(tokowakaSuggestions);

      s3ClientSendStub = sandbox.stub().callsFake((command) => {
        // Handle GetObjectCommand (fetchConfig) - return NoSuchKey to simulate no existing config
        if (command.constructor.name === 'GetObjectCommand') {
          const error = new Error('NoSuchKey');
          error.name = 'NoSuchKey';
          return Promise.reject(error);
        }
        // Handle PutObjectCommand (uploadConfig) - simulate successful upload
        return Promise.resolve();
      });
      context.s3 = {
        s3Client: {
          send: s3ClientSendStub,
        },
      };
      context.env = {
        TOKOWAKA_SITE_CONFIG_BUCKET: 'test-tokowaka-bucket',
        TOKOWAKA_PREVIEW_BUCKET: 'test-tokowaka-preview-bucket',
        TOKOWAKA_CDN_PROVIDER: 'test-cdn-provider',
        TOKOWAKA_EDGE_URL: 'https://edge-dev.tokowaka.now',
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          cloudfront: {
            distributionId: 'E123456',
            region: 'us-east-1',
          },
        }),
      };
      context.log = {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      };
    });

    it('should deploy headings suggestions successfully', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      // Check metadata
      expect(body.metadata).to.deep.equal({
        total: 2,
        success: 2,
        failed: 0,
      });

      // Check individual suggestions
      expect(body.suggestions).to.have.length(2);
      expect(body.suggestions[0].uuid).to.equal(SUGGESTION_IDS[0]);
      expect(body.suggestions[0].statusCode).to.equal(200);
      expect(body.suggestions[1].uuid).to.equal(SUGGESTION_IDS[1]);
      expect(body.suggestions[1].statusCode).to.equal(200);

      // Verify S3 was called (GET to fetch existing config, PUT to upload)
      expect(s3ClientSendStub.callCount).to.be.at.least(1);
      // Verify PutObjectCommand was called for upload
      const putObjectCalls = s3ClientSendStub.getCalls().filter((call) => call.args[0].constructor.name === 'PutObjectCommand');
      expect(putObjectCalls).to.have.length(2);

      // Verify suggestion data was updated with deployment timestamp
      const firstSugg = tokowakaSuggestions[0];
      const secondSugg = tokowakaSuggestions[1];

      expect(firstSugg.setData.calledOnce).to.be.true;
      expect(secondSugg.setData.calledOnce).to.be.true;

      // Verify tokowakaDeployed field was added
      const firstCallArgs = firstSugg.setData.firstCall.args[0];
      expect(firstCallArgs).to.have.property('tokowakaDeployed');
      expect(firstCallArgs.tokowakaDeployed).to.be.a('number');

      // Verify updatedBy was set
      expect(firstSugg.setUpdatedBy.calledWith('tokowaka-deployment')).to.be.true;
      expect(secondSugg.setUpdatedBy.calledWith('tokowaka-deployment')).to.be.true;

      // Verify save was called
      expect(firstSugg.save.calledOnce).to.be.true;
      expect(secondSugg.save.calledOnce).to.be.true;
    });

    it('should return 400 if siteId is invalid', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: 'invalid-id',
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Site ID required');
    });

    it('should return 400 if opportunityId is invalid', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: 'invalid-id',
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Opportunity ID required');
    });

    it('should return 400 if no data provided', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: null,
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('No data provided');
    });

    it('should return 400 if suggestionIds is empty', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [],
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('non-empty array');
    });

    it('should return 404 if site not found', async () => {
      mockSite.findById.withArgs(SITE_ID).resolves(null);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.equal('Site not found');
    });

    it('should return 403 if user does not have access to site', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(403);
      const body = await response.json();
      expect(body.message).to.equal('User does not belong to the organization');
    });

    it('should return 404 if opportunity not found', async () => {
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(null);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.equal('Opportunity not found');
    });

    it('should return 404 if opportunity does not match siteId', async () => {
      const mismatchedOpportunity = {
        getId: sandbox.stub().returns(OPPORTUNITY_ID),
        getSiteId: sandbox.stub().returns('different-site-id'),
        getType: sandbox.stub().returns('headings'),
      };
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(mismatchedOpportunity);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.equal('Opportunity not found');
    });

    it('should return 500 if site does not have Tokowaka API key', async () => {
      const suggestionsController2 = SuggestionsController({
        dataAccess: {
          ...mockSuggestionDataAccess,
          Site: {
            findById: sandbox.stub().resolves({
              getConfig: sandbox.stub().returns({
                getTokowakaConfig: sandbox.stub().returns({}),
              }),
            }),
          },
        },
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContext,
      }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
      const response = await suggestionsController2.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.metadata.total).to.equal(1);
      expect(body.metadata.failed).to.equal(1);
      expect(body.suggestions[0].statusCode).to.equal(500);
      expect(body.suggestions[0].message).to.include('Internal server error');
    });

    it('should handle S3 upload failure gracefully', async () => {
      s3ClientSendStub.rejects(Object.assign(new Error('S3 upload failed', { status: 403 })));

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      // All suggestions should fail
      expect(body.metadata.success).to.equal(0);
      expect(body.metadata.failed).to.equal(2);
      expect(body.suggestions[0].statusCode).to.equal(500);
      expect(body.suggestions[0].message).to.include('Deployment failed');
    });

    it('should handle partial success when some suggestions not found', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], 'not-found-id', SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.total).to.equal(3);
      expect(body.metadata.success).to.equal(2);
      expect(body.metadata.failed).to.equal(1);

      const failedSuggestion = body.suggestions.find((s) => s.uuid === 'not-found-id');
      expect(failedSuggestion.statusCode).to.equal(404);
      expect(failedSuggestion.message).to.include('not found');
    });

    it('should handle suggestions not in NEW status', async () => {
      tokowakaSuggestions[0].getStatus = () => 'IN_PROGRESS';

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.success).to.equal(1);
      expect(body.metadata.failed).to.equal(1);

      const failedSuggestion = body.suggestions.find((s) => s.uuid === SUGGESTION_IDS[0]);
      expect(failedSuggestion.statusCode).to.equal(400);
      expect(failedSuggestion.message).to.include('not in NEW status');
    });

    it('should reject non-empty headings for headings opportunity', async () => {
      tokowakaSuggestions[0].getData = () => ({
        url: 'https://example.com/page1',
        recommendedAction: 'New Heading Title',
        checkType: 'heading-missing', // Not eligible checkType
        transformRules: {
          action: 'replace',
          selector: 'h1.test-selector',
        },
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.success).to.equal(1); // Only sugg-2 succeeds
      expect(body.metadata.failed).to.equal(1); // sugg-1 fails

      const failedSuggestion = body.suggestions.find((s) => s.uuid === SUGGESTION_IDS[0]);
      expect(failedSuggestion.statusCode).to.equal(400);
      expect(failedSuggestion.message).to.include('can be deployed');
      expect(failedSuggestion.message).to.include('heading-missing');
    });

    it('should validate generated config structure', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);

      // Find the second PutObjectCommand call
      const putObjectCalls = s3ClientSendStub.getCalls().filter((call) => call.args[0].constructor.name === 'PutObjectCommand');
      expect(putObjectCalls).to.have.length.at.least(2);
      const uploadedConfig = JSON.parse(putObjectCalls[1].args[0].input.Body);
      console.log(JSON.stringify(uploadedConfig, null, 2));
      // Validate config structure
      expect(uploadedConfig).to.have.property('url');
      expect(uploadedConfig).to.have.property('version', '1.0');
      expect(uploadedConfig).to.have.property('forceFail', false);
      expect(uploadedConfig).to.have.property('patches');

      const { patches } = uploadedConfig;
      expect(patches).to.have.length(2);
      expect(patches[0]).to.have.property('op', 'replace');
      expect(patches[0]).to.have.property('selector');
      expect(patches[0]).to.have.property('value');
      expect(patches[0]).to.have.property('opportunityId', OPPORTUNITY_ID);
      expect(patches[0]).to.have.property('suggestionId');
      expect(patches[0]).to.have.property('prerenderRequired', true);
      expect(patches[0]).to.have.property('lastUpdated');
    });

    describe('domain-wide suggestions', () => {
      let s3ClientSendStub;
      let prerenderOpportunity;
      let domainWideSuggestion;
      let regularSuggestions;
      let allSuggestions;

      beforeEach(() => {
        // Create a domain-wide suggestion
        domainWideSuggestion = {
          getId: () => SUGGESTION_IDS[0],
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 1,
          getData: () => ({
            url: 'https://example.com/* (All Domain URLs)',
            isDomainWide: true,
            allowedRegexPatterns: ['/*'],
            pathPattern: '/*',
            scope: 'domain-wide',
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        };

        // Create regular suggestions that should be covered by domain-wide
        regularSuggestions = [
          {
            getId: () => SUGGESTION_IDS[1],
            getType: () => 'prerender',
            getOpportunityId: () => OPPORTUNITY_ID,
            getStatus: () => 'NEW',
            getRank: () => 2,
            getData: () => ({
              url: 'https://example.com/page1',
            }),
            getKpiDeltas: () => ({}),
            getCreatedAt: () => '2025-01-15T10:00:00Z',
            getUpdatedAt: () => '2025-01-15T10:00:00Z',
            getUpdatedBy: () => 'system',
            setData: sandbox.stub().returnsThis(),
            setUpdatedBy: sandbox.stub().returnsThis(),
            save: sandbox.stub().returnsThis(),
          },
          {
            getId: () => SUGGESTION_IDS[2],
            getType: () => 'prerender',
            getOpportunityId: () => OPPORTUNITY_ID,
            getStatus: () => 'NEW',
            getRank: () => 3,
            getData: () => ({
              url: 'https://example.com/page2',
            }),
            getKpiDeltas: () => ({}),
            getCreatedAt: () => '2025-01-15T10:00:00Z',
            getUpdatedAt: () => '2025-01-15T10:00:00Z',
            getUpdatedBy: () => 'system',
            setData: sandbox.stub().returnsThis(),
            setUpdatedBy: sandbox.stub().returnsThis(),
            save: sandbox.stub().returnsThis(),
          },
        ];

        allSuggestions = [domainWideSuggestion, ...regularSuggestions];

        prerenderOpportunity = {
          getId: sandbox.stub().returns(OPPORTUNITY_ID),
          getSiteId: sandbox.stub().returns(SITE_ID),
          getType: sandbox.stub().returns('prerender'),
        };

        site.getConfig = sandbox.stub().returns({
          getTokowakaConfig: () => ({ apiKey: 'test-api-key-123' }),
        });
        site.getBaseURL = sandbox.stub().returns('https://example.com');
        site.getId = sandbox.stub().returns(SITE_ID);
        mockOpportunity.findById.resetBehavior();
        mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(prerenderOpportunity);
        mockSuggestion.allByOpportunityId.resetBehavior();
        mockSuggestion.allByOpportunityId.resolves(allSuggestions);

        s3ClientSendStub = sandbox.stub().callsFake((command) => {
          // Handle GetObjectCommand (fetchMetaconfig)
          if (command.constructor.name === 'GetObjectCommand') {
            // Return existing metaconfig
            return Promise.resolve({
              Body: {
                transformToString: () => Promise.resolve(JSON.stringify({
                  siteId: SITE_ID,
                  existingProperty: 'should-be-preserved',
                })),
              },
            });
          }
          // Handle PutObjectCommand (uploadMetaconfig)
          return Promise.resolve();
        });

        context.s3 = {
          s3Client: {
            send: s3ClientSendStub,
          },
        };
        context.env = {
          TOKOWAKA_SITE_CONFIG_BUCKET: 'test-tokowaka-bucket',
          TOKOWAKA_PREVIEW_BUCKET: 'test-tokowaka-preview-bucket',
          TOKOWAKA_CDN_PROVIDER: 'test-cdn-provider',
          TOKOWAKA_EDGE_URL: 'https://edge-dev.tokowaka.now',
          TOKOWAKA_CDN_CONFIG: JSON.stringify({
            cloudfront: {
              distributionId: 'E123456',
              region: 'us-east-1',
            },
          }),
        };
        context.log = {
          info: sandbox.stub(),
          warn: sandbox.stub(),
          error: sandbox.stub(),
          debug: sandbox.stub(),
        };
      });

      it('should deploy domain-wide suggestion and update metaconfig', async () => {
        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0]],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // Should successfully deploy domain-wide suggestion
        expect(body.metadata.success).to.equal(1);
        expect(body.suggestions[0].uuid).to.equal(SUGGESTION_IDS[0]);
        expect(body.suggestions[0].statusCode).to.equal(200);

        // Verify metaconfig was updated
        const putObjectCalls = s3ClientSendStub.getCalls()
          .filter((call) => call.args[0].constructor.name === 'PutObjectCommand');
        expect(putObjectCalls.length).to.be.at.least(1);

        // Verify domain-wide suggestion was marked as deployed
        expect(domainWideSuggestion.setData.calledOnce).to.be.true;
        const setDataArgs = domainWideSuggestion.setData.firstCall.args[0];
        expect(setDataArgs).to.have.property('tokowakaDeployed');
        expect(setDataArgs.tokowakaDeployed).to.be.a('number');
        expect(domainWideSuggestion.setUpdatedBy.calledWith('tokowaka-deployment')).to.be.true;
        expect(domainWideSuggestion.save.calledOnce).to.be.true;
      });

      it('should filter out regular suggestions covered by domain-wide pattern', async () => {
        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1], SUGGESTION_IDS[2]],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // Domain-wide should be deployed
        expect(body.metadata.total).to.equal(3);
        expect(body.metadata.success).to.equal(3); // All marked as success

        // Verify regular suggestions were marked as covered
        expect(regularSuggestions[0].setData.calledOnce).to.be.true;
        expect(regularSuggestions[1].setData.calledOnce).to.be.true;

        const firstRegularData = regularSuggestions[0].setData.firstCall.args[0];
        expect(firstRegularData).to.have.property('tokowakaDeployed');
        expect(firstRegularData).to.have.property('coveredByDomainWide');
        expect(firstRegularData).to.have.property('skippedInDeployment', true);
      });

      it('should include autoCovered count in metadata when suggestions are auto-marked', async () => {
        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1], SUGGESTION_IDS[2]],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // Should include autoCovered metadata
        expect(body.metadata).to.have.property('autoCovered');
        expect(body.metadata.autoCovered).to.equal(2); // 2 regular suggestions auto-covered
        expect(body.metadata).to.have.property('message');
        expect(body.metadata.message).to.include('automatically marked as deployed');
      });

      it('should mark other NEW suggestions matching domain-wide pattern as covered', async () => {
        // Add another NEW suggestion that matches the pattern but wasn't in deployment
        const anotherSuggestion = {
          getId: () => 'suggestion-id-4',
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 4,
          getData: () => ({
            url: 'https://example.com/page3',
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        };

        mockSuggestion.allByOpportunityId.resolves([
          domainWideSuggestion,
          ...regularSuggestions,
          anotherSuggestion,
        ]);

        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0]], // Only deploying domain-wide
            suggestionsMetadata: [
              {
                id: SUGGESTION_IDS[0],
                allowedRegexPatterns: ['/*'],
              },
            ],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // The other suggestion should have been auto-marked
        expect(body.metadata.autoCovered).to.be.at.least(3);
        expect(anotherSuggestion.setData.called).to.be.true;
        const anotherData = anotherSuggestion.setData.firstCall.args[0];
        expect(anotherData).to.have.property('coveredByDomainWide', SUGGESTION_IDS[0]);
        expect(anotherSuggestion.setUpdatedBy.calledWith('domain-wide-deployment')).to.be.true;
      });

      it('should not mark non-NEW suggestions as covered by domain-wide', async () => {
        const deployedSuggestion = {
          getId: () => 'suggestion-id-5',
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'DEPLOYED', // Not NEW
          getRank: () => 5,
          getData: () => ({
            url: 'https://example.com/page4',
            tokowakaDeployed: Date.now() - 10000,
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        };

        mockSuggestion.allByOpportunityId.resolves([
          domainWideSuggestion,
          ...regularSuggestions,
          deployedSuggestion,
        ]);

        await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0]],
          },
        });

        // Deployed suggestion should NOT be modified
        expect(deployedSuggestion.setData.called).to.be.false;
        expect(deployedSuggestion.save.called).to.be.false;
      });

      it('should not mark suggestions without URLs as covered', async () => {
        const noUrlSuggestion = {
          getId: () => 'suggestion-id-6',
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 6,
          getData: () => ({}), // No URL
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        };

        mockSuggestion.allByOpportunityId.resolves([
          domainWideSuggestion,
          noUrlSuggestion,
        ]);

        await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0]],
          },
        });

        // Suggestion without URL should NOT be auto-marked
        expect(noUrlSuggestion.setData.called).to.be.false;
      });

      it('should handle domain-wide deployment errors gracefully', async () => {
        // Make S3 fail
        s3ClientSendStub.rejects(new Error('S3 upload failed'));

        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0]],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // Domain-wide suggestion should be marked as failed
        expect(body.metadata.failed).to.equal(1);
        expect(body.suggestions[0].uuid).to.equal(SUGGESTION_IDS[0]);
        expect(body.suggestions[0].statusCode).to.equal(500);
        expect(body.suggestions[0].message).to.include('Deployment failed');
      });

      it('should handle errors when marking skipped suggestions', async () => {
        // Override save to reject for ALL suggestions to trigger the catch block
        const saveError = new Error('Database error');
        allSuggestions.forEach((sugg) => {
          if (sugg.save && sugg.save.restore) {
            sugg.save.restore();
          }
          sugg.save = sandbox.stub().rejects(saveError);
        });

        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1], SUGGESTION_IDS[2]],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // Should have failed suggestions due to save errors
        expect(body.metadata.failed).to.be.at.least(2);
        const failedSuggestions = body.suggestions.filter((s) => s.statusCode === 500);
        expect(failedSuggestions.length).to.be.at.least(2);
        expect(failedSuggestions.some((s) => s.message.includes('Failed to mark as covered'))).to.be.true;
      });

      it('should handle errors when auto-marking covered suggestions', async () => {
        // Add a suggestion that will fail when auto-marking
        const failingSuggestion = {
          getId: () => 'failing-suggestion',
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 10,
          getData: () => ({
            url: 'https://example.com/failing',
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().rejects(new Error('Failed to save covered suggestion')),
        };

        mockSuggestion.allByOpportunityId.resolves([
          domainWideSuggestion,
          failingSuggestion,
        ]);

        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0]],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // Domain-wide should still deploy successfully despite auto-mark error
        expect(body.metadata.success).to.equal(1);
        expect(context.log.error.called).to.be.true;
        const errorCalls = context.log.error.getCalls();
        const coverErrorLog = errorCalls.find((call) => call.args[0].includes('Error marking covered suggestions'));
        expect(coverErrorLog).to.exist;
      });

      it('should handle errors at the start of domain-wide deployment', async () => {
        // Make site.getBaseURL throw an error
        site.getBaseURL.throws(new Error('Cannot get base URL'));

        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0]],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // Domain-wide deployment should fail
        expect(body.metadata.failed).to.equal(1);
        expect(body.suggestions[0].statusCode).to.equal(500);
        expect(body.suggestions[0].message).to.equal('Deployment failed: Internal server error');
      });

      it('should create new metaconfig when none exists', async () => {
        // Make S3 return NoSuchKey error (no existing metaconfig)
        s3ClientSendStub.callsFake((command) => {
          if (command.constructor.name === 'GetObjectCommand') {
            const error = new Error('NoSuchKey');
            error.name = 'NoSuchKey';
            return Promise.reject(error);
          }
          return Promise.resolve();
        });

        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0]],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();
        expect(body.metadata.success).to.equal(1);

        // Verify PutObjectCommand was called with new metaconfig
        const putCalls = s3ClientSendStub.getCalls()
          .filter((call) => call.args[0].constructor.name === 'PutObjectCommand');
        expect(putCalls.length).to.be.at.least(1);
      });

      it('should skip other domain-wide suggestions when auto-marking', async () => {
        // Create a second domain-wide suggestion
        const secondDomainWide = {
          getId: () => 'domain-wide-2',
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 11,
          getData: () => ({
            url: 'https://example.com/subdomain/* (Subdomain)',
            isDomainWide: true,
            allowedRegexPatterns: ['/subdomain/*'],
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        };

        mockSuggestion.allByOpportunityId.resolves([
          domainWideSuggestion,
          secondDomainWide,
          ...regularSuggestions,
        ]);

        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0]],
          },
        });

        expect(response.status).to.equal(207);

        // Second domain-wide should NOT be auto-marked
        expect(secondDomainWide.setData.called).to.be.false;
        expect(secondDomainWide.save.called).to.be.false;
      });

      it('should handle suggestions without URLs in filtering logic', async () => {
        const suggestionWithoutUrl = {
          getId: () => SUGGESTION_IDS[3],
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 12,
          getData: () => ({}), // No URL
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        };

        mockSuggestion.allByOpportunityId.resolves([
          domainWideSuggestion,
          suggestionWithoutUrl,
        ]);

        // Deploy both domain-wide and the suggestion without URL
        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[3]],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // Suggestion without URL should not be filtered out
        expect(body.metadata.success).to.be.at.least(1);
      });

      it('should include suggestions not covered by domain-wide pattern', async () => {
        const notCoveredSuggestion = {
          getId: () => SUGGESTION_IDS[4],
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 13,
          getData: () => ({
            url: 'https://different-domain.com/page1', // Different domain
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        };

        mockSuggestion.allByOpportunityId.resolves([
          domainWideSuggestion,
          notCoveredSuggestion,
        ]);

        // Deploy both domain-wide and the non-covered suggestion
        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[4]],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // Non-covered suggestion should be deployed normally
        expect(body.metadata.success).to.be.at.least(2);
        expect(notCoveredSuggestion.setData.called).to.be.true;
        expect(notCoveredSuggestion.save.called).to.be.true;
      });

      it('should fail domain-wide suggestion without allowedRegexPatterns', async () => {
        const missingPatternsId = 'missing-patterns-uuid';

        // Mock domain-wide suggestion WITHOUT allowedRegexPatterns in its data
        const domainWideWithoutPatterns = {
          getId: () => missingPatternsId,
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 999999,
          getData: () => ({
            url: 'https://example.com/* (All Domain URLs)',
            isDomainWide: true,
            // Missing allowedRegexPatterns
          }),
          save: sandbox.stub().returnsThis(),
        };

        mockSuggestion.allByOpportunityId.resolves([domainWideWithoutPatterns]);

        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [missingPatternsId],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // Domain-wide suggestion should fail due to missing allowedRegexPatterns
        expect(body.metadata.failed).to.equal(1);
        expect(body.suggestions[0].uuid).to.equal(missingPatternsId);
        expect(body.suggestions[0].statusCode).to.equal(400);
        expect(body.suggestions[0].message).to.include('allowedRegexPatterns');
      });

      it('should handle invalid regex patterns gracefully', async () => {
        const invalidRegexId = 'invalid-regex-uuid';
        const regularId = 'regular-suggestion-uuid';

        // Mock domain-wide suggestion WITH invalid regex patterns in its data
        const domainWideWithInvalidRegex = {
          getId: () => invalidRegexId,
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 999999,
          getData: () => ({
            url: 'https://example.com/* (All Domain URLs)',
            isDomainWide: true,
            allowedRegexPatterns: ['[invalid(regex'], // Invalid regex
          }),
          save: sandbox.stub().returnsThis(),
        };

        const regularSuggestion = {
          getId: () => regularId,
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 2,
          getData: () => ({
            url: 'https://example.com/page1',
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        };

        mockSuggestion.allByOpportunityId.resolves([domainWideWithInvalidRegex, regularSuggestion]);

        const response = await suggestionsController.deploySuggestionToEdge({
          ...context,
          params: {
            siteId: SITE_ID,
            opportunityId: OPPORTUNITY_ID,
          },
          data: {
            suggestionIds: [invalidRegexId, regularId],
          },
        });

        expect(response.status).to.equal(207);
        const body = await response.json();

        // Should still deploy domain-wide despite invalid regex (will log warning)
        expect(body.metadata.success).to.be.at.least(1);
        expect(context.log.warn.called).to.be.true;
        const warnCalls = context.log.warn.getCalls();
        const regexWarning = warnCalls.find((call) => call.args[0].includes('Invalid regex pattern'));
        expect(regexWarning).to.exist;
      });
    });
  });

  describe('rollbackSuggestionFromEdge (Tokowaka Rollback)', () => {
    let s3ClientSendStub;
    let tokowakaSuggestions;
    let headingsOpportunity;

    beforeEach(() => {
      // Mock suggestions with tokowakaDeployed timestamp
      tokowakaSuggestions = [
        {
          getId: () => SUGGESTION_IDS[0],
          getType: () => 'headings',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 1,
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Heading Title',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1.test-selector',
            },
            tokowakaDeployed: '2025-01-01T00:00:00.000Z',
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        },
        {
          getId: () => SUGGESTION_IDS[1],
          getType: () => 'headings',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 2,
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Subtitle',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h2.test-selector',
            },
            tokowakaDeployed: '2025-01-01T00:00:00.000Z',
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().returnsThis(),
        },
      ];

      headingsOpportunity = {
        getId: sandbox.stub().returns(OPPORTUNITY_ID),
        getSiteId: sandbox.stub().returns(SITE_ID),
        getType: sandbox.stub().returns('headings'),
      };

      site.getConfig = sandbox.stub().returns({
        getTokowakaConfig: () => ({ apiKey: 'test-api-key-123' }),
      });
      site.getBaseURL = sandbox.stub().returns('https://example.com');
      site.getId = sandbox.stub().returns(SITE_ID);
      mockOpportunity.findById.resetBehavior();
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(headingsOpportunity);
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID_NOT_ENABLED).resolves(opportunityNotEnabled);
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID_NOT_FOUND).resolves(null);
      mockSuggestion.allByOpportunityId.resetBehavior();
      mockSuggestion.allByOpportunityId.resolves(tokowakaSuggestions);

      // Mock S3 GetObject to return existing config with deployed patches
      const existingConfig = {
        siteId: SITE_ID,
        baseURL: 'https://example.com',
        version: '1.0',
        tokowakaOptimizations: {
          '/page1': {
            prerender: true,
            patches: [
              {
                opportunityId: OPPORTUNITY_ID,
                suggestionId: SUGGESTION_IDS[0],
                op: 'replace',
                selector: 'h1.test-selector',
                value: 'New Heading Title',
                prerenderRequired: true,
                lastUpdated: '2025-01-01T00:00:00.000Z',
              },
              {
                opportunityId: OPPORTUNITY_ID,
                suggestionId: SUGGESTION_IDS[1],
                op: 'replace',
                selector: 'h2.test-selector',
                value: 'New Subtitle',
                prerenderRequired: true,
                lastUpdated: '2025-01-01T00:00:00.000Z',
              },
            ],
          },
        },
      };

      s3ClientSendStub = sandbox.stub().callsFake((command) => {
        // Handle GetObjectCommand (fetchConfig) - return existing config with deployed patches
        if (command.constructor.name === 'GetObjectCommand') {
          return Promise.resolve({
            Body: {
              transformToString: () => JSON.stringify(existingConfig),
            },
          });
        }
        // Handle PutObjectCommand (uploadConfig) - simulate successful upload
        return Promise.resolve();
      });
      context.s3 = {
        s3Client: {
          send: s3ClientSendStub,
        },
      };
      context.env = {
        TOKOWAKA_SITE_CONFIG_BUCKET: 'test-tokowaka-bucket',
        TOKOWAKA_PREVIEW_BUCKET: 'test-tokowaka-preview-bucket',
        TOKOWAKA_CDN_PROVIDER: 'test-cdn-provider',
        TOKOWAKA_EDGE_URL: 'https://edge-dev.tokowaka.now',
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          cloudfront: {
            distributionId: 'E123456',
            region: 'us-east-1',
          },
        }),
      };

      tokowakaSuggestions.forEach((suggestion, index) => {
        mockSuggestion.findById
          .withArgs(SUGGESTION_IDS[index])
          .resolves(suggestion);
      });

      context.log = {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      };
    });

    it('should return 400 when no data provided', async () => {
      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: null,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'No data provided');
    });

    it('should return 400 when suggestionIds is empty', async () => {
      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [],
        },
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Request body must contain a non-empty array of suggestionIds');
    });

    it('should return 404 when site not found', async () => {
      mockSite.findById.withArgs('non-existent-site').resolves(null);

      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: 'non-existent-site',
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(404);
    });

    it('should return 403 when user does not have access', async () => {
      const restrictedSite = {
        getId: sandbox.stub().returns('restricted-site-id'),
        getConfig: sandbox.stub().returns({
          getTokowakaConfig: () => ({ apiKey: 'test-api-key-123' }),
        }),
        getBaseURL: sandbox.stub().returns('https://example.com'),
      };

      mockSite.findById.withArgs('restricted-site-id').resolves(restrictedSite);
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);

      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: 'restricted-site-id',
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(403);
    });

    it('should return 404 when opportunity not found', async () => {
      mockOpportunity.findById.withArgs('non-existent-opportunity').resolves(null);

      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: 'non-existent-opportunity',
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(404);
    });

    it('should successfully rollback suggestions', async () => {
      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.success).to.equal(1);
      expect(body.metadata.failed).to.equal(0);

      // Verify tokowakaDeployed was removed
      const suggestion = tokowakaSuggestions[0];
      expect(suggestion.setData.calledOnce).to.be.true;
      const dataArg = suggestion.setData.firstCall.args[0];
      expect(dataArg).to.not.have.property('tokowakaDeployed');

      // Verify setUpdatedBy was called
      expect(suggestion.setUpdatedBy.calledWith('tokowaka-rollback')).to.be.true;

      // Verify save was called
      expect(suggestion.save.calledOnce).to.be.true;
    });

    it('should return 400 for suggestions without tokowakaDeployed during rollback', async () => {
      // Remove tokowakaDeployed from suggestion
      tokowakaSuggestions[0].getData = () => ({
        type: 'headings',
        checkType: 'heading-empty',
        recommendedAction: {
          description: 'Suggestion 1',
          transformRules: {
            action: 'replace',
            selector: 'h1:nth-of-type(1)',
          },
        },
      });

      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.success).to.equal(0);
      expect(body.metadata.failed).to.equal(1);
      expect(body.suggestions[0].message).to.include('has not been deployed');
    });

    it('should handle multiple suggestions rollback', async () => {
      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.success).to.equal(2);
      expect(body.metadata.failed).to.equal(0);

      // Verify both suggestions were updated
      tokowakaSuggestions.forEach((suggestion) => {
        expect(suggestion.setData.calledOnce).to.be.true;
        expect(suggestion.setUpdatedBy.calledWith('tokowaka-rollback')).to.be.true;
        expect(suggestion.save.calledOnce).to.be.true;
      });
    });

    it('should handle rollback failure gracefully', async () => {
      // Make S3 upload fail
      s3ClientSendStub.rejects(new Error('S3 upload failed'));

      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.success).to.equal(0);
      expect(body.metadata.failed).to.equal(1);
      expect(body.suggestions[0].message).to.include('Rollback failed');
    });

    it('should handle suggestion not found during rollback', async () => {
      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], 'not-found-id'],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.total).to.equal(2);
      expect(body.metadata.success).to.equal(1);
      expect(body.metadata.failed).to.equal(1);

      const failedSuggestion = body.suggestions.find((s) => s.uuid === 'not-found-id');
      expect(failedSuggestion.statusCode).to.equal(404);
      expect(failedSuggestion.message).to.include('not found');
    });

    it('should handle ineligible suggestions during rollback from tokowaka client', async () => {
      // Mock TokowakaClient to return some ineligible suggestions
      const TokowakaClientStub = {
        rollbackSuggestions: sandbox.stub().resolves({
          succeededSuggestions: [tokowakaSuggestions[0]],
          failedSuggestions: [
            {
              suggestion: tokowakaSuggestions[1],
              reason: 'Suggestion cannot be rolled back due to invalid configuration',
            },
          ],
        }),
      };

      sandbox.stub(TokowakaClient, 'createFrom').returns(TokowakaClientStub);

      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.total).to.equal(2);
      expect(body.metadata.success).to.equal(1);
      expect(body.metadata.failed).to.equal(1);

      const failedSuggestion = body.suggestions.find((s) => s.uuid === SUGGESTION_IDS[1]);
      expect(failedSuggestion.statusCode).to.equal(400);
      expect(failedSuggestion.message).to.include('invalid configuration');
    });
  });

  describe('rollbackSuggestionFromEdge - domain-wide rollback', () => {
    let domainWideSuggestion;
    let coveredSuggestions;
    let prerenderOpportunity;
    let tokowakaClientStub;

    beforeEach(() => {
      // Create a domain-wide suggestion that has been deployed
      domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'prerender',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          url: 'https://example.com/* (All Domain URLs)',
          isDomainWide: true,
          allowedRegexPatterns: ['/*'],
          pathPattern: '/*',
          scope: 'domain-wide',
          tokowakaDeployed: Date.now(),
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };

      // Create suggestions that were covered by the domain-wide deployment
      coveredSuggestions = [
        {
          getId: () => SUGGESTION_IDS[1],
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 2,
          getData: () => ({
            url: 'https://example.com/page1',
            tokowakaDeployed: Date.now(),
            coveredByDomainWide: SUGGESTION_IDS[0],
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().resolves(),
        },
        {
          getId: () => SUGGESTION_IDS[2],
          getType: () => 'prerender',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 3,
          getData: () => ({
            url: 'https://example.com/page2',
            tokowakaDeployed: Date.now(),
            coveredByDomainWide: SUGGESTION_IDS[0],
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
          setData: sandbox.stub().returnsThis(),
          setUpdatedBy: sandbox.stub().returnsThis(),
          save: sandbox.stub().resolves(),
        },
      ];

      prerenderOpportunity = {
        getId: sandbox.stub().returns(OPPORTUNITY_ID),
        getSiteId: sandbox.stub().returns(SITE_ID),
        getType: sandbox.stub().returns('prerender'),
      };

      site.getConfig = sandbox.stub().returns({
        getTokowakaConfig: () => ({ apiKey: 'test-api-key-123' }),
      });
      site.getBaseURL = sandbox.stub().returns('https://example.com');
      site.getId = sandbox.stub().returns(SITE_ID);

      mockOpportunity.findById.resetBehavior();
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(prerenderOpportunity);

      const allSuggestions = [domainWideSuggestion, ...coveredSuggestions];
      mockSuggestion.allByOpportunityId.resolves(allSuggestions);
      mockSuggestion.findById.withArgs(SUGGESTION_IDS[0]).resolves(domainWideSuggestion);
      coveredSuggestions.forEach((suggestion, index) => {
        mockSuggestion.findById
          .withArgs(SUGGESTION_IDS[index + 1])
          .resolves(suggestion);
      });

      // Mock TokowakaClient
      tokowakaClientStub = {
        fetchMetaconfig: sandbox.stub().resolves({
          prerender: {
            enabled: true,
            patterns: ['/*'],
          },
        }),
        uploadMetaconfig: sandbox.stub().resolves(),
      };

      sandbox.stub(TokowakaClient, 'createFrom').returns(tokowakaClientStub);

      context.env = {
        TOKOWAKA_SITE_CONFIG_BUCKET: 'test-tokowaka-bucket',
        TOKOWAKA_PREVIEW_BUCKET: 'test-tokowaka-preview-bucket',
        TOKOWAKA_CDN_PROVIDER: 'test-cdn-provider',
        TOKOWAKA_EDGE_URL: 'https://edge-dev.tokowaka.now',
      };

      context.log = {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      };
    });

    it('should rollback domain-wide suggestion and covered suggestions', async () => {
      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      // Should successfully rollback domain-wide suggestion
      expect(body.metadata.success).to.equal(1);
      expect(body.metadata.failed).to.equal(0);

      // Verify metaconfig was updated (prerender removed)
      expect(tokowakaClientStub.fetchMetaconfig.calledOnce).to.be.true;
      expect(tokowakaClientStub.uploadMetaconfig.calledOnce).to.be.true;
      const uploadedMetaconfig = tokowakaClientStub.uploadMetaconfig.firstCall.args[1];
      expect(uploadedMetaconfig).to.not.have.property('prerender');

      // Verify domain-wide suggestion data was updated
      expect(domainWideSuggestion.setData.calledOnce).to.be.true;
      const domainWideData = domainWideSuggestion.setData.firstCall.args[0];
      expect(domainWideData).to.not.have.property('tokowakaDeployed');
      expect(domainWideSuggestion.setUpdatedBy.calledWith('tokowaka-rollback')).to.be.true;
      expect(domainWideSuggestion.save.calledOnce).to.be.true;

      // Verify covered suggestions were also rolled back
      coveredSuggestions.forEach((suggestion) => {
        expect(suggestion.setData.calledOnce).to.be.true;
        const suggestionData = suggestion.setData.firstCall.args[0];
        expect(suggestionData).to.not.have.property('tokowakaDeployed');
        expect(suggestionData).to.not.have.property('coveredByDomainWide');
        expect(suggestion.setUpdatedBy.calledWith('domain-wide-rollback')).to.be.true;
        expect(suggestion.save.calledOnce).to.be.true;
      });
    });

    it('should handle error when metaconfig fetch fails', async () => {
      tokowakaClientStub.fetchMetaconfig.rejects(new Error('Failed to fetch metaconfig'));

      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.success).to.equal(0);
      expect(body.metadata.failed).to.equal(1);
      expect(body.suggestions[0].statusCode).to.equal(500);
      expect(body.suggestions[0].message).to.include('Rollback failed');
    });

    it('should continue with domain-wide rollback even if metaconfig has no prerender config', async () => {
      // Return metaconfig without prerender property
      tokowakaClientStub.fetchMetaconfig.resolves({
        someOtherConfig: true,
      });

      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      // Should still succeed
      expect(body.metadata.success).to.equal(1);
      expect(body.metadata.failed).to.equal(0);

      // Verify metaconfig fetch was attempted but upload was not called (no prerender to remove)
      expect(tokowakaClientStub.fetchMetaconfig.calledOnce).to.be.true;
      expect(tokowakaClientStub.uploadMetaconfig.called).to.be.false;

      // Verify domain-wide suggestion was still rolled back
      expect(domainWideSuggestion.save.calledOnce).to.be.true;
    });

    it('should handle error when TokowakaClient.createFrom fails', async () => {
      // Make TokowakaClient.createFrom throw an error
      TokowakaClient.createFrom.restore();
      sandbox.stub(TokowakaClient, 'createFrom').throws(new Error('Failed to create Tokowaka client'));

      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      // Should fail all domain-wide suggestions
      expect(body.metadata.success).to.equal(0);
      expect(body.metadata.failed).to.equal(1);
      expect(body.suggestions[0].uuid).to.equal(SUGGESTION_IDS[0]);
      expect(body.suggestions[0].statusCode).to.equal(500);
      expect(body.suggestions[0].message).to.include('Rollback failed: Internal server error');

      // Verify error was logged
      expect(context.log.error.called).to.be.true;
    });
  });

  describe('previewSuggestions (Tokowaka Preview)', () => {
    let s3ClientSendStub;
    let tokowakaSuggestions;
    let headingsOpportunity;
    let fetchStub;
    let setTimeoutStub;
    const originalSetTimeout = global.setTimeout;

    beforeEach(() => {
      // Stub setTimeout to execute immediately (skip warmup delays in tests)
      setTimeoutStub = sandbox.stub(global, 'setTimeout').callsFake((callback, delay) => {
        // Execute callback immediately instead of waiting
        return originalSetTimeout(callback, 0);
      });

      // Stub global fetch for HTML fetching
      fetchStub = sandbox.stub(global, 'fetch');
      // Mock fetch responses for HTML fetching (warmup + actual for both original and optimized)
      fetchStub.resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (headerName) => {
            if (headerName === 'x-tokowaka-cache') {
              return 'hit';
            }
            return null;
          },
        },
        text: async () => '<html><body>Test HTML</body></html>',
      });

      tokowakaSuggestions = [
        {
          getId: () => SUGGESTION_IDS[0],
          getType: () => 'headings',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 1,
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Heading Title',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1.test-selector',
            },
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
        },
        {
          getId: () => SUGGESTION_IDS[1],
          getType: () => 'headings',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 2,
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Subtitle',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h2.test-selector',
            },
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
        },
        {
          getId: () => SUGGESTION_IDS[2],
          getType: () => 'headings',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 3,
          getData: () => ({
            url: 'https://example.com/page2', // Different URL
            recommendedAction: 'Another Heading',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1.test-selector',
            },
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
        },
      ];

      headingsOpportunity = {
        getId: sandbox.stub().returns(OPPORTUNITY_ID),
        getSiteId: sandbox.stub().returns(SITE_ID),
        getType: sandbox.stub().returns('headings'),
      };

      site.getConfig = sandbox.stub().returns({
        getTokowakaConfig: () => ({ apiKey: 'test-api-key-123', forwardedHost: 'example.com' }),
      });
      site.getBaseURL = sandbox.stub().returns('https://example.com');
      site.getId = sandbox.stub().returns(SITE_ID);
      mockOpportunity.findById.resetBehavior();
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(headingsOpportunity);
      mockSuggestion.allByOpportunityId.resetBehavior();
      mockSuggestion.allByOpportunityId.resolves(tokowakaSuggestions);

      s3ClientSendStub = sandbox.stub().callsFake((command) => {
        // Handle GetObjectCommand (fetchConfig) - return NoSuchKey to simulate no existing config
        if (command.constructor.name === 'GetObjectCommand') {
          const error = new Error('NoSuchKey');
          error.name = 'NoSuchKey';
          return Promise.reject(error);
        }
        // Handle PutObjectCommand (uploadConfig) - simulate successful upload
        return Promise.resolve();
      });
      context.s3 = {
        s3Client: {
          send: s3ClientSendStub,
        },
      };
      context.env = {
        TOKOWAKA_SITE_CONFIG_BUCKET: 'test-tokowaka-bucket',
        TOKOWAKA_PREVIEW_BUCKET: 'test-tokowaka-preview-bucket',
        TOKOWAKA_CDN_PROVIDER: 'test-cdn-provider',
        TOKOWAKA_EDGE_URL: 'https://edge-dev.tokowaka.now',
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          cloudfront: {
            distributionId: 'E123456',
            region: 'us-east-1',
          },
        }),
      };
      context.log = {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      };
    });

    it('should preview headings suggestions successfully', async function () {
      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      // Check metadata
      expect(body.metadata).to.deep.equal({
        total: 2,
        success: 2,
        failed: 0,
      });

      // Check individual suggestions
      expect(body.suggestions).to.have.length(2);
      expect(body.suggestions[0].uuid).to.equal(SUGGESTION_IDS[0]);
      expect(body.suggestions[0].statusCode).to.equal(200);
      expect(body.suggestions[1].uuid).to.equal(SUGGESTION_IDS[1]);
      expect(body.suggestions[1].statusCode).to.equal(200);

      // Check HTML response structure
      expect(body).to.have.property('html');
      expect(body.html).to.have.property('url', 'https://example.com/page1');
      expect(body.html).to.have.property('originalHtml');
      expect(body.html).to.have.property('optimizedHtml');
      // Verify HTML was actually fetched
      expect(body.html.originalHtml).to.equal('<html><body>Test HTML</body></html>');
      expect(body.html.optimizedHtml).to.equal('<html><body>Test HTML</body></html>');

      // Verify fetch was called for HTML fetching (4 times: warmup + actual for original and optimized)
      expect(fetchStub.callCount).to.equal(4);

      // Verify S3 was called (PUT to upload preview config)
      expect(s3ClientSendStub.callCount).to.be.at.least(1);
      const putObjectCalls = s3ClientSendStub.getCalls().filter((call) => call.args[0].constructor.name === 'PutObjectCommand');
      expect(putObjectCalls).to.have.length(1);

      // Verify it uploads to preview path
      const putCall = putObjectCalls[0];
      const key = putCall.args[0].input.Key;
      expect(key).to.include('preview/opportunities/');
    });

    it('should return 400 if suggestions belong to different URLs', async () => {
      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[2]], // page1 and page2
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('same URL');
    });

    it('should return 400 if siteId is invalid', async () => {
      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: 'invalid-id',
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Site ID required');
    });

    it('should return 400 if opportunityId is invalid', async () => {
      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: 'invalid-id',
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Opportunity ID required');
    });

    it('should return 400 if no data provided', async () => {
      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: null,
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('No data provided');
    });

    it('should return 400 if suggestionIds is empty', async () => {
      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [],
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('non-empty array');
    });

    it('should return 404 if site not found', async () => {
      mockSite.findById.withArgs(SITE_ID).resolves(null);

      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.equal('Site not found');
    });

    it('should return 403 if user does not have access to site', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);

      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(403);
      const body = await response.json();
      expect(body.message).to.equal('User does not belong to the organization');
    });

    it('should return 404 if opportunity not found', async () => {
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(null);

      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.equal('Opportunity not found');
    });

    it('should handle S3 upload failure gracefully', async function () {
      s3ClientSendStub.rejects(Object.assign(new Error('S3 upload failed'), { status: 403 }));

      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      // All suggestions should fail
      expect(body.metadata.success).to.equal(0);
      expect(body.metadata.failed).to.equal(2);
      expect(body.suggestions[0].statusCode).to.equal(500);
      expect(body.suggestions[0].message).to.include('Preview generation failed');
    });

    it('should handle missing and invalid status suggestions', async function () {
      tokowakaSuggestions[1].getStatus = () => 'IN_PROGRESS';

      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], 'not-found-id', SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.total).to.equal(3);
      expect(body.metadata.success).to.equal(1);
      expect(body.metadata.failed).to.equal(2);

      const notFoundSuggestion = body.suggestions.find((s) => s.uuid === 'not-found-id');
      expect(notFoundSuggestion.statusCode).to.equal(404);
      expect(notFoundSuggestion.message).to.include('not found');

      const invalidStatusSuggestion = body.suggestions.find((s) => s.uuid === SUGGESTION_IDS[1]);
      expect(invalidStatusSuggestion.statusCode).to.equal(400);
      expect(invalidStatusSuggestion.message).to.include('not in NEW status');
    });

    it('should validate preview config structure uses preview path', async function () {
      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.metadata.success).to.equal(2);

      // Find the PutObjectCommand call
      const putObjectCalls = s3ClientSendStub.getCalls().filter((call) => call.args[0].constructor.name === 'PutObjectCommand');
      expect(putObjectCalls).to.have.length(1);

      const putCall = putObjectCalls[0];
      const key = putCall.args[0].input.Key;
      const body2 = putCall.args[0].input.Body;

      // Verify preview path
      expect(key).to.equal('preview/opportunities/example.com/L3BhZ2Ux');

      // Verify uploaded config structure
      const uploadedConfig = JSON.parse(body2);
      expect(uploadedConfig).to.have.property('url', 'https://example.com/page1');
      expect(uploadedConfig).to.have.property('version', '1.0');
      expect(uploadedConfig).to.have.property('forceFail', false);
      expect(uploadedConfig).to.have.property('patches');

      // Validate patch structure
      const { patches } = uploadedConfig;
      expect(patches).to.have.length(2);
      expect(patches[0]).to.have.property('op', 'replace');
      expect(patches[0]).to.have.property('selector');
      expect(patches[0]).to.have.property('value');
      expect(patches[0]).to.have.property('opportunityId', OPPORTUNITY_ID);
      expect(patches[0]).to.have.property('suggestionId');
      expect(patches[0]).to.have.property('prerenderRequired', true);
      expect(patches[0]).to.have.property('lastUpdated');
    });

    it('should return 400 when suggestions have no valid URLs', async () => {
      // Create suggestions without URL in data
      const suggestionsWithoutUrl = [
        {
          getId: () => SUGGESTION_IDS[0],
          getType: () => 'headings',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 1,
          getData: () => ({
            // No url property
            recommendedAction: 'New Heading Title',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1.test-selector',
            },
          }),
          getKpiDeltas: () => ({}),
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedBy: () => 'system',
        },
      ];

      mockSuggestion.allByOpportunityId.resolves(suggestionsWithoutUrl);

      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('No valid URLs found');
    });

    it('should handle ineligible suggestions that cannot be deployed', async function () {
      // Create a suggestion with an ineligible checkType
      const ineligibleSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          url: 'https://example.com/page1',
          recommendedAction: 'New Heading Title',
          checkType: 'heading-missing', // Not eligible for deployment
          transformRules: {
            action: 'replace',
            selector: 'h1.test-selector',
          },
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
      };

      mockSuggestion.allByOpportunityId.resolves([ineligibleSuggestion, tokowakaSuggestions[1]]);

      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      // One should succeed, one should fail due to ineligibility
      expect(body.metadata.total).to.equal(2);
      expect(body.metadata.success).to.equal(1);
      expect(body.metadata.failed).to.equal(1);

      // Check the ineligible suggestion
      const failedSuggestion = body.suggestions.find((s) => s.uuid === SUGGESTION_IDS[0]);
      expect(failedSuggestion.statusCode).to.equal(400);
      expect(failedSuggestion.message).to.include('can be deployed');
    });
  });

  describe('fetchFromEdge', () => {
    let fetchStub;

    beforeEach(() => {
      fetchStub = sandbox.stub(global, 'fetch');
    });

    it('should return 400 if siteId is invalid', async () => {
      const response = await suggestionsController.fetchFromEdge({
        ...context,
        params: {
          siteId: 'invalid-site-id',
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: 'https://www.lovesac.com/sactionals',
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Site ID required');
    });

    it('should return 400 if opportunityId is invalid', async () => {
      const response = await suggestionsController.fetchFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: 'invalid-opportunity-id',
        },
        data: {
          url: 'https://www.lovesac.com/sactionals',
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Opportunity ID required');
    });

    it('should return 400 if no data provided', async () => {
      const response = await suggestionsController.fetchFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: null,
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('No data provided');
    });

    it('should return 400 if URL is missing', async () => {
      const response = await suggestionsController.fetchFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: '',
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('URL is required');
    });

    it('should return 400 if URL format is invalid', async () => {
      const response = await suggestionsController.fetchFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: 'not-a-valid-url',
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Invalid URL format');
    });

    it('should return 400 if URL protocol is not HTTP/HTTPS', async () => {
      const response = await suggestionsController.fetchFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: 'ftp://example.com/file.txt',
        },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Invalid URL format: only HTTP/HTTPS URLs are allowed');
    });

    it('should return 404 if site not found', async () => {
      mockSite.findById.withArgs(SITE_ID).resolves(null);

      const response = await suggestionsController.fetchFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: 'https://www.lovesac.com/sactionals',
        },
      });

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.equal('Site not found');
    });

    it('should return 403 if user does not have access to site', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);

      const response = await suggestionsController.fetchFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: 'https://www.lovesac.com/sactionals',
        },
      });

      expect(response.status).to.equal(403);
      const body = await response.json();
      expect(body.message).to.equal('User does not belong to the organization');
    });

    it('should return 404 if opportunity not found', async () => {
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(null);

      const response = await suggestionsController.fetchFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: 'https://www.lovesac.com/sactionals',
        },
      });

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.equal('Opportunity not found');
    });

    it('should return 404 if opportunity does not match siteId', async () => {
      const mismatchedOpportunity = {
        getId: sandbox.stub().returns(OPPORTUNITY_ID),
        getSiteId: sandbox.stub().returns('different-site-id'),
        getType: sandbox.stub().returns('headings'),
      };
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(mismatchedOpportunity);

      const response = await suggestionsController.fetchFromEdge({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: 'https://www.lovesac.com/sactionals',
        },
      });

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.equal('Opportunity not found');
    });

    it('should successfully fetch content from URL', async () => {
      const mockContent = '<html><body>Test Content</body></html>';
      const mockResponse = {
        ok: true,
        status: 200,
        text: sandbox.stub().resolves(mockContent),
        headers: {
          get: sandbox.stub().withArgs('content-type').returns('text/html'),
        },
      };

      fetchStub.resolves(mockResponse);

      const response = await suggestionsController.fetchFromEdge({
        ...context,
        log: {
          info: sandbox.stub(),
          warn: sandbox.stub(),
          error: sandbox.stub(),
        },
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: 'https://www.lovesac.com/sactionals',
        },
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.status).to.equal('success');
      expect(body.statusCode).to.equal(200);
      expect(body.html).to.exist;
      expect(body.html.url).to.equal('https://www.lovesac.com/sactionals');
      expect(body.html.content).to.equal(mockContent);

      // Verify fetch was called with correct parameters
      expect(fetchStub).to.have.been.calledOnce;
      const fetchArgs = fetchStub.getCall(0).args;
      expect(fetchArgs[0]).to.equal('https://www.lovesac.com/sactionals');
      expect(fetchArgs[1].headers['User-Agent']).to.equal('Tokowaka-AI Tokowaka/1.0');
    });

    it('should handle fetch failure with 404', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        headers: {
          get: sandbox.stub().returns(null),
        },
      };

      fetchStub.resolves(mockResponse);

      const response = await suggestionsController.fetchFromEdge({
        ...context,
        log: {
          info: sandbox.stub(),
          warn: sandbox.stub(),
          error: sandbox.stub(),
        },
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: 'https://www.lovesac.com/missing-page',
        },
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.status).to.equal('error');
      expect(body.statusCode).to.equal(404);
      expect(body.html).to.exist;
      expect(body.html.content).to.be.null;
    });

    it('should log x-tokowaka-request-id when present in error response', async () => {
      const mockRequestId = 'req-abc-123-xyz';
      const mockResponse = {
        ok: false,
        status: 503,
        headers: {
          get: sandbox.stub().withArgs('x-tokowaka-request-id').returns(mockRequestId),
        },
      };

      fetchStub.resolves(mockResponse);

      const warnStub = sandbox.stub();
      const response = await suggestionsController.fetchFromEdge({
        ...context,
        log: {
          info: sandbox.stub(),
          warn: warnStub,
          error: sandbox.stub(),
        },
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: 'https://www.lovesac.com/error-page',
        },
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.status).to.equal('error');
      expect(body.statusCode).to.equal(503);
      expect(warnStub).to.have.been.calledWith(
        `Failed to fetch URL. Status: 503, x-tokowaka-request-id: ${mockRequestId}`,
      );
    });

    it('should handle fetch exception', async () => {
      fetchStub.rejects(new Error('Network error'));

      const response = await suggestionsController.fetchFromEdge({
        ...context,
        log: {
          info: sandbox.stub(),
          warn: sandbox.stub(),
          error: sandbox.stub(),
        },
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          url: 'https://www.lovesac.com/sactionals',
        },
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.status).to.equal('error');
      expect(body.statusCode).to.equal(500);
      expect(body.message).to.include('Network error');
      expect(body.html).to.exist;
      expect(body.html.content).to.be.null;
    });
  });

  describe('autofixSuggestions with domain-wide suggestions', () => {
    it('should reject autofix for domain-wide suggestions', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getData: () => ({
          url: 'https://example.com/* (All Domain URLs)',
          isDomainWide: true,
          allowedRegexPatterns: ['/*'],
        }),
      };

      const regularSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getData: () => ({
          url: 'https://example.com/page1',
        }),
      };

      mockSuggestion.allByOpportunityId
        .withArgs(OPPORTUNITY_ID)
        .resolves([domainWideSuggestion, regularSuggestion]);

      mockSuggestion.bulkUpdateStatus.resolves([regularSuggestion]);

      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves({
        getId: () => OPPORTUNITY_ID,
        getSiteId: () => SITE_ID,
        getType: () => 'prerender',
        getData: () => ({}),
      });

      mockConfiguration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
      });

      context.env = {
        AUTOFIX_JOBS_QUEUE: 'test-queue-url',
      };

      context.log = {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      };

      const mockSqs = {
        sendMessage: sandbox.stub().resolves(),
      };
      context.sqs = mockSqs;

      const response = await suggestionsController.autofixSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.total).to.equal(2);
      expect(body.metadata.success).to.equal(1); // Only regular suggestion
      expect(body.metadata.failed).to.equal(1); // Domain-wide rejected

      const failedSuggestion = body.suggestions.find((s) => s.uuid === SUGGESTION_IDS[0]);
      expect(failedSuggestion).to.exist;
      expect(failedSuggestion.statusCode).to.equal(400);
      expect(failedSuggestion.message).to.equal('Domain-wide aggregate suggestions cannot be auto-fixed individually');
    });
  });

  describe('previewSuggestions with domain-wide suggestions', () => {
    it('should reject preview for domain-wide suggestions', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getType: () => 'prerender',
        getRank: () => 1,
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        getData: () => ({
          url: 'https://example.com/* (All Domain URLs)',
          isDomainWide: true,
          allowedRegexPatterns: ['/*'],
        }),
      };

      const regularSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getType: () => 'prerender',
        getRank: () => 2,
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        getData: () => ({
          url: 'https://example.com/page1',
        }),
      };

      mockSuggestion.allByOpportunityId
        .withArgs(OPPORTUNITY_ID)
        .resolves([domainWideSuggestion, regularSuggestion]);

      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves({
        getId: () => OPPORTUNITY_ID,
        getSiteId: () => SITE_ID,
        getType: () => 'prerender',
        getData: () => ({}),
      });

      // Mock TokowakaClient.previewSuggestions for the regular suggestion
      const mockTokowakaClient = {
        previewSuggestions: sandbox.stub().resolves({
          succeededSuggestions: [regularSuggestion],
          failedSuggestions: [],
          html: {
            url: 'https://example.com/page1',
            originalHtml: '<html>original</html>',
            optimizedHtml: '<html>optimized</html>',
          },
        }),
      };

      sandbox.stub(TokowakaClient, 'createFrom').returns(mockTokowakaClient);

      context.log = {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      };

      const response = await suggestionsController.previewSuggestions({
        ...context,
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.total).to.equal(2);
      expect(body.metadata.success).to.equal(1); // Only regular suggestion
      expect(body.metadata.failed).to.equal(1); // Domain-wide rejected

      const failedSuggestion = body.suggestions.find((s) => s.uuid === SUGGESTION_IDS[0]);
      expect(failedSuggestion).to.exist;
      expect(failedSuggestion.statusCode).to.equal(400);
      expect(failedSuggestion.message).to.equal('Domain-wide aggregate suggestions cannot be previewed individually');
    });
  });
});
