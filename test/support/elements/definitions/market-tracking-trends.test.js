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
  transformMarketTrackingTrends,
  buildMarketMentionsTrendPayload,
  buildMarketCitationsTrendPayload,
} from '../../../../src/support/elements/definitions/market-tracking-trends.js';

// Returns the CBF_model value inside the advanced filter tree, or undefined if absent
// (including when the whole `advanced` block is omitted).
function findModelVal(payload) {
  for (const block of payload.filters.advanced?.filters ?? []) {
    const hit = Array.isArray(block.filters)
      ? block.filters.find((f) => f.col === 'CBF_model')
      : undefined;
    if (hit) {
      return hit.val;
    }
  }
  return undefined;
}

describe('market-tracking-trends definitions', () => {
  describe('buildMarketMentionsTrendPayload / buildMarketCitationsTrendPayload', () => {
    const range = { startDate: '2026-07-01', endDate: '2026-07-28' };

    it('scopes mentions to CBF_project (singular) and citations to CBF_projects (plural)', () => {
      const mentions = buildMarketMentionsTrendPayload({ ...range, model: 'search-gpt', projectIds: ['p1'] });
      const citations = buildMarketCitationsTrendPayload({ ...range, model: 'search-gpt', projectIds: ['p1'] });
      expect(mentions.auto_bucketing).to.equal('week');
      expect(mentions.filters.advanced.filters).to.deep.include({
        op: 'or', filters: [{ op: 'eq', val: 'p1', col: 'CBF_project' }],
      });
      expect(citations.filters.advanced.filters).to.deep.include({
        op: 'or', filters: [{ op: 'eq', val: 'p1', col: 'CBF_projects' }],
      });
    });

    it('adds a CBF_model or-block for a concrete model (single-model path)', () => {
      const payload = buildMarketMentionsTrendPayload({ ...range, model: 'openai', projectIds: ['p1'] });
      expect(findModelVal(payload)).to.equal('chatgpt-paid');
    });

    it('omits the CBF_model filter when the model/platform is absent (All Platforms aggregate)', () => {
      const payload = buildMarketMentionsTrendPayload({ ...range, projectIds: ['p1'] });
      expect(findModelVal(payload)).to.be.undefined;
      // project scoping is preserved
      expect(payload.filters.advanced.filters).to.deep.equal([
        { op: 'or', filters: [{ op: 'eq', val: 'p1', col: 'CBF_project' }] },
      ]);
    });

    it("omits the CBF_model filter for the explicit 'all' sentinel", () => {
      const payload = buildMarketCitationsTrendPayload({ ...range, platform: 'all', projectIds: ['p1'] });
      expect(findModelVal(payload)).to.be.undefined;
    });

    // Semrush 422s on `advanced: { op: 'and', filters: [] }` — it is NOT treated as
    // "match all". Verified live 2026-09-02 against TRENDS_MV (b5281393) and
    // MARKET_CITATIONS_TREND (2e5a6f4e): empty AND → 422, key omitted → 200.
    it('omits the advanced block entirely for the mentions element (all-platforms, no region)', () => {
      const payload = buildMarketMentionsTrendPayload({ ...range, platform: 'all' });
      expect(payload.filters).to.not.have.property('advanced');
      expect(payload.filters.simple).to.deep.equal({
        start_date: '2026-07-01', end_date: '2026-07-28',
      });
    });

    it('omits the advanced block entirely for the citations element (all-platforms, no region)', () => {
      const payload = buildMarketCitationsTrendPayload({ ...range, platform: 'all' });
      expect(payload.filters).to.not.have.property('advanced');
      expect(payload.filters.simple).to.deep.equal({
        start_date: '2026-07-01', end_date: '2026-07-28',
      });
    });

    it('omits the advanced block when both the model and projectIds are absent', () => {
      const payload = buildMarketMentionsTrendPayload({ ...range, projectIds: [] });
      expect(payload.filters).to.not.have.property('advanced');
    });

    it('still emits the advanced block when only a region applies (all-platforms)', () => {
      const payload = buildMarketMentionsTrendPayload({ ...range, platform: 'all', projectIds: ['p1'] });
      expect(payload.filters.advanced).to.deep.equal({
        op: 'and',
        filters: [{ op: 'or', filters: [{ op: 'eq', val: 'p1', col: 'CBF_project' }] }],
      });
    });
  });

  describe('transformMarketTrackingTrends', () => {
    it('adds shareOfVoice/brandVisibility (from mentions) and sourceVisibility (from citations) for the tracked brand row', () => {
      const mentionsRaw = {
        blocks: {
          lines: [
            {
              legend: 'OurBrand', x: '2026-07-05', y__mentions: 900, y__sov: 0.42, y__visibility: 0.61,
            },
          ],
        },
      };
      const citationsRaw = {
        blocks: {
          lines: [
            {
              legend: 'OurBrand', x: '2026-07-05', y__mentions: 5000, y__visibility: 0.33,
            },
          ],
        },
      };
      const [week] = transformMarketTrackingTrends(mentionsRaw, citationsRaw, 'OurBrand');
      expect(week).to.deep.include({
        mentions: 900,
        citations: 5000,
        shareOfVoice: 0.42,
        brandVisibility: 0.61,
        sourceVisibility: 0.33,
      });
    });

    it('defaults shareOfVoice/brandVisibility/sourceVisibility to 0 when the raw fields are absent', () => {
      const mentionsRaw = {
        blocks: { lines: [{ legend: 'OurBrand', x: '2026-07-05', y__mentions: 900 }] },
      };
      const citationsRaw = {
        blocks: { lines: [{ legend: 'OurBrand', x: '2026-07-05', y__mentions: 5000 }] },
      };
      const [week] = transformMarketTrackingTrends(mentionsRaw, citationsRaw, 'OurBrand');
      expect(week).to.deep.include({
        shareOfVoice: 0,
        brandVisibility: 0,
        sourceVisibility: 0,
      });
    });

    it('does not add shareOfVoice/brandVisibility/sourceVisibility to competitor rows', () => {
      const mentionsRaw = {
        blocks: {
          lines: [
            {
              legend: 'OurBrand', x: '2026-07-05', y__mentions: 900, y__sov: 0.42, y__visibility: 0.61,
            },
            {
              legend: 'Rival One', x: '2026-07-05', y__mentions: 150, y__sov: 0.1, y__visibility: 0.2,
            },
          ],
        },
      };
      const citationsRaw = {
        blocks: {
          lines: [
            {
              legend: 'Rival One', x: '2026-07-05', y__mentions: 300, y__visibility: 0.5,
            },
          ],
        },
      };
      const [week] = transformMarketTrackingTrends(mentionsRaw, citationsRaw, 'OurBrand');
      expect(week.competitors).to.deep.equal([{ name: 'Rival One', mentions: 150, citations: 300 }]);
    });

    it('keeps existing mentions/citations/competitors behavior unchanged (backward compatible)', () => {
      const mentionsRaw = {
        blocks: {
          lines: [
            { legend: 'OurBrand', x: '2026-07-05', y__mentions: 900 },
            { legend: 'Rival One', x: '2026-07-05', y__mentions: 150 },
            { legend: 'Rival Two', x: '2026-07-05', y__mentions: 120 },
          ],
        },
      };
      const citationsRaw = {
        blocks: {
          lines: [
            { legend: 'OurBrand', x: '2026-07-05', y__mentions: 5000 },
            { legend: 'Rival One', x: '2026-07-05', y__mentions: 300 },
          ],
        },
      };
      const result = transformMarketTrackingTrends(mentionsRaw, citationsRaw, 'OurBrand');
      expect(result).to.deep.equal([
        {
          week: '2026-07-05',
          weekNumber: 27,
          year: 2026,
          mentions: 900,
          citations: 5000,
          shareOfVoice: 0,
          brandVisibility: 0,
          sourceVisibility: 0,
          competitors: [
            { name: 'Rival One', mentions: 150, citations: 300 },
            { name: 'Rival Two', mentions: 120, citations: 0 },
          ],
        },
      ]);
    });

    it('matches the brand row case-insensitively and trims whitespace', () => {
      const mentionsRaw = {
        blocks: {
          lines: [{
            legend: '  OurBrand  ', x: '2026-07-05', y__mentions: 900, y__sov: 0.5, y__visibility: 0.7,
          }],
        },
      };
      const [week] = transformMarketTrackingTrends(mentionsRaw, undefined, '  ourbrand  ');
      expect(week).to.deep.include({ shareOfVoice: 0.5, brandVisibility: 0.7 });
    });

    it('groups multiple weeks and sorts ascending, each carrying its own rate metrics', () => {
      const mentionsRaw = {
        blocks: {
          lines: [
            {
              legend: 'OurBrand', x: '2026-07-12', y__mentions: 100, y__sov: 0.2, y__visibility: 0.3,
            },
            {
              legend: 'OurBrand', x: '2026-07-05', y__mentions: 900, y__sov: 0.42, y__visibility: 0.61,
            },
          ],
        },
      };
      const result = transformMarketTrackingTrends(mentionsRaw, undefined, 'OurBrand');
      expect(result.map((w) => w.week)).to.deep.equal(['2026-07-05', '2026-07-12']);
      expect(result[0]).to.deep.include({ shareOfVoice: 0.42, brandVisibility: 0.61 });
      expect(result[1]).to.deep.include({ shareOfVoice: 0.2, brandVisibility: 0.3 });
    });

    it('returns an empty array for missing/empty blocks.lines on both inputs', () => {
      expect(transformMarketTrackingTrends(undefined, undefined, 'OurBrand')).to.deep.equal([]);
      expect(transformMarketTrackingTrends({ blocks: {} }, { blocks: { lines: [] } }, 'OurBrand'))
        .to.deep.equal([]);
    });

    it('skips rows with no legend or a non-string x', () => {
      const mentionsRaw = {
        blocks: {
          lines: [
            { legend: null, x: '2026-07-05', y__mentions: 900 },
            { legend: 'OurBrand', x: 12345, y__mentions: 900 },
            {
              legend: 'OurBrand', x: '2026-07-05', y__mentions: 900, y__sov: 0.4,
            },
          ],
        },
      };
      const result = transformMarketTrackingTrends(mentionsRaw, undefined, 'OurBrand');
      expect(result).to.have.lengthOf(1);
      expect(result[0]).to.deep.include({ mentions: 900, shareOfVoice: 0.4 });
    });

    it('skips rows whose x is not a well-formed YYYY-MM-DD week start', () => {
      const mentionsRaw = {
        blocks: {
          lines: [
            { legend: 'OurBrand', x: 'not-a-date', y__mentions: 900 },
            {
              legend: 'OurBrand', x: '2026-07-05', y__mentions: 900, y__sov: 0.4,
            },
          ],
        },
      };
      const result = transformMarketTrackingTrends(mentionsRaw, undefined, 'OurBrand');
      expect(result).to.have.lengthOf(1);
      expect(result[0].week).to.equal('2026-07-05');
    });

    it('coerces a non-numeric y__mentions to 0, not NaN', () => {
      const mentionsRaw = {
        blocks: { lines: [{ legend: 'OurBrand', x: '2026-07-05', y__mentions: 'not-a-number' }] },
      };
      const [week] = transformMarketTrackingTrends(mentionsRaw, undefined, 'OurBrand');
      expect(week.mentions).to.equal(0);
    });

    it('treats a missing brandName as excluding nothing (no legend can match an empty string)', () => {
      const mentionsRaw = {
        blocks: { lines: [{ legend: 'Acme', x: '2026-07-05', y__mentions: 10 }] },
      };
      const [week] = transformMarketTrackingTrends(mentionsRaw, undefined, undefined);
      expect(week.competitors).to.deep.equal([{ name: 'Acme', mentions: 10, citations: 0 }]);
    });

    it('uses the last row\'s value (not a sum) when the brand appears twice for the same week', () => {
      const mentionsRaw = {
        blocks: {
          lines: [
            { legend: 'OurBrand', x: '2026-07-05', y__sov: 0.3 },
            { legend: 'OurBrand', x: '2026-07-05', y__sov: 0.7 },
          ],
        },
      };
      const [week] = transformMarketTrackingTrends(mentionsRaw, undefined, 'OurBrand');
      expect(week.shareOfVoice).to.equal(0.7);
    });

    it('clamps an out-of-range rate field into [0,1]', () => {
      const mentionsRaw = {
        blocks: {
          lines: [{
            legend: 'OurBrand', x: '2026-07-05', y__sov: 1.4, y__visibility: -0.2,
          }],
        },
      };
      const [week] = transformMarketTrackingTrends(mentionsRaw, undefined, 'OurBrand');
      expect(week).to.deep.include({ shareOfVoice: 1, brandVisibility: 0 });
    });
  });
});
