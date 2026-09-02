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
  isAllPlatforms,
  isAllModelsFilter,
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
