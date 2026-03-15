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

/* eslint-env mocha */

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { getTopSuggestions, grantSuggestionsForOpportunity } from '../../src/support/grant-suggestions-handler.js';

use(chaiAsPromised);
use(sinonChai);

describe('grant-suggestions-handler', () => {
  const sandbox = sinon.createSandbox();

  afterEach(() => {
    sandbox.restore();
  });

  describe('getTopSuggestions', () => {
    it('returns empty array when suggestions is null or undefined', () => {
      expect(getTopSuggestions(null)).to.deep.equal([]);
      expect(getTopSuggestions(undefined)).to.deep.equal([]);
    });

    it('returns empty array when suggestions is empty', () => {
      expect(getTopSuggestions([])).to.deep.equal([]);
    });

    it('returns one group per suggestion (default grouping)', () => {
      const s1 = { getId: () => 'id-1', getRank: () => 10 };
      const s2 = { getId: () => 'id-2', getRank: () => 5 };
      const groups = getTopSuggestions([s1, s2]);
      expect(groups).to.have.lengthOf(2);
      expect(groups.every((g) => Array.isArray(g) && g.length === 1)).to.be.true;
      const flat = groups.flat();
      expect(flat).to.include(s1);
      expect(flat).to.include(s2);
    });

    it('sorts groups by rank ascending then by id (default sort)', () => {
      const s1 = { getId: () => 'id-b', getRank: () => 10 };
      const s2 = { getId: () => 'id-a', getRank: () => 5 };
      const s3 = { getId: () => 'id-c', getRank: () => 10 };
      const groups = getTopSuggestions([s1, s2, s3]);
      expect(groups).to.have.lengthOf(3);
      expect(groups[0][0]).to.equal(s2); // rank 5 first
      expect(groups[1][0]).to.equal(s1); // rank 10, id-b before id-c
      expect(groups[2][0]).to.equal(s3); // rank 10, id-c
    });

    it('handles plain objects with id and rank', () => {
      const s1 = { id: 'x', rank: 1 };
      const s2 = { id: 'y', rank: 0 };
      const groups = getTopSuggestions([s1, s2]);
      expect(groups).to.have.lengthOf(2);
      expect(groups[0][0]).to.equal(s2);
      expect(groups[1][0]).to.equal(s1);
    });

    it('uses default strategy for unknown opportunity name', () => {
      const s1 = { getId: () => 'id-1', getRank: () => 10 };
      const s2 = { getId: () => 'id-2', getRank: () => 5 };
      const groups = getTopSuggestions([s1, s2], 'unknown-type');
      expect(groups).to.have.lengthOf(2);
      expect(groups[0][0]).to.equal(s2);
      expect(groups[1][0]).to.equal(s1);
    });

    it('falls back to defaults for objects missing rank and id', () => {
      const s1 = { foo: 'bar' };
      const s2 = { foo: 'baz' };
      const groups = getTopSuggestions([s1, s2]);
      expect(groups).to.have.lengthOf(2);
    });
  });

  describe('grantSuggestionsForOpportunity', () => {
    const siteId = 'site-uuid';
    const opptyId = 'oppty-uuid';
    const site = { getId: () => siteId };
    const opportunity = { getId: () => opptyId, getType: () => 'cwv' };

    it('returns early when dataAccess is missing', async () => {
      const Token = sandbox.stub();
      await grantSuggestionsForOpportunity(null, site, opportunity);
      await grantSuggestionsForOpportunity(undefined, site, opportunity);
      expect(Token).to.not.have.been.called;
    });

    it('returns early when site or opportunity is missing', async () => {
      const dataAccess = { Suggestion: {}, Token: {} };
      await grantSuggestionsForOpportunity(dataAccess, null, opportunity);
      await grantSuggestionsForOpportunity(dataAccess, site, null);
      expect(true).to.be.true;
    });

    it('returns early when Token or Suggestion is missing from dataAccess', async () => {
      const Suggestion = { allByOpportunityIdAndStatus: sandbox.stub() };
      await grantSuggestionsForOpportunity({ Suggestion, Token: null }, site, opportunity);
      await grantSuggestionsForOpportunity({ Suggestion: null, Token: {} }, site, opportunity);
      expect(Suggestion.allByOpportunityIdAndStatus).to.not.have.been.called;
    });

    it('returns early when opportunity type has no token type mapping', async () => {
      const Token = { findBySiteIdAndTokenType: sandbox.stub() };
      const dataAccess = { Suggestion: {}, Token };
      const oppNoMapping = { getId: () => opptyId, getType: () => 'unknown-type' };
      await grantSuggestionsForOpportunity(dataAccess, site, oppNoMapping);
      expect(Token.findBySiteIdAndTokenType).to.not.have.been.called;
    });

    it('returns early when no new suggestions exist', async () => {
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([]),
      };
      const Token = { findBySiteIdAndTokenType: sandbox.stub() };
      const dataAccess = { Suggestion, Token };
      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);
      expect(Token.findBySiteIdAndTokenType).to.not.have.been.called;
    });

    it('returns early when token exists with no remaining', async () => {
      const mockSugg = { getId: () => 'sugg-1', getRank: () => 1 };
      const existingToken = { getRemaining: () => 0 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([mockSugg]),
        splitSuggestionsByGrantStatus: sandbox.stub(),
        grantSuggestions: sandbox.stub(),
      };
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub().resolves(existingToken),
      };
      const dataAccess = { Suggestion, Token };
      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);
      expect(Suggestion.splitSuggestionsByGrantStatus)
        .to.not.have.been.called;
      expect(Suggestion.grantSuggestions).to.not.have.been.called;
    });

    it('creates token when none exists and grants top suggestions', async () => {
      const s1 = { getId: () => 'sugg-1', getRank: () => 1 };
      const s2 = { getId: () => 'sugg-2', getRank: () => 2 };
      const createdToken = { getRemaining: () => 2 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1, s2]),
        splitSuggestionsByGrantStatus: sandbox.stub(),
        grantSuggestions: sandbox.stub().resolves({ success: true }),
      };
      // First call: no token, second call: create
      Suggestion.splitSuggestionsByGrantStatus
        .onFirstCall().resolves({ grantIds: [] })
        .onSecondCall().resolves({
          notGrantedIds: ['sugg-1', 'sugg-2'],
        });
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub(),
      };
      Token.findBySiteIdAndTokenType
        .onFirstCall().resolves(null)
        .onSecondCall().resolves(createdToken);
      const dataAccess = { Suggestion, Token };

      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

      expect(Token.findBySiteIdAndTokenType).to.have.been.calledTwice;
      expect(Token.findBySiteIdAndTokenType.secondCall.args[2])
        .to.deep.include({ createIfNotFound: true });
      expect(Suggestion.grantSuggestions).to.have.been.calledTwice;
    });

    it('grants only up to remaining token count', async () => {
      const s1 = { getId: () => 'sugg-1', getRank: () => 1 };
      const s2 = { getId: () => 'sugg-2', getRank: () => 2 };
      const existingToken = { getRemaining: () => 1 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1, s2]),
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          notGrantedIds: ['sugg-1', 'sugg-2'],
        }),
        grantSuggestions: sandbox.stub().resolves({ success: true }),
      };
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub()
          .resolves(existingToken),
      };
      const dataAccess = { Suggestion, Token };

      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

      // Only 1 remaining, so only 1 grant call
      expect(Suggestion.grantSuggestions).to.have.been.calledOnce;
      expect(Suggestion.grantSuggestions.firstCall.args[0])
        .to.deep.equal(['sugg-1']);
    });

    it('adjusts total by already-granted count when creating token', async () => {
      const s1 = { getId: () => 'sugg-1', getRank: () => 1 };
      const createdToken = { getRemaining: () => 1 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
        splitSuggestionsByGrantStatus: sandbox.stub(),
        grantSuggestions: sandbox.stub().resolves({ success: true }),
      };
      Suggestion.splitSuggestionsByGrantStatus
        .onFirstCall().resolves({ grantIds: ['g1', 'g2'] })
        .onSecondCall().resolves({ notGrantedIds: ['sugg-1'] });
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub(),
      };
      Token.findBySiteIdAndTokenType
        .onFirstCall().resolves(null)
        .onSecondCall().resolves(createdToken);
      const dataAccess = { Suggestion, Token };

      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

      // tokensPerCycle=3, 2 already granted => total=1
      const createArgs = Token.findBySiteIdAndTokenType.secondCall.args;
      expect(createArgs[2]).to.deep.include({ total: 1 });
    });

    it('handles undefined grantIds when creating token', async () => {
      const s1 = { getId: () => 'sugg-1', getRank: () => 1 };
      const createdToken = { getRemaining: () => 1 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
        splitSuggestionsByGrantStatus: sandbox.stub(),
        grantSuggestions: sandbox.stub().resolves({ success: true }),
      };
      Suggestion.splitSuggestionsByGrantStatus
        .onFirstCall().resolves({})
        .onSecondCall().resolves({ notGrantedIds: ['sugg-1'] });
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub(),
      };
      Token.findBySiteIdAndTokenType
        .onFirstCall().resolves(null)
        .onSecondCall().resolves(createdToken);
      const dataAccess = { Suggestion, Token };

      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

      const createArgs = Token.findBySiteIdAndTokenType.secondCall.args;
      expect(createArgs[2]).to.deep.include({ total: 3 });
    });

    it('skips grant for groups with no valid ids', async () => {
      const s1 = { getId: () => '', getRank: () => 1 };
      const existingToken = { getRemaining: () => 1 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          notGrantedIds: [''],
        }),
        grantSuggestions: sandbox.stub(),
      };
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub()
          .resolves(existingToken),
      };
      const dataAccess = { Suggestion, Token };

      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

      expect(Suggestion.grantSuggestions).to.not.have.been.called;
    });
  });
});
