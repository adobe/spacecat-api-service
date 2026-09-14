/*
 * Copyright 2026 Adobe. All rights reserved.
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
import {
  ALL_PLATFORMS,
  DEFAULT_ELEMENT_MODEL,
  isAllPlatforms,
  isAllModelsFilter,
  buildModelFilter,
  buildModelOrFilter,
  resolveElementModels,
  buildAdvancedFilters,
} from '../../../src/support/elements/constants.js';

describe('elements constants', () => {
  describe('isAllPlatforms', () => {
    it('matches the ALL_PLATFORMS sentinel, case/whitespace-insensitive', () => {
      expect(isAllPlatforms(ALL_PLATFORMS)).to.equal(true);
      expect(isAllPlatforms('all')).to.equal(true);
      expect(isAllPlatforms('  ALL  ')).to.equal(true);
      expect(isAllPlatforms('All')).to.equal(true);
    });

    it('does NOT match a real model, an empty string, or a non-string', () => {
      expect(isAllPlatforms('search-gpt')).to.equal(false);
      expect(isAllPlatforms('')).to.equal(false);
      expect(isAllPlatforms(undefined)).to.equal(false);
      expect(isAllPlatforms(null)).to.equal(false);
    });
  });

  describe('isAllModelsFilter', () => {
    it('is true when the value is ABSENT (the "All Platforms" omitted-param case)', () => {
      expect(isAllModelsFilter(undefined)).to.equal(true);
      expect(isAllModelsFilter(null)).to.equal(true);
      expect(isAllModelsFilter('')).to.equal(true);
      expect(isAllModelsFilter('   ')).to.equal(true);
    });

    it('is true for the explicit ALL_PLATFORMS sentinel', () => {
      expect(isAllModelsFilter('all')).to.equal(true);
      expect(isAllModelsFilter('  All ')).to.equal(true);
    });

    it('is false for a concrete model or UI platform code (single-model path)', () => {
      expect(isAllModelsFilter('search-gpt')).to.equal(false);
      expect(isAllModelsFilter('openai')).to.equal(false);
      expect(isAllModelsFilter('not-a-real-model')).to.equal(false);
    });

    // Not reachable from HTTP query params (always string|undefined), but the `typeof`
    // check means any non-string is treated as "absent" — documented here so the
    // contract is explicit if a non-HTTP caller ever passes one.
    it('treats a non-string value as absent (aggregate), not as a model', () => {
      expect(isAllModelsFilter(0)).to.equal(true);
      expect(isAllModelsFilter(false)).to.equal(true);
      expect(isAllModelsFilter({})).to.equal(true);
    });
  });

  describe('buildModelFilter', () => {
    it('returns null for the all-models aggregate (absent or the "all" sentinel)', () => {
      expect(buildModelFilter(undefined)).to.equal(null);
      expect(buildModelFilter('')).to.equal(null);
      expect(buildModelFilter('all')).to.equal(null);
      expect(buildModelFilter(ALL_PLATFORMS)).to.equal(null);
      // the aggregate case wins regardless of `wrap`
      expect(buildModelFilter('all', { wrap: false })).to.equal(null);
    });

    it('wraps the eq in a one-member or block by default (wrap: true)', () => {
      expect(buildModelFilter('search-gpt')).to.deep.equal({
        op: 'or',
        filters: [{ op: 'eq', val: 'search-gpt', col: 'CBF_model' }],
      });
    });

    it('returns a bare eq when wrap is false (stats mentions/citations shape)', () => {
      expect(buildModelFilter('search-gpt', { wrap: false })).to.deep.equal({
        op: 'eq', val: 'search-gpt', col: 'CBF_model',
      });
    });

    it('translates a UI platform code to its Semrush model name', () => {
      expect(buildModelFilter('openai').filters[0].val).to.equal('chatgpt-paid');
      expect(buildModelFilter('chatgpt').filters[0].val).to.equal('search-gpt');
      expect(buildModelFilter('gemini', { wrap: false }).val).to.equal('gemini-2.5-flash');
    });

    it('falls back to the default model for an unrecognized value (NOT the aggregate)', () => {
      expect(buildModelFilter('not-a-real-model')).to.deep.equal({
        op: 'or',
        filters: [{ op: 'eq', val: 'search-gpt', col: 'CBF_model' }],
      });
    });
  });

  describe('resolveElementModels (subset multi-model, LLMO-7553)', () => {
    it('resolves a single value (no comma) to a 1-element array', () => {
      expect(resolveElementModels('search-gpt')).to.deep.equal(['search-gpt']);
    });

    it('translates a single UI platform code, same as resolveElementModel', () => {
      expect(resolveElementModels('openai')).to.deep.equal(['chatgpt-paid']);
    });

    it('coerces absent / unrecognized single values to the default model', () => {
      expect(resolveElementModels(undefined)).to.deep.equal([DEFAULT_ELEMENT_MODEL]);
      expect(resolveElementModels('')).to.deep.equal([DEFAULT_ELEMENT_MODEL]);
      expect(resolveElementModels('not-a-real-model')).to.deep.equal([DEFAULT_ELEMENT_MODEL]);
    });

    it('treats the `all` sentinel as a single default model (caller must guard it first)', () => {
      expect(resolveElementModels('all')).to.deep.equal([DEFAULT_ELEMENT_MODEL]);
    });

    it('splits a comma value, trimming each and translating UI codes', () => {
      expect(resolveElementModels('openai,gemini')).to.deep.equal(['chatgpt-paid', 'gemini-2.5-flash']);
      expect(resolveElementModels('  openai , gemini ')).to.deep.equal(['chatgpt-paid', 'gemini-2.5-flash']);
    });

    it('dedupes members (repeated ids and codes resolving to the same model collapse)', () => {
      expect(resolveElementModels('openai,openai')).to.deep.equal(['chatgpt-paid']);
      // chatgpt -> search-gpt, and search-gpt -> search-gpt, so both collapse to one member.
      expect(resolveElementModels('chatgpt,search-gpt')).to.deep.equal(['search-gpt']);
    });

    it('drops blank members from a comma value', () => {
      expect(resolveElementModels('openai,,gemini,')).to.deep.equal(['chatgpt-paid', 'gemini-2.5-flash']);
    });

    it('never returns an empty array, even for an all-blank comma value', () => {
      expect(resolveElementModels(',')).to.deep.equal([DEFAULT_ELEMENT_MODEL]);
    });
  });

  describe('buildModelOrFilter (subset multi-model, LLMO-7553)', () => {
    it('a 1-element array yields the SAME one-member or as the single-model wrap path', () => {
      // Backward-compatibility guarantee: identical to buildModelFilter('search-gpt').
      expect(buildModelOrFilter(['search-gpt'])).to.deep.equal({
        op: 'or',
        filters: [{ op: 'eq', val: 'search-gpt', col: 'CBF_model' }],
      });
      expect(buildModelOrFilter(['search-gpt'])).to.deep.equal(buildModelFilter('search-gpt'));
    });

    it('builds one eq per model under a single or for a multi-member list', () => {
      expect(buildModelOrFilter(['chatgpt-paid', 'gemini-2.5-flash'])).to.deep.equal({
        op: 'or',
        filters: [
          { op: 'eq', val: 'chatgpt-paid', col: 'CBF_model' },
          { op: 'eq', val: 'gemini-2.5-flash', col: 'CBF_model' },
        ],
      });
    });

    it('composes with resolveElementModels end-to-end for a comma value', () => {
      expect(buildModelOrFilter(resolveElementModels('openai,gemini'))).to.deep.equal({
        op: 'or',
        filters: [
          { op: 'eq', val: 'chatgpt-paid', col: 'CBF_model' },
          { op: 'eq', val: 'gemini-2.5-flash', col: 'CBF_model' },
        ],
      });
    });
  });

  // Semrush rejects `advanced: { op: 'and', filters: [] }` with HTTP 422
  // {"message":"request could not be processed"} — it does NOT treat an empty AND as
  // "match all". Verified live 2026-09-02 against SENTIMENT (f4153af8), TRENDS_MV
  // (b5281393) and MARKET_CITATIONS_TREND (2e5a6f4e): empty AND → 422 on all three,
  // `advanced` key omitted → 200 on all three.
  describe('buildAdvancedFilters', () => {
    it('omits the advanced key entirely for an empty or absent filter list', () => {
      expect(buildAdvancedFilters([])).to.deep.equal({});
      expect(buildAdvancedFilters(undefined)).to.deep.equal({});
      expect(buildAdvancedFilters(null)).to.deep.equal({});
    });

    it('wraps a non-empty filter list in an AND block', () => {
      const f = { op: 'eq', val: 'x', col: 'CBF_tags' };
      expect(buildAdvancedFilters([f])).to.deep.equal({ advanced: { op: 'and', filters: [f] } });
    });

    it('produces a fragment that spreads away cleanly when empty', () => {
      expect({ simple: {}, ...buildAdvancedFilters([]) }).to.not.have.property('advanced');
    });
  });
});
