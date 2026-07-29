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
  ALL_DIMENSIONS,
  STANDARD_PROMPT_TAG_VALUES,
  isDimensionRootName,
  isClosedDimension,
  closedValuesOf,
} from '../../../src/support/serenity/prompt-tags.js';

describe('serenity prompt-tags taxonomy', () => {
  describe('dimension roots', () => {
    it('has exactly four roots, all bare-named', () => {
      expect([...DIMENSION_ROOT_NAMES]).to.deep.equal(['category', 'intent', 'origin', 'type']);
      DIMENSION_ROOT_NAMES.forEach((n) => expect(n).to.not.include(':'));
    });

    it('splits the roots into one open and three closed dimensions', () => {
      expect([...OPEN_DIMENSIONS]).to.deep.equal([DIMENSION.CATEGORY]);
      expect([...CLOSED_DIMENSIONS]).to.deep.equal(['intent', 'origin', 'type']);
      expect([...ALL_DIMENSIONS].sort()).to.deep.equal([...DIMENSION_ROOT_NAMES].sort());
    });

    it('recognises a reserved root name', () => {
      expect(isDimensionRootName('category')).to.equal(true);
      expect(isDimensionRootName('type')).to.equal(true);
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
});
