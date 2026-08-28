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
  DIMENSION_PROVISION_ORDER,
  RESERVED_ROOT_NAMES,
  INTENT_ROOT_NAME,
  ROOT_DISPLAY_NAME,
  rootNameOfDimension,
  dimensionOfRootName,
  ORIGIN_VALUE,
  INTENT_VALUE,
  TYPE_VALUE,
  TYPE_VALUE_DISPLAY,
  CLOSED_DIMENSION_VALUES,
  CLOSED_DIMENSIONS,
  OPEN_DIMENSIONS,
  SERVER_OWNED_DIMENSIONS,
  ALL_DIMENSIONS,
  SOURCE_VALUES,
  SOURCE_LABEL,
  DERIVED_SOURCE_VALUES,
  MAX_TAG_NAME_LEN,
  STANDARD_PROMPT_TAG_VALUES,
  isDimensionRootName,
  isClosedDimension,
  isServerOwnedDimension,
  canonicalizeSource,
  closedValuesOf,
  displayToSlug,
  displayNameOfValue,
  valueSlugOfDisplayName,
  deriveSource,
} from '../../../src/support/serenity/prompt-tags.js';

describe('serenity prompt-tags taxonomy', () => {
  describe('dimension roots', () => {
    it('includes the five roots, all bare-named (membership, never a count)', () => {
      // Membership, not set-equality — a further open root is contemplated
      // (source-dimension.md header), so nothing may key on the root count.
      expect([...DIMENSION_PROVISION_ORDER]).to.include.members([
        'category', 'intent', 'origin', 'type', 'source',
      ]);
      DIMENSION_PROVISION_ORDER.forEach((n) => expect(n).to.not.include(':'));
    });

    it('splits the roots into open (category, source) and closed (intent, origin, type)', () => {
      expect([...OPEN_DIMENSIONS]).to.deep.equal([DIMENSION.CATEGORY, DIMENSION.SOURCE]);
      expect([...CLOSED_DIMENSIONS]).to.deep.equal(['intent', 'origin', 'type']);
      expect([...ALL_DIMENSIONS].sort()).to.deep.equal([...DIMENSION_PROVISION_ORDER].sort());
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

    it('reserves BOTH intent spellings, so neither can be shadowed', () => {
      // The bare name is reserved even though no root is named that: it folds to
      // the intent dimension, so a customer category called `intent` at the root
      // level would be READ as the dimension itself.
      expect(isDimensionRootName(INTENT_ROOT_NAME)).to.equal(true);
      expect(isDimensionRootName(DIMENSION.INTENT)).to.equal(true);
      expect([...RESERVED_ROOT_NAMES]).to.include(INTENT_ROOT_NAME);
    });

    it('maps a dimension to its upstream root name, and back', () => {
      // Only `intent` differs from its key: Semrush hides a `$abv_tags$`-marked
      // entry from the customer-facing Brand Presence tag filter.
      expect(rootNameOfDimension(DIMENSION.INTENT)).to.equal(INTENT_ROOT_NAME);
      expect(dimensionOfRootName(INTENT_ROOT_NAME)).to.equal(DIMENSION.INTENT);
      // The fold is identity for the dimension key itself.
      expect(dimensionOfRootName(DIMENSION.INTENT)).to.equal(DIMENSION.INTENT);
      DIMENSION_PROVISION_ORDER
        .filter((d) => d !== DIMENSION.INTENT)
        .forEach((d) => {
          expect(rootNameOfDimension(d)).to.equal(d);
          expect(dimensionOfRootName(d)).to.equal(d);
        });
      // Nothing outside the taxonomy is rewritten in either direction.
      expect(rootNameOfDimension('Running Shoes')).to.equal('Running Shoes');
      expect(dimensionOfRootName('Running Shoes')).to.equal('Running Shoes');
    });

    it('is frozen (immutable single source of truth)', () => {
      expect(Object.isFrozen(DIMENSION)).to.equal(true);
      expect(Object.isFrozen(DIMENSION_PROVISION_ORDER)).to.equal(true);
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
    it('seeds intent=Informational only (type is classified per prompt, origin is retired)', () => {
      // tag-display-names.md §3: the `origin/ai` entry this list used to carry
      // is retired — every writer that stamped an `origin` tag has stopped.
      expect(STANDARD_PROMPT_TAG_VALUES.map((t) => [t.dimension, t.name])).to.deep.equal([
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

  describe('SOURCE_LABEL (the tag-name map, tag-display-names.md §1 item 3)', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(SOURCE_LABEL)).to.equal(true);
    });

    it('every SOURCE_VALUES entry either has its own label, or is `llm-generated` (covered by the fold into ai-onboarding) — CI gate', () => {
      // This assertion FAILS the moment a canonical value is added to
      // SOURCE_VALUES without a label AND without being the one deliberate
      // fold exemption (tag-display-names.md §6 item 1, §1 item 3). No
      // pass-through slug default is permitted.
      SOURCE_VALUES.forEach((slug) => {
        if (slug === 'llm-generated') {
          expect(SOURCE_LABEL).to.not.have.property(slug);
          expect(deriveSource(slug, undefined)).to.equal('ai-onboarding');
        } else {
          expect(SOURCE_LABEL[slug], `missing SOURCE_LABEL for ${slug}`)
            .to.be.a('string').and.not.equal('');
        }
      });
    });

    it('also labels every DERIVED_SOURCE_VALUES entry (the fold target)', () => {
      DERIVED_SOURCE_VALUES.forEach((slug) => {
        expect(SOURCE_LABEL[slug], `missing SOURCE_LABEL for derived value ${slug}`)
          .to.be.a('string').and.not.equal('');
      });
    });

    it('every display name in the tag-name map is unique (bijective, never two slugs sharing one name)', () => {
      const names = Object.values(SOURCE_LABEL);
      expect(new Set(names).size, 'SOURCE_LABEL has a duplicate display name').to.equal(names.length);
    });

    it('no display name folds back into a DIFFERENT slug than the one it labels', () => {
      // tag-display-names.md §1 item 7: canonicalizeSource is never applied to
      // a display name as if it were a slug; this pins that a folded display
      // name, if it folds to anything at all, is exactly its own slug — never
      // silently a different SOURCE_VALUES member. Holds trivially today
      // (identity placeholders: folded === slug) and starts doing real
      // disambiguation work the moment SOURCE_LABEL's values diverge.
      Object.entries(SOURCE_LABEL).forEach(([slug, displayName]) => {
        const folded = canonicalizeSource(displayName);
        if (folded !== null) {
          expect(folded).to.equal(slug);
        }
      });
    });

    it('displayToSlug is the true inverse of SOURCE_LABEL', () => {
      Object.entries(SOURCE_LABEL).forEach(([slug, displayName]) => {
        expect(displayToSlug(displayName)).to.equal(slug);
      });
      expect(displayToSlug('not-a-known-display-name')).to.equal(undefined);
    });

    it('every canonical value that keeps its own tag name canonicalizes to itself (already folded)', () => {
      SOURCE_VALUES.filter((slug) => slug !== 'llm-generated').forEach((slug) => {
        expect(canonicalizeSource(slug)).to.equal(slug);
      });
    });

    it('is frozen for SOURCE_VALUES too', () => {
      expect(Object.isFrozen(SOURCE_VALUES)).to.equal(true);
    });
  });

  describe('DERIVED_SOURCE_VALUES (tag-display-names.md §6 item 3)', () => {
    it('is frozen and contains ai-onboarding', () => {
      expect(Object.isFrozen(DERIVED_SOURCE_VALUES)).to.equal(true);
      expect([...DERIVED_SOURCE_VALUES]).to.include('ai-onboarding');
    });

    it('is disjoint from the create-accepted enum (SOURCE_VALUES) — never a legal stored value', () => {
      DERIVED_SOURCE_VALUES.forEach((value) => {
        expect(SOURCE_VALUES).to.not.include(value);
      });
    });
  });

  describe('deriveSource (tag-display-names.md §3)', () => {
    it('folds `config` + origin `ai` into ai-onboarding', () => {
      expect(deriveSource('config', ORIGIN_VALUE.AI)).to.equal('ai-onboarding');
    });

    it('leaves `config` + origin `human` as config (the producer wins)', () => {
      expect(deriveSource('config', ORIGIN_VALUE.HUMAN)).to.equal('config');
    });

    it('folds llm-generated into ai-onboarding regardless of origin', () => {
      expect(deriveSource('llm-generated', ORIGIN_VALUE.HUMAN)).to.equal('ai-onboarding');
      expect(deriveSource('llm-generated', ORIGIN_VALUE.AI)).to.equal('ai-onboarding');
      expect(deriveSource('llm-generated', undefined)).to.equal('ai-onboarding');
    });

    it('leaves a specific producer untouched — origin carries no information for it', () => {
      expect(deriveSource('gsc', ORIGIN_VALUE.HUMAN)).to.equal('gsc');
      expect(deriveSource('drs', ORIGIN_VALUE.AI)).to.equal('drs');
    });

    it('canonicalizes before folding (case/underscore variants)', () => {
      expect(deriveSource('CONFIG', ORIGIN_VALUE.AI)).to.equal('ai-onboarding');
      expect(deriveSource('LLM_GENERATED', ORIGIN_VALUE.HUMAN)).to.equal('ai-onboarding');
    });

    it('propagates canonicalizeSource\'s null (do-not-tag) rather than substituting a default', () => {
      expect(deriveSource('', ORIGIN_VALUE.AI)).to.equal(null);
      expect(deriveSource(undefined, ORIGIN_VALUE.AI)).to.equal(null);
    });
  });

  describe('ROOT_DISPLAY_NAME / rootNameOfDimension (tag-display-names.md §1 item 4)', () => {
    it('is frozen and IDENTITY today for category/type/source', () => {
      expect(Object.isFrozen(ROOT_DISPLAY_NAME)).to.equal(true);
      expect(ROOT_DISPLAY_NAME[DIMENSION.CATEGORY]).to.equal(DIMENSION.CATEGORY);
      expect(ROOT_DISPLAY_NAME[DIMENSION.TYPE]).to.equal(DIMENSION.TYPE);
      expect(ROOT_DISPLAY_NAME[DIMENSION.SOURCE]).to.equal(DIMENSION.SOURCE);
    });

    it('does NOT cover intent or origin — intent stays hidden, origin retires rather than renames', () => {
      expect(ROOT_DISPLAY_NAME).to.not.have.property(DIMENSION.INTENT);
      expect(ROOT_DISPLAY_NAME).to.not.have.property(DIMENSION.ORIGIN);
      expect(rootNameOfDimension(DIMENSION.INTENT)).to.equal(INTENT_ROOT_NAME);
      expect(rootNameOfDimension(DIMENSION.ORIGIN)).to.equal(DIMENSION.ORIGIN);
    });

    it('RESERVED_ROOT_NAMES grows with the display root names without double-listing under identity', () => {
      DIMENSION_PROVISION_ORDER.forEach((d) => {
        expect(RESERVED_ROOT_NAMES).to.include(rootNameOfDimension(d));
      });
      // Deduped: today display === slug for category/type/source, so the set
      // is still exactly 6 entries (5 dimensions + the one intent divergence).
      expect(RESERVED_ROOT_NAMES.length).to.equal(6);
    });
  });

  describe('dimensionOfRootName (resolves display names, slug names, and $abv_tags$intent)', () => {
    it('resolves every dimension key to itself', () => {
      DIMENSION_PROVISION_ORDER.forEach((d) => {
        expect(dimensionOfRootName(d)).to.equal(d);
      });
    });

    it('resolves every CURRENT root-name spelling (rootNameOfDimension) to its dimension', () => {
      DIMENSION_PROVISION_ORDER.forEach((d) => {
        expect(dimensionOfRootName(rootNameOfDimension(d))).to.equal(d);
      });
    });

    it('resolves $abv_tags$intent to intent explicitly', () => {
      expect(dimensionOfRootName(INTENT_ROOT_NAME)).to.equal(DIMENSION.INTENT);
    });

    it('is identity for anything outside the taxonomy', () => {
      expect(dimensionOfRootName('Running Shoes')).to.equal('Running Shoes');
    });
  });

  describe('TYPE_VALUE_DISPLAY / displayNameOfValue / valueSlugOfDisplayName', () => {
    it('TYPE_VALUE_DISPLAY is frozen and identity today', () => {
      expect(Object.isFrozen(TYPE_VALUE_DISPLAY)).to.equal(true);
      expect(TYPE_VALUE_DISPLAY[TYPE_VALUE.BRANDED]).to.equal(TYPE_VALUE.BRANDED);
      expect(TYPE_VALUE_DISPLAY[TYPE_VALUE.NON_BRANDED]).to.equal(TYPE_VALUE.NON_BRANDED);
    });

    it('displayNameOfValue routes source/type through their maps and leaves intent/origin untouched', () => {
      expect(displayNameOfValue(DIMENSION.SOURCE, 'config')).to.equal(SOURCE_LABEL.config);
      expect(displayNameOfValue(DIMENSION.TYPE, TYPE_VALUE.BRANDED))
        .to.equal(TYPE_VALUE_DISPLAY[TYPE_VALUE.BRANDED]);
      expect(displayNameOfValue(DIMENSION.INTENT, INTENT_VALUE.TASK)).to.equal(INTENT_VALUE.TASK);
      expect(displayNameOfValue(DIMENSION.ORIGIN, ORIGIN_VALUE.AI)).to.equal(ORIGIN_VALUE.AI);
    });

    it('valueSlugOfDisplayName is the inverse for source/type, undefined for intent/origin', () => {
      expect(valueSlugOfDisplayName(DIMENSION.SOURCE, SOURCE_LABEL.config)).to.equal('config');
      expect(valueSlugOfDisplayName(DIMENSION.TYPE, TYPE_VALUE_DISPLAY[TYPE_VALUE.BRANDED]))
        .to.equal(TYPE_VALUE.BRANDED);
      expect(valueSlugOfDisplayName(DIMENSION.INTENT, INTENT_VALUE.TASK)).to.equal(undefined);
      expect(valueSlugOfDisplayName(DIMENSION.ORIGIN, ORIGIN_VALUE.AI)).to.equal(undefined);
    });
  });
});
