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
  mergeUrlPromptsResponses,
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

    it('lets an explicit model win over platform=all (single model, not the union)', () => {
      expect(advancedVal(
        buildUrlPromptsPayload({ url: URL, model: 'search-gpt', platform: 'all' }),
        'CBF_model',
      )).to.equal('search-gpt');
    });

    it('OMITS the CBF_model filter for the `all` sentinel (deduped cross-model union)', () => {
      const payload = buildUrlPromptsPayload({ url: URL, model: 'all' });
      expect(payload.filters.advanced.filters.some((f) => f.col === 'CBF_model')).to.equal(false);
    });

    it('treats the `all` sentinel case-insensitively', () => {
      const payload = buildUrlPromptsPayload({ url: URL, platform: 'ALL' });
      expect(advancedVal(payload, 'CBF_model')).to.be.undefined;
    });

    it('recognises `all` via platform as well as model', () => {
      expect(advancedVal(buildUrlPromptsPayload({ url: URL, platform: 'all' }), 'CBF_model'))
        .to.be.undefined;
    });

    it('still applies the other filters when platform is `all`', () => {
      const payload = buildUrlPromptsPayload({
        url: URL, model: 'all', startDate: '2026-06-29', endDate: '2026-07-26', category: 'category__Brand',
      });
      expect(payload.filters.simple.CBF_source).to.equal(URL);
      expect(advancedVal(payload, 'CBF_source')).to.equal(URL);
      expect(advancedVal(payload, 'CBF_date__start')).to.equal('2026-06-29');
      expect(advancedVal(payload, 'CBF_date__end')).to.equal('2026-07-26');
      expect(advancedVal(payload, 'CBF_tags')).to.equal('category__Brand');
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

    it('scopes the market via a TOP-LEVEL project_id when projectId is given', () => {
      const payload = buildUrlPromptsPayload({ url: URL, projectId: 'US-en' });
      expect(payload.project_id).to.equal('US-en');
    });

    it('omits project_id when no projectId is given (aggregate across the sub-workspace)', () => {
      expect(buildUrlPromptsPayload({ url: URL })).to.not.have.property('project_id');
    });

    it('never scopes the market via a CBF_project advanced filter (verified no-op)', () => {
      const payload = buildUrlPromptsPayload({ url: URL, projectId: 'US-en' });
      expect(advancedVal(payload, 'CBF_project')).to.be.undefined;
    });

    it('scopes the category via CBF_tags (eq) in advanced, sent as-is', () => {
      const payload = buildUrlPromptsPayload({ url: URL, category: 'category__Brand' });
      const tagFilter = payload.filters.advanced.filters.find((f) => f.col === 'CBF_tags');
      expect(tagFilter).to.deep.equal({ op: 'eq', val: 'category__Brand', col: 'CBF_tags' });
    });

    it('never puts CBF_tags in the simple block (verified no-op)', () => {
      const payload = buildUrlPromptsPayload({ url: URL, category: 'category__Brand' });
      expect(payload.filters.simple).to.not.have.property('CBF_tags');
    });

    it('omits CBF_tags when no category is given', () => {
      const payload = buildUrlPromptsPayload({ url: URL });
      expect(advancedVal(payload, 'CBF_tags')).to.be.undefined;
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
        category: '',
        region: '',
        topics: '',
        citations: 0,
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

  describe('mergeUrlPromptsResponses', () => {
    // Minimal transformed-row factory (the shape transformUrlPromptsResponse emits).
    const row = (prompt, over = {}) => ({
      prompt,
      category: '',
      region: '',
      topics: '',
      citations: 0,
      sourceTitle: '',
      brandMentioned: '',
      brands: [],
      closestDate: null,
      ...over,
    });

    it('returns an empty array for empty / non-array input', () => {
      expect(mergeUrlPromptsResponses()).to.deep.equal([]);
      expect(mergeUrlPromptsResponses([])).to.deep.equal([]);
      expect(mergeUrlPromptsResponses([null, undefined])).to.deep.equal([]);
    });

    it('unions distinct prompts across markets in first-seen order', () => {
      const merged = mergeUrlPromptsResponses([[row('a')], [row('b')], [row('a')]]);
      expect(merged.map((r) => r.prompt)).to.deep.equal(['a', 'b']);
    });

    it('dedupes the same prompt across markets: unions brands, keeps latest closestDate', () => {
      const merged = mergeUrlPromptsResponses([
        [row('p', { brands: ['Lovesac'], closestDate: '2026-07-01T00:00:00Z' })],
        [row('p', { brands: ['Lovesac', 'Figma'], closestDate: '2026-07-26T00:00:00Z' })],
      ]);
      expect(merged).to.have.length(1);
      expect(merged[0].brands).to.deep.equal(['Lovesac', 'Figma']);
      expect(merged[0].closestDate).to.equal('2026-07-26T00:00:00Z');
    });

    it('keeps the EARLIER closestDate when a later market has an older one', () => {
      const merged = mergeUrlPromptsResponses([
        [row('p', { closestDate: '2026-07-26T00:00:00Z' })],
        [row('p', { closestDate: '2026-07-01T00:00:00Z' })],
      ]);
      expect(merged[0].closestDate).to.equal('2026-07-26T00:00:00Z');
    });

    it('first occurrence wins for scalar fields (sourceTitle/brandMentioned)', () => {
      const merged = mergeUrlPromptsResponses([
        [row('p', { sourceTitle: 'first', brandMentioned: 'mentioned' })],
        [row('p', { sourceTitle: 'second', brandMentioned: 'not_mentioned' })],
      ]);
      expect(merged[0].sourceTitle).to.equal('first');
      expect(merged[0].brandMentioned).to.equal('mentioned');
    });

    it('drops malformed blank-prompt rows instead of collapsing them into one entry', () => {
      const merged = mergeUrlPromptsResponses([
        [row(''), row('real')],
        [row('')],
      ]);
      expect(merged.map((r) => r.prompt)).to.deep.equal(['real']);
    });

    it('does not mutate the input rows (brands array is copied)', () => {
      const input = [[row('p', { brands: ['A'] })], [row('p', { brands: ['B'] })]];
      mergeUrlPromptsResponses(input);
      expect(input[0][0].brands).to.deep.equal(['A']);
    });
  });
});
