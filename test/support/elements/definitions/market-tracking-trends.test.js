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
  buildMarketMentionsTrendPayload,
  buildMarketCitationsTrendPayload,
  transformMarketTrackingTrends,
} from '../../../../src/support/elements/definitions/market-tracking-trends.js';
import { resolveElementModel } from '../../../../src/support/elements/constants.js';
import { dateToIsoWeek } from '../../../../src/support/elements/week-utils.js';

const START = '2026-06-16';
const END = '2026-07-15';

describe('market-tracking-trends definitions', () => {
  describe('buildMarketMentionsTrendPayload', () => {
    it('builds a weekly-bucketed payload scoped by CBF_project (singular)', () => {
      const payload = buildMarketMentionsTrendPayload({
        model: 'search-gpt', startDate: START, endDate: END, projectIds: ['p1', 'p2'],
      });
      expect(payload.auto_bucketing).to.equal('week');
      expect(payload.filters.simple).to.deep.equal({ start_date: START, end_date: END });
      expect(payload.filters.advanced.op).to.equal('and');
      const [modelBlock, projectBlock] = payload.filters.advanced.filters;
      expect(modelBlock).to.deep.equal({
        op: 'or',
        filters: [{ op: 'eq', val: resolveElementModel('search-gpt'), col: 'CBF_model' }],
      });
      expect(projectBlock).to.deep.equal({
        op: 'or',
        filters: [
          { op: 'eq', val: 'p1', col: 'CBF_project' },
          { op: 'eq', val: 'p2', col: 'CBF_project' },
        ],
      });
    });

    it('never sends comparison_data_formatting (the trend elements omit it)', () => {
      const payload = buildMarketMentionsTrendPayload({
        startDate: START, endDate: END, projectIds: ['p1'],
      });
      expect(payload).to.not.have.property('comparison_data_formatting');
    });

    it('falls back to the default model and honors the platform alias', () => {
      const payload = buildMarketMentionsTrendPayload({
        platform: 'perplexity', startDate: START, endDate: END, projectIds: ['p1'],
      });
      const [modelBlock] = payload.filters.advanced.filters;
      expect(modelBlock.filters[0].val).to.equal(resolveElementModel('perplexity'));
    });

    it('omits the project filter block when no projectIds are given', () => {
      const payload = buildMarketMentionsTrendPayload({ startDate: START, endDate: END });
      expect(payload.filters.advanced.filters).to.have.length(1);
      expect(payload.filters.advanced.filters[0].filters[0].col).to.equal('CBF_model');
    });
  });

  describe('buildMarketCitationsTrendPayload', () => {
    it('is identical to the mentions payload except CBF_projects (plural)', () => {
      const payload = buildMarketCitationsTrendPayload({
        model: 'search-gpt', startDate: START, endDate: END, projectIds: ['p1', 'p2'],
      });
      expect(payload.auto_bucketing).to.equal('week');
      const [, projectBlock] = payload.filters.advanced.filters;
      expect(projectBlock.filters.every((f) => f.col === 'CBF_projects')).to.equal(true);
    });
  });

  describe('transformMarketTrackingTrends', () => {
    // Synthetic data shaped like the MFE response: `legend` = brand/competitor NAME,
    // `y__mentions` holds mentions in the mentions element and citations in the citations one.
    const mentionsRaw = {
      type: 'line',
      blocks: {
        lines: [
          {
            legend: 'Acme', x: '2026-07-05T00:00:00Z', y__mentions: 900, y__visibility: 0.51,
          },
          { legend: 'Rival One', x: '2026-07-05T00:00:00Z', y__mentions: 150 },
          { legend: 'Acme', x: '2026-07-12T00:00:00Z', y__mentions: 1000 },
        ],
      },
    };
    const citationsRaw = {
      type: 'line',
      blocks: {
        lines: [
          { legend: 'Acme', x: '2026-07-05T00:00:00Z', y__mentions: 5000 },
          { legend: 'Rival One', x: '2026-07-05T00:00:00Z', y__mentions: 300 },
          // Appears only in citations for its week — mentions must default to 0.
          { legend: 'Rival Two', x: '2026-07-12T00:00:00Z', y__mentions: 400 },
        ],
      },
    };

    it('merges mentions + citations per week and splits brand from competitors', () => {
      const result = transformMarketTrackingTrends(mentionsRaw, citationsRaw, 'Acme');
      expect(result).to.have.length(2);

      const [w1, w2] = result;
      const iso1 = dateToIsoWeek('2026-07-05').split('-W');
      expect(w1).to.deep.equal({
        week: '2026-07-05',
        year: Number.parseInt(iso1[0], 10),
        weekNumber: Number.parseInt(iso1[1], 10),
        mentions: 900,
        citations: 5000,
        competitors: [{ name: 'Rival One', mentions: 150, citations: 300 }],
      });
      // Rival Two appears only in citations that week → mentions defaults to 0;
      // Acme has no citation line that week → its citations default to 0.
      expect(w2.week).to.equal('2026-07-12');
      expect(w2.mentions).to.equal(1000);
      expect(w2.citations).to.equal(0);
      expect(w2.competitors).to.deep.equal([{ name: 'Rival Two', mentions: 0, citations: 400 }]);
    });

    it('sorts weeks ascending and competitors by mentions desc', () => {
      const raw = {
        blocks: {
          lines: [
            { legend: 'Acme', x: '2026-07-05T00:00:00Z', y__mentions: 10 },
            { legend: 'Small', x: '2026-07-05T00:00:00Z', y__mentions: 5 },
            { legend: 'Big', x: '2026-07-05T00:00:00Z', y__mentions: 50 },
          ],
        },
      };
      const [week] = transformMarketTrackingTrends(raw, { blocks: { lines: [] } }, 'Acme');
      expect(week.competitors.map((c) => c.name)).to.deep.equal(['Big', 'Small']);
    });

    it('matches the brand legend case-insensitively', () => {
      const raw = { blocks: { lines: [{ legend: 'ACME', x: '2026-07-05T00:00:00Z', y__mentions: 7 }] } };
      const [week] = transformMarketTrackingTrends(raw, { blocks: { lines: [] } }, 'acme');
      expect(week.mentions).to.equal(7);
      expect(week.competitors).to.deep.equal([]);
    });

    it('coerces a non-numeric value to 0 rather than NaN', () => {
      const raw = { blocks: { lines: [{ legend: 'Acme', x: '2026-07-05T00:00:00Z', y__mentions: 'oops' }] } };
      const [week] = transformMarketTrackingTrends(raw, { blocks: { lines: [] } }, 'Acme');
      expect(week.mentions).to.equal(0);
    });

    it('skips malformed lines (missing legend or non-string x) and empty responses', () => {
      const raw = {
        blocks: {
          lines: [
            { x: '2026-07-05T00:00:00Z', y__mentions: 1 }, // no legend
            { legend: 'Rival One', x: 20260705, y__mentions: 2 }, // non-string x
            null,
          ],
        },
      };
      expect(transformMarketTrackingTrends(raw, undefined, 'Acme')).to.deep.equal([]);
      expect(transformMarketTrackingTrends(undefined, undefined, 'Acme')).to.deep.equal([]);
    });
  });
});
