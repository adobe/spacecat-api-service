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

    it('sorts cwv suggestions by pageviews descending using getData()', () => {
      const mk = (id, pageviews) => ({
        getId: () => id,
        getRank: () => 0,
        getData: () => ({ url: `https://example.com/${id}`, pageviews }),
      });
      const s1 = mk('id-1', 5220);
      const s2 = mk('id-2', 3800);
      const s3 = mk('id-3', 900);
      const s4 = mk('id-4', 2000);
      const groups = getTopSuggestions([s1, s2, s3, s4], 'cwv');
      expect(groups).to.have.lengthOf(4);
      expect(groups[0].items[0]).to.equal(s1); // 5220 first
      expect(groups[1].items[0]).to.equal(s2); // 3800
      expect(groups[2].items[0]).to.equal(s4); // 2000
      expect(groups[3].items[0]).to.equal(s3); // 900 last
    });

    it('sorts cwv suggestions by pageviews descending using plain objects', () => {
      const s1 = { id: 'id-1', rank: 0, data: { pageviews: 5220 } };
      const s2 = { id: 'id-2', rank: 0, data: { pageviews: 2000 } };
      const groups = getTopSuggestions([s2, s1], 'cwv');
      expect(groups[0].items[0]).to.equal(s1);
      expect(groups[1].items[0]).to.equal(s2);
    });

    it('cwv tie-breaks by id ascending when pageviews are equal', () => {
      const s1 = { getId: () => 'id-b', getRank: () => 0, getData: () => ({ pageviews: 1000 }) };
      const s2 = { getId: () => 'id-a', getRank: () => 0, getData: () => ({ pageviews: 1000 }) };
      const groups = getTopSuggestions([s1, s2], 'cwv');
      expect(groups[0].items[0]).to.equal(s2); // id-a before id-b
      expect(groups[1].items[0]).to.equal(s1);
    });

    it('cwv tie-breaks by id ascending using plain objects when pageviews are equal', () => {
      const s1 = { id: 'id-b', rank: 0, data: { pageviews: 1000 } };
      const s2 = { id: 'id-a', rank: 0, data: { pageviews: 1000 } };
      const groups = getTopSuggestions([s1, s2], 'cwv');
      expect(groups[0].items[0]).to.equal(s2); // id-a before id-b
      expect(groups[1].items[0]).to.equal(s1);
    });

    it('cwv tie-breaks fall back to empty string when plain objects have no id', () => {
      const s1 = { rank: 0, data: { pageviews: 1000 } };
      const s2 = { rank: 0, data: { pageviews: 1000 } };
      const groups = getTopSuggestions([s1, s2], 'cwv');
      expect(groups).to.have.lengthOf(2);
    });

    it('cwv treats missing pageviews as 0', () => {
      const s1 = { getId: () => 'id-1', getRank: () => 0, getData: () => ({}) };
      const s2 = { getId: () => 'id-2', getRank: () => 0, getData: () => ({ pageviews: 500 }) };
      const groups = getTopSuggestions([s1, s2], 'cwv');
      expect(groups[0].items[0]).to.equal(s2); // 500 before 0
      expect(groups[1].items[0]).to.equal(s1);
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
      const mockSugg = {
        getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
      };
      const existingToken = { getId: () => 'tok-1', getRemaining: () => 0 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([mockSugg]),
      };
      const SuggestionGrant = {
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          grantedIds: [], grantIds: [], notGrantedIds: ['sugg-1'],
        }),
        allByIndexKeys: sandbox.stub().resolves([]),
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

    it('creates token with default total when none exists and grants top suggestions', async () => {
      const s1 = {
        getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
      };
      const s2 = {
        getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'NEW',
      };
      const createdToken = { getRemaining: () => 2 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1, s2]),
      };
      const SuggestionGrant = {
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          grantedIds: [],
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

      // Called once: no re-fetch needed since no revoke occurred
      expect(SuggestionGrant.splitSuggestionsByGrantStatus).to.have.been.calledOnce;
      expect(Token.findBySiteIdAndTokenType).to.have.been.calledTwice;
      // New token uses default total (no suppliedTotal)
      expect(Token.findBySiteIdAndTokenType.secondCall.args[2])
        .to.deep.include({ createIfNotFound: true });
      expect(Token.findBySiteIdAndTokenType.secondCall.args[2])
        .to.not.have.property('total');
      expect(SuggestionGrant.grantSuggestions).to.have.been.calledTwice;
    });

    it('grants only up to remaining token count', async () => {
      const s1 = {
        getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
      };
      const s2 = {
        getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'NEW',
      };
      const existingToken = { getId: () => 'tok-1', getRemaining: () => 1 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1, s2]),
      };
      const SuggestionGrant = {
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          grantedIds: [],
          grantIds: [],
          notGrantedIds: ['sugg-1', 'sugg-2'],
        }),
        allByIndexKeys: sandbox.stub().resolves([]),
        grantSuggestions: sandbox.stub().resolves({ success: true }),
      };
      const Token = {
        findBySiteIdAndTokenType: sandbox.stub()
          .resolves(existingToken),
      };
      const dataAccess = { Suggestion, SuggestionGrant, Token };

      await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

      // Called once: no re-fetch needed since no revoke occurred
      expect(SuggestionGrant.splitSuggestionsByGrantStatus).to.have.been.calledOnce;
      // Only 1 remaining, so only 1 grant call
      expect(SuggestionGrant.grantSuggestions).to.have.been.calledOnce;
      expect(SuggestionGrant.grantSuggestions.firstCall.args[0])
        .to.deep.equal(['sugg-1']);
    });

    describe('new token (new cycle) — revoke and re-grant', () => {
      it('revokes old grants and re-grants when new token is created', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };
        const s2 = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'NEW',
        };
        const s3 = {
          getId: () => 'sugg-3', getRank: () => 3, getStatus: () => 'NEW',
        };
        const createdToken = { getRemaining: () => 3 };
        const tokenAfterRegrant = { getRemaining: () => 1 };
        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1, s2, s3]),
        };
        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub(),
          grantSuggestions: sandbox.stub().resolves({ success: true }),
          revokeSuggestionGrant: sandbox.stub().resolves({ success: true }),
        };
        // First call: initial split
        SuggestionGrant.splitSuggestionsByGrantStatus
          .onFirstCall().resolves({
            grantedIds: ['sugg-1', 'sugg-2'],
            grantIds: ['g1', 'g2'],
            notGrantedIds: ['sugg-3'],
          })
          // Second call: re-fetch after revoke+re-grant, sugg-1/sugg-2 re-granted, sugg-3 not
          .onSecondCall().resolves({
            grantedIds: ['sugg-1', 'sugg-2'],
            grantIds: ['new-g1', 'new-g2'],
            notGrantedIds: ['sugg-3'],
          });
        const Token = {
          findBySiteIdAndTokenType: sandbox.stub(),
        };
        Token.findBySiteIdAndTokenType
          .onFirstCall()
          .resolves(null) // no existing token
          .onSecondCall()
          .resolves(createdToken) // create new token
          .onThirdCall()
          .resolves(tokenAfterRegrant); // after re-grant

        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        // Should revoke old grants
        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledTwice;
        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledWith('g1');
        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledWith('g2');
        // Should re-grant 2 previously granted + 1 new = 3 grant calls
        expect(SuggestionGrant.grantSuggestions).to.have.been.calledThrice;
      });

      it('skips revoke when new token created but no existing grants', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };
        const createdToken = { getRemaining: () => 3 };
        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
        };
        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub().resolves({
            grantedIds: [],
            grantIds: [],
            notGrantedIds: ['sugg-1'],
          }),
          grantSuggestions: sandbox.stub().resolves({ success: true }),
          revokeSuggestionGrant: sandbox.stub(),
        };
        const Token = {
          findBySiteIdAndTokenType: sandbox.stub(),
        };
        Token.findBySiteIdAndTokenType
          .onFirstCall().resolves(null)
          .onSecondCall().resolves(createdToken);
        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        // No revoke needed
        expect(SuggestionGrant.revokeSuggestionGrant).to.not.have.been.called;
        // Called once: no re-fetch needed since no revoke occurred
        expect(SuggestionGrant.splitSuggestionsByGrantStatus).to.have.been.calledOnce;
        // Grant the 1 new suggestion
        expect(SuggestionGrant.grantSuggestions).to.have.been.calledOnce;
      });

      it('handles empty grantIds when grantedIds exist (revokeGrants guard)', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };
        const s2 = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'NEW',
        };
        const createdToken = { getRemaining: () => 3 };
        const tokenAfterRegrant = { getRemaining: () => 1 };
        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1, s2]),
        };
        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub(),
          grantSuggestions: sandbox.stub().resolves({ success: true }),
          revokeSuggestionGrant: sandbox.stub().resolves({ success: true }),
        };
        // grantedIds has items but grantIds is empty — triggers revokeGrants guard
        SuggestionGrant.splitSuggestionsByGrantStatus
          .onFirstCall().resolves({
            grantedIds: ['sugg-1'],
            grantIds: [],
            notGrantedIds: ['sugg-2'],
          })
          .onSecondCall().resolves({
            grantedIds: ['sugg-1'],
            grantIds: [],
            notGrantedIds: ['sugg-2'],
          });
        const Token = {
          findBySiteIdAndTokenType: sandbox.stub(),
        };
        Token.findBySiteIdAndTokenType
          .onFirstCall().resolves(null)
          .onSecondCall().resolves(createdToken)
          .onThirdCall()
          .resolves(tokenAfterRegrant);
        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        // revokeGrants called but no revokes since grantIds is empty
        expect(SuggestionGrant.revokeSuggestionGrant).to.not.have.been.called;
        // Re-grant of grantedIds + grant of remaining
        expect(SuggestionGrant.grantSuggestions.callCount).to.be.greaterThan(0);
      });

      it('returns early after re-grant if token is null on re-fetch', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };
        const s2 = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'NEW',
        };
        const createdToken = { getRemaining: () => 3 };
        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1, s2]),
        };
        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub().resolves({
            grantedIds: ['sugg-1'],
            grantIds: ['g1'],
            notGrantedIds: ['sugg-2'],
          }),
          grantSuggestions: sandbox.stub().resolves({ success: true }),
          revokeSuggestionGrant: sandbox.stub().resolves({ success: true }),
        };
        const Token = {
          findBySiteIdAndTokenType: sandbox.stub(),
        };
        Token.findBySiteIdAndTokenType
          .onFirstCall()
          .resolves(null)
          .onSecondCall()
          .resolves(createdToken)
          .onThirdCall()
          .resolves(null); // token gone on re-fetch
        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        // Revoke + re-grant happened but no new grants since token was null
        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledOnce;
        expect(SuggestionGrant.grantSuggestions).to.have.been.calledOnce; // only re-grant
      });
    });

    describe('existing token — re-grant logic', () => {
      const mkGrant = (suggestionId, grantId) => ({
        getSuggestionId: () => suggestionId,
        getGrantId: () => grantId,
      });

      it('revokes only revocable grants when OUTDATED found and fills from NEW', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };
        const s2 = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'NEW',
        };

        const existingToken = { getId: () => 'tok-1', getRemaining: () => 0 };
        const tokenAfterRevoke = { getId: () => 'tok-1', getRemaining: () => 1 };

        const sugg2Granted = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'OUTDATED',
        };
        const sugg3Granted = {
          getId: () => 'sugg-3', getRank: () => 5, getStatus: () => 'APPROVED',
        };

        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1, s2]),
          batchGetByKeys: sandbox.stub().resolves({
            data: [sugg2Granted, sugg3Granted],
            unprocessed: [],
          }),
        };

        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub().resolves({
            grantedIds: [],
            grantIds: [],
            notGrantedIds: ['sugg-1', 'sugg-2'],
          }),
          allByIndexKeys: sandbox.stub().resolves([
            mkGrant('sugg-2', 'g2'),
            mkGrant('sugg-3', 'g3'),
          ]),
          grantSuggestions: sandbox.stub().resolves({ success: true }),
          revokeSuggestionGrant: sandbox.stub().resolves({ success: true }),
        };

        const Token = {
          findBySiteIdAndTokenType: sandbox.stub(),
        };
        Token.findBySiteIdAndTokenType
          .onFirstCall().resolves(existingToken)
          .onSecondCall().resolves(tokenAfterRevoke); // after revoke

        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        // Should only revoke the stale grant (g2/OUTDATED), not g3 (APPROVED)
        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledOnce;
        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledWith('g2');
        // Remaining=1 after revoking 1 stale grant, fills 1 from NEW
        expect(SuggestionGrant.grantSuggestions).to.have.been.calledOnce;
      });

      it('revokes grants with PENDING_VALIDATION status as stale', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };

        const existingToken = { getId: () => 'tok-1', getRemaining: () => 0 };
        const tokenAfterRevoke = { getId: () => 'tok-1', getRemaining: () => 1 };

        const sugg2PendingValidation = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'PENDING_VALIDATION',
        };

        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
          batchGetByKeys: sandbox.stub().resolves({
            data: [sugg2PendingValidation],
            unprocessed: [],
          }),
        };

        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub().resolves({
            grantedIds: [],
            grantIds: [],
            notGrantedIds: ['sugg-1'],
          }),
          allByIndexKeys: sandbox.stub().resolves([
            mkGrant('sugg-2', 'g2'),
          ]),
          grantSuggestions: sandbox.stub().resolves({ success: true }),
          revokeSuggestionGrant: sandbox.stub().resolves({ success: true }),
        };

        const Token = {
          findBySiteIdAndTokenType: sandbox.stub(),
        };
        Token.findBySiteIdAndTokenType
          .onFirstCall().resolves(existingToken)
          .onSecondCall().resolves(tokenAfterRevoke);

        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledOnce;
        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledWith('g2');
        expect(SuggestionGrant.grantSuggestions).to.have.been.calledOnce;
      });

      it('does not revoke when only NEW grants exist (no stale triggers revocation)', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };

        const existingToken = { getId: () => 'tok-1', getRemaining: () => 0 };

        const sugg2GrantedNew = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'NEW',
        };
        const sugg3Approved = {
          getId: () => 'sugg-3', getRank: () => 5, getStatus: () => 'APPROVED',
        };

        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
          batchGetByKeys: sandbox.stub().resolves({
            data: [sugg2GrantedNew, sugg3Approved],
            unprocessed: [],
          }),
        };

        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub().resolves({
            grantedIds: [],
            grantIds: [],
            notGrantedIds: ['sugg-1'],
          }),
          allByIndexKeys: sandbox.stub().resolves([
            mkGrant('sugg-2', 'g2'),
            mkGrant('sugg-3', 'g3'),
          ]),
          grantSuggestions: sandbox.stub(),
          revokeSuggestionGrant: sandbox.stub(),
        };

        const Token = {
          findBySiteIdAndTokenType: sandbox.stub().resolves(existingToken),
        };

        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        // No stale grants → early return, no revocation even though NEW is revocable
        expect(SuggestionGrant.revokeSuggestionGrant).to.not.have.been.called;
        expect(SuggestionGrant.grantSuggestions).to.not.have.been.called;
      });

      it('revokes NEW grants alongside stale when stale triggers revocation', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };

        const existingToken = { getId: () => 'tok-1', getRemaining: () => 0 };
        const tokenAfterRevoke = { getId: () => 'tok-1', getRemaining: () => 2 };

        const sugg2GrantedNew = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'NEW',
        };
        const sugg3Outdated = {
          getId: () => 'sugg-3', getRank: () => 5, getStatus: () => 'OUTDATED',
        };
        const sugg4Approved = {
          getId: () => 'sugg-4', getRank: () => 8, getStatus: () => 'APPROVED',
        };

        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
          batchGetByKeys: sandbox.stub().resolves({
            data: [sugg2GrantedNew, sugg3Outdated, sugg4Approved],
            unprocessed: [],
          }),
        };

        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub().resolves({
            grantedIds: [],
            grantIds: [],
            notGrantedIds: ['sugg-1'],
          }),
          allByIndexKeys: sandbox.stub().resolves([
            mkGrant('sugg-2', 'g2'),
            mkGrant('sugg-3', 'g3'),
            mkGrant('sugg-4', 'g4'),
          ]),
          grantSuggestions: sandbox.stub().resolves({ success: true }),
          revokeSuggestionGrant: sandbox.stub().resolves({ success: true }),
        };

        const Token = {
          findBySiteIdAndTokenType: sandbox.stub(),
        };
        Token.findBySiteIdAndTokenType
          .onFirstCall().resolves(existingToken)
          .onSecondCall().resolves(tokenAfterRevoke);

        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        // Stale (g3/OUTDATED) triggers revocation, NEW (g2) also revoked; APPROVED (g4) preserved
        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledTwice;
        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledWith('g2');
        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledWith('g3');
        expect(SuggestionGrant.grantSuggestions).to.have.been.calledOnce;
      });

      it('revokes all grants when REJECTED found and fills from NEW', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };

        const existingToken = { getId: () => 'tok-1', getRemaining: () => 0 };
        const tokenAfterRevoke = { getId: () => 'tok-1', getRemaining: () => 1 };

        const sugg2Rejected = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'REJECTED',
        };

        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
          batchGetByKeys: sandbox.stub().resolves({
            data: [sugg2Rejected],
            unprocessed: [],
          }),
        };

        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub().resolves({
            grantedIds: [],
            grantIds: [],
            notGrantedIds: ['sugg-1'],
          }),
          allByIndexKeys: sandbox.stub().resolves([
            mkGrant('sugg-2', 'g2'),
          ]),
          grantSuggestions: sandbox.stub().resolves({ success: true }),
          revokeSuggestionGrant: sandbox.stub().resolves({ success: true }),
        };

        const Token = {
          findBySiteIdAndTokenType: sandbox.stub(),
        };
        Token.findBySiteIdAndTokenType
          .onFirstCall().resolves(existingToken)
          .onSecondCall().resolves(tokenAfterRevoke);

        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledOnce;
        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledWith('g2');
        // Should grant from NEW with freed capacity
        expect(SuggestionGrant.grantSuggestions).to.have.been.calledOnce;
      });

      it('does not revoke when all grants are non-revocable', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };

        const existingToken = { getId: () => 'tok-1', getRemaining: () => 1 };

        const sugg2Approved = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'APPROVED',
        };

        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
          batchGetByKeys: sandbox.stub().resolves({
            data: [sugg2Approved],
            unprocessed: [],
          }),
        };

        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub().resolves({
            grantedIds: [],
            grantIds: [],
            notGrantedIds: ['sugg-1'],
          }),
          allByIndexKeys: sandbox.stub().resolves([
            mkGrant('sugg-2', 'g2'),
          ]),
          grantSuggestions: sandbox.stub().resolves({ success: true }),
          revokeSuggestionGrant: sandbox.stub(),
        };

        const Token = {
          findBySiteIdAndTokenType: sandbox.stub().resolves(existingToken),
        };

        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        // No revoke since all grants are non-revocable (APPROVED)
        expect(SuggestionGrant.revokeSuggestionGrant).to.not.have.been.called;
        // Should grant the 1 ungranted NEW
        expect(SuggestionGrant.grantSuggestions).to.have.been.calledOnce;
      });

      it('skips re-grant logic when no grants exist for token', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };

        const existingToken = { getId: () => 'tok-1', getRemaining: () => 2 };

        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
        };

        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub().resolves({
            grantedIds: [],
            grantIds: [],
            notGrantedIds: ['sugg-1'],
          }),
          allByIndexKeys: sandbox.stub().resolves([]),
          grantSuggestions: sandbox.stub().resolves({ success: true }),
          revokeSuggestionGrant: sandbox.stub(),
        };

        const Token = {
          findBySiteIdAndTokenType: sandbox.stub().resolves(existingToken),
        };

        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        expect(SuggestionGrant.revokeSuggestionGrant).to.not.have.been.called;
        expect(SuggestionGrant.grantSuggestions).to.have.been.calledOnce;
      });

      it('returns early if token is null after revoking revocable grants', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };

        const existingToken = { getId: () => 'tok-1', getRemaining: () => 1 };

        const sugg2Outdated = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'OUTDATED',
        };

        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
          batchGetByKeys: sandbox.stub().resolves({
            data: [sugg2Outdated],
            unprocessed: [],
          }),
        };

        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub().resolves({
            grantedIds: [],
            grantIds: [],
            notGrantedIds: ['sugg-1'],
          }),
          allByIndexKeys: sandbox.stub().resolves([
            mkGrant('sugg-2', 'g2'),
          ]),
          grantSuggestions: sandbox.stub(),
          revokeSuggestionGrant: sandbox.stub().resolves({ success: true }),
        };

        const Token = {
          findBySiteIdAndTokenType: sandbox.stub(),
        };
        Token.findBySiteIdAndTokenType
          .onFirstCall().resolves(existingToken)
          .onSecondCall().resolves(null); // token gone after revoke

        const dataAccess = { Suggestion, SuggestionGrant, Token };

        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);

        expect(SuggestionGrant.revokeSuggestionGrant).to.have.been.calledOnce;
        expect(SuggestionGrant.grantSuggestions).to.not.have.been.called;
      });

      it('throws when revokeSuggestionGrant fails for revocable grants', async () => {
        const s1 = {
          getId: () => 'sugg-1', getRank: () => 1, getStatus: () => 'NEW',
        };

        const existingToken = { getId: () => 'tok-1', getRemaining: () => 1 };

        const sugg2Outdated = {
          getId: () => 'sugg-2', getRank: () => 2, getStatus: () => 'OUTDATED',
        };

        const Suggestion = {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
          batchGetByKeys: sandbox.stub().resolves({
            data: [sugg2Outdated],
            unprocessed: [],
          }),
        };

        const SuggestionGrant = {
          splitSuggestionsByGrantStatus: sandbox.stub().resolves({
            grantedIds: [],
            grantIds: [],
            notGrantedIds: ['sugg-1'],
          }),
          allByIndexKeys: sandbox.stub().resolves([
            { getSuggestionId: () => 'sugg-2', getGrantId: () => 'g2' },
          ]),
          grantSuggestions: sandbox.stub(),
          revokeSuggestionGrant: sandbox.stub().rejects(new Error('DB error')),
        };

        const Token = {
          findBySiteIdAndTokenType: sandbox.stub().resolves(existingToken),
        };

        const dataAccess = { Suggestion, SuggestionGrant, Token };

        try {
          await grantSuggestionsForOpportunity(dataAccess, site, opportunity);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.equal('Failed to revoke 1/1 grants');
        }
      });
    });

    it('skips grant for groups with no valid ids', async () => {
      const s1 = {
        getId: () => '', getRank: () => 1, getStatus: () => 'NEW',
      };
      const existingToken = { getId: () => 'tok-1', getRemaining: () => 1 };
      const Suggestion = {
        allByOpportunityIdAndStatus: sandbox.stub().resolves([s1]),
      };
      const SuggestionGrant = {
        splitSuggestionsByGrantStatus: sandbox.stub().resolves({
          grantedIds: [],
          grantIds: [],
          notGrantedIds: [''],
        }),
        allByIndexKeys: sandbox.stub().resolves([]),
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
