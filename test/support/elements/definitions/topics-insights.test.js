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
import { aggregateTopicsFromPrompts } from '../../../../src/support/elements/definitions/topics-insights.js';

// Minimal clean per-prompt row (as transformTopicPromptsResponse emits).
function row(overrides = {}) {
  return {
    prompt: 'p',
    topic: 'T',
    primaryIntent: '',
    region: 'US-en',
    mentions: 0,
    citations: 0,
    visibility: 0,
    position: null,
    sentiment: null,
    volume: 0,
    ...overrides,
  };
}

describe('topics-insights aggregation', () => {
  describe('aggregateTopicsFromPrompts', () => {
    it('returns an empty array for empty/invalid input', () => {
      expect(aggregateTopicsFromPrompts([])).to.deep.equal([]);
      expect(aggregateTopicsFromPrompts(undefined)).to.deep.equal([]);
    });

    it('groups by topic and sums mentions, citations and volume', () => {
      const out = aggregateTopicsFromPrompts([
        row({
          topic: 'A', mentions: 10, citations: 5, volume: 100,
        }),
        row({
          topic: 'A', mentions: 20, citations: 7, volume: 200,
        }),
        row({
          topic: 'B', mentions: 1, citations: 1, volume: 5,
        }),
      ]);
      const a = out.find((t) => t.topic === 'A');
      expect(a.promptCount).to.equal(2);
      expect(a.brandMentions).to.equal(30);
      expect(a.brandCitations).to.equal(12);
      expect(a.volume).to.equal(300);
    });

    it('averages visibility over ALL prompts (unanswered 0 counts in the denominator)', () => {
      const [t] = aggregateTopicsFromPrompts([
        row({ topic: 'A', visibility: 100 }),
        row({ topic: 'A', visibility: 0 }),
      ]);
      expect(t.averageVisibilityScore).to.equal(50);
    });

    it('averages position only over ranked prompts, excluding null sentinels', () => {
      const [t] = aggregateTopicsFromPrompts([
        row({ topic: 'A', position: 2 }),
        row({ topic: 'A', position: 4 }),
        row({ topic: 'A', position: null }),
      ]);
      expect(t.averagePosition).to.equal(3);
    });

    it('averages sentiment only over prompts that have sentiment', () => {
      const [t] = aggregateTopicsFromPrompts([
        row({ topic: 'A', sentiment: 0.6 }),
        row({ topic: 'A', sentiment: 0.8 }),
        row({ topic: 'A', sentiment: null }),
      ]);
      expect(t.averageSentiment).to.equal(0.7);
    });

    it('yields null averagePosition / averageSentiment when the topic has no valid values', () => {
      const [t] = aggregateTopicsFromPrompts([
        row({ topic: 'A', position: null, sentiment: null }),
      ]);
      expect(t.averagePosition).to.equal(null);
      expect(t.averageSentiment).to.equal(null);
    });

    it('rounds averages to two decimals', () => {
      const [t] = aggregateTopicsFromPrompts([
        row({ topic: 'A', visibility: 1 }),
        row({ topic: 'A', visibility: 2 }),
        row({ topic: 'A', visibility: 2 }),
      ]);
      expect(t.averageVisibilityScore).to.equal(1.67);
    });

    it('sorts topics by total volume descending', () => {
      const out = aggregateTopicsFromPrompts([
        row({ topic: 'small', volume: 10 }),
        row({ topic: 'big', volume: 1000 }),
        row({ topic: 'mid', volume: 100 }),
      ]);
      expect(out.map((t) => t.topic)).to.deep.equal(['big', 'mid', 'small']);
    });

    it('embeds the topic\'s own prompts, sorted by volume descending', () => {
      const [t] = aggregateTopicsFromPrompts([
        row({
          topic: 'A', prompt: 'low', volume: 10,
        }),
        row({
          topic: 'A', prompt: 'high', volume: 900,
        }),
        row({
          topic: 'A', prompt: 'mid', volume: 100,
        }),
      ]);
      expect(t.prompts.map((p) => p.prompt)).to.deep.equal(['high', 'mid', 'low']);
      expect(t.promptCount).to.equal(3);
    });

    it('skips rows with an empty, whitespace-only, or non-string topic', () => {
      const out = aggregateTopicsFromPrompts([
        row({ topic: '', mentions: 99 }),
        row({ topic: '   ', mentions: 99 }),
        { mentions: 99 }, // no topic field at all (non-string)
        row({ topic: 'A', mentions: 1 }),
      ]);
      expect(out).to.have.length(1);
      expect(out[0].topic).to.equal('A');
    });
  });
});
