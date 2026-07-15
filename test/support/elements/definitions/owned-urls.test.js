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

/*
 * Contract tests for the owned-urls element definition (LLMO-6086 POC, previously
 * c8-ignored). transformOwnedUrlsResponse merges per-project Stats-per-URL + trend
 * responses into the URL Inspector `owned-urls` row shape: owned-only filtering,
 * cross-project citation summing, region collection, and weekly-citation rollup.
 */

import { expect } from 'chai';
import {
  buildOwnedUrlsStatsPayload,
  buildOwnedUrlsTrendPayload,
  transformOwnedUrlsResponse,
} from '../../../../src/support/elements/definitions/owned-urls.js';

const project = ({ region, data = [], lines = [] }) => ({
  region,
  stats: { blocks: { data } },
  trend: { blocks: { lines } },
});
const statsRow = (o = {}) => ({
  source: 'https://a.com/p', domain_type: 'Owned', citations: 10, prompts_with_citation: 2, ...o,
});

describe('owned-urls definition', () => {
  describe('build payloads', () => {
    for (const [name, build] of [
      ['buildOwnedUrlsStatsPayload', buildOwnedUrlsStatsPayload],
      ['buildOwnedUrlsTrendPayload', buildOwnedUrlsTrendPayload],
    ]) {
      it(`${name}: encodes model, dates, category tag and projectId`, () => {
        const payload = build({
          platform: 'openai', startDate: '2026-03-01', endDate: '2026-03-31', category: 'Firefly', projectId: 'proj-1',
        });
        expect(payload.project_id).to.equal('proj-1');
        expect(payload.filters.simple).to.deep.equal({ CBF_date__start: '2026-03-01', CBF_date__end: '2026-03-31' });
        const adv = payload.filters.advanced.filters;
        expect(adv.find((f) => f.op === 'or').filters[0]).to.deep.equal({ op: 'eq', val: 'gpt-5', col: 'CBF_model' });
        expect(adv).to.deep.include({ op: 'eq', val: 'category:Firefly', col: 'CBF_tags' });
      });

      it(`${name}: omits projectId and category tag when not provided`, () => {
        const payload = build({ startDate: '2026-03-01', endDate: '2026-03-31' });
        expect(payload).to.not.have.property('project_id');
        expect(payload.filters.advanced.filters.some((f) => f.col === 'CBF_tags')).to.equal(false);
      });
    }
  });

  describe('transformOwnedUrlsResponse', () => {
    it('maps an owned URL to the full URL Inspector row shape', () => {
      const result = transformOwnedUrlsResponse([
        project({
          region: 'US',
          data: [statsRow()],
          lines: [{ legend: 'https://a.com/p', x: '2026-03-15', y__mentions: 4 }],
        }),
      ]);
      expect(result).to.deep.equal([{
        urlId: '',
        url: 'https://a.com/p',
        citations: 10,
        promptsCited: 2,
        products: [],
        regions: ['US'],
        weeklyCitations: [{ week: '2026-W11', value: 4 }],
        weeklyPromptsCited: [],
        agenticHits: 0,
        agenticHitsTrend: [],
        referralHits: 0,
        referralHitsTrend: [],
      }]);
    });

    it('sums citations/prompts and merges regions for the same URL across projects', () => {
      const result = transformOwnedUrlsResponse([
        project({ region: 'US', data: [statsRow({ citations: 10, prompts_with_citation: 2 })] }),
        project({ region: 'EU', data: [statsRow({ citations: 5, prompts_with_citation: 1, domain_type: 'owned' })] }),
      ]);
      expect(result[0]).to.include({ citations: 15, promptsCited: 3 });
      expect(result[0].regions).to.have.members(['US', 'EU']);
    });

    it('keeps only domain_type "owned" (case-insensitive) rows', () => {
      const result = transformOwnedUrlsResponse([
        project({
          region: 'US',
          data: [
            statsRow({ source: 'https://a.com/owned', domain_type: 'Owned' }),
            statsRow({ source: 'https://a.com/other', domain_type: 'Other', citations: 999 }),
            statsRow({ source: 'https://a.com/none', domain_type: undefined, citations: 999 }),
          ],
        }),
      ]);
      expect(result.map((u) => u.url)).to.deep.equal(['https://a.com/owned']);
    });

    it('skips null-source rows and coerces non-numeric metrics to 0', () => {
      const result = transformOwnedUrlsResponse([
        project({
          region: 'US',
          data: [
            statsRow({ source: null }),
            {
              source: 'https://a.com/x', domain_type: 'Owned', citations: 'nope', prompts_with_citation: undefined,
            },
          ],
        }),
      ]);
      expect(result).to.have.length(1);
      expect(result[0]).to.include({ url: 'https://a.com/x', citations: 0, promptsCited: 0 });
    });

    it('rolls trend lines into weekly citations (summed per week, sorted ascending) for kept URLs only', () => {
      const result = transformOwnedUrlsResponse([
        project({
          region: 'US',
          data: [statsRow({ source: 'https://a.com/p' })],
          lines: [
            { legend: 'https://a.com/p', x: '2026-03-15', y__mentions: 4 }, // W11
            { legend: 'https://a.com/p', x: '2026-03-10', y__mentions: 1 }, // W11 → summed
            { legend: 'https://a.com/p', x: '2026-03-02', y__mentions: 6 }, // W10
            { legend: 'https://not-kept.com/p', x: '2026-03-15', y__mentions: 99 }, // url not kept
            { legend: null, x: '2026-03-15', y__mentions: 1 }, // null legend
            { legend: 'https://a.com/p', x: 12345, y__mentions: 1 }, // non-string x
          ],
        }),
      ]);
      expect(result[0].weeklyCitations).to.deep.equal([
        { week: '2026-W10', value: 6 },
        { week: '2026-W11', value: 5 },
      ]);
    });

    it('sorts URLs by citations descending', () => {
      const result = transformOwnedUrlsResponse([
        project({
          region: 'US',
          data: [
            statsRow({ source: 'https://a.com/low', citations: 10 }),
            statsRow({ source: 'https://a.com/high', citations: 90 }),
            statsRow({ source: 'https://a.com/mid', citations: 50 }),
          ],
        }),
      ]);
      expect(result.map((u) => u.url)).to.deep.equal([
        'https://a.com/high', 'https://a.com/mid', 'https://a.com/low',
      ]);
    });

    it('coerces non-numeric trend values to 0', () => {
      const result = transformOwnedUrlsResponse([
        project({
          region: 'US',
          data: [statsRow({ source: 'https://a.com/p' })],
          lines: [{ legend: 'https://a.com/p', x: '2026-03-15', y__mentions: 'nope' }],
        }),
      ]);
      expect(result[0].weeklyCitations).to.deep.equal([{ week: '2026-W11', value: 0 }]);
    });

    it('tolerates projects missing stats/trend blocks and null rows in the data array', () => {
      const result = transformOwnedUrlsResponse([
        { region: 'US', stats: {}, trend: {} }, // no blocks → both loops fall back to []
        project({ region: 'US', data: [null, statsRow({ source: 'https://a.com/keep' })] }),
      ]);
      expect(result.map((u) => u.url)).to.deep.equal(['https://a.com/keep']);
    });

    it('returns an empty regions array when a project has no region', () => {
      const result = transformOwnedUrlsResponse([project({ data: [statsRow()] })]);
      expect(result[0].regions).to.deep.equal([]);
    });

    it('returns [] for empty input', () => {
      expect(transformOwnedUrlsResponse()).to.deep.equal([]);
      expect(transformOwnedUrlsResponse([project({ region: 'US' })])).to.deep.equal([]);
    });
  });
});
