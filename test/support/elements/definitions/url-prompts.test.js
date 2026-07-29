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
  buildUrlPromptsPayload,
  transformUrlPromptsResponse,
} from '../../../../src/support/elements/definitions/url-prompts.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

const URL = 'https://www.lovesac.com/sactionals';

// Returns the first `eq` filter for a column in the flat advanced.filters list.
function advancedVal(payload, col) {
  return payload.filters.advanced.filters.find((f) => f.col === col)?.val;
}

describe('url-prompts definitions', () => {
  describe('buildUrlPromptsPayload', () => {
    it('uses an AND operator over the advanced filters', () => {
      expect(buildUrlPromptsPayload({ url: URL }).filters.advanced.op).to.equal('and');
    });

    it('places CBF_source (the URL) in BOTH simple and advanced (unique to this element)', () => {
      const payload = buildUrlPromptsPayload({ url: URL });
      expect(payload.filters.simple.CBF_source).to.equal(URL);
      expect(advancedVal(payload, 'CBF_source')).to.equal(URL);
    });

    it('defaults the model to DEFAULT_ELEMENT_MODEL as a bare CBF_model eq', () => {
      const payload = buildUrlPromptsPayload({ url: URL });
      const modelFilter = payload.filters.advanced.filters.find((f) => f.col === 'CBF_model');
      expect(modelFilter).to.deep.equal({ op: 'eq', val: DEFAULT_ELEMENT_MODEL, col: 'CBF_model' });
    });

    it('translates a UI platform code to the Semrush model (openai -> chatgpt-paid)', () => {
      expect(advancedVal(buildUrlPromptsPayload({ url: URL, model: 'openai' }), 'CBF_model'))
        .to.equal('chatgpt-paid');
    });

    it('prefers model over platform when both are given', () => {
      expect(advancedVal(
        buildUrlPromptsPayload({ url: URL, model: 'openai', platform: 'gemini' }),
        'CBF_model',
      )).to.equal('chatgpt-paid');
    });

    it('sends the date window as CBF_date__start (gte) / CBF_date__end (lte) in advanced', () => {
      const payload = buildUrlPromptsPayload({
        url: URL, startDate: '2026-06-29', endDate: '2026-07-26',
      });
      const start = payload.filters.advanced.filters.find((f) => f.col === 'CBF_date__start');
      const end = payload.filters.advanced.filters.find((f) => f.col === 'CBF_date__end');
      expect(start).to.deep.equal({ op: 'gte', val: '2026-06-29', col: 'CBF_date__start' });
      expect(end).to.deep.equal({ op: 'lte', val: '2026-07-26', col: 'CBF_date__end' });
    });

    it('does not send a CBF_brand filter (sub-workspace scopes the brand)', () => {
      const payload = buildUrlPromptsPayload({ url: URL });
      expect(payload.filters.simple).to.not.have.property('CBF_brand');
      expect(advancedVal(payload, 'CBF_brand')).to.be.undefined;
    });
  });

  describe('transformUrlPromptsResponse', () => {
    it('returns an empty array for a missing/empty response', () => {
      expect(transformUrlPromptsResponse(undefined)).to.deep.equal([]);
      expect(transformUrlPromptsResponse({ blocks: {} })).to.deep.equal([]);
      expect(transformUrlPromptsResponse({ blocks: { data: [] } })).to.deep.equal([]);
    });

    it('maps a full row into the clean camelCase contract', () => {
      const raw = {
        blocks: {
          data: [{
            prompt: 'What size Lovesac sectional is best for a studio apartment?',
            source: URL,
            source_title: 'Modular Sectional Couches | Lovesac Sactionals',
            brand_mentioned: 'mentioned',
            brands_string: 'Lovesac, Figma',
            closest_date: '2026-07-26T00:00:00Z',
            url_cbf: 'irrelevant',
          }],
        },
      };
      expect(transformUrlPromptsResponse(raw)).to.deep.equal([{
        prompt: 'What size Lovesac sectional is best for a studio apartment?',
        sourceTitle: 'Modular Sectional Couches | Lovesac Sactionals',
        brandMentioned: 'mentioned',
        brands: ['Lovesac', 'Figma'],
        closestDate: '2026-07-26T00:00:00Z',
      }]);
    });

    it('splits brands_string on commas and trims, dropping blanks', () => {
      const raw = { blocks: { data: [{ prompt: 'p', brands_string: 'A, B ,, C' }] } };
      expect(transformUrlPromptsResponse(raw)[0].brands).to.deep.equal(['A', 'B', 'C']);
    });

    it('defaults an absent brands_string to an empty array', () => {
      const raw = { blocks: { data: [{ prompt: 'p' }] } };
      expect(transformUrlPromptsResponse(raw)[0].brands).to.deep.equal([]);
    });

    it('defaults missing string fields to empty strings and closestDate to null', () => {
      const row = transformUrlPromptsResponse({ blocks: { data: [{}] } })[0];
      expect(row.prompt).to.equal('');
      expect(row.sourceTitle).to.equal('');
      expect(row.brandMentioned).to.equal('');
      expect(row.closestDate).to.equal(null);
    });
  });
});
