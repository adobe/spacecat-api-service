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
  dedupeAliases,
  sameAliasSet,
  rejectedAliasesFrom,
} from '../../../src/support/serenity/aliases.js';

describe('serenity alias helpers', () => {
  describe('dedupeAliases', () => {
    it('trims, drops empties, and de-dupes case-insensitively (first spelling wins)', () => {
      expect(dedupeAliases([' Acme ', 'acme', 'ACME Inc', '', '   ', null, 42]))
        .to.deep.equal(['Acme', 'ACME Inc']);
    });

    it('returns [] for non-array / empty input', () => {
      expect(dedupeAliases(null)).to.deep.equal([]);
      expect(dedupeAliases(undefined)).to.deep.equal([]);
      expect(dedupeAliases([])).to.deep.equal([]);
    });
  });

  describe('sameAliasSet', () => {
    it('is order- and case-insensitive after trim/dedupe', () => {
      expect(sameAliasSet(['A', 'b'], ['b', 'a'])).to.equal(true);
      expect(sameAliasSet([' A ', 'B', 'b'], ['a', 'B'])).to.equal(true);
    });

    it('detects a genuine difference', () => {
      expect(sameAliasSet(['A'], ['A', 'C'])).to.equal(false);
      expect(sameAliasSet(['A', 'B'], ['A', 'C'])).to.equal(false);
    });

    it('treats empty / non-array as the empty set', () => {
      expect(sameAliasSet([], null)).to.equal(true);
      expect(sameAliasSet(undefined, [])).to.equal(true);
      expect(sameAliasSet(['A'], [])).to.equal(false);
    });
  });

  describe('rejectedAliasesFrom', () => {
    const benchmarks = [
      { domain: 'own.com', main_brand: true, rejected_brand_aliases: ['bad-own'] },
      { domain: 'rival.com', main_brand: false, rejected_brand_aliases: ['bad-rival', ''] },
      { domain: 'clean.com', main_brand: false, rejected_brand_aliases: [] },
      { domain: 'none.com', main_brand: false },
    ];

    it('selects via the predicate and keeps only non-empty rejected sets', () => {
      expect(rejectedAliasesFrom(benchmarks, (b) => b.main_brand !== true))
        .to.deep.equal([{ domain: 'rival.com', aliases: ['bad-rival'] }]);
    });

    it('falls back to a null domain when the benchmark has none', () => {
      const noDomain = [{ main_brand: false, rejected_brand_aliases: ['x'] }];
      expect(rejectedAliasesFrom(noDomain, () => true))
        .to.deep.equal([{ domain: null, aliases: ['x'] }]);
    });

    it('can target the main brand benchmark', () => {
      expect(rejectedAliasesFrom(benchmarks, (b) => b.main_brand === true))
        .to.deep.equal([{ domain: 'own.com', aliases: ['bad-own'] }]);
    });

    it('returns [] for non-array input', () => {
      expect(rejectedAliasesFrom(null, () => true)).to.deep.equal([]);
    });
  });
});
