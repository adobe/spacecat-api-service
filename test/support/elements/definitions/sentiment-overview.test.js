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
  buildSentimentOverviewPayload,
  transformSentimentOverviewResponse,
  SENTIMENT_COLORS,
} from '../../../../src/support/elements/definitions/sentiment-overview.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

// Locates the CBF_project value inside the advanced filter tree (it sits in its own
// `or` block, like the CBF_model block), or returns undefined if absent.
function findProjectFilterVal(payload) {
  const blocks = payload.filters.advanced.filters;
  for (const block of blocks) {
    const inner = Array.isArray(block.filters) ? block.filters : [];
    const hit = inner.find((f) => f.col === 'CBF_project');
    if (hit) {
      return hit.val;
    }
  }
  return undefined;
}

describe('sentiment-overview definitions', () => {
  describe('buildSentimentOverviewPayload', () => {
    it('requests weekly server-side bucketing', () => {
      expect(buildSentimentOverviewPayload().auto_bucketing).to.equal('week');
    });

    it('sends the date range via filters.simple.start_date / end_date (not CBF_date__*)', () => {
      const payload = buildSentimentOverviewPayload({
        startDate: '2026-03-01',
        endDate: '2026-03-28',
      });
      expect(payload.filters.simple.start_date).to.equal('2026-03-01');
      expect(payload.filters.simple.end_date).to.equal('2026-03-28');
      // The element ignores the Cited Domains convention — it must NOT be sent.
      expect(payload.filters.simple).to.not.have.property('CBF_date__start');
      expect(payload.filters.simple).to.not.have.property('CBF_date__end');
    });

    it('does not carry the removed Cited-Domains-isms (top-level project_id / comparison_data_formatting)', () => {
      const payload = buildSentimentOverviewPayload({ projectId: 'proj-1' });
      expect(payload).to.not.have.property('project_id');
      expect(payload).to.not.have.property('comparison_data_formatting');
    });

    it('uses an AND operator over the advanced filters', () => {
      expect(buildSentimentOverviewPayload().filters.advanced.op).to.equal('and');
    });

    it('defaults the model to DEFAULT_ELEMENT_MODEL in a CBF_model or-block', () => {
      const modelBlock = buildSentimentOverviewPayload().filters.advanced.filters[0];
      expect(modelBlock.op).to.equal('or');
      expect(modelBlock.filters[0].col).to.equal('CBF_model');
      expect(modelBlock.filters[0].val).to.equal(DEFAULT_ELEMENT_MODEL);
    });

    it('translates a UI platform code to the Semrush model', () => {
      const modelBlock = buildSentimentOverviewPayload({ model: 'openai' }).filters.advanced.filters[0];
      expect(modelBlock.filters[0].val).to.equal('chatgpt-paid');
    });

    it('includes CBF_project (in an or-block) when projectId is provided', () => {
      expect(findProjectFilterVal(buildSentimentOverviewPayload({ projectId: 'proj-42' })))
        .to.equal('proj-42');
    });

    it('omits CBF_project when projectId is not provided', () => {
      expect(findProjectFilterVal(buildSentimentOverviewPayload())).to.be.undefined;
    });

    it('pushes a namespaced category tag onto CBF_tags when category is provided', () => {
      const payload = buildSentimentOverviewPayload({ category: 'travel' });
      const tagFilter = payload.filters.advanced.filters
        .find((f) => f.col === 'CBF_tags');
      expect(tagFilter).to.deep.include({ op: 'eq', val: 'category__travel', col: 'CBF_tags' });
    });
  });

  describe('transformSentimentOverviewResponse', () => {
    it('returns an empty weeklyTrends for a missing/empty response', () => {
      const empty = { weeklyTrends: [] };
      expect(transformSentimentOverviewResponse(undefined)).to.deep.equal(empty);
      expect(transformSentimentOverviewResponse({ blocks: {} })).to.deep.equal(empty);
    });

    it('maps a weekly bucket to its ISO week with percentages summing to 100', () => {
      const raw = {
        type: 'bar',
        blocks: {
          data: [
            {
              bar: '2026-03-15', legend: 'Positive', value: 10, value__prompts: 60,
            },
            {
              bar: '2026-03-15', legend: 'Neutral', value: 5, value__prompts: 30,
            },
            {
              bar: '2026-03-15', legend: 'Negative', value: 3, value__prompts: 20,
            },
          ],
          line: [{ bar: '2026-03-15', value: 80 }],
        },
      };
      const { weeklyTrends } = transformSentimentOverviewResponse(raw);
      expect(weeklyTrends).to.have.length(1);
      const [wk] = weeklyTrends;
      expect(wk.week).to.equal('2026-W11');
      const byName = Object.fromEntries(wk.sentiment.map((s) => [s.name, s.value]));
      expect(byName.Positive + byName.Neutral + byName.Negative).to.equal(100);
      expect(byName.Positive).to.equal(55); // 60/110 -> 54.5 -> 55
      expect(byName.Negative).to.equal(18); // 20/110 -> 18.18 -> 18
      expect(wk.sentiment[0].color).to.equal(SENTIMENT_COLORS.positive);
    });

    it('keeps overlapping-legend promptsWithSentiment above the distinct totalPrompts', () => {
      const raw = {
        blocks: {
          data: [
            {
              bar: '2026-03-15', legend: 'Positive', value: 1, value__prompts: 60,
            },
            {
              bar: '2026-03-15', legend: 'Neutral', value: 1, value__prompts: 30,
            },
            {
              bar: '2026-03-15', legend: 'Negative', value: 1, value__prompts: 20,
            },
          ],
          line: [{ bar: '2026-03-15', value: 80 }],
        },
      };
      const [wk] = transformSentimentOverviewResponse(raw).weeklyTrends;
      expect(wk.totalPrompts).to.equal(80);
      expect(wk.promptsWithSentiment).to.equal(110);
    });

    it('clamps neutral to 0 when independent rounding pushes positive+negative to 101', () => {
      const raw = {
        blocks: {
          data: [
            {
              bar: '2026-03-15', legend: 'Positive', value: 1, value__prompts: 101,
            },
            {
              bar: '2026-03-15', legend: 'Negative', value: 1, value__prompts: 99,
            },
          ],
          line: [{ bar: '2026-03-15', value: 200 }],
        },
      };
      const [wk] = transformSentimentOverviewResponse(raw).weeklyTrends;
      const byName = Object.fromEntries(wk.sentiment.map((s) => [s.name, s.value]));
      expect(byName.Neutral).to.equal(0);
      expect(byName.Positive).to.be.at.least(0);
      expect(byName.Negative).to.be.at.least(0);
      expect(byName.Positive + byName.Neutral + byName.Negative).to.equal(100);
    });

    it('orders multiple weeks oldest-first', () => {
      const raw = {
        blocks: {
          data: [
            {
              bar: '2026-03-15', legend: 'Positive', value: 1, value__prompts: 20,
            },
            {
              bar: '2026-03-08', legend: 'Positive', value: 1, value__prompts: 10,
            },
          ],
          line: [
            { bar: '2026-03-15', value: 20 },
            { bar: '2026-03-08', value: 10 },
          ],
        },
      };
      const { weeklyTrends } = transformSentimentOverviewResponse(raw);
      expect(weeklyTrends.map((w) => w.week)).to.deep.equal(['2026-W10', '2026-W11']);
    });

    it('drops rows with a non-date bar so no phantom week is emitted', () => {
      const raw = {
        blocks: {
          data: [
            {
              bar: 'N/A', legend: 'Positive', value: 1, value__prompts: 5,
            },
            {
              bar: '2026-03-15', legend: 'Positive', value: 1, value__prompts: 10,
            },
          ],
          line: [{ bar: '2026-03-15', value: 10 }],
        },
      };
      const { weeklyTrends } = transformSentimentOverviewResponse(raw);
      expect(weeklyTrends).to.have.length(1);
      expect(weeklyTrends[0].week).to.equal('2026-W11');
      expect(weeklyTrends.some((w) => /NaN/.test(w.week))).to.be.false;
    });
  });
});
