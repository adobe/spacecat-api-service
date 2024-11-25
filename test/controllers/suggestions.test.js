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

import { ValidationError } from '@adobe/spacecat-shared-data-access';
import SuggestionsController from '../../src/controllers/suggestions.js';

use(chaiAsPromised);

describe('Suggestions Controller', () => {
  const sandbox = sinon.createSandbox();

  const mockSuggestionEntity = (suggData) => ({
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
          return 'site67890';
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
    remove() {
    },
  });

  const suggestionsFunctions = [
    'getAllForOpportunity',
    'getByStatus',
    'getByID',
    'createSuggestions',
    'patchSuggestion',
    'patchSuggestionsStatus',
  ];

  let mockSuggestionDataAccess;
  let mockSuggestion;
  let suggestionsController;
  let suggs;

  beforeEach(() => {
    suggs = [
      {
        id: 'sug12345',
        opportunityId: 'op67890',
        type: 'CODE_CHANGE',
        status: 'NEW',
        rank: 1,
        data: {
          info: 'sample data',
        },
        kpiDeltas: {
          conversionRate: 0.05,
        },
      },
      {
        id: 'sug67890',
        opportunityId: 'op67890',
        type: 'FIX_LINK',
        status: 'APPROVED',
        rank: 2,
        data: {
          info: 'broken back link data',
        },
        kpiDeltas: {
          conversionRate: 0.02,
        },
      },
    ];

    mockSuggestion = {
      allByOpportunityId: sandbox.stub().resolves([mockSuggestionEntity(suggs[0])]),
      allByOpportunityIdAndStatus: sandbox.stub().resolves([mockSuggestionEntity(suggs[0])]),
      findById: sandbox.stub().callsFake((id) => {
        const suggestion = suggs.find((s) => s.id === id);
        return Promise.resolve(suggestion ? mockSuggestionEntity(suggestion) : null);
      }),
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
      Suggestion: mockSuggestion,
    };

    suggestionsController = SuggestionsController(mockSuggestionDataAccess);
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

  it('throws an error if data access is not an object', () => {
    expect(() => SuggestionsController()).to.throw('Data access required');
  });

  it('throws an error if data access cannot be destructured to Opportunity', () => {
    expect(() => SuggestionsController({ test: {} })).to.throw('Data access required');
  });

  it('gets all suggestions for an opportunity and a site', async () => {
    const response = await suggestionsController.getAllForOpportunity({ params: { siteId: 'site67890', opportunityId: 'op67890' } });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityId.calledOnce).to.be.true;
    expect(response.status).to.equal(200);
    const suggestions = await response.json();
    expect(suggestions).to.be.an('array').with.lengthOf(1);
    expect(suggestions[0]).to.have.property('opportunityId', 'op67890');
  });

  it('gets all suggestions for an opportunity returns bad request if no site ID is passed', async () => {
    const response = await suggestionsController.getAllForOpportunity({ params: {} });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityId.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets all suggestions for an opportunity returns bad request if no opportunity ID is passed', async () => {
    const response = await suggestionsController.getAllForOpportunity({ params: { siteId: 'site67890' } });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityId.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('gets all suggestions for an opportunity returns bad request if passed site ID does not match opportunity site id', async () => {
    const response = await suggestionsController.getAllForOpportunity({ params: { siteId: 'wrong-site-id', opportunityId: 'op12345' } });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityId.calledOnce).to.be.true;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
  });

  it('gets all suggestions for an opportunity by status', async () => {
    const response = await suggestionsController.getByStatus({ params: { siteId: 'site67890', opportunityId: 'op67890', status: 'NEW' } });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.true;
    expect(response.status).to.equal(200);
    const suggestions = await response.json();
    expect(suggestions).to.be.an('array').with.lengthOf(1);
    expect(suggestions[0]).to.have.property('opportunityId', 'op67890');
  });

  it('gets all suggestions for an opportunity by status returns bad request if no Site ID is passed', async () => {
    const response = await suggestionsController.getByStatus({ params: { opportunityId: 'op67890', status: 'NEW' } });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets all suggestions for an opportunity by status returns bad request if no opportunity ID is passed', async () => {
    const response = await suggestionsController.getByStatus({ params: { siteId: 'site67890', status: 'NEW' } });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('gets all suggestions for an opportunity by status returns bad request if no status is passed', async () => {
    const response = await suggestionsController.getByStatus({ params: { siteId: 'site67890', opportunityId: 'op67890' } });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Status is required');
  });

  it('gets all suggestions for an opportunity by status returns bad request if no site ID passed does not match opportunity site id', async () => {
    const response = await suggestionsController.getByStatus({ params: { siteId: 'wrong-site-id', opportunityId: 'op67890', status: 'NEW' } });
    expect(mockSuggestionDataAccess.Suggestion.allByOpportunityIdAndStatus.calledOnce).to.be.true;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity not found');
  });

  it('gets suggestion by ID', async () => {
    const response = await suggestionsController.getByID({ params: { siteId: 'site67890', opportunityId: 'op67890', suggestionId: 'sug12345' } });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.true;
    expect(response.status).to.equal(200);
    const suggestion = await response.json();
    expect(suggestion).to.have.property('id', 'sug12345');
  });

  it('gets suggestion by ID returns bad request if no site ID is passed', async () => {
    const response = await suggestionsController.getByID({ params: { opportunityId: 'op67890', suggestionId: 'sug12345' } });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets suggestion by ID returns bad request if no opportunity ID is passed', async () => {
    const response = await suggestionsController.getByID({ params: { siteId: 'site67890', suggestionId: 'sug12345' } });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('gets suggestion by ID returns bad request if no suggestion ID is passed', async () => {
    const response = await suggestionsController.getByID({ params: { siteId: 'site67890', opportunityId: 'op67890' } });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion ID required');
  });

  it('gets suggestion by ID returns not found if suggestion is not found', async () => {
    mockSuggestion.findById.resolves(null);
    const response = await suggestionsController.getByID({ params: { siteId: 'site67890', opportunityId: 'op67890', suggestionId: 'sug12345' } });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.true;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion not found');
  });

  it('gets suggestion by ID returns not found if suggestion is not associated with the opportunity', async () => {
    const response = await suggestionsController.getByID({ params: { siteId: 'site67890', opportunityId: 'wrong-oportunity-id', suggestionId: 'sug12345' } });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.true;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion not found');
  });

  it('gets suggestion by ID returns not found if site id is not associated with the opportunity', async () => {
    const response = await suggestionsController.getByID({ params: { siteId: 'wrong-site-id', opportunityId: 'op67890', suggestionId: 'sug12345' } });
    expect(mockSuggestionDataAccess.Suggestion.findById.calledOnce).to.be.true;
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion not found');
  });

  it('creates 2 suggestions success', async () => {
    const response = await suggestionsController.createSuggestions({ params: { siteId: 'site67890', opportunityId: 'op67890' }, data: suggs });
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
    expect(createResponse.suggestions[0].suggestion).to.have.property('id', 'sug12345');
    expect(createResponse.suggestions[1].suggestion).to.have.property('id', 'sug67890');
  });

  it('creates bulk suggestion returns 400 and 500 error', async () => {
    suggs[0].throwError = true;
    suggs[1].throwValidationError = true;
    const response = await suggestionsController.createSuggestions({ params: { siteId: 'site67890', opportunityId: 'op67890' }, data: suggs });
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
    const response = await suggestionsController.createSuggestions({ params: { opportunityId: 'op67890' }, data: suggs });
    expect(mockSuggestionDataAccess.Suggestion.create.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('creates a suggestion returns bad request if no opportunity ID is passed', async () => {
    const response = await suggestionsController.createSuggestions({ params: { siteId: 'site67890' }, data: suggs });
    expect(mockSuggestionDataAccess.Suggestion.create.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('creates a suggestion returns bad request if no data is passed', async () => {
    const response = await suggestionsController.createSuggestions({ params: { siteId: 'site67890', opportunityId: 'op67890' } });
    expect(mockSuggestionDataAccess.Suggestion.create.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('creates a suggestion returns bad request if passed data is not an array', async () => {
    const response = await suggestionsController.createSuggestions({ params: { siteId: 'site67890', opportunityId: 'op67890' }, data: 'not an array' });
    expect(mockSuggestionDataAccess.Suggestion.create.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Request body must be an array');
  });

  it('patches a suggestion', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: 'site67890',
        opportunityId: 'op67890',
        suggestionId: 'sug12345',
      },
      data: { rank, data, kpiDeltas },
    });

    expect(response.status).to.equal(200);

    const updatedSuggestion = await response.json();
    expect(updatedSuggestion).to.have.property('opportunityId', 'op67890');
    expect(updatedSuggestion).to.have.property('id', 'sug12345');
    expect(updatedSuggestion).to.have.property('rank', 2);
  });

  it('patches a suggestion returns bad request if no site ID is passed', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        opportunityId: 'op67890',
        suggestionId: 'sug12345',
      },
      data: { rank, data, kpiDeltas },
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('patches a suggestion returns bad request if no opportunity ID is passed', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: 'site67890',
        suggestionId: 'sug12345',
      },
      data: { rank, data, kpiDeltas },
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('patches a suggestion returns bad request if no suggestion ID is passed', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: 'site67890',
        opportunityId: 'op67890',
      },
      data: { rank, data, kpiDeltas },
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
        siteId: 'site67890',
        opportunityId: 'op67890',
        suggestionId: 'sug12345',
      },
      data: { rank, data, kpiDeltas },
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion not found');
  });

  it('patches a suggestion returns not found if suggestion is not associated with the opportunity', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: 'site67890',
        opportunityId: 'wrong-opportunity-id',
        suggestionId: 'sug12345',
      },
      data: { rank, data, kpiDeltas },
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion not found');
  });

  it('patches a suggestion returns not found if site id is not associated with the opportunity', async () => {
    const { rank, data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: 'wrong-site-id',
        opportunityId: 'op67890',
        suggestionId: 'sug12345',
      },
      data: { rank, data, kpiDeltas },
    });
    expect(response.status).to.equal(404);
    const error = await response.json();
    expect(error).to.have.property('message', 'Suggestion not found');
  });

  it('patches a suggestion returns bad request if no data is passed', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: 'site67890',
        opportunityId: 'op67890',
        suggestionId: 'sug12345',
      },
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('patches a suggestion returns bad request if passed data is not an object', async () => {
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: 'site67890',
        opportunityId: 'op67890',
        suggestionId: 'sug12345',
      },
      data: 'not an object',
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('patches a suggestion returns bad request if there is a validation error', async () => {
    const { data, kpiDeltas } = suggs[1];
    const response = await suggestionsController.patchSuggestion({
      params: {
        siteId: 'site67890',
        opportunityId: 'op67890',
        suggestionId: 'sug12345',
      },
      data: { rank: 'throw-error', data, kpiDeltas },
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Validation error');
  });

  it('bulk patches suggestion status 2 successes', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: 'site67890',
        opportunityId: 'op67890',
      },
      data: [{ id: 'sug12345', status: 'NEW-updated' }, { id: 'sug67890', status: 'APPROVED-updated' }],
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

  it('bulk patches suggestion status returns bad request if no site ID is passed', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        opportunityId: 'op67890',
      },
      data: [{ id: 'sug12345', status: 'NEW-NEW' }, { id: 'sug67890', status: 'NEW-APPROVED' }],
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('bulk patches suggestion status returns bad request if no opportunity ID is passed', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: 'site67890',
      },
      data: [{ id: 'sug12345', status: 'NEW-NEW' }, { id: 'sug67890', status: 'NEW-APPROVED' }],
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Opportunity ID required');
  });

  it('bulk patches suggestion status returns bad request if no data is passed', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: 'site67890',
        opportunityId: 'op67890',
      },
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('bulk patches suggestion status returns bad request if passed data is not an array', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: 'site67890',
        opportunityId: 'op67890',
      },
      data: 'not an array',
    });
    expect(response.status).to.equal(400);
    const error = await response.json();
    expect(error).to.have.property('message', 'Request body must be an array of [{ id: <suggestion id>, status: <suggestion status> },...]');
  });

  it('bulk patches suggestion status 1 fails passed data does not have id', async () => {
    const response = await suggestionsController.patchSuggestionsStatus({
      params: {
        siteId: 'site67890',
        opportunityId: 'op67890',
      },
      data: [{ id: 'sug67890', status: 'NEW-APPROVED' }, { status: 'NEW-APPROVED' }],
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
        siteId: 'wrong-site-id',
        opportunityId: 'op67890',
      },
      data: [{ id: 'sug67890', status: 'NEW-APPROVED' }, { id: 'sug12345', status: 'NEW-APPROVED' }],
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
        siteId: 'site67890',
        opportunityId: 'op67890',
      },
      data: [{ id: 'sug67890', status: 'NEW-APPROVED' }, { id: 'sug12345' }],
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
        siteId: 'site67890',
        opportunityId: 'op67890',
      },
      data: [{ id: 'wrong-sugg-id', status: 'NEW-NEW' }, { id: 'sug12345', status: 'NEW-APPROVED' }],
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
        siteId: 'site67890',
        opportunityId: 'op67890',
      },
      data: [{ id: 'sug12345', status: 'NEW' }, { id: 'sug67890', status: 'APPROVED' }],
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
        siteId: 'site67890',
        opportunityId: 'op67890',
      },
      data: [{ id: 'sug12345', status: 'throw-error' }, { id: 'sug67890', status: 'throw-error' }],
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
        siteId: 'site67890',
        opportunityId: 'op67890',
      },
      data: [{ id: 'sug12345', status: 'NEW updated' }, { id: 'sug67890', status: 'APPROVED updated' }],
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
});
