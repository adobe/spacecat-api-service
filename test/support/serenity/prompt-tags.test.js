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
  DIMENSION,
  DIMENSION_ROOT_NAMES,
  ORIGIN_VALUE,
  INTENT_VALUE,
  TYPE_VALUE,
  CLOSED_DIMENSION_VALUES,
  CLOSED_DIMENSIONS,
  OPEN_DIMENSIONS,
  SERVER_OWNED_DIMENSIONS,
  ALL_DIMENSIONS,
  SOURCE_VALUES,
  SOURCE_LABEL,
  MAX_TAG_NAME_LEN,
  STANDARD_PROMPT_TAG_VALUES,
  isDimensionRootName,
  isClosedDimension,
  isServerOwnedDimension,
  canonicalizeSource,
  closedValuesOf,
} from '../../../src/support/serenity/prompt-tags.js';

describe('serenity prompt-tags taxonomy', () => {
  describe('dimension roots', () => {
    it('includes the five roots, all bare-named (membership, never a count)', () => {
      // Membership, not set-equality — a further open root is contemplated
      // (source-dimension.md header), so nothing may key on the root count.
      expect([...DIMENSION_ROOT_NAMES]).to.include.members([
        'category', 'intent', 'origin', 'type', 'source',
      ]);
      DIMENSION_ROOT_NAMES.forEach((n) => expect(n).to.not.include(':'));
    });

    it('splits the roots into open (category, source) and closed (intent, origin, type)', () => {
      expect([...OPEN_DIMENSIONS]).to.deep.equal([DIMENSION.CATEGORY, DIMENSION.SOURCE]);
      expect([...CLOSED_DIMENSIONS]).to.deep.equal(['intent', 'origin', 'type']);
      expect([...ALL_DIMENSIONS].sort()).to.deep.equal([...DIMENSION_ROOT_NAMES].sort());
    });

    it('is server-owned for everything except category (write-guard / create-semantics axis)', () => {
      expect([...SERVER_OWNED_DIMENSIONS]).to.deep.equal(['intent', 'origin', 'type', 'source']);
      expect(isServerOwnedDimension(DIMENSION.CATEGORY)).to.equal(false);
      expect(isServerOwnedDimension(DIMENSION.SOURCE)).to.equal(true);
      expect(isServerOwnedDimension(DIMENSION.INTENT)).to.equal(true);
      // `source` is server-owned yet OPEN — a separate axis from vocabulary.
      expect(isClosedDimension(DIMENSION.SOURCE)).to.equal(false);
    });

    it('recognises a reserved root name, including source', () => {
      expect(isDimensionRootName('category')).to.equal(true);
      expect(isDimensionRootName('type')).to.equal(true);
      expect(isDimensionRootName('source')).to.equal(true);
      expect(isDimensionRootName('Running Shoes')).to.equal(false);
    });

    it('is frozen (immutable single source of truth)', () => {
      expect(Object.isFrozen(DIMENSION)).to.equal(true);
      expect(Object.isFrozen(DIMENSION_ROOT_NAMES)).to.equal(true);
      expect(Object.isFrozen(CLOSED_DIMENSION_VALUES)).to.equal(true);
    });
  });

  describe('closed vocabularies', () => {
    it('carries all five intents, including Navigational', () => {
      expect([...closedValuesOf(DIMENSION.INTENT)]).to.deep.equal([
        'Informational', 'Task', 'Commercial', 'Transactional', 'Navigational',
      ]);
      expect(INTENT_VALUE.NAVIGATIONAL).to.equal('Navigational');
    });

    it('carries the source and type vocabularies', () => {
      expect([...closedValuesOf(DIMENSION.ORIGIN)]).to.deep.equal(['ai', 'human']);
      expect([...closedValuesOf(DIMENSION.TYPE)]).to.deep.equal(['branded', 'non-branded']);
      expect(ORIGIN_VALUE.AI).to.equal('ai');
      expect(TYPE_VALUE.NON_BRANDED).to.equal('non-branded');
    });

    it('every closed value is bare — no dimension prefix survives', () => {
      CLOSED_DIMENSIONS.forEach((d) => {
        closedValuesOf(d).forEach((v) => expect(v).to.not.include(':'));
      });
    });

    it('reports the open dimension as not closed, with no fixed vocabulary', () => {
      expect(isClosedDimension(DIMENSION.CATEGORY)).to.equal(false);
      expect([...closedValuesOf(DIMENSION.CATEGORY)]).to.deep.equal([]);
    });

    it('returns an empty vocabulary for an unknown dimension', () => {
      expect([...closedValuesOf('nope')]).to.deep.equal([]);
    });
  });

  describe('STANDARD_PROMPT_TAG_VALUES', () => {
    it('seeds source=ai + intent=Informational only (type is classified per prompt)', () => {
      expect(STANDARD_PROMPT_TAG_VALUES.map((t) => [t.dimension, t.name])).to.deep.equal([
        ['origin', 'ai'],
        ['intent', 'Informational'],
      ]);
    });

    it('names only values that exist in their dimension vocabulary', () => {
      STANDARD_PROMPT_TAG_VALUES.forEach(({ dimension, name }) => {
        expect(closedValuesOf(dimension)).to.include(name);
      });
    });

    it('is frozen', () => {
      expect(Object.isFrozen(STANDARD_PROMPT_TAG_VALUES)).to.equal(true);
    });
  });

  describe('canonicalizeSource', () => {
    it('trims, lowercases and folds `_` to `-`', () => {
      expect(canonicalizeSource('  GSC ')).to.equal('gsc');
      expect(canonicalizeSource('agentic_traffic')).to.equal('agentic-traffic');
      expect(canonicalizeSource('CITATION_ATTEMPT')).to.equal('citation-attempt');
      expect(canonicalizeSource('config')).to.equal('config');
    });

    it('folds the twinned spellings onto one canonical value', () => {
      expect(canonicalizeSource('synthetic_personas'))
        .to.equal(canonicalizeSource('synthetic-personas'));
    });

    it('returns null (do-not-tag) for a value that fails the guard — never a default', () => {
      expect(canonicalizeSource('')).to.equal(null);
      expect(canonicalizeSource('   ')).to.equal(null);
      expect(canonicalizeSource('has:colon')).to.equal(null);
      expect(canonicalizeSource('x'.repeat(MAX_TAG_NAME_LEN + 1))).to.equal(null);
      // shadows a dimension-root name (including the reserved legacy `source`)
      expect(canonicalizeSource('category')).to.equal(null);
      expect(canonicalizeSource('source')).to.equal(null);
      expect(canonicalizeSource('ORIGIN')).to.equal(null);
      // non-string
      expect(canonicalizeSource(null)).to.equal(null);
      expect(canonicalizeSource(undefined)).to.equal(null);
    });

    it('accepts a value exactly at the length limit', () => {
      const atLimit = 'a'.repeat(MAX_TAG_NAME_LEN);
      expect(canonicalizeSource(atLimit)).to.equal(atLimit);
    });
  });

  describe('SOURCE_LABEL', () => {
    it('is frozen and has exactly one entry per canonical value (exhaustive, CI gate)', () => {
      expect(Object.isFrozen(SOURCE_LABEL)).to.equal(true);
      // This assertion FAILS the moment a canonical value is added to SOURCE_VALUES
      // without a label — the exhaustiveness gate (source-dimension.md §7). No
      // pass-through slug default is permitted.
      expect(Object.keys(SOURCE_LABEL).sort()).to.deep.equal([...SOURCE_VALUES].sort());
      SOURCE_VALUES.forEach((slug) => {
        expect(SOURCE_LABEL[slug], `missing SOURCE_LABEL for ${slug}`).to.be.a('string').and.not.equal('');
      });
    });

    it('every canonical value canonicalizes to itself (already folded)', () => {
      SOURCE_VALUES.forEach((slug) => {
        expect(canonicalizeSource(slug)).to.equal(slug);
      });
    });

    it('is frozen for SOURCE_VALUES too', () => {
      expect(Object.isFrozen(SOURCE_VALUES)).to.equal(true);
    });
  });
});
