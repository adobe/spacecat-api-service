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
import { transformMarketTrackingTrends } from '../../../../src/support/elements/definitions/market-tracking-trends.js';

describe('market-tracking-trends definitions', () => {
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
  });
});
