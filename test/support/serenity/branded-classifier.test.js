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
  normalizeMatch,
  needlesFromNames,
  brandNeedles,
  classifyBrandedTag,
} from '../../../src/support/serenity/branded-classifier.js';
import { TYPE_TAG } from '../../../src/support/serenity/prompt-tags.js';

describe('serenity branded-classifier', () => {
  describe('normalizeMatch', () => {
    it('folds diacritics, lower-cases, collapses non-alphanumerics, trims', () => {
      expect(normalizeMatch('  Café   Nörd! ')).to.equal('cafe nord');
      expect(normalizeMatch('Le Creuset')).to.equal('le creuset');
      expect(normalizeMatch('AT&T')).to.equal('at t');
    });

    it('returns empty string for empty / nullish input', () => {
      expect(normalizeMatch('')).to.equal('');
      expect(normalizeMatch('   ')).to.equal('');
      expect(normalizeMatch(undefined)).to.equal('');
      expect(normalizeMatch(null)).to.equal('');
    });
  });

  describe('needlesFromNames', () => {
    it('normalizes, drops empties, and de-duplicates (first spelling wins order)', () => {
      expect(needlesFromNames(['Acme', 'ACME', '  acme ', '', 'Örsted']))
        .to.deep.equal(['acme', 'orsted']);
    });

    it('tolerates a non-array input', () => {
      expect(needlesFromNames(undefined)).to.deep.equal([]);
      expect(needlesFromNames(null)).to.deep.equal([]);
    });
  });

  describe('brandNeedles', () => {
    it('combines the brand name with region-clamped aliases', () => {
      const aliases = [
        { name: 'Acme US', regions: ['us'] },
        { name: 'Acme EU', regions: ['de'] },
        { name: 'Acme WW' }, // region-less → applies everywhere
      ];
      expect(brandNeedles('Acme Corp', aliases, 'US'))
        .to.deep.equal(['acme corp', 'acme us', 'acme ww']);
      expect(brandNeedles('Acme Corp', aliases, 'DE'))
        .to.deep.equal(['acme corp', 'acme eu', 'acme ww']);
    });

    it('keeps only region-less aliases when the market is unknown/empty', () => {
      const aliases = [
        { name: 'Regional', regions: ['us'] },
        { name: 'Global' },
      ];
      expect(brandNeedles('Brand', aliases, '')).to.deep.equal(['brand', 'global']);
    });

    it('drops a blank brand name', () => {
      expect(brandNeedles('', [], 'US')).to.deep.equal([]);
    });
  });

  describe('classifyBrandedTag', () => {
    const needles = needlesFromNames(['Ace', 'Le Creuset', 'Örsted']);

    it('matches a needle as a whole word → branded', () => {
      expect(classifyBrandedTag('is Ace a good brand?', needles)).to.equal(TYPE_TAG.BRANDED);
    });

    it('does NOT match a needle as a substring of a larger word → non-branded', () => {
      expect(classifyBrandedTag('what is the best surface finish?', needles))
        .to.equal(TYPE_TAG.NON_BRANDED);
      expect(classifyBrandedTag('tell me about outer space', needles))
        .to.equal(TYPE_TAG.NON_BRANDED);
    });

    it('matches a multi-word needle only as a contiguous whole-word run', () => {
      expect(classifyBrandedTag('best Le Creuset dutch oven', needles))
        .to.equal(TYPE_TAG.BRANDED);
      expect(classifyBrandedTag('le fancy creuset pan', needles))
        .to.equal(TYPE_TAG.NON_BRANDED);
    });

    it('folds decomposing diacritics on BOTH sides (café ≈ cafe, Örsted ≈ orsted)', () => {
      expect(classifyBrandedTag('who founded Orsted energy?', needles))
        .to.equal(TYPE_TAG.BRANDED);
      const cafeNeedles = needlesFromNames(['Café']);
      expect(classifyBrandedTag('a cafe near me', cafeNeedles)).to.equal(TYPE_TAG.BRANDED);
    });

    it('folds NON-decomposing accented/ligature letters (Ø/Æ/ß have no NFD form)', () => {
      // Ørsted: Ø (U+00D8) has no canonical decomposition, so NFD+strip alone
      // would leave it — the explicit fold table makes it match ASCII "Orsted".
      const orsted = needlesFromNames(['Ørsted']);
      expect(classifyBrandedTag('who founded Orsted energy?', orsted)).to.equal(TYPE_TAG.BRANDED);
      // …and the reverse: an ASCII needle matches an accented prompt.
      expect(classifyBrandedTag('tell me about Ørsted', needlesFromNames(['Orsted'])))
        .to.equal(TYPE_TAG.BRANDED);
      // ß → ss
      expect(classifyBrandedTag('is Straße a street?', needlesFromNames(['Strasse'])))
        .to.equal(TYPE_TAG.BRANDED);
    });

    it('is case- and punctuation-insensitive', () => {
      expect(classifyBrandedTag('ACE!!! is great', needles)).to.equal(TYPE_TAG.BRANDED);
    });

    it('empty needles ⇒ everything is non-branded', () => {
      expect(classifyBrandedTag('Ace Le Creuset Orsted', [])).to.equal(TYPE_TAG.NON_BRANDED);
    });

    it('tolerates empty / nullish prompt text', () => {
      expect(classifyBrandedTag('', needles)).to.equal(TYPE_TAG.NON_BRANDED);
      expect(classifyBrandedTag(undefined, needles)).to.equal(TYPE_TAG.NON_BRANDED);
    });
  });
});
