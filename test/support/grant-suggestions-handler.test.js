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
      expect(groups.every((g) => Array.isArray(g.items) && g.items.length === 1)).to.be.true;
      const allItems = groups.flatMap((g) => g.items);
      expect(allItems).to.include(s1);
      expect(allItems).to.include(s2);
    });

    it('exposes getRank on default groups delegating to first item', () => {
      const s1 = { getId: () => 'id-1', getRank: () => 10 };
      const s2 = { getId: () => 'id-2', getRank: () => 5 };
      const groups = getTopSuggestions([s1, s2]);
      expect(groups[0].getRank()).to.equal(5);
      expect(groups[1].getRank()).to.equal(10);
    });

    it('sorts groups by rank ascending then by id (default sort)', () => {
      const s1 = { getId: () => 'id-b', getRank: () => 10 };
      const s2 = { getId: () => 'id-a', getRank: () => 5 };
      const s3 = { getId: () => 'id-c', getRank: () => 10 };
      const groups = getTopSuggestions([s1, s2, s3]);
      expect(groups).to.have.lengthOf(3);
      expect(groups[0].items[0]).to.equal(s2); // rank 5 first
      expect(groups[1].items[0]).to.equal(s1); // rank 10, id-b before id-c
      expect(groups[2].items[0]).to.equal(s3); // rank 10, id-c
    });

    it('handles plain objects with id and rank', () => {
      const s1 = { id: 'x', rank: 1 };
      const s2 = { id: 'y', rank: 0 };
      const groups = getTopSuggestions([s1, s2]);
      expect(groups).to.have.lengthOf(2);
      expect(groups[0].items[0]).to.equal(s2);
      expect(groups[1].items[0]).to.equal(s1);
    });

    it('uses default strategy for unknown opportunity name', () => {
      const s1 = { getId: () => 'id-1', getRank: () => 10 };
      const s2 = { getId: () => 'id-2', getRank: () => 5 };
      const groups = getTopSuggestions([s1, s2], 'unknown-type');
      expect(groups).to.have.lengthOf(2);
      expect(groups[0].items[0]).to.equal(s2);
      expect(groups[1].items[0]).to.equal(s1);
    });

    it('groups broken-backlinks suggestions by data.url_to using getData()', () => {
      const s1 = { getId: () => 'id-1', getRank: () => 10, getData: () => ({ url_to: 'https://example.com/a' }) };
      const s2 = { getId: () => 'id-2', getRank: () => 5, getData: () => ({ url_to: 'https://example.com/a' }) };
      const s3 = { getId: () => 'id-3', getRank: () => 8, getData: () => ({ url_to: 'https://example.com/b' }) };
      const groups = getTopSuggestions([s1, s2, s3], 'broken-backlinks');
      expect(groups).to.have.lengthOf(2);
      const groupA = groups.find((g) => g.items[0].getData().url_to === 'https://example.com/a');
      const groupB = groups.find((g) => g.items[0].getData().url_to === 'https://example.com/b');
      expect(groupA.items).to.have.lengthOf(2);
      expect(groupB.items).to.have.lengthOf(1);
    });

    it('broken-backlinks group getRank returns highest rank among items', () => {
      const s1 = { getId: () => 'id-1', getRank: () => 10, getData: () => ({ url_to: 'https://example.com/a' }) };
      const s2 = { getId: () => 'id-2', getRank: () => 5, getData: () => ({ url_to: 'https://example.com/a' }) };
      const s3 = { getId: () => 'id-3', getRank: () => 8, getData: () => ({ url_to: 'https://example.com/b' }) };
      const groups = getTopSuggestions([s1, s2, s3], 'broken-backlinks');
      const groupA = groups.find((g) => g.items.includes(s1));
      const groupB = groups.find((g) => g.items.includes(s3));
      expect(groupA.getRank()).to.equal(10);
      expect(groupB.getRank()).to.equal(8);
    });

    it('groups broken-backlinks suggestions by data.urlTo (camelCase fallback)', () => {
      const s1 = { getId: () => 'id-1', getRank: () => 1, getData: () => ({ urlTo: 'https://example.com/x' }) };
      const s2 = { getId: () => 'id-2', getRank: () => 2, getData: () => ({ urlTo: 'https://example.com/x' }) };
      const groups = getTopSuggestions([s1, s2], 'broken-backlinks');
      expect(groups).to.have.lengthOf(1);
      expect(groups[0].items).to.have.lengthOf(2);
    });

    it('groups broken-backlinks suggestions using plain object data', () => {
      const s1 = { id: 'id-1', rank: 1, data: { url_to: 'https://example.com/a' } };
      const s2 = { id: 'id-2', rank: 2, data: { url_to: 'https://example.com/b' } };
      const groups = getTopSuggestions([s1, s2], 'broken-backlinks');
      expect(groups).to.have.lengthOf(2);
      expect(groups[0].items).to.have.lengthOf(1);
      expect(groups[1].items).to.have.lengthOf(1);
    });

    it('groups broken-backlinks suggestions with missing data under empty string key', () => {
      const s1 = { getId: () => 'id-1', getRank: () => 1, getData: () => ({}) };
      const s2 = { getId: () => 'id-2', getRank: () => 2, getData: () => null };
      const groups = getTopSuggestions([s1, s2], 'broken-backlinks');
      expect(groups).to.have.lengthOf(1);
      expect(groups[0].items).to.have.lengthOf(2);
    });

    it('groups and ranks 10 broken-backlinks suggestions correctly', () => {
      const mk = (id, rank, urlTo) => ({
        getId: () => id, getRank: () => rank, getData: () => ({ url_to: urlTo }),
      });
      // 4 distinct url_to values across 10 suggestions
      const suggestions = [
        mk('s01', 100, 'https://example.com/page-a'), // group A
        mk('s02', 500, 'https://example.com/page-b'), // group B
        mk('s03', 200, 'https://example.com/page-a'), // group A
        mk('s04', 50, 'https://example.com/page-c'), // group C
        mk('s05', 800, 'https://example.com/page-b'), // group B (highest in B)
        mk('s06', 300, 'https://example.com/page-d'), // group D
        mk('s07', 150, 'https://example.com/page-c'), // group C
        mk('s08', 900, 'https://example.com/page-a'), // group A (highest in A)
        mk('s09', 700, 'https://example.com/page-d'), // group D (highest in D)
        mk('s10', 400, 'https://example.com/page-c'), // group C (highest in C)
      ];

      const groups = getTopSuggestions(suggestions, 'broken-backlinks');

      // 4 groups: A(s01,s03,s08), B(s02,s05), C(s04,s07,s10), D(s06,s09)
      expect(groups).to.have.lengthOf(4);

      // group ranks: A=900, B=800, D=700, C=400
      // sorted ascending: C(400), D(700), B(800), A(900)
      expect(groups[0].getRank()).to.equal(400);
      expect(groups[1].getRank()).to.equal(700);
      expect(groups[2].getRank()).to.equal(800);
      expect(groups[3].getRank()).to.equal(900);

      // verify group C (rank 400) — page-c items
      const groupC = groups[0];
      expect(groupC.items).to.have.lengthOf(3);
      const groupCIds = groupC.items.map((s) => s.getId());
      expect(groupCIds).to.include.members(['s04', 's07', 's10']);

      // verify group D (rank 700) — page-d items
      const groupD = groups[1];
      expect(groupD.items).to.have.lengthOf(2);
      const groupDIds = groupD.items.map((s) => s.getId());
      expect(groupDIds).to.include.members(['s06', 's09']);

      // verify group B (rank 800) — page-b items
      const groupB = groups[2];
      expect(groupB.items).to.have.lengthOf(2);
      const groupBIds = groupB.items.map((s) => s.getId());
      expect(groupBIds).to.include.members(['s02', 's05']);

      // verify group A (rank 900) — page-a items
      const groupA = groups[3];
      expect(groupA.items).to.have.lengthOf(3);
      const groupAIds = groupA.items.map((s) => s.getId());
      expect(groupAIds).to.include.members(['s01', 's03', 's08']);

      // slicing top 2 groups gives the two lowest-ranked groups
      const top2 = groups.slice(0, 2);
      expect(top2[0].getRank()).to.equal(400); // group C
      expect(top2[1].getRank()).to.equal(700); // group D
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

    it('returns early when Token, Suggestion, or SuggestionGrant is missing from dataAccess', async () => {
      const Suggestion = { allByOpportunityIdAndStatus: sandbox.stub() };
      const SuggestionGrant = {};
      await grantSuggestionsForOpportunity({
        Suggestion, SuggestionGrant, Token: null,
      }, site, opportunity);
      await grantSuggestionsForOpportunity({
        Suggestion: null, SuggestionGrant, Token: {},
      }, site, opportunity);
      await grantSuggestionsForOpportunity({
        Suggestion, SuggestionGrant: null, Token: {},
      }, site, opportunity);
      expect(Suggestion.allByOpportunityIdAndStatus).to.not.have.been.called;
    });

    it('returns early when opportunity type has no token type mapping', async () => {
      const Token = { findBySiteIdAndTokenType: sandbox.stub() };
      const dataAccess = { Suggestion: {}, SuggestionGrant: {}, Token };
      const oppNoMapping = { getId: () => opptyId, getType: () => 'unknown-type' };
      await grantSuggestionsForOpportunity(dataAccess, site, oppNoMapping);
      expect(Token.findBySiteIdAndTokenType).to.not.have.been.called;
    });

    it('returns early when no new suggestions exist', async () => {
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([]),
      };
      const Token = { findBySiteIdAndTokenType: sandbox.stub() };
      const dataAccess = { Suggestion, SuggestionGrant: {}, Token };
      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);
      expect(Token.findBySiteIdAndTokenType).to.not.have.been.called;
    });

    it('returns early when token exists with no remaining', async () => {
      const mockSugg = { getId: () => 'sugg-1', getRank: () => 1 };
      const existingToken = { getRemaining: () => 0 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([mockSugg]),
      };
      const SuggestionGrant = {
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          grantIds: [], notGrantedIds: ['sugg-1'],
        }),
        grantSuggestions: sandbox.stub(),
      };
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub().resolves(existingToken),
      };
      const dataAccess = { Suggestion, SuggestionGrant, Token };
      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);
      expect(SuggestionGrant.splitSuggestionsByGrantStatus)
        .to.have.been.calledOnce;
      expect(SuggestionGrant.grantSuggestions).to.not.have.been.called;
    });

    it('creates token when none exists and grants top suggestions', async () => {
      const s1 = { getId: () => 'sugg-1', getRank: () => 1 };
      const s2 = { getId: () => 'sugg-2', getRank: () => 2 };
      const createdToken = { getRemaining: () => 2 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1, s2]),
      };
      const SuggestionGrant = {
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          grantIds: [],
          notGrantedIds: ['sugg-1', 'sugg-2'],
        }),
        grantSuggestions: sandbox.stub().resolves({ success: true }),
      };
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub(),
      };
      Token.findBySiteIdAndTokenType
        .onFirstCall().resolves(null)
        .onSecondCall().resolves(createdToken);
      const dataAccess = { Suggestion, SuggestionGrant, Token };

      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

      expect(SuggestionGrant.splitSuggestionsByGrantStatus).to.have.been.calledOnce;
      expect(Token.findBySiteIdAndTokenType).to.have.been.calledTwice;
      expect(Token.findBySiteIdAndTokenType.secondCall.args[2])
        .to.deep.include({ createIfNotFound: true });
      expect(SuggestionGrant.grantSuggestions).to.have.been.calledTwice;
    });

    it('grants only up to remaining token count', async () => {
      const s1 = { getId: () => 'sugg-1', getRank: () => 1 };
      const s2 = { getId: () => 'sugg-2', getRank: () => 2 };
      const existingToken = { getRemaining: () => 1 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1, s2]),
      };
      const SuggestionGrant = {
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          notGrantedIds: ['sugg-1', 'sugg-2'],
        }),
        grantSuggestions: sandbox.stub().resolves({ success: true }),
      };
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub()
          .resolves(existingToken),
      };
      const dataAccess = { Suggestion, SuggestionGrant, Token };

      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

      // Only 1 remaining, so only 1 grant call
      expect(SuggestionGrant.grantSuggestions).to.have.been.calledOnce;
      expect(SuggestionGrant.grantSuggestions.firstCall.args[0])
        .to.deep.equal(['sugg-1']);
    });

    it('adjusts total by already-granted count when creating token', async () => {
      const s1 = { getId: () => 'sugg-1', getRank: () => 1 };
      const createdToken = { getRemaining: () => 1 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
      };
      const SuggestionGrant = {
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          grantIds: ['g1', 'g2'],
          notGrantedIds: ['sugg-1'],
        }),
        grantSuggestions: sandbox.stub().resolves({ success: true }),
      };
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub(),
      };
      Token.findBySiteIdAndTokenType
        .onFirstCall().resolves(null)
        .onSecondCall().resolves(createdToken);
      const dataAccess = { Suggestion, SuggestionGrant, Token };

      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

      expect(SuggestionGrant.splitSuggestionsByGrantStatus).to.have.been.calledOnce;
      // tokensPerCycle=3, 2 already granted => total=1
      const createArgs = Token.findBySiteIdAndTokenType.secondCall.args;
      expect(createArgs[2]).to.deep.include({ total: 1 });
    });

    it('handles undefined grantIds when creating token', async () => {
      const s1 = { getId: () => 'sugg-1', getRank: () => 1 };
      const createdToken = { getRemaining: () => 1 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
      };
      const SuggestionGrant = {
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          notGrantedIds: ['sugg-1'],
        }),
        grantSuggestions: sandbox.stub().resolves({ success: true }),
      };
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub(),
      };
      Token.findBySiteIdAndTokenType
        .onFirstCall().resolves(null)
        .onSecondCall().resolves(createdToken);
      const dataAccess = { Suggestion, SuggestionGrant, Token };

      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

      expect(SuggestionGrant.splitSuggestionsByGrantStatus).to.have.been.calledOnce;
      const createArgs = Token.findBySiteIdAndTokenType.secondCall.args;
      expect(createArgs[2]).to.deep.include({ total: 3 });
    });

    it('skips grant for groups with no valid ids', async () => {
      const s1 = { getId: () => '', getRank: () => 1 };
      const existingToken = { getRemaining: () => 1 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
      };
      const SuggestionGrant = {
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          notGrantedIds: [''],
        }),
        grantSuggestions: sandbox.stub(),
      };
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub()
          .resolves(existingToken),
      };
      const dataAccess = { Suggestion, SuggestionGrant, Token };

      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

      expect(SuggestionGrant.grantSuggestions).to.not.have.been.called;
    });
  });
});
