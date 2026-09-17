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
  buildContentTypesPayload,
  transformContentTypesToFilterDimensions,
} from '../../../../src/support/elements/definitions/content-types.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

describe('content-types definitions', () => {
  describe('buildContentTypesPayload', () => {
    it('uses the default model when no params are provided', () => {
      const payload = buildContentTypesPayload();
      expect(payload.filters.advanced.filters[0]).to.deep.equal({
        op: 'eq',
        val: DEFAULT_ELEMENT_MODEL,
        col: 'CBF_model',
      });
    });

    it('uses the default model when model is not in ELEMENT_MODELS', () => {
      const payload = buildContentTypesPayload({ model: 'unknown-model' });
      expect(payload.filters.advanced.filters[0].val).to.equal(DEFAULT_ELEMENT_MODEL);
    });

    it('uses the provided model when it is in ELEMENT_MODELS', () => {
      const payload = buildContentTypesPayload({ model: 'perplexity' });
      expect(payload.filters.advanced.filters[0].val).to.equal('perplexity');
    });

    it('translates a SpaceCat/UI platform code to the Semrush model', () => {
      const payload = buildContentTypesPayload({ model: 'copilot' });
      expect(payload.filters.advanced.filters[0].val).to.equal('microsoft-copilot');
    });

    it('accepts the platform alias and translates it', () => {
      const payload = buildContentTypesPayload({ platform: 'openai' });
      expect(payload.filters.advanced.filters[0].val).to.equal('chatgpt-paid');
    });

    it('uses the provided startDate and endDate', () => {
      const payload = buildContentTypesPayload({ startDate: '2026-06-07', endDate: '2026-06-14' });
      expect(payload.filters.advanced.filters[1]).to.deep.equal({
        op: 'gte',
        val: '2026-06-07',
        col: 'CBF_date__start',
      });
      expect(payload.filters.advanced.filters[2]).to.deep.equal({
        op: 'lte',
        val: '2026-06-14',
        col: 'CBF_date__end',
      });
    });

    it('defaults to a rolling 28-day window when no dates are provided', () => {
      const payload = buildContentTypesPayload();
      const start = payload.filters.advanced.filters[1];
      const end = payload.filters.advanced.filters[2];
      expect(start.col).to.equal('CBF_date__start');
      expect(end.col).to.equal('CBF_date__end');
      const startMs = new Date(start.val).getTime();
      const endMs = new Date(end.val).getTime();
      const daysApart = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000));
      expect(daysApart).to.equal(28);
    });

    it('sets comparison_data_formatting to union', () => {
      const payload = buildContentTypesPayload();
      expect(payload.comparison_data_formatting).to.equal('union');
    });

    it('uses AND operator in the advanced filter', () => {
      const payload = buildContentTypesPayload();
      expect(payload.filters.advanced.op).to.equal('and');
    });

    it('includes an empty simple filter object', () => {
      const payload = buildContentTypesPayload();
      expect(payload.filters.simple).to.deep.equal({});
    });
  });

  describe('transformContentTypesToFilterDimensions', () => {
    it('returns an empty array when raw is null', () => {
      expect(transformContentTypesToFilterDimensions(null)).to.deep.equal([]);
    });

    it('returns an empty array when raw has no blocks', () => {
      expect(transformContentTypesToFilterDimensions({})).to.deep.equal([]);
    });

    it('derives id from a single-word label', () => {
      const raw = { blocks: { value: [{ value: 'Owned' }] } };
      const [item] = transformContentTypesToFilterDimensions(raw);
      expect(item).to.deep.equal({ id: 'owned', label: 'Owned' });
    });

    it('derives id from a multi-word label by replacing spaces with underscores', () => {
      const raw = { blocks: { value: [{ value: 'Benchmark Competitors' }] } };
      const [item] = transformContentTypesToFilterDimensions(raw);
      expect(item).to.deep.equal({ id: 'benchmark_competitors', label: 'Benchmark Competitors' });
    });

    it('filters out entries with an empty/missing value', () => {
      const raw = { blocks: { value: [{ value: '' }, { }, { value: 'Social' }] } };
      const result = transformContentTypesToFilterDimensions(raw);
      expect(result).to.deep.equal([{ id: 'social', label: 'Social' }]);
    });

    it('handles the full known set of content types, preserving element order', () => {
      const raw = {
        blocks: {
          value: [
            { value: 'Other' },
            { value: 'Social' },
            { value: 'Earned' },
            { value: 'Owned' },
            { value: 'Benchmark Competitors' },
          ],
        },
      };
      const result = transformContentTypesToFilterDimensions(raw);
      expect(result).to.deep.equal([
        { id: 'other', label: 'Other' },
        { id: 'social', label: 'Social' },
        { id: 'earned', label: 'Earned' },
        { id: 'owned', label: 'Owned' },
        { id: 'benchmark_competitors', label: 'Benchmark Competitors' },
      ]);
    });
  });
});
