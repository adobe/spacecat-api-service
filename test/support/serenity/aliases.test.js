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
  sameAliasSetExact,
  benchmarkAliases,
  mergeBenchmarkAliases,
  aliasKeysOwnedByOthers,
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

  describe('sameAliasSetExact', () => {
    it('is order-insensitive but case-SENSITIVE', () => {
      expect(sameAliasSetExact(['A', 'b'], ['b', 'A'])).to.equal(true);
      expect(sameAliasSetExact([' A ', 'b'], ['A', 'b'])).to.equal(true);
      expect(sameAliasSetExact(['A', 'b'], ['a', 'b'])).to.equal(false);
    });

    it('detects a genuine difference and treats empty / non-array as the empty set', () => {
      expect(sameAliasSetExact(['A'], ['A', 'a'])).to.equal(false);
      expect(sameAliasSetExact([], null)).to.equal(true);
      expect(sameAliasSetExact(undefined, ['A'])).to.equal(false);
      expect(sameAliasSetExact(['A', ''], ['A'])).to.equal(true);
    });

    it('does not call two same-size sets equal when their members differ', () => {
      expect(sameAliasSetExact(['A', 'B'], ['A', 'C'])).to.equal(false);
    });
  });

  describe('benchmarkAliases', () => {
    it('returns one lowercase spelling per alias, plus the benchmark name', () => {
      expect(benchmarkAliases('Ford', ['Ford Motor', 'FoMoCo']))
        .to.deep.equal(['ford motor', 'fomoco', 'ford']);
    });

    it('yields just the name when the brand has no aliases', () => {
      expect(benchmarkAliases('Bass Pro', [])).to.deep.equal(['bass pro']);
      expect(benchmarkAliases('Bass Pro', null)).to.deep.equal(['bass pro']);
    });

    it('collapses two spellings of one alias, so a 409 pair cannot be built', () => {
      // Upstream folds case to identify an alias and refuses a list holding both.
      expect(benchmarkAliases('GMC', ['GMC', 'gmc'])).to.deep.equal(['gmc']);
      expect(benchmarkAliases('Acme', ['ACME', 'acme'])).to.deep.equal(['acme']);
    });

    it('tolerates a missing name and empty entries', () => {
      expect(benchmarkAliases('', ['Acme', '  '])).to.deep.equal(['acme']);
      expect(benchmarkAliases(null, ['Acme'])).to.deep.equal(['acme']);
      expect(benchmarkAliases('Acme', [])).to.deep.equal(['acme']);
    });
  });

  describe('mergeBenchmarkAliases', () => {
    it('carries forward live values the desired set does not know', () => {
      // 'gm' is Semrush's own enrichment — a plain replace would drop it.
      expect(mergeBenchmarkAliases(['gm', 'onstar'], ['onstar', 'guardian']))
        .to.deep.equal(['gm', 'onstar', 'guardian']);
    });

    it('keeps the live spelling of an alias already there', () => {
      // A PUT cannot re-case an alias upstream already stores.
      expect(mergeBenchmarkAliases(['Bass Pro'], ['bass pro'])).to.deep.equal(['Bass Pro']);
    });

    it('applies the preferred spelling only to an alias it creates', () => {
      expect(mergeBenchmarkAliases(['Bass Pro'], ['bass pro', 'outdoor world']))
        .to.deep.equal(['Bass Pro', 'outdoor world']);
    });

    it('drops a removed alias whatever its casing', () => {
      expect(mergeBenchmarkAliases(['Old', 'Keep'], ['keep'], ['old']))
        .to.deep.equal(['Keep']);
    });

    it('keeps a removed value the desired set still asks for', () => {
      expect(mergeBenchmarkAliases(['Acme'], ['acme'], ['Acme'])).to.deep.equal(['acme']);
    });

    it('trims, drops empties, and tolerates non-array inputs', () => {
      expect(mergeBenchmarkAliases([' A ', '', null], [' b '])).to.deep.equal(['A', 'b']);
      expect(mergeBenchmarkAliases(null, null)).to.deep.equal([]);
      expect(mergeBenchmarkAliases(['A'], null, null)).to.deep.equal(['A']);
      expect(mergeBenchmarkAliases(['A'], ['A'], [''])).to.deep.equal(['A']);
    });
  });

  describe('aliasKeysOwnedByOthers', () => {
    const benchmarks = [
      { id: 'a', brand_name: 'Rival One', brand_aliases: ['rival one', 'R1'] },
      { id: 'b', brand_name: 'Rival Two', brand_aliases: ['rival two'] },
      { id: 'c', brand_name: '', brand_aliases: null },
    ];

    it('collects every other benchmark\'s name and aliases, case-folded', () => {
      expect([...aliasKeysOwnedByOthers(benchmarks, 'a')].sort())
        .to.deep.equal(['rival two']);
      expect([...aliasKeysOwnedByOthers(benchmarks, 'b')].sort())
        .to.deep.equal(['r1', 'rival one']);
    });

    it('excludes nothing when no owner id is given', () => {
      expect([...aliasKeysOwnedByOthers(benchmarks)].sort())
        .to.deep.equal(['r1', 'rival one', 'rival two']);
    });

    it('tolerates a non-array listing and blank values', () => {
      expect(aliasKeysOwnedByOthers(null, 'a').size).to.equal(0);
      expect(aliasKeysOwnedByOthers([{ id: 'x', brand_name: '  ' }], 'y').size).to.equal(0);
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
