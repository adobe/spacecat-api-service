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
  buildPromptsPayload,
  transformPromptsResponse,
} from '../../../../src/support/elements/definitions/prompts.js';

const advancedFilters = (payload) => payload.filters.advanced.filters;
const clauseFor = (payload, col) => advancedFilters(payload)
  .find((f) => f.filters?.some((c) => c.col === col));

describe('prompts definitions', () => {
  describe('buildPromptsPayload', () => {
    it('defaults the model to search-gpt when none is provided', () => {
      const payload = buildPromptsPayload();
      const modelClause = clauseFor(payload, 'CBF_model');
      expect(modelClause).to.deep.equal({
        op: 'or',
        filters: [{ op: 'eq', val: 'search-gpt', col: 'CBF_model' }],
      });
    });

    it('sets comparison_data_formatting to union with an AND advanced group', () => {
      const payload = buildPromptsPayload();
      expect(payload.comparison_data_formatting).to.equal('union');
      expect(payload.filters.advanced.op).to.equal('and');
    });

    it('resolves a UI platform code to its Semrush model', () => {
      const payload = buildPromptsPayload({ platform: 'copilot' });
      expect(clauseFor(payload, 'CBF_model').filters[0].val).to.equal('microsoft-copilot');
    });

    it('prefers model over platform when both are given', () => {
      const payload = buildPromptsPayload({ model: 'perplexity', platform: 'copilot' });
      expect(clauseFor(payload, 'CBF_model').filters[0].val).to.equal('perplexity');
    });

    it('falls back to the default model for an unrecognised value', () => {
      const payload = buildPromptsPayload({ model: 'not-a-model' });
      expect(clauseFor(payload, 'CBF_model').filters[0].val).to.equal('search-gpt');
    });

    it('omits any tag clause when no tags are provided', () => {
      const payload = buildPromptsPayload();
      const hasTagsClause = advancedFilters(payload).some((f) => f.col === 'tags');
      expect(hasTagsClause).to.be.false;
    });

    it('adds a raw `tags contains <value>` clause for a single tag (no prefixing)', () => {
      const payload = buildPromptsPayload({ tags: ['type__branded'] });
      const tagClause = advancedFilters(payload).find((f) => f.col === 'tags');
      expect(tagClause).to.deep.equal({ op: 'contains', val: 'type__branded', col: 'tags' });
    });

    it('ANDs multiple tags as separate clauses (must match all)', () => {
      const payload = buildPromptsPayload({ tags: ['type__branded', 'category__Brand'] });
      const tagClauses = advancedFilters(payload).filter((f) => f.col === 'tags');
      expect(tagClauses).to.deep.equal([
        { op: 'contains', val: 'type__branded', col: 'tags' },
        { op: 'contains', val: 'category__Brand', col: 'tags' },
      ]);
    });

    it('omits the project clause when no projectIds are provided (workspace-wide)', () => {
      const payload = buildPromptsPayload();
      const hasProjectClause = advancedFilters(payload)
        .some((f) => f.filters?.some((c) => c.col === 'CBF_project'));
      expect(hasProjectClause).to.be.false;
    });

    it('ORs multiple project ids together', () => {
      const payload = buildPromptsPayload({ projectIds: ['proj-a', 'proj-b'] });
      expect(clauseFor(payload, 'CBF_project').filters).to.deep.equal([
        { op: 'eq', val: 'proj-a', col: 'CBF_project' },
        { op: 'eq', val: 'proj-b', col: 'CBF_project' },
      ]);
    });

    it('combines model, tags and projects into one AND group', () => {
      const payload = buildPromptsPayload({
        model: 'search-gpt', tags: ['type__branded'], projectIds: ['proj-a'],
      });
      const af = advancedFilters(payload);
      expect(af).to.have.length(3);
      expect(af.find((f) => f.filters?.[0]?.col === 'CBF_model')).to.exist;
      expect(af.find((f) => f.col === 'tags')).to.exist;
      expect(af.find((f) => f.filters?.[0]?.col === 'CBF_project')).to.exist;
    });
  });

  describe('transformPromptsResponse', () => {
    const RAW = {
      type: 'table',
      blocks: {
        data: [
          {
            primary_intent: 'informational',
            prompt: 'can i make ai influencer for free',
            prompt_topic: 'AI Instagram Influencers',
            volume: 2119,
          },
          {
            primary_intent: 'informational',
            prompt: 'What is the best AI free image generator?',
            prompt_topic: 'AI Image Generators',
            volume: 997,
          },
        ],
      },
    };

    it('returns count and prompts passing Semrush field names through unchanged', () => {
      const result = transformPromptsResponse(RAW);
      expect(result.count).to.equal(2);
      expect(result.prompts[0]).to.deep.equal({
        prompt: 'can i make ai influencer for free',
        prompt_topic: 'AI Instagram Influencers',
        primary_intent: 'informational',
        volume: 2119,
      });
    });

    it('returns an empty result when blocks.data is missing', () => {
      expect(transformPromptsResponse({})).to.deep.equal({ count: 0, prompts: [] });
    });

    it('returns an empty result when raw is null', () => {
      expect(transformPromptsResponse(null)).to.deep.equal({ count: 0, prompts: [] });
    });

    it('returns an empty result when blocks.data is not an array', () => {
      expect(transformPromptsResponse({ blocks: { data: null } }))
        .to.deep.equal({ count: 0, prompts: [] });
    });
  });
});
