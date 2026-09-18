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
import {
  RAW_SENTIMENT_WEEK,
  SENTIMENT_MENTIONS_TOTAL,
  SENTIMENT_PROMPTS_TOTAL,
  SENTIMENT_MENTIONS_PCT,
  SENTIMENT_PROMPTS_PCT,
  SENTIMENT_MENTION_COUNTS,
  SENTIMENT_PROMPT_COUNTS,
} from '../fixtures/sentiment-overview.js';

// Locates the CBF_project value inside the advanced filter tree (it sits in its own
// `or` block, like the CBF_model block), or returns undefined if absent (including when
// the whole `advanced` block is omitted).
function findProjectFilterVal(payload) {
  const blocks = payload.filters.advanced?.filters ?? [];
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
      expect(buildSentimentOverviewPayload({ projectId: 'proj-1' }).filters.advanced.op).to.equal('and');
    });

    // Semrush 422s on `advanced: { op: 'and', filters: [] }` — it is NOT treated as
    // "match all". Verified live 2026-09-02 against SENTIMENT (f4153af8): empty AND → 422,
    // key omitted → 200. This is the Overview-SR default view (all platforms, no region,
    // no category), so the empty case is reachable in production.
    it('omits the advanced block entirely when there is nothing to filter on', () => {
      const payload = buildSentimentOverviewPayload();
      expect(payload.filters).to.not.have.property('advanced');
      expect(payload.auto_bucketing).to.equal('week');
    });

    it('omits the CBF_model filter when the model is absent (All Platforms aggregate)', () => {
      const payload = buildSentimentOverviewPayload({ projectId: 'proj-1' });
      const hasModel = payload.filters.advanced.filters.some(
        (f) => f.filters?.some((sub) => sub.col === 'CBF_model'),
      );
      expect(hasModel).to.equal(false);
      // no model and no category → project scoping is the only advanced filter left
      expect(payload.filters.advanced.filters).to.deep.equal([
        { op: 'or', filters: [{ op: 'eq', val: 'proj-1', col: 'CBF_project' }] },
      ]);
    });

    it('still emits the advanced block when only a category applies (all-platforms, no region)', () => {
      const payload = buildSentimentOverviewPayload({ platform: 'all', category: 'category__Paint' });
      expect(payload.filters.advanced).to.deep.equal({
        op: 'and',
        filters: [{ op: 'eq', val: 'category__Paint', col: 'CBF_tags' }],
      });
    });

    it("omits the CBF_model filter for the explicit 'all' sentinel, keeping project scoping", () => {
      const payload = buildSentimentOverviewPayload({ platform: 'all', projectId: 'proj-1' });
      const hasModel = payload.filters.advanced.filters.some(
        (f) => f.filters?.some((sub) => sub.col === 'CBF_model'),
      );
      expect(hasModel).to.equal(false);
      expect(findProjectFilterVal(payload)).to.equal('proj-1');
    });

    it('translates a UI platform code to the Semrush model in a CBF_model or-block', () => {
      const modelBlock = buildSentimentOverviewPayload({ model: 'openai' }).filters.advanced.filters[0];
      expect(modelBlock.op).to.equal('or');
      expect(modelBlock.filters[0].col).to.equal('CBF_model');
      expect(modelBlock.filters[0].val).to.equal('chatgpt-paid');
    });

    it('includes CBF_project (in an or-block) when projectId is provided', () => {
      expect(findProjectFilterVal(buildSentimentOverviewPayload({ projectId: 'proj-42' })))
        .to.equal('proj-42');
    });

    it('omits CBF_project when projectId is not provided', () => {
      expect(findProjectFilterVal(buildSentimentOverviewPayload())).to.be.undefined;
    });

    it('ORs multiple projectIds together into a single CBF_project filter', () => {
      const payload = buildSentimentOverviewPayload({ projectIds: ['proj-a', 'proj-b'] });
      const projectBlock = payload.filters.advanced.filters.find(
        (f) => Array.isArray(f.filters) && f.filters.some((inner) => inner.col === 'CBF_project'),
      );
      expect(projectBlock).to.deep.equal({
        op: 'or',
        filters: [
          { op: 'eq', val: 'proj-a', col: 'CBF_project' },
          { op: 'eq', val: 'proj-b', col: 'CBF_project' },
        ],
      });
    });

    it('omits CBF_project when projectIds is an empty array (falls back to projectId)', () => {
      const payload = buildSentimentOverviewPayload({ projectIds: [] });
      expect(findProjectFilterVal(payload)).to.be.undefined;
    });

    it('prefers projectIds over projectId when both are given', () => {
      const payload = buildSentimentOverviewPayload({ projectId: 'ignored', projectIds: ['proj-a'] });
      expect(findProjectFilterVal(payload)).to.equal('proj-a');
    });

    it('pushes the category tag onto CBF_tags as-is when category is provided', () => {
      const payload = buildSentimentOverviewPayload({ category: 'category__travel' });
      const tagFilter = payload.filters.advanced.filters
        .find((f) => f.col === 'CBF_tags');
      expect(tagFilter).to.deep.include({ op: 'eq', val: 'category__travel', col: 'CBF_tags' });
    });

    // Brand scoping (LLMO-7456). The sub-workspace alone does NOT scope to the brand — it
    // also holds the brand's tracked competitors — so without CBF_brand the element blends
    // them into the sentiment counts. Verified live: brand "au", week 2026-08-23, 319/345/16
    // with the filter vs 507/585/66 without it.
    describe('brand scoping (CBF_brand)', () => {
      const findBrandFilter = (payload) => (payload.filters.advanced?.filters ?? [])
        .find((f) => f.col === 'CBF_brand');

      it('sends CBF_brand as a bare eq when brandName is provided', () => {
        const payload = buildSentimentOverviewPayload({ brandName: 'au' });
        expect(findBrandFilter(payload)).to.deep.equal({ op: 'eq', val: 'au', col: 'CBF_brand' });
      });

      it('uses CBF_brand, not CBF_ws_brand', () => {
        const payload = buildSentimentOverviewPayload({ brandName: 'au' });
        expect(payload.filters.advanced.filters.some((f) => f.col === 'CBF_ws_brand')).to.equal(false);
      });

      it('omits CBF_brand when brandName is not provided', () => {
        expect(findBrandFilter(buildSentimentOverviewPayload({ projectId: 'proj-1' }))).to.be.undefined;
      });

      // A whitespace-only name must NOT be forwarded: `CBF_brand: "   "` matches no brand
      // and silently zeroes the counts, which is indistinguishable from a real "no
      // sentiment". Note `hasText` does not trim, so it would not catch this.
      it('treats a blank or whitespace-only brandName as absent', () => {
        expect(findBrandFilter(buildSentimentOverviewPayload({ brandName: '', projectId: 'p' }))).to.be.undefined;
        expect(findBrandFilter(buildSentimentOverviewPayload({ brandName: '   ', projectId: 'p' }))).to.be.undefined;
      });

      it('ignores a non-string brandName', () => {
        expect(findBrandFilter(buildSentimentOverviewPayload({ brandName: 42, projectId: 'p' }))).to.be.undefined;
      });

      it('trims a padded brandName before sending it', () => {
        const payload = buildSentimentOverviewPayload({ brandName: '  au  ' });
        expect(findBrandFilter(payload)).to.deep.equal({ op: 'eq', val: 'au', col: 'CBF_brand' });
      });

      // Guards the documented empty-AND → HTTP 422 behaviour: a whitespace-only brand must
      // not be the thing that keeps an otherwise-empty advanced block alive.
      it('still omits the advanced block when a whitespace brandName is the only input', () => {
        expect(buildSentimentOverviewPayload({ brandName: '   ' }).filters).to.not.have.property('advanced');
      });

      it('emits the advanced block when brandName is the only filter', () => {
        const payload = buildSentimentOverviewPayload({ brandName: 'au' });
        expect(payload.filters.advanced).to.deep.equal({
          op: 'and',
          filters: [{ op: 'eq', val: 'au', col: 'CBF_brand' }],
        });
      });

      it('coexists with the model, project and category filters', () => {
        const payload = buildSentimentOverviewPayload({
          model: 'openai',
          brandName: 'au',
          projectId: 'proj-1',
          category: 'category__Paint',
        });
        expect(payload.filters.advanced.filters).to.deep.equal([
          { op: 'or', filters: [{ op: 'eq', val: 'chatgpt-paid', col: 'CBF_model' }] },
          { op: 'eq', val: 'au', col: 'CBF_brand' },
          { op: 'or', filters: [{ op: 'eq', val: 'proj-1', col: 'CBF_project' }] },
          { op: 'eq', val: 'category__Paint', col: 'CBF_tags' },
        ]);
      });

      // Guards the merge of LLMO-7456 (brandName) with the faceted-tag work, which added
      // tagPaths to this same signature: both must survive and be emitted together.
      it('coexists with faceted tagPaths', () => {
        const payload = buildSentimentOverviewPayload({
          brandName: 'au',
          tagPaths: ['category__Paint', 'type__branded'],
        });
        expect(findBrandFilter(payload)).to.deep.equal({ op: 'eq', val: 'au', col: 'CBF_brand' });
        expect(payload.filters.advanced.filters).to.deep.include.members([
          { op: 'or', filters: [{ op: 'eq', val: 'category__Paint', col: 'CBF_tags' }] },
          { op: 'or', filters: [{ op: 'eq', val: 'type__branded', col: 'CBF_tags' }] },
        ]);
      });
    });
  });

  describe('transformSentimentOverviewResponse', () => {
    it('returns an empty weeklyTrends for a missing/empty response', () => {
      const empty = { metric: 'prompts', weeklyTrends: [] };
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

    // The `metric` switch (LLMO-7457). The fixture below is a REAL bucket captured from
    // the live element (brand "au", week starting 2026-08-16), whose numbers the Semrush
    // MFE tooltip rendered as Negative 1% / 7, Neutral 56% / 571, Positive 43% / 443.
    describe('metric switch (prompts vs mentions)', () => {
      const rawWeek = RAW_SENTIMENT_WEEK;
      const pctOf = (wk) => Object.fromEntries(wk.sentiment.map((s) => [s.name, s.value]));

      it('defaults to prompts when no metric is given (unchanged behaviour)', () => {
        const res = transformSentimentOverviewResponse(rawWeek);
        expect(res.metric).to.equal('prompts');
        expect(pctOf(res.weeklyTrends[0])).to.deep.equal(SENTIMENT_PROMPTS_PCT);
        expect(res.weeklyTrends[0].sentimentTotal).to.equal(SENTIMENT_PROMPTS_TOTAL);
      });

      it('reproduces the live MFE tooltip percentages when metric is mentions', () => {
        const res = transformSentimentOverviewResponse(rawWeek, { metric: 'mentions' });
        expect(res.metric).to.equal('mentions');
        // Exactly what the MFE showed for this bucket.
        expect(pctOf(res.weeklyTrends[0])).to.deep.equal(SENTIMENT_MENTIONS_PCT);
        expect(res.weeklyTrends[0].sentimentTotal).to.equal(SENTIMENT_MENTIONS_TOTAL);
      });

      it('normalises a padded/upper-case metric (shared with the controller)', () => {
        const res = transformSentimentOverviewResponse(rawWeek, { metric: '  MENTIONS  ' });
        expect(res.metric).to.equal('mentions');
        expect(res.weeklyTrends[0].sentimentTotal).to.equal(SENTIMENT_MENTIONS_TOTAL);
      });

      it('falls back to prompts for an unrecognised or blank metric', () => {
        for (const metric of ['bogus', '', null, undefined, 42]) {
          const res = transformSentimentOverviewResponse(rawWeek, { metric });
          expect(res.metric, `metric=${metric}`).to.equal('prompts');
          expect(res.weeklyTrends[0].sentimentTotal, `metric=${metric}`)
            .to.equal(SENTIMENT_PROMPTS_TOTAL);
        }
      });

      it('returns BOTH count sets regardless of the selected metric', () => {
        for (const metric of ['prompts', 'mentions']) {
          const [wk] = transformSentimentOverviewResponse(rawWeek, { metric }).weeklyTrends;
          expect(wk.mentionCounts, `metric=${metric}`).to.deep.equal(SENTIMENT_MENTION_COUNTS);
          expect(wk.promptCounts, `metric=${metric}`).to.deep.equal(SENTIMENT_PROMPT_COUNTS);
        }
      });

      // These two must not change meaning when the metric flips, or existing consumers
      // would silently start reading a different quantity under the same field name.
      it('keeps promptsWithSentiment and totalPrompts prompt-based under either metric', () => {
        for (const metric of ['prompts', 'mentions']) {
          const [wk] = transformSentimentOverviewResponse(rawWeek, { metric }).weeklyTrends;
          expect(wk.promptsWithSentiment, `metric=${metric}`).to.equal(SENTIMENT_PROMPTS_TOTAL);
          expect(wk.totalPrompts, `metric=${metric}`).to.equal(275);
        }
      });

      it('still emits percentages summing to 100 under mentions', () => {
        const [wk] = transformSentimentOverviewResponse(rawWeek, { metric: 'mentions' }).weeklyTrends;
        const total = wk.sentiment.reduce((sum, s) => sum + s.value, 0);
        expect(total).to.equal(100);
      });

      it('zeroes percentages for a week with no sentiment under either metric', () => {
        const emptyWeek = { blocks: { data: [], line: [{ bar: '2026-08-16', value: 0 }] } };
        for (const metric of ['prompts', 'mentions']) {
          const [wk] = transformSentimentOverviewResponse(emptyWeek, { metric }).weeklyTrends;
          expect(pctOf(wk), `metric=${metric}`)
            .to.deep.equal({ Positive: 0, Neutral: 0, Negative: 0 });
          expect(wk.sentimentTotal, `metric=${metric}`).to.equal(0);
        }
      });

      // The zero case above has BOTH sets empty. This is the asymmetric shape: the
      // SELECTED basis is zero while the other is not — what an upstream `value`
      // regression would look like, and what the controller's warn log keys on.
      it('zeroes percentages when only the selected basis is empty', () => {
        const mentionsMissing = {
          blocks: {
            data: [
              {
                bar: '2026-08-16', legend: 'Positive', value: 0, value__prompts: 165,
              },
              {
                bar: '2026-08-16', legend: 'Neutral', value: 0, value__prompts: 208,
              },
            ],
            line: [{ bar: '2026-08-16', value: 275 }],
          },
        };
        const [asMentions] = transformSentimentOverviewResponse(mentionsMissing, { metric: 'mentions' }).weeklyTrends;
        expect(pctOf(asMentions)).to.deep.equal({ Positive: 0, Neutral: 0, Negative: 0 });
        expect(asMentions.sentimentTotal).to.equal(0);
        // The other set is intact, which is exactly what makes this diagnosable.
        expect(asMentions.promptCounts).to.deep.equal({ positive: 165, neutral: 208, negative: 0 });

        const [asPrompts] = transformSentimentOverviewResponse(mentionsMissing, { metric: 'prompts' }).weeklyTrends;
        expect(asPrompts.sentimentTotal).to.equal(373);
      });

      it('coerces a non-numeric mention value to 0 rather than NaN', () => {
        const dirty = {
          blocks: {
            data: [
              {
                bar: '2026-08-16', legend: 'Positive', value: 'N/A', value__prompts: 10,
              },
              {
                bar: '2026-08-16', legend: 'Neutral', value: 30, value__prompts: 10,
              },
            ],
            line: [{ bar: '2026-08-16', value: 20 }],
          },
        };
        const [wk] = transformSentimentOverviewResponse(dirty, { metric: 'mentions' }).weeklyTrends;
        expect(wk.mentionCounts).to.deep.equal({ positive: 0, neutral: 30, negative: 0 });
        expect(wk.sentimentTotal).to.equal(30);
        expect(pctOf(wk)).to.deep.equal({ Positive: 0, Neutral: 100, Negative: 0 });
      });

      // The absorb branch: independent rounding of positive and negative can sum to
      // 101, which would make the neutral remainder negative. Exercised on the
      // mention path, which previously had no case for it.
      it('clamps neutral to 0 on the mention path when rounding overflows to 101', () => {
        const split = {
          blocks: {
            data: [
              {
                bar: '2026-08-16', legend: 'Positive', value: 101, value__prompts: 1,
              },
              {
                bar: '2026-08-16', legend: 'Negative', value: 99, value__prompts: 1,
              },
            ],
            line: [{ bar: '2026-08-16', value: 200 }],
          },
        };
        const [wk] = transformSentimentOverviewResponse(split, { metric: 'mentions' }).weeklyTrends;
        const pct = pctOf(wk);
        expect(pct.Neutral).to.equal(0);
        expect(pct.Positive + pct.Neutral + pct.Negative).to.equal(100);
        expect(pct.Positive).to.be.at.least(pct.Negative);
      });
    });
  });
});
