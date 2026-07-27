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
  buildTopicPromptsPayload,
  transformTopicPromptsResponse,
} from '../../../../src/support/elements/definitions/topic-prompts.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

// Finds the value of a CBF_* column that sits inside its own `or` block within
// the advanced filter tree (CBF_model / CBF_topic / CBF_project all use this shape),
// or returns undefined if absent.
function findFilterVal(payload, col) {
  const blocks = payload.filters.advanced.filters;
  for (const block of blocks) {
    const inner = Array.isArray(block.filters) ? block.filters : [];
    const hit = inner.find((f) => f.col === col);
    if (hit) {
      return hit.val;
    }
  }
  return undefined;
}

describe('topic-prompts definitions', () => {
  describe('buildTopicPromptsPayload', () => {
    it('uses comparison_data_formatting "join" (matches the live MFE, not "union")', () => {
      expect(buildTopicPromptsPayload().comparison_data_formatting).to.equal('join');
    });

    it('uses an AND operator over the advanced filters', () => {
      expect(buildTopicPromptsPayload().filters.advanced.op).to.equal('and');
    });

    it('defaults the model to DEFAULT_ELEMENT_MODEL in a CBF_model or-block', () => {
      const modelBlock = buildTopicPromptsPayload().filters.advanced.filters[0];
      expect(modelBlock.op).to.equal('or');
      expect(modelBlock.filters[0].col).to.equal('CBF_model');
      expect(modelBlock.filters[0].val).to.equal(DEFAULT_ELEMENT_MODEL);
    });

    it('translates a UI platform code to the Semrush model (openai -> chatgpt-paid)', () => {
      const modelBlock = buildTopicPromptsPayload({ model: 'openai' }).filters.advanced.filters[0];
      expect(modelBlock.filters[0].val).to.equal('chatgpt-paid');
    });

    it('prefers model over platform when both are given', () => {
      const modelBlock = buildTopicPromptsPayload({ model: 'openai', platform: 'gemini' })
        .filters.advanced.filters[0];
      expect(modelBlock.filters[0].val).to.equal('chatgpt-paid');
    });

    it('scopes to a single topic via a CBF_topic or-block (bare topic name) when topic is provided', () => {
      expect(findFilterVal(buildTopicPromptsPayload({ topic: 'Video Generation' }), 'CBF_topic'))
        .to.equal('Video Generation');
    });

    it('omits CBF_topic when topic is not provided (all topics)', () => {
      expect(findFilterVal(buildTopicPromptsPayload(), 'CBF_topic')).to.be.undefined;
    });

    it('includes CBF_project (in an or-block) when projectId is provided', () => {
      expect(findFilterVal(buildTopicPromptsPayload({ projectId: 'proj-42' }), 'CBF_project'))
        .to.equal('proj-42');
    });

    it('omits CBF_project when projectId is not provided', () => {
      expect(findFilterVal(buildTopicPromptsPayload(), 'CBF_project')).to.be.undefined;
    });

    it('sends filters.simple date window only when both dates are present', () => {
      const payload = buildTopicPromptsPayload({ startDate: '2026-06-01', endDate: '2026-06-30' });
      expect(payload.filters.simple).to.deep.equal({
        start_date: '2026-06-01', end_date: '2026-06-30',
      });
    });

    it('omits filters.simple when a date is missing', () => {
      expect(buildTopicPromptsPayload({ startDate: '2026-06-01' }).filters)
        .to.not.have.property('simple');
      expect(buildTopicPromptsPayload().filters).to.not.have.property('simple');
    });
  });

  describe('transformTopicPromptsResponse', () => {
    it('returns an empty array for a missing/empty response', () => {
      expect(transformTopicPromptsResponse(undefined)).to.deep.equal([]);
      expect(transformTopicPromptsResponse({ blocks: {} })).to.deep.equal([]);
      expect(transformTopicPromptsResponse({ blocks: { data: [] } })).to.deep.equal([]);
    });

    it('maps a full row into the clean camelCase contract', () => {
      const raw = {
        blocks: {
          data: [{
            prompt: 'best modular sofa',
            prompt_topic: 'Loveseats with Ottomans',
            primary_intent: 'commercial',
            project_title: 'US-en',
            mentions: 30,
            citations: 27,
            visibility: 100,
            position: 1,
            sentiment: 0.72,
            volume: 5658,
            days: 30,
            model: 'Chat GPT',
          }],
        },
      };
      expect(transformTopicPromptsResponse(raw)).to.deep.equal([{
        prompt: 'best modular sofa',
        topic: 'Loveseats with Ottomans',
        primaryIntent: 'commercial',
        region: 'US-en',
        mentions: 30,
        citations: 27,
        visibility: 100,
        position: 1,
        sentiment: 0.72,
        volume: 5658,
      }]);
    });

    it('normalizes the position -1 sentinel to null', () => {
      const raw = { blocks: { data: [{ prompt: 'p', prompt_topic: 't', position: -1 }] } };
      expect(transformTopicPromptsResponse(raw)[0].position).to.equal(null);
    });

    it('keeps a null sentiment as null (not 0)', () => {
      const raw = { blocks: { data: [{ prompt: 'p', prompt_topic: 't', sentiment: null }] } };
      expect(transformTopicPromptsResponse(raw)[0].sentiment).to.equal(null);
    });

    it('coerces null/absent mentions, citations, visibility and volume to 0', () => {
      const raw = {
        blocks: {
          data: [{
            prompt: 'p', prompt_topic: 't', mentions: null, citations: null,
          }],
        },
      };
      const row = transformTopicPromptsResponse(raw)[0];
      expect(row.mentions).to.equal(0);
      expect(row.citations).to.equal(0);
      expect(row.visibility).to.equal(0);
      expect(row.volume).to.equal(0);
    });

    it('defaults missing string fields to empty strings', () => {
      const row = transformTopicPromptsResponse({ blocks: { data: [{}] } })[0];
      expect(row.prompt).to.equal('');
      expect(row.topic).to.equal('');
      expect(row.primaryIntent).to.equal('');
      expect(row.region).to.equal('');
    });
  });
});
