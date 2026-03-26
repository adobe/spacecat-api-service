/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { loadSuggestionsByOpportunityIds } from '../../../src/controllers/paid/opportunity-suggestions.js';

const createSuggestion = ({ opportunityId, status = 'NEW' }) => ({
  getOpportunityId: () => opportunityId,
  getStatus: () => status,
});

describe('loadSuggestionsByOpportunityIds', () => {
  let sandbox;
  let log;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      warn: sandbox.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('uses batchGetByKeys when available and groups suggestions by opportunity', async () => {
    const Suggestion = {
      batchGetByKeys: sandbox.stub().resolves({
        data: [
          createSuggestion({ opportunityId: 'opp-1', status: 'NEW' }),
          createSuggestion({ opportunityId: 'opp-1', status: 'PENDING_VALIDATION' }),
          createSuggestion({ opportunityId: 'opp-2', status: 'NEW' }),
        ],
        unprocessed: [],
      }),
      allByOpportunityId: sandbox.stub(),
    };

    const {
      suggestionsByOpportunityId,
      failedOpportunityIds,
    } = await loadSuggestionsByOpportunityIds(
      Suggestion,
      ['opp-1', 'opp-2', 'opp-3'],
      log,
    );

    expect(Suggestion.batchGetByKeys.calledOnce).to.be.true;
    expect(Suggestion.batchGetByKeys.firstCall.args[0]).to.deep.equal([
      { opportunityId: 'opp-1' },
      { opportunityId: 'opp-2' },
      { opportunityId: 'opp-3' },
    ]);
    expect(Suggestion.allByOpportunityId.called).to.be.false;
    expect(failedOpportunityIds.size).to.equal(0);
    expect(suggestionsByOpportunityId.get('opp-1').hasPendingValidation).to.be.true;
    expect(suggestionsByOpportunityId.get('opp-1').newSuggestions).to.have.lengthOf(1);
    expect(suggestionsByOpportunityId.get('opp-2').newSuggestions).to.have.lengthOf(1);
    expect(suggestionsByOpportunityId.get('opp-3')).to.deep.equal({
      newSuggestions: [],
      hasPendingValidation: false,
    });
  });

  it('falls back to per-opportunity fetches when batchGetByKeys fails', async () => {
    const Suggestion = {
      batchGetByKeys: sandbox.stub().rejects(new Error('batch failed')),
      allByOpportunityId: sandbox.stub(),
    };

    Suggestion.allByOpportunityId.withArgs('opp-1').resolves([
      createSuggestion({ opportunityId: 'opp-1', status: 'NEW' }),
    ]);
    Suggestion.allByOpportunityId.withArgs('opp-2').rejects(new Error('single failed'));

    const {
      suggestionsByOpportunityId,
      failedOpportunityIds,
    } = await loadSuggestionsByOpportunityIds(
      Suggestion,
      ['opp-1', 'opp-2'],
      log,
    );

    expect(log.warn.calledTwice).to.be.true;
    expect(log.warn.firstCall.args[0]).to.equal(
      'Batch suggestion fetch failed, falling back to per-opportunity queries',
    );
    expect(log.warn.secondCall.args[0]).to.equal(
      'Failed to fetch suggestions for opportunity, excluding from results',
    );
    expect(failedOpportunityIds.has('opp-2')).to.be.true;
    expect(suggestionsByOpportunityId.get('opp-1').newSuggestions).to.have.lengthOf(1);
    expect(suggestionsByOpportunityId.get('opp-1').hasPendingValidation).to.be.false;
  });

  it('ignores suggestions returned for unknown opportunity IDs', async () => {
    const Suggestion = {
      batchGetByKeys: sandbox.stub().resolves({
        data: [
          createSuggestion({ opportunityId: 'opp-1', status: 'NEW' }),
          createSuggestion({ opportunityId: 'opp-extra', status: 'PENDING_VALIDATION' }),
        ],
        unprocessed: [],
      }),
      allByOpportunityId: sandbox.stub(),
    };

    const { suggestionsByOpportunityId } = await loadSuggestionsByOpportunityIds(
      Suggestion,
      ['opp-1'],
      log,
    );

    expect(suggestionsByOpportunityId.get('opp-1').newSuggestions).to.have.lengthOf(1);
    expect(suggestionsByOpportunityId.get('opp-1').hasPendingValidation).to.be.false;
  });

  it('returns empty results without querying when no opportunity IDs are provided', async () => {
    const Suggestion = {
      batchGetByKeys: sandbox.stub(),
      allByOpportunityId: sandbox.stub(),
    };

    const {
      suggestionsByOpportunityId,
      failedOpportunityIds,
    } = await loadSuggestionsByOpportunityIds(
      Suggestion,
      [],
      log,
    );

    expect(suggestionsByOpportunityId.size).to.equal(0);
    expect(failedOpportunityIds.size).to.equal(0);
    expect(Suggestion.batchGetByKeys.called).to.be.false;
    expect(Suggestion.allByOpportunityId.called).to.be.false;
  });

  it('treats null batch results as empty suggestions', async () => {
    const Suggestion = {
      batchGetByKeys: sandbox.stub().resolves({ data: null, unprocessed: [] }),
      allByOpportunityId: sandbox.stub(),
    };

    const {
      suggestionsByOpportunityId,
      failedOpportunityIds,
    } = await loadSuggestionsByOpportunityIds(
      Suggestion,
      ['opp-1'],
      log,
    );

    expect(failedOpportunityIds.size).to.equal(0);
    expect(suggestionsByOpportunityId.get('opp-1')).to.deep.equal({
      newSuggestions: [],
      hasPendingValidation: false,
    });
  });

  it('uses per-opportunity fetches when batchGetByKeys is unavailable', async () => {
    const Suggestion = {
      allByOpportunityId: sandbox.stub(),
    };

    Suggestion.allByOpportunityId.withArgs('opp-1').resolves([
      createSuggestion({ opportunityId: 'opp-1', status: 'NEW' }),
      createSuggestion({ opportunityId: 'opp-1', status: 'PENDING_VALIDATION' }),
      createSuggestion({ opportunityId: 'opp-1', status: 'ERROR' }),
    ]);

    const {
      suggestionsByOpportunityId,
      failedOpportunityIds,
    } = await loadSuggestionsByOpportunityIds(
      Suggestion,
      ['opp-1'],
      log,
    );

    expect(failedOpportunityIds.size).to.equal(0);
    expect(suggestionsByOpportunityId.get('opp-1').newSuggestions).to.have.lengthOf(1);
    expect(suggestionsByOpportunityId.get('opp-1').hasPendingValidation).to.be.true;
  });

  it('treats null per-opportunity results as empty suggestions', async () => {
    const Suggestion = {
      allByOpportunityId: sandbox.stub().withArgs('opp-1').resolves(null),
    };

    const {
      suggestionsByOpportunityId,
      failedOpportunityIds,
    } = await loadSuggestionsByOpportunityIds(
      Suggestion,
      ['opp-1'],
      log,
    );

    expect(failedOpportunityIds.size).to.equal(0);
    expect(suggestionsByOpportunityId.get('opp-1')).to.deep.equal({
      newSuggestions: [],
      hasPendingValidation: false,
    });
  });
});
