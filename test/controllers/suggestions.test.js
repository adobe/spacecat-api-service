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
import DrsClient from '@adobe/spacecat-shared-drs-client';
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
        getType() {
          return 'test-opportunity-type';
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
    getSkipReason() {
      return suggData.skipReason;
    },
    setSkipReason(value) {
      suggData.skipReason = value;
    },
    getSkipDetail() {
      return suggData.skipDetail;
    },
    setSkipDetail(value) {
      suggData.skipDetail = value;
    },
    remove: removeStub,
  });

  const suggestionsFunctions = [
    'autofixSuggestions',
    'createSuggestions',
    'getAllForOpportunity',
    'getAllForOpportunityPaged',
    'deploySuggestionToEdge',
    'listGeoExperiments',
    'getGeoExperiment',
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
  let mockSuggestionGrant;
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
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
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
        skipReason: undefined,
        skipDetail: undefined,
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
    isHandlerEnabledForSite.withArgs('no-cta-above-the-fold-auto-fix', site).returns(true);
    isHandlerEnabledForSite.withArgs('form-accessibility-auto-fix', site).returns(true);
    isHandlerEnabledForSite.withArgs('product-metatags-auto-fix', site).returns(true);
    isHandlerEnabledForSite.withArgs('summit-plg', site).returns(true);
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

    mockSuggestionGrant = {
      splitSuggestionsByGrantStatus: sandbox.stub().callsFake((suggestionIds) => {
        const ids = suggestionIds || [];
        return Promise.resolve({ grantedIds: ids, notGrantedIds: [], grantIds: ids.map((id) => `grant-${id}`) });
      }),
      isSuggestionGranted: sandbox.stub().resolves(true),
    };

    mockSuggestionDataAccess = {
      Opportunity: mockOpportunity,
      Suggestion: mockSuggestion,
      SuggestionGrant: mockSuggestionGrant,
      Site: mockSite,
      Configuration: mockConfiguration,
      AsyncJob: {
        create: sandbox.stub(),
        findById: sandbox.stub(),
      },
      GeoExperiment: {
        create: sandbox.stub(),
        findById: sandbox.stub().resolves({
          getId: () => 'dep-exp-001',
          getStatus: () => 'pre_analysis_started',
          getPreScheduleId: () => 'batch-pre-001',
          getPostScheduleId: () => null,
          getError: () => null,
        }),
      },
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

  it('returns all suggestions when grant filtering throws an error', async () => {
    mockSuggestionGrant.splitSuggestionsByGrantStatus.rejects(new Error('db failure'));
    const ControllerWithSummitPlg = await esmock('../../src/controllers/suggestions.js', {
      '../../src/support/utils.js': {
        getIsSummitPlgEnabled: async () => true,
      },
    });
    const controllerWithSummitPlg = ControllerWithSummitPlg({
      dataAccess: mockSuggestionDataAccess,
      pathInfo: { headers: { 'x-product': 'llmo' } },
      ...authContext,
    }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    const response = await controllerWithSummitPlg.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      pathInfo: { headers: { 'x-client-type': 'sites-optimizer-ui' } },
      ...context,
    });
    expect(response.status).to.equal(200);
    const suggestions = await response.json();
    expect(suggestions).to.be.an('array').with.lengthOf(1);
  });

  it('filters suggestions by grant status when summit-plg is enabled', async () => {
    const grantedId = SUGGESTION_IDS[0];
    mockSuggestionGrant.splitSuggestionsByGrantStatus.resolves({
      grantedIds: [grantedId],
      notGrantedIds: [],
      grantIds: [`grant-${grantedId}`],
    });
    const ControllerWithSummitPlg = await esmock('../../src/controllers/suggestions.js', {
      '../../src/support/utils.js': {
        getIsSummitPlgEnabled: async () => true,
      },
    });
    const controllerWithSummitPlg = ControllerWithSummitPlg({
      dataAccess: mockSuggestionDataAccess,
      pathInfo: { headers: { 'x-product': 'llmo' } },
      ...authContext,
    }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    const response = await controllerWithSummitPlg.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      pathInfo: { headers: { 'x-client-type': 'sites-optimizer-ui' } },
      ...context,
    });
    expect(response.status).to.equal(200);
    const result = await response.json();
    expect(result).to.be.an('array').with.lengthOf(1);
    expect(mockSuggestionGrant.splitSuggestionsByGrantStatus).to.have.been.calledOnce;
  });

  it('skips grant filtering when x-client-type is not sites-optimizer-ui', async () => {
    const ControllerWithSummitPlg = await esmock('../../src/controllers/suggestions.js', {
      '../../src/support/utils.js': {
        getIsSummitPlgEnabled: async (site, ctx, reqCtx) => {
          const clientType = reqCtx?.pathInfo?.headers?.['x-client-type'];
          return clientType === 'sites-optimizer-ui';
        },
      },
    });
    const controllerWithSummitPlg = ControllerWithSummitPlg({
      dataAccess: mockSuggestionDataAccess,
      pathInfo: { headers: { 'x-product': 'llmo' } },
      ...authContext,
    }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    mockSuggestionGrant.splitSuggestionsByGrantStatus.resetHistory();
    const response = await controllerWithSummitPlg.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(mockSuggestionGrant.splitSuggestionsByGrantStatus).to.not.have.been.called;
  });

  it('returns all suggestions and logs when grant filtering throws a non-Error value', async () => {
    mockSuggestionGrant.splitSuggestionsByGrantStatus.callsFake(() => Promise.reject({ code: 500 }));
    const mockLog = { error: sandbox.stub() };
    const ControllerWithSummitPlg = await esmock('../../src/controllers/suggestions.js', {
      '../../src/support/utils.js': {
        getIsSummitPlgEnabled: async () => true,
      },
    });
    const controllerWithSummitPlg = ControllerWithSummitPlg({
      dataAccess: mockSuggestionDataAccess,
      pathInfo: { headers: { 'x-product': 'llmo' } },
      log: mockLog,
      ...authContext,
    }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    const response = await controllerWithSummitPlg.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      pathInfo: { headers: { 'x-client-type': 'sites-optimizer-ui' } },
      ...context,
    });
    expect(response.status).to.equal(200);
    const suggestions = await response.json();
    expect(suggestions).to.be.an('array').with.lengthOf(1);
    expect(mockLog.error).to.have.been.calledOnce;
  });

  it('returns all suggestions without grant filtering when summit-plg is not enabled', async () => {
    const nonPlgSite = {
      getId: sandbox.stub().returns(SITE_ID),
      getDeliveryType: sandbox.stub().returns('aem_edge'),
    };
    mockSite.findById.withArgs(SITE_ID).resolves(nonPlgSite);
    mockSuggestionGrant.splitSuggestionsByGrantStatus.resetHistory();
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(mockSuggestionGrant.splitSuggestionsByGrantStatus).to.not.have.been.called;
    mockSite.findById.withArgs(SITE_ID).resolves(site);
  });

  it('calls grantSuggestionsForOpportunity when summit-plg is enabled in getAllForOpportunity', async () => {
    const grantStub = sandbox.stub().resolves();
    const ControllerWithGrant = await esmock('../../src/controllers/suggestions.js', {
      '../../src/support/utils.js': {
        getIsSummitPlgEnabled: async () => true,
      },
      '../../src/support/grant-suggestions-handler.js': {
        grantSuggestionsForOpportunity: grantStub,
      },
    });
    const controllerWithGrant = ControllerWithGrant({
      dataAccess: mockSuggestionDataAccess,
      pathInfo: { headers: { 'x-product': 'llmo' } },
      ...authContext,
    }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    const response = await controllerWithGrant.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      pathInfo: { headers: { 'x-client-type': 'sites-optimizer-ui' } },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(grantStub).to.have.been.calledOnce;
    expect(grantStub).to.have.been.calledWith(mockSuggestionDataAccess, site, sinon.match.object);
  });

  it('does not call grantSuggestionsForOpportunity when summit-plg is not enabled', async () => {
    const grantStub = sandbox.stub().resolves();
    const ControllerWithGrant = await esmock('../../src/controllers/suggestions.js', {
      '../../src/support/utils.js': {
        getIsSummitPlgEnabled: async () => false,
      },
      '../../src/support/grant-suggestions-handler.js': {
        grantSuggestionsForOpportunity: grantStub,
      },
    });
    const controllerWithGrant = ControllerWithGrant({
      dataAccess: mockSuggestionDataAccess,
      pathInfo: { headers: { 'x-product': 'llmo' } },
      ...authContext,
    }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    const response = await controllerWithGrant.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(grantStub).to.not.have.been.called;
  });

  it('does not call grantSuggestionsForOpportunity when no suggestions exist', async () => {
    const grantStub = sandbox.stub().resolves();
    mockSuggestion.allByOpportunityId.resolves([]);
    const ControllerWithGrant = await esmock('../../src/controllers/suggestions.js', {
      '../../src/support/utils.js': {
        getIsSummitPlgEnabled: async () => true,
      },
      '../../src/support/grant-suggestions-handler.js': {
        grantSuggestionsForOpportunity: grantStub,
      },
    });
    const controllerWithGrant = ControllerWithGrant({
      dataAccess: mockSuggestionDataAccess,
      pathInfo: { headers: { 'x-product': 'llmo' } },
      ...authContext,
    }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    const response = await controllerWithGrant.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      pathInfo: { headers: { 'x-client-type': 'sites-optimizer-ui' } },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(grantStub).to.not.have.been.called;
  });

  it('continues returning suggestions when grantSuggestionsForOpportunity throws', async () => {
    const grantStub = sandbox.stub().rejects(new Error('grant failure'));
    const ControllerWithGrant = await esmock('../../src/controllers/suggestions.js', {
      '../../src/support/utils.js': {
        getIsSummitPlgEnabled: async () => true,
      },
      '../../src/support/grant-suggestions-handler.js': {
        grantSuggestionsForOpportunity: grantStub,
      },
    });
    const mockLog = { warn: sandbox.stub(), info: sandbox.stub(), error: sandbox.stub() };
    const controllerWithGrant = ControllerWithGrant({
      dataAccess: mockSuggestionDataAccess,
      pathInfo: { headers: { 'x-product': 'llmo' } },
      log: mockLog,
      ...authContext,
    }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    const response = await controllerWithGrant.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      pathInfo: { headers: { 'x-client-type': 'sites-optimizer-ui' } },
      ...context,
    });
    expect(response.status).to.equal(200);
    const suggestions = await response.json();
    expect(suggestions).to.be.an('array').with.lengthOf(1);
    expect(mockLog.warn).to.have.been.calledOnce;
    expect(mockLog.warn).to.have.been.calledWith('Grant suggestions handler failed', 'grant failure');
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

  it('gets all suggestions for an opportunity returns bad request for invalid view parameter', async () => {
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: { view: 'invalid-view' },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Invalid view. Must be one of: minimal, summary, full');
  });

  it('gets all suggestions for an opportunity with minimal view', async () => {
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: { view: 'minimal' },
      ...context,
    });
    expect(response.status).to.equal(200);
    const suggestions = await response.json();
    expect(suggestions).to.be.an('array').with.lengthOf(1);
    expect(suggestions[0]).to.have.property('id');
    expect(suggestions[0]).to.have.property('status');
    // Minimal view now includes data with URL-related fields only
    expect(suggestions[0]).to.not.have.property('kpiDeltas');
    expect(suggestions[0]).to.not.have.property('opportunityId');
    expect(suggestions[0]).to.not.have.property('type');
  });

  it('gets all suggestions for an opportunity filtered by single status', async () => {
    const suggWithStatus = { ...suggs[0], status: 'NEW' };
    mockSuggestion.allByOpportunityId.resolves([mockSuggestionEntity(suggWithStatus)]);
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: { status: 'NEW' },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(mockSuggestion.allByOpportunityId).to.have.been.calledWith(OPPORTUNITY_ID);
    const suggestions = await response.json();
    expect(suggestions).to.be.an('array').with.lengthOf(1);
  });

  it('gets all suggestions for an opportunity filtered by multiple statuses (comma-separated)', async () => {
    const sugg1 = { ...suggs[0], status: 'NEW' };
    const sugg2 = { ...suggs[0], id: 'different-id', status: 'APPROVED' };
    const sugg3 = { ...suggs[0], id: 'another-id', status: 'COMPLETED' };
    mockSuggestion.allByOpportunityId.resolves([
      mockSuggestionEntity(sugg1),
      mockSuggestionEntity(sugg2),
      mockSuggestionEntity(sugg3),
    ]);
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: { status: 'NEW,APPROVED' },
      ...context,
    });
    expect(response.status).to.equal(200);
    const suggestions = await response.json();
    // Should only return NEW and APPROVED, not COMPLETED
    expect(suggestions).to.be.an('array').with.lengthOf(2);
  });

  it('gets all suggestions for an opportunity with status and view filters', async () => {
    const suggWithStatus = { ...suggs[0], status: 'NEW' };
    mockSuggestion.allByOpportunityId.resolves([mockSuggestionEntity(suggWithStatus)]);
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: { status: 'NEW', view: 'minimal' },
      ...context,
    });
    expect(response.status).to.equal(200);
    const suggestions = await response.json();
    expect(suggestions).to.be.an('array').with.lengthOf(1);
    expect(suggestions[0]).to.have.property('id');
    expect(suggestions[0]).to.have.property('status');
    // Minimal view now includes data with URL-related fields only
    expect(suggestions[0]).to.not.have.property('kpiDeltas');
    expect(suggestions[0]).to.not.have.property('opportunityId');
    expect(suggestions[0]).to.not.have.property('type');
  });

  it('returns bad request for invalid status values', async () => {
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: { status: 'INVALID_STATUS' },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error.message).to.include('Invalid status value(s): INVALID_STATUS');
    expect(error.message).to.include('Valid:');
  });

  it('returns bad request for multiple invalid status values', async () => {
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: { status: 'NEW,INVALID,APPROVED,BOGUS' },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error.message).to.include('INVALID');
    expect(error.message).to.include('BOGUS');
  });

  it('returns all suggestions when status param is empty commas', async () => {
    mockSuggestion.allByOpportunityId.resolves(suggs.map(mockSuggestionEntity));
    const response = await suggestionsController.getAllForOpportunity({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: { status: ',,,' },
      ...context,
    });
    expect(response.status).to.equal(200);
    const suggestions = await response.json();
    // Should return all suggestions since no valid statuses were provided
    expect(suggestions).to.be.an('array').with.lengthOf(suggs.length);
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

  it('gets paged suggestions returns bad request for invalid view parameter', async () => {
    const response = await suggestionsController.getAllForOpportunityPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        limit: 10,
      },
      data: { view: 'invalid-view' },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Invalid view. Must be one of: minimal, summary, full');
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

  it('gets paged suggestions handles undefined data property gracefully', async () => {
    const resultsWithoutData = {
      cursor: undefined,
    };
    mockSuggestion.allByOpportunityId.resolves(resultsWithoutData);
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

  it('gets all suggestions for an opportunity by status returns bad request for invalid view parameter', async () => {
    const response = await suggestionsController.getByStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      data: { view: 'invalid-view' },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Invalid view. Must be one of: minimal, summary, full');
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

  it('gets paged suggestions by status returns bad request for invalid view parameter', async () => {
    const response = await suggestionsController.getByStatusPaged({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'NEW',
      },
      data: { view: 'invalid-view' },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Invalid view. Must be one of: minimal, summary, full');
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

  it('gets suggestion by ID returns bad request for invalid view parameter', async () => {
    const response = await suggestionsController.getByID({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: { view: 'invalid-view' },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Invalid view. Must be one of: minimal, summary, full');
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

  it('getByID returns not found for summit-plg enabled site with ungranted suggestion when x-client-type is sites-optimizer-ui', async () => {
    mockSuggestionGrant.isSuggestionGranted.resolves(false);
    const ControllerWithSummitPlg = await esmock('../../src/controllers/suggestions.js', {
      '../../src/support/utils.js': {
        getIsSummitPlgEnabled: async () => true,
      },
    });
    const controllerWithSummitPlg = ControllerWithSummitPlg({
      dataAccess: mockSuggestionDataAccess,
      pathInfo: { headers: { 'x-product': 'llmo' } },
      ...authContext,
    }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    const response = await controllerWithSummitPlg.getByID({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      pathInfo: { headers: { 'x-client-type': 'sites-optimizer-ui' } },
      ...context,
    });
    expect(response.status).to.equal(404);
  });

  it('getByID returns suggestion for summit-plg enabled site with ungranted suggestion when x-client-type is not sites-optimizer-ui', async () => {
    mockSuggestionGrant.isSuggestionGranted.resolves(false);
    const ControllerWithSummitPlg = await esmock('../../src/controllers/suggestions.js', {
      '../../src/support/utils.js': {
        getIsSummitPlgEnabled: async (site, ctx, reqCtx) => {
          const clientType = reqCtx?.pathInfo?.headers?.['x-client-type'];
          return clientType === 'sites-optimizer-ui';
        },
      },
    });
    const controllerWithSummitPlg = ControllerWithSummitPlg({
      dataAccess: mockSuggestionDataAccess,
      pathInfo: { headers: { 'x-product': 'llmo' } },
      ...authContext,
    }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });
    const response = await controllerWithSummitPlg.getByID({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      ...context,
    });
    expect(response.status).to.equal(200);
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

  it('patches a suggestion with status SKIPPED and skipReason/skipDetail', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
        skipReason: 'ALREADY_IMPLEMENTED',
        skipDetail: 'Fix was applied manually',
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(suggs[0].status).to.equal('SKIPPED');
    expect(suggs[0].skipReason).to.equal('ALREADY_IMPLEMENTED');
    expect(suggs[0].skipDetail).to.equal('Fix was applied manually');
  });

  it('patches a suggestion returns 400 for invalid skipReason when status is SKIPPED', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
        skipReason: 'invalid_reason',
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error.message).to.include('Invalid skipReason');
  });

  it('patches a suggestion updates skipReason/skipDetail when already SKIPPED', async () => {
    // First set the suggestion to SKIPPED
    suggs[0].status = 'SKIPPED';
    suggs[0].skipReason = 'NO_REASON';
    suggs[0].skipDetail = null;

    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
        skipReason: 'TOO_RISKY',
        skipDetail: 'Changed my mind',
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(suggs[0].skipReason).to.equal('TOO_RISKY');
    expect(suggs[0].skipDetail).to.equal('Changed my mind');
  });

  it('patches a suggestion updates only skipReason when already SKIPPED without providing skipDetail', async () => {
    suggs[0].status = 'SKIPPED';
    suggs[0].skipReason = 'NO_REASON';
    suggs[0].skipDetail = 'old detail';

    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
        skipReason: 'TOO_RISKY',
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(suggs[0].skipReason).to.equal('TOO_RISKY');
    expect(suggs[0].skipDetail).to.be.null;
  });

  it('patches a suggestion updates only skipDetail when already SKIPPED without providing skipReason', async () => {
    suggs[0].status = 'SKIPPED';
    suggs[0].skipReason = 'NO_REASON';
    suggs[0].skipDetail = null;

    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
        skipDetail: 'Only updating detail',
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(suggs[0].skipReason).to.be.null;
    expect(suggs[0].skipDetail).to.equal('Only updating detail');
  });

  it('patches a suggestion logs warning when already SKIPPED and setSkipReason unavailable', async () => {
    suggs[0].status = 'SKIPPED';
    const entity = mockSuggestionEntity(suggs[0]);
    delete entity.setSkipReason;
    delete entity.setSkipDetail;
    mockSuggestion.findById.callsFake((id) => {
      if (id === SUGGESTION_IDS[0]) return Promise.resolve(entity);
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });

    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
        skipReason: 'OTHER',
      },
      ...context,
    });
    // Skip fields silently dropped with warning when model doesn't support them
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error.message).to.include('No updates provided');
    expect(context.log.warn.calledWithMatch('Suggestion model does not support skip fields')).to.be.true;
    // Restore
    mockSuggestion.findById.callsFake((id) => {
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });
  });

  it('patches a suggestion returns 400 for invalid skipReason when already SKIPPED and updating skip fields', async () => {
    suggs[0].status = 'SKIPPED';
    suggs[0].skipReason = 'NO_REASON';

    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
        skipReason: 'invalid_reason',
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error.message).to.include('Invalid skipReason');
  });

  it('patches a suggestion to SKIPPED without providing skipReason or skipDetail', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(suggs[0].status).to.equal('SKIPPED');
    expect(suggs[0].skipReason).to.be.null;
    expect(suggs[0].skipDetail).to.be.null;
  });

  it('patches a suggestion changes from SKIPPED to APPROVED without setSkipReason on model', async () => {
    suggs[0].status = 'SKIPPED';
    const entity = mockSuggestionEntity(suggs[0]);
    delete entity.setSkipReason;
    delete entity.setSkipDetail;
    mockSuggestion.findById.callsFake((id) => {
      if (id === SUGGESTION_IDS[0]) return Promise.resolve(entity);
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });

    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'APPROVED',
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(suggs[0].status).to.equal('APPROVED');
    // Restore
    mockSuggestion.findById.callsFake((id) => {
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });
  });

  it('patches a suggestion to SKIPPED gracefully when setSkipReason is not available', async () => {
    const entity = mockSuggestionEntity(suggs[0]);
    delete entity.setSkipReason;
    delete entity.setSkipDetail;
    mockSuggestion.findById.callsFake((id) => {
      if (id === SUGGESTION_IDS[0]) return Promise.resolve(entity);
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });

    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
        skipReason: 'TOO_RISKY',
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(suggs[0].status).to.equal('SKIPPED');
    expect(context.log.warn.calledWithMatch('Suggestion model does not support skip fields')).to.be.true;
    // Restore findById
    mockSuggestion.findById.callsFake((id) => {
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });
  });

  it('patches a suggestion clears skip fields when changing from SKIPPED to another status', async () => {
    suggs[0].status = 'SKIPPED';
    suggs[0].skipReason = 'TOO_RISKY';
    suggs[0].skipDetail = 'Some detail';

    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'APPROVED',
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(suggs[0].status).to.equal('APPROVED');
    expect(suggs[0].skipReason).to.be.null;
    expect(suggs[0].skipDetail).to.be.null;
  });

  it('patches a suggestion returns 400 when skipDetail exceeds 500 chars and status is SKIPPED', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
        skipReason: 'OTHER',
        skipDetail: 'x'.repeat(501),
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error.message).to.include('500');
  });

  it('patches a suggestion returns 400 when skipReason provided with non-SKIPPED status', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'APPROVED',
        skipReason: 'TOO_RISKY',
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error.message).to.include('skipReason and skipDetail can only be provided when status is SKIPPED');
  });

  it('patches a suggestion returns 400 when skipDetail provided with non-SKIPPED status', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'APPROVED',
        skipDetail: 'Some detail',
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error.message).to.include('skipReason and skipDetail can only be provided when status is SKIPPED');
  });

  it('patches a suggestion returns 400 when skipDetail is not a string', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
        skipReason: 'OTHER',
        skipDetail: 12345,
      },
      ...context,
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error.message).to.include('skipDetail must be a string');
  });

  it('patches a suggestion logs warning when model does not support skip fields on status change to SKIPPED', async () => {
    suggs[0].status = 'NEW';
    const entity = mockSuggestionEntity(suggs[0]);
    delete entity.setSkipReason;
    delete entity.setSkipDetail;
    mockSuggestion.findById.callsFake((id) => {
      if (id === SUGGESTION_IDS[0]) return Promise.resolve(entity);
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });

    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
        suggestionId: SUGGESTION_IDS[0],
      },
      data: {
        status: 'SKIPPED',
        skipReason: 'TOO_RISKY',
      },
      ...context,
    });
    expect(response.status).to.equal(200);
    expect(context.log.warn.calledWithMatch('Suggestion model does not support skip fields')).to.be.true;
    // Restore findById
    mockSuggestion.findById.callsFake((id) => {
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });
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

  it('bulk patches suggestion status with skipReason and skipDetail when status is SKIPPED', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'SKIPPED', skipReason: 'TOO_RISKY', skipDetail: 'Low confidence' },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.success).to.equal(1);
    expect(bulkPatchResponse.suggestions[0].statusCode).to.equal(200);
    expect(suggs[0].status).to.equal('SKIPPED');
    expect(suggs[0].skipReason).to.equal('TOO_RISKY');
    expect(suggs[0].skipDetail).to.equal('Low confidence');
  });

  it('bulk patches suggestion status accepts only id and status (non-breaking)', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [{ id: SUGGESTION_IDS[0], status: 'SKIPPED' }],
      ...context,
    });
    expect(response.status).to.equal(207);
    expect((await response.json()).metadata.success).to.equal(1);
  });

  it('bulk patches suggestion status clears skip fields when changing from SKIPPED to another status', async () => {
    suggs[0].status = 'SKIPPED';
    suggs[0].skipReason = 'TOO_RISKY';
    suggs[0].skipDetail = 'Some detail';

    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'APPROVED' },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.success).to.equal(1);
    expect(suggs[0].status).to.equal('APPROVED');
    expect(suggs[0].skipReason).to.be.null;
    expect(suggs[0].skipDetail).to.be.null;
  });

  it('bulk patches suggestion status to SKIPPED without skipReason or skipDetail', async () => {
    suggs[0].status = 'NEW';
    suggs[0].skipReason = undefined;
    suggs[0].skipDetail = undefined;

    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'SKIPPED' },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.success).to.equal(1);
    expect(suggs[0].status).to.equal('SKIPPED');
    expect(suggs[0].skipReason).to.be.null;
    expect(suggs[0].skipDetail).to.be.null;
  });

  it('bulk patches suggestion status changes from SKIPPED to APPROVED without setSkipReason on model', async () => {
    suggs[0].status = 'SKIPPED';
    const entity = mockSuggestionEntity(suggs[0]);
    delete entity.setSkipReason;
    delete entity.setSkipDetail;
    mockSuggestion.findById.callsFake((id) => {
      if (id === SUGGESTION_IDS[0]) return Promise.resolve(entity);
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });

    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'APPROVED' },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.success).to.equal(1);
    expect(suggs[0].status).to.equal('APPROVED');
    // Restore
    mockSuggestion.findById.callsFake((id) => {
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });
  });

  it('bulk patches suggestion status handles SKIPPED without setSkipReason on model', async () => {
    suggs[0].status = 'NEW';
    const entity = mockSuggestionEntity(suggs[0]);
    delete entity.setSkipReason;
    delete entity.setSkipDetail;
    mockSuggestion.findById.callsFake((id) => {
      if (id === SUGGESTION_IDS[0]) return Promise.resolve(entity);
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });

    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'SKIPPED', skipReason: 'TOO_RISKY' },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.success).to.equal(1);
    expect(suggs[0].status).to.equal('SKIPPED');
    // Restore
    mockSuggestion.findById.callsFake((id) => {
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });
  });

  it('bulk patches suggestion status updates only skipReason when already SKIPPED without providing skipDetail', async () => {
    suggs[0].status = 'SKIPPED';
    suggs[0].skipReason = 'NO_REASON';
    suggs[0].skipDetail = 'old detail';

    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'SKIPPED', skipReason: 'OTHER' },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.success).to.equal(1);
    expect(suggs[0].skipReason).to.equal('OTHER');
    expect(suggs[0].skipDetail).to.be.null;
  });

  it('bulk patches suggestion status updates only skipDetail when already SKIPPED without providing skipReason', async () => {
    suggs[0].status = 'SKIPPED';
    suggs[0].skipReason = 'NO_REASON';
    suggs[0].skipDetail = null;

    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'SKIPPED', skipDetail: 'Only detail' },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.success).to.equal(1);
    expect(suggs[0].skipReason).to.be.null;
    expect(suggs[0].skipDetail).to.equal('Only detail');
  });

  it('bulk patches suggestion status logs warning when already SKIPPED without setSkipReason and updating skip fields', async () => {
    suggs[0].status = 'SKIPPED';
    const entity = mockSuggestionEntity(suggs[0]);
    delete entity.setSkipReason;
    delete entity.setSkipDetail;
    mockSuggestion.findById.callsFake((id) => {
      if (id === SUGGESTION_IDS[0]) return Promise.resolve(entity);
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });

    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'SKIPPED', skipReason: 'OTHER' },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.success).to.equal(1);
    expect(bulkPatchResponse.suggestions[0].statusCode).to.equal(200);
    expect(context.log.warn.calledWithMatch('Suggestion model does not support skip fields')).to.be.true;
    // Restore
    mockSuggestion.findById.callsFake((id) => {
      const s = suggs.find((sg) => sg.id === id);
      return Promise.resolve(s ? mockSuggestionEntity(s, removeStub) : null);
    });
  });

  it('bulk patches suggestion status updates skipReason/skipDetail when already SKIPPED', async () => {
    suggs[0].status = 'SKIPPED';
    suggs[0].skipReason = 'NO_REASON';
    suggs[0].skipDetail = null;

    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'SKIPPED', skipReason: 'OTHER', skipDetail: 'Updated reason' },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.success).to.equal(1);
    expect(bulkPatchResponse.suggestions[0].statusCode).to.equal(200);
    expect(suggs[0].skipReason).to.equal('OTHER');
    expect(suggs[0].skipDetail).to.equal('Updated reason');
  });

  it('bulk patches suggestion status returns 400 for invalid skipReason when status is SKIPPED', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'SKIPPED', skipReason: 'invalid_reason' },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.failed).to.equal(1);
    expect(bulkPatchResponse.suggestions[0].statusCode).to.equal(400);
    expect(bulkPatchResponse.suggestions[0].message).to.include('Invalid skipReason');
  });

  it('bulk patches suggestion status returns 400 when skipReason provided with non-SKIPPED status', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'APPROVED', skipReason: 'TOO_RISKY' },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.failed).to.equal(1);
    expect(bulkPatchResponse.suggestions[0].statusCode).to.equal(400);
    expect(bulkPatchResponse.suggestions[0].message).to.include('skipReason and skipDetail can only be provided when status is SKIPPED');
  });

  it('bulk patches suggestion status returns 400 when skipDetail is not a string', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: SITE_ID,
        opportunityId: OPPORTUNITY_ID,
      },
      data: [
        { id: SUGGESTION_IDS[0], status: 'SKIPPED', skipDetail: 12345 },
      ],
      ...context,
    });
    expect(response.status).to.equal(207);
    const bulkPatchResponse = await response.json();
    expect(bulkPatchResponse.metadata.failed).to.equal(1);
    expect(bulkPatchResponse.suggestions[0].statusCode).to.equal(400);
    expect(bulkPatchResponse.suggestions[0].message).to.include('skipDetail must be a string');
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

  describe('REJECTED status validation', () => {
    it('should return 403 when non-admin user tries to reject a suggestion', async () => {
      // Create a suggestion with PENDING_VALIDATION status
      const pendingSuggestion = {
        id: SUGGESTION_IDS[0],
        opportunityId: OPPORTUNITY_ID,
        type: 'CODE_CHANGE',
        status: 'PENDING_VALIDATION',
        rank: 1,
        data: { info: 'sample data' },
      };

      mockSuggestion.findById.withArgs(SUGGESTION_IDS[0]).resolves(mockSuggestionEntity(pendingSuggestion, removeStub));
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(opportunity);
      mockSite.findById.withArgs(SITE_ID).resolves(site);

      // Mock AccessControlUtil - allow hasAccess (for initial check), deny hasAdminAccess (for REJECTED check)
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);
      sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(false);

      const response = await suggestionsController.patchSuggestionsStatus({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: [{ id: SUGGESTION_IDS[0], status: 'REJECTED' }],
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 403);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('uuid', SUGGESTION_IDS[0]);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('message', 'Only admins can reject suggestions');
      expect(bulkPatchResponse.suggestions[0].suggestion).to.not.exist;
    });

    it('should return 400 when trying to reject a suggestion that is not PENDING_VALIDATION', async () => {
      // Create a suggestion with NEW status (not PENDING_VALIDATION)
      const newSuggestion = {
        id: SUGGESTION_IDS[0],
        opportunityId: OPPORTUNITY_ID,
        type: 'CODE_CHANGE',
        status: 'NEW',
        rank: 1,
        data: { info: 'sample data' },
      };

      mockSuggestion.findById.withArgs(SUGGESTION_IDS[0]).resolves(mockSuggestionEntity(newSuggestion, removeStub));
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(opportunity);
      mockSite.findById.withArgs(SITE_ID).resolves(site);

      // Mock AccessControlUtil - allow both hasAccess and hasAdminAccess
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);
      sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(true);

      const response = await suggestionsController.patchSuggestionsStatus({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: [{ id: SUGGESTION_IDS[0], status: 'REJECTED' }],
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 400);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('uuid', SUGGESTION_IDS[0]);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('message', 'Can only reject suggestions with status PENDING_VALIDATION');
      expect(bulkPatchResponse.suggestions[0].suggestion).to.not.exist;
    });

    it('should successfully reject a suggestion with PENDING_VALIDATION status when user has admin access', async () => {
      // Create a suggestion with PENDING_VALIDATION status
      const pendingSuggestion = {
        id: SUGGESTION_IDS[0],
        opportunityId: OPPORTUNITY_ID,
        type: 'CODE_CHANGE',
        status: 'PENDING_VALIDATION',
        rank: 1,
        data: { info: 'sample data' },
      };

      const suggestionEntity = mockSuggestionEntity(pendingSuggestion, removeStub);
      mockSuggestion.findById.withArgs(SUGGESTION_IDS[0]).resolves(suggestionEntity);
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(opportunity);
      mockSite.findById.withArgs(SITE_ID).resolves(site);

      // Mock AccessControlUtil - allow both hasAccess and hasAdminAccess
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);
      sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(true);

      const response = await suggestionsController.patchSuggestionsStatus({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: [{ id: SUGGESTION_IDS[0], status: 'REJECTED' }],
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse.suggestions[0]).to.have.property('suggestion');
      expect(bulkPatchResponse.suggestions[0].suggestion).to.have.property('status', 'REJECTED');
      expect(bulkPatchResponse.suggestions[0].suggestion).to.have.property('id', SUGGESTION_IDS[0]);
      expect(bulkPatchResponse.metadata).to.have.property('success', 1);
      expect(bulkPatchResponse.metadata).to.have.property('failed', 0);
    });

    it('should return 400 when trying to reject a suggestion with APPROVED status', async () => {
      // Create a suggestion with APPROVED status (not PENDING_VALIDATION)
      const approvedSuggestion = {
        id: SUGGESTION_IDS[0],
        opportunityId: OPPORTUNITY_ID,
        type: 'CODE_CHANGE',
        status: 'APPROVED',
        rank: 1,
        data: { info: 'sample data' },
      };

      mockSuggestion.findById.withArgs(SUGGESTION_IDS[0]).resolves(mockSuggestionEntity(approvedSuggestion, removeStub));
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(opportunity);
      mockSite.findById.withArgs(SITE_ID).resolves(site);

      // Mock AccessControlUtil - allow both hasAccess and hasAdminAccess
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);
      sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(true);

      const response = await suggestionsController.patchSuggestionsStatus({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: [{ id: SUGGESTION_IDS[0], status: 'REJECTED' }],
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 400);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('uuid', SUGGESTION_IDS[0]);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('message', 'Can only reject suggestions with status PENDING_VALIDATION');
      expect(bulkPatchResponse.suggestions[0].suggestion).to.not.exist;
    });
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
          getIsSummitPlgEnabled: async () => true,
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

    it('triggers autofix for suggestions in PENDING_VALIDATION status', async () => {
      opportunity.getType = sandbox.stub().returns('meta-tags');
      const pendingSugg = { ...suggs[0], status: 'PENDING_VALIDATION' };
      mockSuggestion.allByOpportunityId.resolves([mockSuggestionEntity(pendingSugg)]);
      mockSuggestion.bulkUpdateStatus.resolves([
        mockSuggestionEntity({ ...pendingSugg, status: 'IN_PROGRESS' }),
      ]);
      const response = await suggestionsControllerWithMock.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse.metadata).to.have.property('success', 1);
      expect(bulkPatchResponse.metadata).to.have.property('failed', 0);
      expect(bulkPatchResponse.suggestions[0]).to.have.property('statusCode', 200);
      expect(bulkPatchResponse.suggestions[0].suggestion).to.have.property('status', 'IN_PROGRESS');
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

    it('derives no-cta auto-fix URL from contentFix.page_patch.original_page_url', async () => {
      const noCtaSuggestion = {
        id: SUGGESTION_IDS[0],
        opportunityId: OPPORTUNITY_ID,
        type: 'CONTENT_UPDATE',
        rank: 1,
        status: 'NEW',
        data: {
          contentFix: {
            page_patch: {
              original_page_url: 'https://example.com/no-cta-page',
              changes: {
                type: 'patch',
                patch: {
                  operations: [
                    { op: 'add', path: '/items/0', value: { text: 'Explore' } },
                  ],
                },
              },
            },
          },
        },
        updatedAt: new Date(),
      };
      opportunity.getType = sandbox.stub().returns('no-cta-above-the-fold');
      mockSuggestion.allByOpportunityId.resolves([mockSuggestionEntity(noCtaSuggestion)]);
      mockSuggestion.bulkUpdateStatus.resolves([
        mockSuggestionEntity({ ...noCtaSuggestion, status: 'IN_PROGRESS' }),
      ]);

      const response = await suggestionsControllerWithMock.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        ...context,
      });

      expect(response.status).to.equal(207);
      const bulkPatchResponse = await response.json();
      expect(bulkPatchResponse.metadata).to.have.property('success', 1);
      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const sqsPayload = mockSqs.sendMessage.firstCall.args[1];
      expect(sqsPayload).to.have.property('url', 'https://example.com/no-cta-page');
      expect(sqsPayload.suggestionIds).to.deep.equal([SUGGESTION_IDS[0]]);
    });

    it('skips bulkUpdateStatus when action is assess and still sends SQS message', async () => {
      opportunity.getType = sandbox.stub().returns('alt-text');
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(altTextSuggs[0]),
          mockSuggestionEntity(altTextSuggs[1])],
      );

      const response = await suggestionsControllerWithMock.autofixSuggestions({
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]], action: 'assess' },
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
      expect(bulkPatchResponse.suggestions[0].suggestion).to.have.property('status', 'NEW');
      expect(bulkPatchResponse.suggestions[1].suggestion).to.have.property('status', 'NEW');

      expect(mockSuggestion.bulkUpdateStatus).to.not.have.been.called;

      // alt-text is grouped by URL, so 2 suggestions with different URLs = 2 SQS calls
      expect(mockSqs.sendMessage).to.have.been.calledTwice;
      const allSqsCalls = mockSqs.sendMessage.getCalls();
      allSqsCalls.forEach((call) => {
        expect(call.args[1]).to.have.property('action', 'assess');
        expect(call.args[1]).to.have.property('siteId', SITE_ID);
        expect(call.args[1]).to.have.property('opportunityId', OPPORTUNITY_ID);
        expect(call.args[1]).to.have.property('url').that.is.a('string');
      });
      const allSentIds = allSqsCalls.flatMap((call) => call.args[1].suggestionIds);
      expect(allSentIds).to.have.members([SUGGESTION_IDS[0], SUGGESTION_IDS[1]]);
    });

    it('forwards precheckOnly to worker when action is assess', async () => {
      opportunity.getType = sandbox.stub().returns('alt-text');
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(altTextSuggs[0])],
      );

      const response = await suggestionsControllerWithMock.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
          action: 'assess',
          precheckOnly: true,
        },
        ...context,
      });

      expect(response.status).to.equal(207);
      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const payload = mockSqs.sendMessage.firstCall.args[1];
      expect(payload).to.have.property('precheckOnly', true);
      expect(payload).to.have.property('action', 'assess');
    });

    it('does not include precheckOnly in SQS payload when precheckOnly is false', async () => {
      opportunity.getType = sandbox.stub().returns('alt-text');
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(altTextSuggs[0])],
      );

      const response = await suggestionsControllerWithMock.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
          action: 'assess',
          precheckOnly: false,
        },
        ...context,
      });

      expect(response.status).to.equal(207);
      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const payload = mockSqs.sendMessage.firstCall.args[1];
      expect(payload).to.not.have.property('precheckOnly');
    });

    it('does not call getIMSPromiseToken when action is assess and precheckOnly is true', async () => {
      const getIMSPromiseTokenStub = sandbox.stub().resolves({ promise_token: 'unused' });
      const ControllerWithSpy = await esmock('../../src/controllers/suggestions.js', {
        '../../src/support/utils.js': {
          getIMSPromiseToken: getIMSPromiseTokenStub,
          getIsSummitPlgEnabled: async () => true,
        },
      });
      const controller = ControllerWithSpy({
        dataAccess: mockSuggestionDataAccess,
        pathInfo: { headers: { 'x-product': 'abcd' } },
        ...authContext,
      }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });

      opportunity.getType = sandbox.stub().returns('alt-text');
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(altTextSuggs[0])],
      );

      const response = await controller.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
          action: 'assess',
          precheckOnly: true,
        },
        ...context,
      });

      expect(response.status).to.equal(207);
      expect(getIMSPromiseTokenStub).to.not.have.been.called;
    });

    it('returns 400 when precheckOnly is not a boolean', async () => {
      const response = await suggestionsControllerWithMock.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
          action: 'assess',
          precheckOnly: 'yes',
        },
        ...context,
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body).to.have.property('message', 'precheckOnly must be a boolean');
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
      expect(bulkPatchResponse.suggestions[1]).to.have.property('message', 'Suggestion must be in NEW or PENDING_VALIDATION status for auto-fix');
    });
  });

  describe('auto-fix with action assess-urls', () => {
    let assessUrlsConfig;
    beforeEach(() => {
      opportunity.getType = sandbox.stub().returns('alt-text');
      assessUrlsConfig = { isHandlerEnabledForSite: sandbox.stub().returns(true) };
      mockConfiguration.findLatest.resolves(assessUrlsConfig);
    });

    it('queues assess-urls job and returns 202', async () => {
      const pages = ['https://example.com/page1', 'https://example.com/page2'];
      const response = await suggestionsController.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { action: 'assess-urls', pages },
        ...context,
      });

      expect(response.status).to.equal(202);
      const body = await response.json();
      expect(body).to.have.property('message', 'Assess-urls job queued');
      expect(body).to.have.property('siteId', SITE_ID);
      expect(body).to.have.property('pagesCount', 2);

      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const payload = mockSqs.sendMessage.firstCall.args[1];
      expect(payload).to.have.property('siteId', SITE_ID);
      expect(payload).to.have.property('action', 'assess-urls');
      expect(payload).to.deep.include({ pages });
    });

    it('forwards precheckOnly to worker when action is assess-urls', async () => {
      const pages = ['https://example.com/page1'];
      const response = await suggestionsController.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { action: 'assess-urls', pages, precheckOnly: true },
        ...context,
      });

      expect(response.status).to.equal(202);
      const payload = mockSqs.sendMessage.firstCall.args[1];
      expect(payload).to.have.property('precheckOnly', true);
    });

    it('accepts pages as array of objects with pageUrl and imageUrls', async () => {
      const pages = [
        {
          pageUrl: 'https://example.com/page1',
          imageUrls: [
            'https://example.com/img1.jpg',
            'https://example.com/img2.jpg',
          ],
        },
        { pageUrl: 'https://example.com/page2' },
      ];
      const response = await suggestionsController.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { action: 'assess-urls', pages },
        ...context,
      });

      expect(response.status).to.equal(202);
      const payload = mockSqs.sendMessage.firstCall.args[1];
      expect(payload).to.have.property('pages').that.deep.equals(pages);
      expect(payload).to.have.property('action', 'assess-urls');
    });

    it('returns 400 when action is assess-urls but pages is missing', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { action: 'assess-urls' },
        ...context,
      });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body).to.have.property('message', 'Request body must contain a non-empty array of pages (URLs) when action is assess-urls');
    });

    it('returns 400 when action is assess-urls but pages is empty', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { action: 'assess-urls', pages: [] },
        ...context,
      });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body).to.have.property('message', 'Request body must contain a non-empty array of pages (URLs) when action is assess-urls');
    });

    it('returns 400 when action is assess-urls but a page is not a valid URL', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { action: 'assess-urls', pages: ['https://valid.com/p', 'not-a-url'] },
        ...context,
      });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body).to.have.property('message').that.includes('valid URL');
    });

    it('returns 400 when action is assess-urls and page object has invalid pageUrl or imageUrls', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: {
          action: 'assess-urls',
          pages: [
            { pageUrl: 'https://valid.com/p', imageUrls: ['https://ok.jpg', 'not-a-url'] },
          ],
        },
        ...context,
      });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body).to.have.property('message').that.includes('valid URL');
    });

    it('returns 400 when action is assess-urls and page object has invalid or missing pageUrl', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: {
          action: 'assess-urls',
          pages: [
            { imageUrls: ['https://example.com/img.jpg'] },
          ],
        },
        ...context,
      });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body).to.have.property('message').that.includes('valid URL');
    });

    it('returns 400 when action is assess-urls and page object has imageUrls that is not an array', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: {
          action: 'assess-urls',
          pages: [
            { pageUrl: 'https://valid.com/p', imageUrls: 'https://single-url.com' },
          ],
        },
        ...context,
      });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body).to.have.property('message').that.includes('valid URL');
    });

    it('returns 400 when action is assess-urls but a page entry is not a string or page object', async () => {
      const response = await suggestionsController.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: {
          action: 'assess-urls',
          pages: ['https://valid.com/p', 123],
        },
        ...context,
      });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body).to.have.property('message').that.includes('valid URL');
    });

    it('returns 400 when action is assess-urls but handler is not enabled for site', async () => {
      assessUrlsConfig.isHandlerEnabledForSite.returns(false);
      const response = await suggestionsController.autofixSuggestions({
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { action: 'assess-urls', pages: ['https://example.com/p'] },
        ...context,
      });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body).to.have.property('message').that.includes('Handler is not enabled for site');
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

    it('uses promiseToken cookie when present instead of IMS', async () => {
      mockSuggestion.allByOpportunityId.resolves(
        [mockSuggestionEntity(suggs[0]),
          mockSuggestionEntity(suggs[2]),
        ],
      );
      mockSuggestion.bulkUpdateStatus.resolves([mockSuggestionEntity({ ...suggs[0], status: 'IN_PROGRESS' }),
        mockSuggestionEntity({ ...suggs[2], status: 'IN_PROGRESS' })]);

      const getIMSPromiseTokenStub = sandbox.stub();
      const SuggestionsControllerWithStub = await esmock('../../src/controllers/suggestions.js', {
        '../../src/support/utils.js': {
          getIMSPromiseToken: getIMSPromiseTokenStub,
          getIsSummitPlgEnabled: async () => true,
        },
      });
      const controllerWithStub = SuggestionsControllerWithStub({
        dataAccess: mockSuggestionDataAccess,
        pathInfo: { headers: { 'x-product': 'abcd' } },
        ...authContext,
      }, spySqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });

      const response = await controllerWithStub.autofixSuggestions({
        env: {
          AUTOFIX_CRYPT_SECRET: 'superSecret',
          AUTOFIX_CRYPT_SALT: 'salt',
        },
        pathInfo: {
          headers: {
            authorization: 'Bearer token123',
            cookie: 'promiseToken=promiseToken123',
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
      expect(sqsSpy.firstCall.args[1].promiseToken).to.have.property('promise_token', 'promiseToken123');
      expect(getIMSPromiseTokenStub).to.not.have.been.called;
    });

    it('falls back to IMS when promiseToken cookie is absent', async () => {
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

    it('falls back to IMS when promiseToken cookie is not present among other cookies', async () => {
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
            cookie: 'otherCookie=abc',
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
          getIsSummitPlgEnabled: async () => true,
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

  describe('deploySuggestionToEdge (Experiment Async Flow)', () => {
    let edgeSuggestions;
    let mockDrsClient;
    const JOB_ID = 'c3a7b5e2-1234-4abc-9def-567890abcdef';

    beforeEach(() => {
      context.pathInfo = { headers: { prefer: 'respond-async' } };
      context.attributes.authInfo.profile = { email: 'default-owner@example.com' };
      sandbox.stub(AccessControlUtil.prototype, 'isLLMOAdministrator').returns(true);
      sandbox.stub(AccessControlUtil.prototype, 'isOwnerOfSite').resolves(true);

      class StubPutObjectCommand {
        constructor(input) {
          Object.assign(this, input);
        }
      }
      class StubGetObjectCommand {
        constructor(input) {
          Object.assign(this, input);
        }
      }
      context.s3 = {
        s3Client: { send: sandbox.stub().resolves() },
        s3Bucket: 'test-bucket',
        PutObjectCommand: StubPutObjectCommand,
        GetObjectCommand: StubGetObjectCommand,
      };

      edgeSuggestions = [
        {
          getId: () => SUGGESTION_IDS[0],
          getType: () => 'headings',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 1,
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Heading Title',
            prompts: [{ prompt: 'What is page1?', regions: ['US'] }],
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
          getId: () => SUGGESTION_IDS[1],
          getType: () => 'headings',
          getOpportunityId: () => OPPORTUNITY_ID,
          getStatus: () => 'NEW',
          getRank: () => 2,
          getData: () => ({
            url: 'https://example.com/page2',
            recommendedAction: 'New Subtitle',
            prompts: [{ prompt: 'What is page2?', regions: ['US'] }],
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

      const headingsOpportunity = {
        getId: sandbox.stub().returns(OPPORTUNITY_ID),
        getSiteId: sandbox.stub().returns(SITE_ID),
        getType: sandbox.stub().returns('headings'),
      };

      site.getBaseURL = sandbox.stub().returns('https://example.com');
      site.getId = sandbox.stub().returns(SITE_ID);

      mockOpportunity.findById.resetBehavior();
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(headingsOpportunity);
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID_NOT_FOUND).resolves(null);
      mockSuggestion.allByOpportunityId.resetBehavior();
      mockSuggestion.allByOpportunityId.resolves(edgeSuggestions);

      mockDrsClient = {
        createExperimentSchedule: sandbox.stub().resolves({
          schedule: {
            schedule_id: 'sched-pre-001',
          },
        }),
      };
      sandbox.stub(DrsClient, 'createFrom').returns(mockDrsClient);

      mockSuggestionDataAccess.AsyncJob.create.resolves({
        getId: () => JOB_ID,
        getStatus: () => 'IN_PROGRESS',
        getMetadata: () => ({
          jobType: 'geo-experiment',
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
          deployStatus: 'pre_analysis_started',
          preExperimentBatchId: 'batch-pre-001',
        }),
      });
      mockSuggestionDataAccess.GeoExperiment.create.callsFake(async (payload) => {
        const id = payload.geoExperimentId;
        return {
          getId: () => id,
          setPreScheduleId: sandbox.stub(),
          setStatus: sandbox.stub(),
          setUpdatedBy: sandbox.stub(),
          save: sandbox.stub().resolves(),
          remove: sandbox.stub().resolves(),
        };
      });
    });

    it('returns 207 with failure when suggestions have no prompts', async () => {
      const noPromptsSugg = {
        ...edgeSuggestions[0],
        getData: () => ({
          url: 'https://example.com/page1',
          recommendedAction: 'New Heading Title',
        }),
      };
      mockSuggestion.allByOpportunityId.resolves([noPromptsSugg]);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.metadata.failed).to.equal(1);
      expect(body.suggestions[0].message).to.include('No prompts found');
    });

    it('returns badRequest for invalid siteId', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: 'invalid', opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });
      expect(response.status).to.equal(400);
    });

    it('returns notFound when site does not exist', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID_NOT_FOUND, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });
      expect(response.status).to.equal(404);
    });

    it('returns forbidden when user is not LLMO administrator', async () => {
      AccessControlUtil.prototype.isLLMOAdministrator.restore();
      sandbox.stub(AccessControlUtil.prototype, 'isLLMOAdministrator').returns(false);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });
      expect(response.status).to.equal(403);
    });

    it('returns badRequest for invalid opportunityId', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: 'invalid-uuid' },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });
      expect(response.status).to.equal(400);
    });

    it('uses baseURL fallback when hostname cannot be extracted', async () => {
      site.getBaseURL = sandbox.stub().returns('');

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: 'invalid-uuid' },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });

      expect(response.status).to.equal(400);
    });

    it('returns badRequest when no data provided', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: null,
        env: {},
      });
      expect(response.status).to.equal(400);
    });

    it('returns badRequest when suggestionIds is empty', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [] },
        env: {},
      });
      expect(response.status).to.equal(400);
    });

    it('returns forbidden when user does not have access to site', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(false);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });
      expect(response.status).to.equal(403);
    });

    it('returns forbidden when user is not owner of site', async () => {
      AccessControlUtil.prototype.isOwnerOfSite.restore();
      sandbox.stub(AccessControlUtil.prototype, 'isOwnerOfSite').resolves(false);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });
      expect(response.status).to.equal(403);
    });

    it('returns notFound when opportunity does not exist', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID_NOT_FOUND },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });
      expect(response.status).to.equal(404);
    });

    it('returns notFound when opportunity belongs to different site', async () => {
      const wrongSiteOpportunity = {
        getId: sandbox.stub().returns(OPPORTUNITY_ID),
        getSiteId: sandbox.stub().returns('different-site-id'),
        getType: sandbox.stub().returns('headings'),
      };
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(wrongSiteOpportunity);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });
      expect(response.status).to.equal(404);
    });

    it('returns 207 with all failed suggestions when no valid suggestions found', async () => {
      mockSuggestion.allByOpportunityId.resolves([]);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });
      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.metadata.success).to.equal(0);
      expect(body.metadata.failed).to.equal(1);
    });

    it('returns 207 with failure when GeoExperiment data access is missing', async () => {
      const controllerWithoutGeoExperiment = SuggestionsController({
        dataAccess: {
          ...mockSuggestionDataAccess,
          GeoExperiment: undefined,
        },
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContext,
      }, mockSqs, { AUTOFIX_JOBS_QUEUE: 'https://autofix-jobs-queue' });

      const response = await controllerWithoutGeoExperiment.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: { prefer: 'respond-async' } },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.metadata.failed).to.equal(1);
    });

    it('returns 207 with failure when GeoExperiment create returns no id', async () => {
      mockSuggestionDataAccess.GeoExperiment.create.resolves({});

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: { prefer: 'respond-async' } },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.suggestions[0].statusCode).to.equal(500);
      expect(body.suggestions[0].message).to.include('GeoExperiment was not created');
    });

    it('filters out suggestions not in NEW status (non-domain-wide)', async () => {
      const approvedSugg = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'APPROVED',
        getData: () => ({ url: 'https://example.com/page1' }),
        setData: sandbox.stub(),
        setUpdatedBy: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([approvedSugg]);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });
      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.metadata.success).to.equal(0);
      expect(body.metadata.failed).to.equal(1);
    });

    it('filters out domain-wide suggestions missing allowedRegexPatterns', async () => {
      const domainWideSugg = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'APPROVED',
        getData: () => ({ isDomainWide: true, url: 'https://example.com' }),
        setData: sandbox.stub(),
        setUpdatedBy: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSugg]);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: {},
      });
      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.metadata.success).to.equal(0);
      expect(body.metadata.failed).to.equal(1);
    });

    it('allows domain-wide suggestions with allowedRegexPatterns', async () => {
      const domainWideSugg = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'APPROVED',
        getData: () => ({
          isDomainWide: true,
          url: 'https://example.com',
          allowedRegexPatterns: ['.*\\.html'],
          prompts: [{ prompt: 'What is example.com?', regions: ['US'] }],
        }),
        setData: sandbox.stub(),
        setUpdatedBy: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };
      const regularSugg = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          url: 'https://example.com/page1',
          prompts: [{ prompt: 'What is page1?', regions: ['US'] }],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSugg, regularSugg]);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
        env: { AWS_ENV: 'dev' },
      });
      expect(response.status).to.equal(207);
      const body = await response.json();
      // Domain-wide suggestion with allowedRegexPatterns is accepted as valid
      const accepted = body.suggestions.filter((s) => s.statusCode !== 400 && s.statusCode !== 404);
      expect(accepted.length).to.be.greaterThan(0);
    });

    it('logs warning and continues when domain-wide regex is invalid', async () => {
      const domainWideSugg = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['[invalid-regex'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub(),
        setUpdatedBy: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };
      const regularSugg = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 2,
        getData: () => ({ url: 'https://example.com/page2' }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub(),
        setUpdatedBy: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSugg, regularSugg]);

      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().callsFake(async () => {
          context.log.warn('Invalid regex pattern "[invalid-regex" for domain-wide suggestion');
          return {
            succeededSuggestions: [domainWideSugg, regularSugg],
            failedSuggestions: [],
            coveredSuggestions: [],
          };
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
      });

      expect(response.status).to.equal(207);
      expect(context.log.warn.calledWithMatch('Invalid regex pattern')).to.equal(true);
    });

    it('uses fallback updatedBy for auto-covered suggestions when profile email is missing', async () => {
      context.attributes.authInfo.profile = null;

      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const coveredSuggestion = {
        getId: () => '20f74d47-2ce0-402c-bd7d-f10f7237bfa5',
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 2,
        getData: () => ({ url: 'https://example.com/page1' }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSuggestion, coveredSuggestion]);
      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().callsFake(async ({ updatedBy }) => {
          coveredSuggestion.setUpdatedBy(updatedBy);
          return {
            succeededSuggestions: [domainWideSuggestion],
            failedSuggestions: [],
            coveredSuggestions: [coveredSuggestion],
          };
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(207);
      expect(coveredSuggestion.setUpdatedBy.calledWith('tokowaka-deployment')).to.equal(true);
    });

    it('uses fallback updatedBy for same-batch skipped suggestions when profile email is missing', async () => {
      context.attributes.authInfo.profile = null;

      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const skippedSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 2,
        getData: () => ({ url: 'https://example.com/page1' }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSuggestion, skippedSuggestion]);
      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().callsFake(async ({ updatedBy }) => {
          skippedSuggestion.setUpdatedBy(updatedBy);
          return {
            succeededSuggestions: [domainWideSuggestion, skippedSuggestion],
            failedSuggestions: [],
            coveredSuggestions: [skippedSuggestion],
          };
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
      });

      expect(response.status).to.equal(207);
      expect(skippedSuggestion.setUpdatedBy.calledWith('tokowaka-deployment')).to.equal(true);
    });

    it('returns 207 with job details on success', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.geoExperimentStatus).to.equal('GENERATING_BASELINE');
      expect(body.geoExperimentPhase).to.equal('pre_analysis_started');
      expect(body.prePhaseScheduleId).to.equal('sched-pre-001');
      expect(body.geoExperimentId).to.be.a('string').and.match(/^[0-9a-f-]{36}$/);
      expect(body.metadata.success).to.equal(2);
      expect(body.suggestions).to.have.lengthOf(2);
      expect(body.suggestions[0].statusCode).to.equal(202);
    });

    it('calls DrsClient.createExperimentSchedule with correct params', async () => {
      await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(mockDrsClient.createExperimentSchedule).to.have.been.calledOnce;
      const callArgs = mockDrsClient.createExperimentSchedule.firstCall.args[0];
      expect(callArgs.siteId).to.equal(SITE_ID);
      expect(callArgs.experimentPhase).to.equal('pre');
    });

    it('creates GeoExperiment with correct metadata', async () => {
      await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(mockSuggestionDataAccess.AsyncJob.create).to.not.have.been.called;
      expect(mockSuggestionDataAccess.GeoExperiment.create).to.have.been.calledOnce;

      const depExpCreateArg = mockSuggestionDataAccess.GeoExperiment.create.firstCall.args[0];
      expect(depExpCreateArg.siteId).to.equal(SITE_ID);
      expect(depExpCreateArg.opportunityId).to.equal(OPPORTUNITY_ID);
      expect(depExpCreateArg.status).to.equal('GENERATING_BASELINE');
      expect(depExpCreateArg.phase).to.equal('pre_analysis_started');
      expect(depExpCreateArg.geoExperimentId).to.be.a('string').and.match(/^[0-9a-f-]{36}$/);
      const geoEntity = await mockSuggestionDataAccess.GeoExperiment.create.firstCall.returnValue;
      expect(geoEntity.setPreScheduleId).to.have.been.calledWith('sched-pre-001');
    });


    it('returns 500 when GeoExperiment save fails after DRS schedule is created', async () => {
      const removeStubFn = sandbox.stub().resolves();
      mockSuggestionDataAccess.GeoExperiment.create.callsFake(async (payload) => {
        const id = payload.geoExperimentId;
        return {
          getId: () => id,
          setPreScheduleId: sandbox.stub(),
          setStatus: sandbox.stub(),
          setUpdatedBy: sandbox.stub(),
          save: sandbox.stub().rejects(new Error('geo save failed')),
          remove: removeStubFn,
        };
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.suggestions[0].message).to.include('geo save failed');
      expect(removeStubFn).to.have.been.calledOnce;
      expect(context.log.error.calledWithMatch('Failed to update GeoExperiment pre schedule ID')).to.equal(true);
    });

    it('returns 207 success and logs warning when marking suggestion as EXPERIMENT_IN_PROGRESS fails', async () => {
      edgeSuggestions[0].save.rejects(new Error('suggestion persist failed'));

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.geoExperimentId).to.be.a('string');
      expect(context.log.warn.calledWithMatch(/suggestion.*failed to mark as EXPERIMENT_IN_PROGRESS/i)).to.equal(true);
    });

    it('returns 207 with failure when S3 prompts upload fails before GeoExperiment is created', async () => {
      context.s3.s3Client.send.rejects(new Error('s3 denied'));

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.suggestions[0].message).to.include('s3 denied');
    });

    it('honors Prefer: respond-async from pathInfo.headers.prefer (current implementation)', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: { prefer: 'respond-async' } },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.geoExperimentId).to.be.a('string');
    });

    it('honors Prefer: respond-async from pathInfo.headers.Prefer (capital P)', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: { Prefer: 'respond-async' } },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.geoExperimentId).to.be.a('string');
    });

    it('honors respond-async prefer value case-insensitively on pathInfo.headers', async () => {
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: { prefer: 'RESPOND-ASYNC' } },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.geoExperimentId).to.be.a('string');
    });

    it('supports createExperimentSchedule response with top-level schedule_id', async () => {
      mockDrsClient.createExperimentSchedule.resolves({
        schedule_id: 'sched-pre-flat-001',
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.prePhaseScheduleId).to.equal('sched-pre-flat-001');
      expect(body.geoExperimentId).to.be.a('string').and.match(/^[0-9a-f-]{36}$/);
    });

    it('updates valid suggestions with deploy metadata', async () => {
      await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(edgeSuggestions[0].setData).to.have.been.calledOnce;
      const dataArg = edgeSuggestions[0].setData.firstCall.args[0];
      expect(dataArg.edgeOptimizeStatus).to.equal('EXPERIMENT_IN_PROGRESS');
      expect(dataArg.geoExperimentId).to.be.undefined;

      expect(edgeSuggestions[0].save).to.have.been.calledOnce;
      expect(edgeSuggestions[1].setData).to.have.been.calledOnce;
      expect(edgeSuggestions[1].save).to.have.been.calledOnce;
    });

    it('uses profile email as updatedBy in async deploy flow', async () => {
      context.attributes.authInfo.profile = { email: 'owner@example.com' };

      await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(edgeSuggestions[0].setUpdatedBy.calledWith('owner@example.com')).to.equal(true);
    });

    it('uses fallback updatedBy in async deploy flow when profile email is missing', async () => {
      context.attributes.authInfo.profile = null;

      await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(edgeSuggestions[0].setUpdatedBy.calledWith('geo-experiment')).to.equal(true);
    });

    it('includes failedSuggestions in response when some are invalid', async () => {
      const notFoundId = 'b0b0b0b0-0000-0000-0000-000000000000';
      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], notFoundId] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.metadata.success).to.equal(1);
      expect(body.metadata.failed).to.equal(1);
      const failed = body.suggestions.filter((s) => s.statusCode !== 202);
      expect(failed).to.have.lengthOf(1);
      expect(failed[0].uuid).to.equal(notFoundId);
    });

    it('returns 207 with failure when DRS call fails', async () => {
      mockDrsClient.createExperimentSchedule.rejects(new Error('DRS unavailable'));

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.suggestions[0].message).to.include('DRS unavailable');
    });

    it('returns 207 with failure when DRS returns no schedule ID', async () => {
      const removeStubFn = sandbox.stub().resolves();
      mockSuggestionDataAccess.GeoExperiment.create.callsFake(async (payload) => {
        const id = payload.geoExperimentId;
        return {
          getId: () => id,
          setPreScheduleId: sandbox.stub(),
          setStatus: sandbox.stub(),
          setUpdatedBy: sandbox.stub(),
          save: sandbox.stub().resolves(),
          remove: removeStubFn,
        };
      });
      mockDrsClient.createExperimentSchedule.resolves({});

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
        env: { AWS_ENV: 'dev' },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.suggestions[0].message).to.include('DRS schedule created but returned no schedule ID');
      expect(removeStubFn).to.have.been.called;
    });

    it('uses direct deploy flow when Prefer: respond-async is missing', async () => {
      const mockTokowakaClient = {
        deployToEdge: sandbox.stub().resolves({
          succeededSuggestions: [edgeSuggestions[0]],
          failedSuggestions: [],
          coveredSuggestions: [],
        }),
      };
      const tokowakaCreateFromStub = sandbox.stub(TokowakaClient, 'createFrom').returns(mockTokowakaClient);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(207);
      expect(tokowakaCreateFromStub).to.have.been.calledOnce;
      expect(mockTokowakaClient.deployToEdge).to.have.been.calledOnce;
      expect(mockDrsClient.createExperimentSchedule).to.not.have.been.called;
      expect(mockSuggestionDataAccess.AsyncJob.create).to.not.have.been.called;
    });

    it('uses profile email in direct deploy success path', async () => {
      context.attributes.authInfo.profile = { email: 'owner@example.com' };
      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().callsFake(async ({ updatedBy }) => {
          edgeSuggestions[0].setUpdatedBy(updatedBy);
          return {
            succeededSuggestions: [edgeSuggestions[0]],
            failedSuggestions: [],
            coveredSuggestions: [],
          };
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(207);
      expect(edgeSuggestions[0].setUpdatedBy.calledWith('owner@example.com')).to.equal(true);
      expect(context.log.info.calledWithMatch('by owner@example.com')).to.equal(true);
    });

    it('uses fallback updatedBy and log text in direct deploy success path when profile email is missing', async () => {
      context.attributes.authInfo.profile = null;
      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().callsFake(async ({ updatedBy }) => {
          edgeSuggestions[0].setUpdatedBy(updatedBy);
          return {
            succeededSuggestions: [edgeSuggestions[0]],
            failedSuggestions: [],
            coveredSuggestions: [],
          };
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(207);
      expect(edgeSuggestions[0].setUpdatedBy.calledWith('tokowaka-deployment')).to.equal(true);
      expect(context.log.info.calledWithMatch('by tokowaka-deployment')).to.equal(true);
    });

    it('marks suggestions as failed when direct deploy throws', async () => {
      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().rejects(new Error('tokowaka deploy failed')),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.suggestions.some((s) => s.message === 'Deployment failed: Internal server error')).to.equal(true);
    });

    it('removes stale edgeOptimizeStatus and returns ineligible suggestions as failed', async () => {
      const staleSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          url: 'https://example.com/page1',
          edgeOptimizeStatus: 'STALE',
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const ineligibleSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 2,
        getData: () => ({ url: 'https://example.com/page2' }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([staleSuggestion, ineligibleSuggestion]);

      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().callsFake(async () => {
          context.log.info('[edge-deploy] headings suggestion is ineligible: Ineligible for edge deployment');
          const currentData = staleSuggestion.getData();
          const updated = { ...currentData, edgeDeployed: Date.now() };
          if (updated.edgeOptimizeStatus === 'STALE') {
            delete updated.edgeOptimizeStatus;
          }
          staleSuggestion.setData(updated);
          return {
            succeededSuggestions: [staleSuggestion],
            failedSuggestions: [
              { suggestion: ineligibleSuggestion, reason: 'Ineligible for edge deployment' },
            ],
            coveredSuggestions: [],
          };
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
      });

      expect(response.status).to.equal(207);
      const staleSetDataArg = staleSuggestion.setData.firstCall.args[0];
      expect(staleSetDataArg.edgeOptimizeStatus).to.equal(undefined);
      const body = await response.json();
      expect(body.metadata.failed).to.be.greaterThan(0);
      expect(context.log.info.calledWithMatch('is ineligible')).to.equal(true);
    });

    it('includes autoCovered metadata when domain-wide deploy covers other suggestions', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const coveredSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 2,
        getData: () => ({
          url: 'https://example.com/page1',
          recommendedAction: 'New Subtitle',
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSuggestion, coveredSuggestion]);

      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().resolves({
          succeededSuggestions: [domainWideSuggestion],
          failedSuggestions: [],
          coveredSuggestions: [coveredSuggestion],
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.metadata.autoCovered).to.equal(1);
      expect(body.metadata.message).to.equal(
        '1 additional suggestion(s) automatically marked as deployed (covered by domain-wide configuration)',
      );
    });

    it('keeps non-covered suggestions when filtering by same-batch domain-wide patterns', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const nonCoveredSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 2,
        getData: () => ({
          url: 'https://example.com/page2',
          recommendedAction: 'Keep me deployable',
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSuggestion, nonCoveredSuggestion]);

      const deployToEdgeStub = sandbox.stub().resolves({
        succeededSuggestions: [domainWideSuggestion, nonCoveredSuggestion],
        failedSuggestions: [],
        coveredSuggestions: [],
      });
      sandbox.stub(TokowakaClient, 'createFrom').returns({ deployToEdge: deployToEdgeStub });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
      });

      expect(response.status).to.equal(207);
      expect(deployToEdgeStub).to.have.been.calledOnce;
    });

    it('should reject suggestions not NEW or PENDING_VALIDATION for edge deploy', async () => {
      edgeSuggestions[0].getStatus = () => 'IN_PROGRESS';
      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().resolves({
          succeededSuggestions: [edgeSuggestions[1]],
          failedSuggestions: [],
          coveredSuggestions: [],
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();

      expect(body.metadata.success).to.equal(1);
      expect(body.metadata.failed).to.equal(1);

      const failedSuggestion = body.suggestions.find((s) => s.uuid === SUGGESTION_IDS[0]);
      expect(failedSuggestion.statusCode).to.equal(400);
      expect(failedSuggestion.message).to.include('NEW or PENDING_VALIDATION');
    });

    it('should deploy suggestions in PENDING_VALIDATION status', async () => {
      edgeSuggestions[0].getStatus = () => 'PENDING_VALIDATION';
      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().resolves({
          succeededSuggestions: [edgeSuggestions[0], edgeSuggestions[1]],
          failedSuggestions: [],
          coveredSuggestions: [],
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
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
      expect(body.suggestions.every((s) => s.statusCode === 200)).to.equal(true);
    });

    it('marks same-batch skipped suggestions as covered after domain-wide deploy', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const skippedSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 2,
        getData: () => ({
          url: 'https://example.com/page1',
          recommendedAction: 'New Subtitle',
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSuggestion, skippedSuggestion]);

      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().callsFake(async () => {
          await skippedSuggestion.save();
          return {
            succeededSuggestions: [domainWideSuggestion, skippedSuggestion],
            failedSuggestions: [],
            coveredSuggestions: [skippedSuggestion],
          };
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
      });

      expect(response.status).to.equal(207);
      expect(skippedSuggestion.save).to.have.been.calledOnce;
      const body = await response.json();
      expect(body.metadata.autoCovered).to.equal(1);
    });

    it('adds failed result when marking same-batch skipped suggestions fails', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const skippedSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 2,
        getData: () => ({
          url: 'https://example.com/page1',
          recommendedAction: 'New Subtitle',
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().rejects(new Error('save failed')),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSuggestion, skippedSuggestion]);

      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().resolves({
          succeededSuggestions: [domainWideSuggestion],
          failedSuggestions: [
            {
              suggestion: skippedSuggestion,
              reason: 'Failed to mark as covered by domain-wide',
              statusCode: 500,
            },
          ],
          coveredSuggestions: [],
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.suggestions.some((s) => s.message === 'Deployment failed: Failed to mark as covered by domain-wide')).to.equal(true);
    });

    it('continues domain-wide deployment when marking covered suggestions fails', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const coveredSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 2,
        getData: () => ({
          url: 'https://example.com/page1',
          recommendedAction: 'New Subtitle',
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().rejects(new Error('covered save failed')),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSuggestion, coveredSuggestion]);

      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().callsFake(async () => {
          context.log.warn('[edge-deploy] Failed to mark covered suggestions for domain-wide test: covered save failed');
          return {
            succeededSuggestions: [domainWideSuggestion],
            failedSuggestions: [],
            coveredSuggestions: [],
          };
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(207);
      expect(context.log.warn.calledWithMatch('Failed to mark covered suggestions')).to.equal(true);
    });

    it('skips non-domain suggestions without URL when evaluating domain-wide coverage', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const noUrlSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 2,
        getData: () => ({}),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSuggestion, noUrlSuggestion]);

      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().resolves({
          succeededSuggestions: [domainWideSuggestion],
          failedSuggestions: [],
          coveredSuggestions: [],
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(207);
    });

    it('handles no-url requested suggestions and auto-covers matching non-requested suggestions', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const noUrlRequestedSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 2,
        getData: () => ({}),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const nonRequestedCoveredSuggestion = {
        getId: () => '8d86058b-2cc3-4d8d-9a40-b25013f9ad10',
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 3,
        getData: () => ({
          url: 'https://example.com/page1',
          recommendedAction: 'Auto-covered content',
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([
        domainWideSuggestion,
        noUrlRequestedSuggestion,
        nonRequestedCoveredSuggestion,
      ]);

      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().resolves({
          succeededSuggestions: [domainWideSuggestion, noUrlRequestedSuggestion],
          failedSuggestions: [],
          coveredSuggestions: [nonRequestedCoveredSuggestion],
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]] },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.metadata.autoCovered).to.equal(1);
    });

    it('deploys domain-wide-only suggestion via Tokowaka deployToEdge', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSuggestion]);

      const deployToEdgeStub = sandbox.stub().resolves({
        succeededSuggestions: [domainWideSuggestion],
        failedSuggestions: [],
        coveredSuggestions: [],
      });
      sandbox.stub(TokowakaClient, 'createFrom').returns({ deployToEdge: deployToEdgeStub });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(207);
      expect(deployToEdgeStub).to.have.been.calledOnce;
    });

    it('skips non-NEW and domain-wide suggestions when evaluating covered suggestions', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const approvedSuggestion = {
        getId: () => SUGGESTION_IDS[1],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'APPROVED',
        getRank: () => 2,
        getData: () => ({ url: 'https://example.com/page1' }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      const secondaryDomainWideSuggestion = {
        getId: () => 'b67db722-b4ee-45f6-a127-e3b72b621f6a',
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 3,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com/other',
          allowedRegexPatterns: ['^https://example\\.com/.*$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([
        domainWideSuggestion,
        approvedSuggestion,
        secondaryDomainWideSuggestion,
      ]);

      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().resolves({
          succeededSuggestions: [domainWideSuggestion],
          failedSuggestions: [],
          coveredSuggestions: [],
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(207);
    });

    it('records domain-wide suggestion failure when domain-wide deploy step throws', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSuggestion]);

      sandbox.stub(TokowakaClient, 'createFrom').returns({
        deployToEdge: sandbox.stub().resolves({
          succeededSuggestions: [],
          failedSuggestions: [
            { suggestion: domainWideSuggestion, reason: 'metaconfig down', statusCode: 500 },
          ],
          coveredSuggestions: [],
        }),
      });

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(207);
      const body = await response.json();
      expect(body.suggestions.some((s) => s.message === 'Deployment failed: metaconfig down')).to.equal(true);
    });

    it('fails domain-wide suggestions when domain-wide processing setup throws', async () => {
      const domainWideSuggestion = {
        getId: () => SUGGESTION_IDS[0],
        getType: () => 'headings',
        getOpportunityId: () => OPPORTUNITY_ID,
        getStatus: () => 'NEW',
        getRank: () => 1,
        getData: () => ({
          isDomainWide: true,
          scope: 'domain-wide',
          url: 'https://example.com',
          allowedRegexPatterns: ['^https://example\\.com/page1$'],
        }),
        getKpiDeltas: () => ({}),
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'system',
        setData: sandbox.stub().returnsThis(),
        setUpdatedBy: sandbox.stub().returnsThis(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestion.allByOpportunityId.resolves([domainWideSuggestion]);

      sandbox.stub(TokowakaClient, 'createFrom').throws(new Error('tokowaka init failed'));

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        pathInfo: { headers: {} },
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(207);
      expect(context.log.error.calledWithMatch('Error deploying to edge')).to.equal(true);
    });

    it('enforces hasAccess → isLLMOAdministrator → isOwnerOfSite call order', async () => {
      const isLLMOAdminStub = AccessControlUtil.prototype.isLLMOAdministrator;
      const isOwnerStub = AccessControlUtil.prototype.isOwnerOfSite;
      const hasAccessStub = sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);
      isOwnerStub.resolves(false);

      const response = await suggestionsController.deploySuggestionToEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(403);
      expect(hasAccessStub.calledBefore(isLLMOAdminStub), 'hasAccess must be called before isLLMOAdministrator').to.be.true;
      expect(isLLMOAdminStub.calledBefore(isOwnerStub), 'isLLMOAdministrator must be called before isOwnerOfSite').to.be.true;
    });
  });

  describe('listGeoExperiments', () => {
    beforeEach(() => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);
    });

    it('returns badRequest for invalid siteId', async () => {
      const response = await suggestionsController.listGeoExperiments({
        ...context,
        params: { siteId: 'not-a-uuid' },
      });
      expect(response.status).to.equal(400);
    });

    it('returns notFound when site missing', async () => {
      const response = await suggestionsController.listGeoExperiments({
        ...context,
        params: { siteId: SITE_ID_NOT_FOUND },
      });
      expect(response.status).to.equal(404);
    });

    it('returns forbidden without site access', async () => {
      AccessControlUtil.prototype.hasAccess.restore();
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(false);
      const response = await suggestionsController.listGeoExperiments({
        ...context,
        params: { siteId: SITE_ID },
      });
      expect(response.status).to.equal(403);
    });

    it('returns list of experiments without prompts', async () => {
      const makeExp = (id, name, status, phase) => ({
        getId: () => id,
        getSiteId: () => SITE_ID,
        getOpportunityId: () => undefined,
        getType: () => 'onsite_opportunity_deployment',
        getName: () => name,
        getStatus: () => status,
        getPhase: () => phase,
        getPreScheduleId: () => undefined,
        getPostScheduleId: () => undefined,
        getSuggestionIds: () => [],
        getPromptsCount: () => 0,
        getPromptsLocation: () => undefined,
        getMetadata: () => undefined,
        getError: () => undefined,
        getStartTime: () => undefined,
        getEndTime: () => undefined,
        getUpdatedBy: () => 'test',
        getCreatedAt: () => '2026-01-01T00:00:00.000Z',
        getUpdatedAt: () => '2026-01-01T00:00:00.000Z',
      });
      const exp1 = makeExp('exp-id-1', 'Exp 1', 'GENERATING_BASELINE', 'pre_analysis_started');
      const exp2 = makeExp('exp-id-2', 'Exp 2', 'COMPLETED', 'post_analysis_done');
      mockSuggestionDataAccess.GeoExperiment.allBySiteId = sandbox.stub().resolves({
        data: [exp1, exp2],
        cursor: null,
      });

      const response = await suggestionsController.listGeoExperiments({
        ...context,
        params: { siteId: SITE_ID },
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.lengthOf(2);
      expect(body[0].id).to.equal('exp-id-1');
      expect(body[0].name).to.equal('Exp 1');
      expect(body[0]).to.not.have.property('prompts');
      expect(body[1].id).to.equal('exp-id-2');
    });

    it('returns empty array when no experiments exist', async () => {
      mockSuggestionDataAccess.GeoExperiment.allBySiteId = sandbox.stub().resolves({
        data: [],
        cursor: null,
      });

      const response = await suggestionsController.listGeoExperiments({
        ...context,
        params: { siteId: SITE_ID },
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.deep.equal([]);
    });
  });

  describe('getGeoExperiment', () => {
    const GEO_EXP_ID = 'b1b2c3d4-e5f6-7890-abcd-ef1234567890';

    let mockGeoExperiment;

    beforeEach(() => {
      class StubGetObjectCommand {
        constructor(input) {
          Object.assign(this, input);
        }
      }
      context.s3 = {
        s3Client: { send: sandbox.stub() },
        s3Bucket: 'test-bucket',
        GetObjectCommand: StubGetObjectCommand,
      };
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);

      mockGeoExperiment = {
        getId: () => GEO_EXP_ID,
        getSiteId: () => SITE_ID,
        getOpportunityId: () => OPPORTUNITY_ID,
        getType: () => 'onsite_opportunity_deployment',
        getName: () => 'Test Experiment',
        getStatus: () => 'GENERATING_BASELINE',
        getPhase: () => 'pre_analysis_started',
        getPreScheduleId: () => 'sched-pre-001',
        getPostScheduleId: () => undefined,
        getSuggestionIds: () => [SUGGESTION_IDS[0]],
        getPromptsCount: () => 3,
        getPromptsLocation: () => `geo-experiments/${SITE_ID}/${GEO_EXP_ID}-prompts.json`,
        getMetadata: () => undefined,
        getError: () => undefined,
        getStartTime: () => undefined,
        getEndTime: () => undefined,
        getUpdatedBy: () => 'test',
        getCreatedAt: () => '2026-01-01T00:00:00.000Z',
        getUpdatedAt: () => '2026-01-01T00:00:00.000Z',
      };

      mockSuggestionDataAccess.GeoExperiment.findById.resolves(mockGeoExperiment);
    });

    it('returns badRequest for invalid siteId', async () => {
      const response = await suggestionsController.getGeoExperiment({
        ...context,
        params: { siteId: 'not-a-uuid', geoExperimentId: GEO_EXP_ID },
      });
      expect(response.status).to.equal(400);
    });

    it('returns badRequest for invalid geoExperimentId', async () => {
      const response = await suggestionsController.getGeoExperiment({
        ...context,
        params: { siteId: SITE_ID, geoExperimentId: 'bad' },
      });
      expect(response.status).to.equal(400);
    });

    it('returns notFound when site missing', async () => {
      const response = await suggestionsController.getGeoExperiment({
        ...context,
        params: { siteId: SITE_ID_NOT_FOUND, geoExperimentId: GEO_EXP_ID },
      });
      expect(response.status).to.equal(404);
    });

    it('returns forbidden without site access', async () => {
      AccessControlUtil.prototype.hasAccess.restore();
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(false);
      const response = await suggestionsController.getGeoExperiment({
        ...context,
        params: { siteId: SITE_ID, geoExperimentId: GEO_EXP_ID },
      });
      expect(response.status).to.equal(403);
    });

    it('returns notFound when GeoExperiment is missing', async () => {
      mockSuggestionDataAccess.GeoExperiment.findById.resolves(null);
      const response = await suggestionsController.getGeoExperiment({
        ...context,
        params: { siteId: SITE_ID, geoExperimentId: GEO_EXP_ID },
      });
      expect(response.status).to.equal(404);
    });

    it('returns notFound when GeoExperiment belongs to another site', async () => {
      mockSuggestionDataAccess.GeoExperiment.findById.resolves({
        getSiteId: () => 'other-site-id',
        toJSON: () => ({}),
        getId: () => GEO_EXP_ID,
      });
      const response = await suggestionsController.getGeoExperiment({
        ...context,
        params: { siteId: SITE_ID, geoExperimentId: GEO_EXP_ID },
      });
      expect(response.status).to.equal(404);
    });

    it('returns experiment details with prompts on success', async () => {
      const promptsPayload = [{ text: 'hello' }];
      context.s3.s3Client.send.resolves({
        Body: { transformToString: sandbox.stub().resolves(JSON.stringify(promptsPayload)) },
      });
      const response = await suggestionsController.getGeoExperiment({
        ...context,
        params: { siteId: SITE_ID, geoExperimentId: GEO_EXP_ID },
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.id).to.equal(GEO_EXP_ID);
      expect(body.prompts).to.deep.equal(promptsPayload);
    });

    it('returns null prompts and logs when S3 fetch fails', async () => {
      context.s3.s3Client.send.rejects(new Error('NoSuchKey'));
      const response = await suggestionsController.getGeoExperiment({
        ...context,
        params: { siteId: SITE_ID, geoExperimentId: GEO_EXP_ID },
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.prompts).to.be.null;
      expect(context.log.info.calledWithMatch(/Could not fetch prompts/)).to.equal(true);
    });

    it('uses fallback S3 key when promptsLocation is not set', async () => {
      mockGeoExperiment.getPromptsLocation = () => null;
      const promptsPayload = [{ text: 'fallback' }];
      context.s3.s3Client.send.resolves({
        Body: { transformToString: sandbox.stub().resolves(JSON.stringify(promptsPayload)) },
      });
      const response = await suggestionsController.getGeoExperiment({
        ...context,
        params: { siteId: SITE_ID, geoExperimentId: GEO_EXP_ID },
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.prompts).to.deep.equal(promptsPayload);
      const sentCommand = context.s3.s3Client.send.firstCall.args[0];
      expect(sentCommand.Key).to.equal(`geo-experiments/${SITE_ID}/${GEO_EXP_ID}-prompts.json`);
    });
  });



  describe('rollbackSuggestionFromEdge (Tokowaka Rollback)', () => {
    let s3ClientSendStub;
    let tokowakaSuggestions;
    let headingsOpportunity;

    beforeEach(() => {
      // Default: allow LLMO administrator access (can be overridden in specific tests)
      sandbox.stub(AccessControlUtil.prototype, 'isLLMOAdministrator').returns(true);
      sandbox.stub(AccessControlUtil.prototype, 'isOwnerOfSite').resolves(true);

      // Mock suggestions with tokowakaDeployed timestamp
      // Mock suggestions with edgeDeployed timestamp
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
            edgeDeployed: '2025-01-01T00:00:00.000Z',
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
            edgeDeployed: '2025-01-01T00:00:00.000Z',
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

    it('uses base URL fallback when getHostName returns null (rollback)', async () => {
      site.getBaseURL = sandbox.stub().returns('');
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
      expect(body.metadata).to.have.property('total');
    });

    it('should return 403 when user is not an LLMO administrator', async () => {
      // Restore the default stub and create a new one that returns false
      AccessControlUtil.prototype.isLLMOAdministrator.restore();
      sandbox.stub(AccessControlUtil.prototype, 'isLLMOAdministrator').returns(false);

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

      expect(response.status).to.equal(403);
      const error = await response.json();
      expect(error).to.have.property('message', 'Only LLMO administrators can rollback suggestions');
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

      // Verify edgeDeployed was removed
      const suggestion = tokowakaSuggestions[0];
      expect(suggestion.setData.calledOnce).to.be.true;
      const dataArg = suggestion.setData.firstCall.args[0];
      expect(dataArg).to.not.have.property('edgeDeployed');

      // Verify setUpdatedBy was called
      expect(suggestion.setUpdatedBy.calledWith('test@test.com')).to.be.true;

      // Verify save was called
      expect(suggestion.save.calledOnce).to.be.true;
    });

    it('uses fallback updatedBy when profile email is missing', async () => {
      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'admin' }])
            .withAuthenticated(true),
        },
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(207);
      expect(tokowakaSuggestions[0].setUpdatedBy.calledWith('tokowaka-rollback')).to.be.true;
    });

    it('should return 400 for suggestions without edgeDeployed during rollback', async () => {
      // Remove edgeDeployed from suggestion
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

    it('should support backward compatibility with legacy tokowakaDeployed property during rollback', async () => {
      // Set up suggestion with legacy tokowakaDeployed property (no edgeDeployed)
      const legacyTimestamp = Date.now() - 10000;
      tokowakaSuggestions[0].getData = () => ({
        type: 'headings',
        checkType: 'heading-empty',
        url: 'https://example.com/page1', // URL is required for rollback
        edgeDeployed: legacyTimestamp,
        tokowakaDeployed: legacyTimestamp, // Legacy property
        recommendedAction: 'New Heading Title',
        transformRules: {
          action: 'replace',
          selector: 'h1:nth-of-type(1)',
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

      expect(body.metadata.success).to.equal(1);
      expect(body.metadata.failed).to.equal(0);

      // Verify both properties are removed
      const dataArg = tokowakaSuggestions[0].setData.getCall(0).args[0];
      expect(dataArg).to.not.have.property('edgeDeployed');
      expect(dataArg).to.not.have.property('tokowakaDeployed');
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
        expect(suggestion.setUpdatedBy.calledWith('test@test.com')).to.be.true;
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

    it('should return 403 if user cannot deploy for site', async () => {
      AccessControlUtil.prototype.isOwnerOfSite.resolves(false);

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

      expect(response.status).to.equal(403);
      const body = await response.json();
      expect(body.message).to.equal('User does not have access to rollback edge optimize fixes for this site');
    });

    it('enforces hasAccess → isLLMOAdministrator → isOwnerOfSite call order', async () => {
      const isLLMOAdminStub = AccessControlUtil.prototype.isLLMOAdministrator;
      const isOwnerStub = AccessControlUtil.prototype.isOwnerOfSite;
      const hasAccessStub = sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);
      isOwnerStub.resolves(false);

      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
        data: { suggestionIds: [SUGGESTION_IDS[0]] },
      });

      expect(response.status).to.equal(403);
      expect(hasAccessStub.calledBefore(isLLMOAdminStub), 'hasAccess must be called before isLLMOAdministrator').to.be.true;
      expect(isLLMOAdminStub.calledBefore(isOwnerStub), 'isLLMOAdministrator must be called before isOwnerOfSite').to.be.true;
    });
  });

  describe('rollbackSuggestionFromEdge - domain-wide rollback', () => {
    let domainWideSuggestion;
    let coveredSuggestions;
    let prerenderOpportunity;
    let tokowakaClientStub;

    beforeEach(() => {
      // Default: allow LLMO administrator access (can be overridden in specific tests)
      sandbox.stub(AccessControlUtil.prototype, 'isLLMOAdministrator').returns(true);
      sandbox.stub(AccessControlUtil.prototype, 'isOwnerOfSite').resolves(true);

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
          edgeDeployed: Date.now(),
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
            edgeDeployed: Date.now(),
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
            edgeDeployed: Date.now(),
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
      expect(domainWideData).to.not.have.property('edgeDeployed');
      expect(domainWideSuggestion.setUpdatedBy.calledWith('test@test.com')).to.be.true;
      expect(domainWideSuggestion.save.calledOnce).to.be.true;

      // Verify covered suggestions were also rolled back
      coveredSuggestions.forEach((suggestion) => {
        expect(suggestion.setData.calledOnce).to.be.true;
        const suggestionData = suggestion.setData.firstCall.args[0];
        expect(suggestionData).to.not.have.property('edgeDeployed');
        expect(suggestionData).to.not.have.property('coveredByDomainWide');
        expect(suggestion.setUpdatedBy.calledWith('test@test.com')).to.be.true;
        expect(suggestion.save.calledOnce).to.be.true;
      });
    });

    it('uses fallback updatedBy when profile email is missing', async () => {
      const response = await suggestionsController.rollbackSuggestionFromEdge({
        ...context,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'admin' }])
            .withAuthenticated(true),
        },
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0]],
        },
      });

      expect(response.status).to.equal(207);
      expect(domainWideSuggestion.setUpdatedBy.calledWith('tokowaka-rollback')).to.be.true;
      coveredSuggestions.forEach((suggestion) => {
        expect(suggestion.setUpdatedBy.calledWith('domain-wide-rollback')).to.be.true;
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
            if (headerName === 'x-edgeoptimize-cache') {
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
        getEdgeOptimizeConfig: () => undefined,
      });
      site.getBaseURL = sandbox.stub().returns('https://example.com');
      site.getId = sandbox.stub().returns(SITE_ID);
      mockOpportunity.findById.resetBehavior();
      mockOpportunity.findById.withArgs(OPPORTUNITY_ID).resolves(headingsOpportunity);
      mockSuggestion.allByOpportunityId.resetBehavior();
      mockSuggestion.allByOpportunityId.resolves(tokowakaSuggestions);

      s3ClientSendStub = sandbox.stub().callsFake((command) => {
        // Handle GetObjectCommand
        if (command.constructor.name === 'GetObjectCommand') {
          const { Key } = command.input;
          // If fetching metaconfig (path ends with /config without base64 path)
          if (Key && Key.match(/^(preview\/)?opportunities\/[^/]+\/config$/)) {
            // Return existing metaconfig
            return Promise.resolve({
              Body: {
                transformToString: async () => JSON.stringify({
                  siteId: SITE_ID,
                  prerender: false,
                  apiKeys: ['test-api-key-123'],
                }),
              },
            });
          }
          // For URL configs (with base64 path), return NoSuchKey to simulate no existing config
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

    it('uses base URL fallback when getHostName returns null (preview)', async function () {
      site.getBaseURL = sandbox.stub().returns('');
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
      expect(body.metadata).to.have.property('total');
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

    it('logs tokowaka-preview when profile email is missing', async () => {
      const response = await suggestionsController.previewSuggestions({
        ...context,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'admin' }])
            .withAuthenticated(true),
        },
        params: {
          siteId: SITE_ID,
          opportunityId: OPPORTUNITY_ID,
        },
        data: {
          suggestionIds: [SUGGESTION_IDS[0], SUGGESTION_IDS[1]],
        },
      });

      expect(response.status).to.equal(207);
      expect(context.log.info.calledWithMatch('tokowaka-preview')).to.be.true;
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

    it('should handle missing suggestions and allow any status', async function () {
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
      expect(body.metadata.success).to.equal(2);
      expect(body.metadata.failed).to.equal(1);

      const notFoundSuggestion = body.suggestions.find((s) => s.uuid === 'not-found-id');
      expect(notFoundSuggestion.statusCode).to.equal(404);
      expect(notFoundSuggestion.message).to.include('not found');

      // Suggestion with IN_PROGRESS status should now succeed
      const inProgressSuggestion = body.suggestions.find((s) => s.uuid === SUGGESTION_IDS[1]);
      expect(inProgressSuggestion.statusCode).to.equal(200);
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
      expect(fetchArgs[1].headers['User-Agent']).to.equal('Tokowaka-AI Tokowaka/1.0 AdobeEdgeOptimize-AI AdobeEdgeOptimize/1.0');
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
          getIsSummitPlgEnabled: async () => true,
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

    it('should reject autofix for domain-wide suggestions', async () => {
      // Stub AccessControlUtil
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);

      opportunity.getType = sandbox.stub().returns('prerender');
      
      const isHandlerEnabledForSite = sandbox.stub();
      isHandlerEnabledForSite.withArgs('prerender-auto-fix', site).returns(true);
      mockConfiguration.findLatest.resolves({
        isHandlerEnabledForSite,
      });
      
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

      mockSuggestion.bulkUpdateStatus.resolves([regularSuggestion]);

      const response = await suggestionsControllerWithMock.autofixSuggestions({
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
    beforeEach(() => {
      site.getBaseURL = sandbox.stub().returns('https://example.com');
    });

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

  describe('LLMO edge optimize config logging', () => {
    it('logs tokowaka-edge-optimize-config when profile email is missing', async () => {
      const log = {
        info: sandbox.stub(),
        error: sandbox.stub(),
      };

      const config = {
        getLlmoConfig: () => ({ dataFolder: 'https://example.com/data' }),
        getEdgeOptimizeConfig: () => ({}),
        updateEdgeOptimizeConfig: sandbox.stub(),
      };

      const site = {
        getId: () => SITE_ID,
        getBaseURL: () => 'https://example.com',
        getConfig: () => config,
        setConfig: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };

      const mockSite = {
        findById: sandbox.stub().resolves(site),
      };

      const tokowakaClientStub = {
        fetchMetaconfig: sandbox.stub().resolves({ apiKeys: ['key'] }),
        updateMetaconfig: sandbox.stub().resolves({ apiKeys: ['key'] }),
      };

      const LlmoController = await esmock('../../src/controllers/llmo/llmo.js', {
        '../../src/support/access-control-util.js': {
          default: {
            fromContext: () => ({
              hasAccess: sandbox.stub().resolves(true),
              isLLMOAdministrator: sandbox.stub().returns(true),
              isOwnerOfSite: sandbox.stub().resolves(true),
            }),
          },
        },
        '@adobe/spacecat-shared-tokowaka-client': {
          default: {
            createFrom: sandbox.stub().returns(tokowakaClientStub),
          },
        },
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: {
            toDynamoItem: (cfg) => cfg,
          },
        },
      });

      const llmoController = LlmoController({
        dataAccess: { Site: mockSite },
        attributes: { authInfo: { profile: {} } },
        log,
        pathInfo: { headers: { 'x-product': 'llmo' } },
      });

      const response = await llmoController.createOrUpdateEdgeConfig({
        dataAccess: { Site: mockSite },
        attributes: { authInfo: { profile: {} } },
        log,
        params: { siteId: SITE_ID },
        data: { tokowakaEnabled: true },
      });

      expect(response.status).to.equal(200);
      expect(log.info.calledWithMatch('tokowaka-edge-optimize-config')).to.be.true;
    });
  });
});
