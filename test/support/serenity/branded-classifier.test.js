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

    it("drops the possessive clitic 's (straight and typographic)", () => {
      expect(normalizeMatch("Kellogg's")).to.equal('kellogg');
      expect(normalizeMatch('Kellogg’s')).to.equal('kellogg');
      expect(normalizeMatch("Kellogg's Frosted Flakes")).to.equal('kellogg frosted flakes');
    });

    it("leaves a plural possessive's bare apostrophe to the plural rule", () => {
      expect(normalizeMatch("Buicks' best selling vehicle")).to.equal('buicks best selling vehicle');
    });

    it("does not strip an 's that is not a possessive clitic", () => {
      // Word-internal 's' and a leading apostrophe are untouched.
      expect(normalizeMatch('sacs')).to.equal('sacs');
      expect(normalizeMatch("'salem")).to.equal('salem');
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

    it('tolerates a non-array needles argument', () => {
      expect(classifyBrandedTag('is Ace a good brand?', undefined)).to.equal(TYPE_TAG.NON_BRANDED);
      expect(classifyBrandedTag('is Ace a good brand?', null)).to.equal(TYPE_TAG.NON_BRANDED);
    });
  });

  describe('classifyBrandedTag — regular plurals of the brand name', () => {
    const branded = (text, names) => classifyBrandedTag(text, needlesFromNames(names));

    it('matches the plain -s plural of a single-word needle', () => {
      expect(branded('Are Buicks luxury cars?', ['Buick'])).to.equal(TYPE_TAG.BRANDED);
      expect(branded('Do Cadillacs hold their value?', ['Cadillac'])).to.equal(TYPE_TAG.BRANDED);
      expect(branded('Are GMCs expensive to maintain?', ['GMC'])).to.equal(TYPE_TAG.BRANDED);
      expect(branded('Are Chevys expensive to maintain?', ['Chevy'])).to.equal(TYPE_TAG.BRANDED);
    });

    it('matches the -es plural only after a sibilant stem', () => {
      // One case per SIBILANT_RE alternation: s, x, z, ch, sh.
      expect(branded('are Lexuses reliable?', ['Lexus'])).to.equal(TYPE_TAG.BRANDED);
      expect(branded('are Foxes fast?', ['Fox'])).to.equal(TYPE_TAG.BRANDED);
      expect(branded('are Benzes reliable?', ['Benz'])).to.equal(TYPE_TAG.BRANDED);
      expect(branded('do Bosches last long?', ['Bosch'])).to.equal(TYPE_TAG.BRANDED);
      expect(branded('are Bushes evergreen?', ['Bush'])).to.equal(TYPE_TAG.BRANDED);
      // A non-sibilant stem must NOT admit -es — `Buickes` is not a word, and
      // admitting it would let any needle match an arbitrary `…es` word.
      expect(branded('are Buickes good?', ['Buick'])).to.equal(TYPE_TAG.NON_BRANDED);
      // A sibilant stem with neither the bare form nor a plural present stays non-branded.
      expect(branded('best luxury sedan', ['Lexus'])).to.equal(TYPE_TAG.NON_BRANDED);
    });

    it('composes the possessive strip with the sibilant -es plural', () => {
      // `Ross's` normalizes to the needle `ross` (possessive stripped), whose
      // stem is sibilant — so the plural `Rosses` matches through both new paths.
      expect(branded('are Rosses near you?', ["Ross's"])).to.equal(TYPE_TAG.BRANDED);
      expect(branded("is Ross's open today?", ["Ross's"])).to.equal(TYPE_TAG.BRANDED);
      expect(branded('is Ross open today?', ["Ross's"])).to.equal(TYPE_TAG.BRANDED);
    });

    it('matches the singular and plural possessive', () => {
      expect(branded("What is Buick's best selling vehicle?", ['Buick']))
        .to.equal(TYPE_TAG.BRANDED);
      expect(branded("What is Buicks' best selling vehicle?", ['Buick']))
        .to.equal(TYPE_TAG.BRANDED);
      // The alias itself may carry the possessive (WK Kellogg Co ships `Kellogg's`).
      expect(branded('how does kellogg ensure cereal safety?', ["Kellogg's"]))
        .to.equal(TYPE_TAG.BRANDED);
      expect(branded('are Kelloggs cereals healthy?', ["Kellogg's"]))
        .to.equal(TYPE_TAG.BRANDED);
    });

    it('pluralizes only the FINAL token of a multi-word needle', () => {
      expect(branded('best Le Creusets on sale', ['Le Creuset'])).to.equal(TYPE_TAG.BRANDED);
      expect(branded('best les creuset pans', ['Le Creuset'])).to.equal(TYPE_TAG.NON_BRANDED);
    });

    it('folds diacritics on a pluralized match', () => {
      expect(branded('do Ørsteds wind farms pay?', ['Orsted'])).to.equal(TYPE_TAG.BRANDED);
    });

    it('does NOT become a substring match — the stem must still be whole-word', () => {
      // The suffix rule only extends the RIGHT edge by -s/-es; the left edge is
      // still anchored, and no other suffix is admitted.
      expect(branded('tell me about outer space', ['Ace'])).to.equal(TYPE_TAG.NON_BRANDED);
      expect(branded('what is the best surface finish?', ['Ace'])).to.equal(TYPE_TAG.NON_BRANDED);
      expect(branded('how many spaces are there?', ['Ace'])).to.equal(TYPE_TAG.NON_BRANDED);
      expect(branded('is this a Buickmobile?', ['Buick'])).to.equal(TYPE_TAG.NON_BRANDED);
      expect(branded('Buicking around town', ['Buick'])).to.equal(TYPE_TAG.NON_BRANDED);
      // …but the true plural of the same short needle does match.
      expect(branded('Aces are wild', ['Ace'])).to.equal(TYPE_TAG.BRANDED);
    });

    it('makes hand-maintained plural aliases redundant (Lovesac)', () => {
      // Lovesac ships `Sacs`, `Sactionals`, `Supersacs`, `pillowsacs` purely to
      // work around the missing plural rule; the singular aliases now suffice.
      const singular = needlesFromNames(['Lovesac', 'Sac', 'Sactional', 'SuperSac', 'PillowSac']);
      for (const text of [
        'How do Lovesac Sacs differ in durability from other bean bags?',
        'are Sactionals worth it?',
        'how many SuperSacs fit in a living room?',
        'compare pillowsacs to floor cushions',
      ]) {
        expect(classifyBrandedTag(text, singular), text).to.equal(TYPE_TAG.BRANDED);
      }
    });

    it('leaves genuinely non-branded prompts non-branded', () => {
      // Real non-branded prompts from the GM / Kellogg workspaces.
      const gmc = needlesFromNames(['GMC', 'Sierra', 'Denali', 'Yukon', 'Canyon', 'Hummer']);
      expect(classifyBrandedTag('best midsize truck for towing', gmc))
        .to.equal(TYPE_TAG.NON_BRANDED);
      expect(classifyBrandedTag('which cereals have the least sugar?', needlesFromNames(["Kellogg's"])))
        .to.equal(TYPE_TAG.NON_BRANDED);
    });
  });
});
