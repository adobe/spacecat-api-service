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
  TAG_DIMENSION,
  SOURCE_TAG,
  INTENT_TAG,
  TYPE_TAG,
  topicTag,
  STANDARD_PROMPT_TAGS,
  PROJECT_STANDARD_TAGS,
  CREATABLE_TAG_DIMENSIONS,
  CLOSED_TAG_DIMENSIONS,
} from '../../../src/support/serenity/prompt-tags.js';

describe('serenity prompt-tags taxonomy', () => {
  describe('topicTag', () => {
    it('builds the topic:<NAME> tag, preserving the name verbatim', () => {
      expect(topicTag('Running Shoes')).to.equal('topic:Running Shoes');
    });

    it('does not slug or trim — whitespace and non-ASCII are preserved', () => {
      expect(topicTag('  spaced  ')).to.equal('topic:  spaced  ');
      expect(topicTag('Café Münich')).to.equal('topic:Café Münich');
    });

    it('produces a bare-prefix tag for an empty name (no transformation)', () => {
      expect(topicTag('')).to.equal('topic:');
    });

    it('uses the TOPIC dimension constant as the prefix', () => {
      expect(topicTag('X').startsWith(`${TAG_DIMENSION.TOPIC}:`)).to.equal(true);
    });
  });

  describe('STANDARD_PROMPT_TAGS', () => {
    it('seeds source:ai + intent:Informational only (type is classified per prompt)', () => {
      expect([...STANDARD_PROMPT_TAGS]).to.deep.equal([SOURCE_TAG.AI, INTENT_TAG.INFORMATIONAL]);
    });

    it('is frozen (immutable single source of truth)', () => {
      expect(Object.isFrozen(STANDARD_PROMPT_TAGS)).to.equal(true);
    });
  });

  describe('PROJECT_STANDARD_TAGS', () => {
    it('registers the full taxonomy: all intents, then sources, then types', () => {
      expect([...PROJECT_STANDARD_TAGS]).to.deep.equal([
        ...Object.values(INTENT_TAG),
        ...Object.values(SOURCE_TAG),
        ...Object.values(TYPE_TAG),
      ]);
    });

    it('is frozen', () => {
      expect(Object.isFrozen(PROJECT_STANDARD_TAGS)).to.equal(true);
    });
  });

  describe('tag dimension constants', () => {
    it('every value tag is prefixed with its dimension', () => {
      Object.values(SOURCE_TAG).forEach((t) => expect(t).to.match(/^source:/));
      Object.values(INTENT_TAG).forEach((t) => expect(t).to.match(/^intent:/));
      Object.values(TYPE_TAG).forEach((t) => expect(t).to.match(/^type:/));
    });
  });

  describe('CREATABLE_TAG_DIMENSIONS', () => {
    it('is exactly [category, topic, tag] — the open, customer-authored dimensions', () => {
      expect([...CREATABLE_TAG_DIMENSIONS]).to.deep.equal([
        TAG_DIMENSION.CATEGORY,
        TAG_DIMENSION.TOPIC,
        TAG_DIMENSION.TAG,
      ]);
    });

    it('is frozen', () => {
      expect(Object.isFrozen(CREATABLE_TAG_DIMENSIONS)).to.equal(true);
    });

    it('is disjoint from CLOSED_TAG_DIMENSIONS (no dimension is both open and closed)', () => {
      const closed = new Set(CLOSED_TAG_DIMENSIONS);
      CREATABLE_TAG_DIMENSIONS.forEach((d) => expect(closed.has(d)).to.equal(false));
    });
  });
});
