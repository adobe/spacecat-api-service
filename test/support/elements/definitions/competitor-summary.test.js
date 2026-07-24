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
import { transformCompetitorSummary } from '../../../../src/support/elements/definitions/competitor-summary.js';

describe('competitor-summary definitions', () => {
  describe('transformCompetitorSummary', () => {
    it('sums mentions and citations per competitor across multiple weekly rows', () => {
      const mentionsRaw = {
        blocks: {
          lines: [
            { legend: 'Acme', x: '2026-03-01', y__mentions: 10 },
            { legend: 'Acme', x: '2026-03-08', y__mentions: 15 },
            { legend: 'Globex', x: '2026-03-01', y__mentions: 5 },
          ],
        },
      };
      const citationsRaw = {
        blocks: {
          lines: [
            { legend: 'Acme', x: '2026-03-01', y__mentions: 40 },
            { legend: 'Globex', x: '2026-03-01', y__mentions: 8 },
          ],
        },
      };
      const { competitors } = transformCompetitorSummary(mentionsRaw, citationsRaw, 'OurBrand');
      expect(competitors).to.deep.equal([
        { name: 'Acme', mentions: 25, citations: 40 },
        { name: 'Globex', mentions: 5, citations: 8 },
      ]);
    });

    it('excludes the tracked brand itself, case-insensitively', () => {
      const mentionsRaw = {
        blocks: {
          lines: [
            { legend: 'OurBrand', x: '2026-03-01', y__mentions: 100 },
            { legend: 'Acme', x: '2026-03-01', y__mentions: 10 },
          ],
        },
      };
      const { competitors } = transformCompetitorSummary(mentionsRaw, undefined, '  ourbrand  ');
      expect(competitors).to.deep.equal([{ name: 'Acme', mentions: 10, citations: 0 }]);
    });

    it('sorts competitors by mentions descending', () => {
      const mentionsRaw = {
        blocks: {
          lines: [
            { legend: 'Small', x: '2026-03-01', y__mentions: 3 },
            { legend: 'Big', x: '2026-03-01', y__mentions: 30 },
            { legend: 'Medium', x: '2026-03-01', y__mentions: 15 },
          ],
        },
      };
      const { competitors } = transformCompetitorSummary(mentionsRaw, undefined, 'OurBrand');
      expect(competitors.map((c) => c.name)).to.deep.equal(['Big', 'Medium', 'Small']);
    });

    it('treats a missing brandName as excluding nothing (no legend can match an empty string)', () => {
      const mentionsRaw = {
        blocks: {
          lines: [{ legend: 'Acme', x: '2026-03-01', y__mentions: 10 }],
        },
      };
      const { competitors } = transformCompetitorSummary(mentionsRaw, undefined, undefined);
      expect(competitors).to.deep.equal([{ name: 'Acme', mentions: 10, citations: 0 }]);
    });

    it('returns an empty competitors array for missing/empty blocks.lines on both inputs', () => {
      expect(transformCompetitorSummary(undefined, undefined, 'OurBrand')).to.deep.equal({ competitors: [] });
      expect(transformCompetitorSummary({ blocks: {} }, { blocks: { lines: [] } }, 'OurBrand'))
        .to.deep.equal({ competitors: [] });
    });

    it('skips rows with no legend and coerces a non-numeric y__mentions to 0, not NaN', () => {
      const mentionsRaw = {
        blocks: {
          lines: [
            { legend: null, x: '2026-03-01', y__mentions: 10 },
            { legend: 'Acme', x: '2026-03-01', y__mentions: 'not-a-number' },
          ],
        },
      };
      const { competitors } = transformCompetitorSummary(mentionsRaw, undefined, 'OurBrand');
      expect(competitors).to.deep.equal([{ name: 'Acme', mentions: 0, citations: 0 }]);
    });

    it('reuses the same y__mentions field for citations (citations element response encodes its metric under that key too)', () => {
      const citationsRaw = {
        blocks: {
          lines: [{ legend: 'Acme', x: '2026-03-01', y__mentions: 42 }],
        },
      };
      const { competitors } = transformCompetitorSummary(undefined, citationsRaw, 'OurBrand');
      expect(competitors).to.deep.equal([{ name: 'Acme', mentions: 0, citations: 42 }]);
    });
  });
});
