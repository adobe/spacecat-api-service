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

import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * Response transformer backing `GET .../brand-presence/competitor-summary` — the
 * lightweight aggregate-totals equivalent of `market-tracking-trends.js` used by the
 * Overview Competitor Comparison bar chart. Reuses the SAME two Semrush elements
 * (TRENDS_MV mentions + MARKET_CITATIONS_TREND citations, fetched by the service via
 * `buildMarketMentionsTrendPayload`/`buildMarketCitationsTrendPayload` from
 * `market-tracking-trends.js` — no new Semrush query shape), but sums every row into
 * one totals-per-competitor entry instead of a weekly series, matching the Postgres
 * `competitor-summary` endpoint's lightweight `{ competitors: [{ name, mentions,
 * citations }] }` contract (see `CompetitorSummaryResponse` in
 * project-elmo-ui's brandPresencePgApi.ts) rather than the heavier
 * `market-tracking-trends` weekly-breakdown shape.
 *
 * @param {object} mentionsRaw - Raw TRENDS_MV response.
 * @param {object} citationsRaw - Raw MARKET_CITATIONS_TREND response.
 * @param {string} brandName - Tracked brand's display name (matches its `legend`;
 *   excluded from the returned competitor list).
 * @returns {{ competitors: Array<{ name: string, mentions: number, citations: number }> }}
 */
export function transformCompetitorSummary(mentionsRaw, citationsRaw, brandName) {
  const wantedBrand = String(brandName ?? '').trim().toLowerCase();
  const totalsByName = new Map();

  const ensureCompetitor = (name) => {
    let entry = totalsByName.get(name);
    if (!entry) {
      entry = { name, mentions: 0, citations: 0 };
      totalsByName.set(name, entry);
    }
    return entry;
  };

  const accumulate = (raw, metric) => {
    for (const line of (raw?.blocks?.lines ?? [])) {
      if (!line || !hasText(line.legend)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (line.legend.trim().toLowerCase() === wantedBrand) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // `Number(x) || 0` (not `?? 0`) so a non-numeric value coerces to 0, not NaN.
      const value = Number(line.y__mentions) || 0;
      ensureCompetitor(line.legend)[metric] += value;
    }
  };

  accumulate(mentionsRaw, 'mentions');
  accumulate(citationsRaw, 'citations');

  return {
    competitors: [...totalsByName.values()].sort((a, b) => b.mentions - a.mentions),
  };
}
