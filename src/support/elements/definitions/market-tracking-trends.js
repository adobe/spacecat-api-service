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
import { resolveElementModel } from '../constants.js';
import { dateToIsoWeek } from '../week-utils.js';

/**
 * Payload builders + response transformer backing
 * `GET .../brand-presence/market-tracking-trends` — the Competitor Comparison chart
 * and the Overview-SR KPI cards (LLMO-6515) on the `brand-presence-sr-ui` dashboard.
 * See docs/elements/market-tracking-trends-plan.md for the full design + the live
 * MFE capture this file is modelled on.
 *
 * Two `line` elements power it, both returning one weekly series per market
 * participant keyed by `legend` = brand/competitor NAME (competitors arrive natively
 * as tracked Semrush benchmarks; there is NO brand filter — that is what keeps the
 * competitor legends in the response):
 *   - TRENDS_MV (b5281393), project filter col `CBF_project` (singular) — a
 *     multi-value element carrying `y__mentions` (mention count), `y__sov` (share of
 *     voice) and `y__visibility` (brand visibility = prompts_mentioned /
 *     total_num_prompts) per row.
 *   - MARKET_CITATIONS_TREND (2e5a6f4e), project filter col `CBF_projects` (plural)
 *     — carries `y__mentions` (⚠️ the CITATION count, not mentions — Semrush reuses
 *     the generic field name) and `y__visibility` (source visibility =
 *     prompts_with_mentions / total_prompts).
 *
 * `y__sov`/`y__visibility` are only meaningful for the tracked brand's own row (the
 * legend matching `brandName`); competitor rows only ever surface mentions/citations.
 */

/* c8 ignore start -- market-tracking-trends payload builders; unit tests intentionally deferred */
/**
 * Builds the weekly-bucketed payload for a market-tracking trend `line` element.
 * Shape verified against the live MFE: top-level `auto_bucketing: "week"`, plain
 * `start_date`/`end_date` in `simple`, and `advanced` = model (in an `or` block) +
 * an `or` block of project ids under `projectCol`. No brand filter, no
 * `comparison_data_formatting` (the MFE omits it for these elements).
 *
 * @param {object} params
 * @param {string} [params.model] - AI model (Semrush engine or UI platform code).
 * @param {string} [params.platform] - Legacy alias for `model`; `model` wins.
 * @param {string} params.startDate - ISO date (YYYY-MM-DD).
 * @param {string} params.endDate - ISO date (YYYY-MM-DD).
 * @param {string[]} [params.projectIds] - Semrush project UUIDs to OR together. A
 *   single selected region → one id; the aggregate "all regions" view → every project
 *   the brand owns. Empty → no project scoping (workspace-wide).
 * @param {string} params.projectCol - `CBF_project` (mentions) or `CBF_projects` (citations).
 * @returns {object} Elements API request payload.
 */
function buildMarketTrendPayload({
  model, platform, startDate, endDate, projectIds = [], projectCol,
}) {
  const resolvedModel = resolveElementModel(model || platform);
  const advancedFilters = [
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
  ];
  if (Array.isArray(projectIds) && projectIds.length > 0) {
    advancedFilters.push({
      op: 'or',
      filters: projectIds.map((val) => ({ op: 'eq', val, col: projectCol })),
    });
  }
  return {
    auto_bucketing: 'week',
    filters: {
      simple: { start_date: startDate, end_date: endDate },
      advanced: { op: 'and', filters: advancedFilters },
    },
  };
}

/**
 * Weekly mentions trend (TRENDS_MV) — project scope via `CBF_project` (singular col).
 * @param {object} params - See {@link buildMarketTrendPayload}.
 */
export function buildMarketMentionsTrendPayload(params = {}) {
  return buildMarketTrendPayload({ ...params, projectCol: 'CBF_project' });
}

/**
 * Weekly citations trend (MARKET_CITATIONS_TREND) — project scope via `CBF_projects`
 * (plural col — the one field this element differs from mentions on).
 * @param {object} params - See {@link buildMarketTrendPayload}.
 */
export function buildMarketCitationsTrendPayload(params = {}) {
  return buildMarketTrendPayload({ ...params, projectCol: 'CBF_projects' });
}
/* c8 ignore stop */

/**
 * Merges the mentions + citations `line` responses into the weekly Competitor
 * Comparison shape, enriched with the tracked brand's Share of Voice / Brand
 * Visibility / Source Visibility rate metrics (LLMO-6515). Both elements are already
 * weekly-bucketed (`auto_bucketing:week`), so each `blocks.lines[]` row is
 * `{ legend: name, x: weekStartIso, y__mentions: N, y__sov: N, y__visibility: N }`;
 * `y__mentions` is the mention count in the mentions response and the citation count
 * in the citations response. Rows are grouped by week (the `x` date, YYYY-MM-DD); the
 * tracked brand's own line (`legend === brandName`, case-insensitive) becomes the
 * week's top-level `mentions`/`citations`/`shareOfVoice`/`brandVisibility`/
 * `sourceVisibility`, every other legend becomes a `competitors[]` entry carrying only
 * `mentions`/`citations` (unchanged). A field a legend/element doesn't carry defaults
 * to 0.
 *
 * @param {object} mentionsRaw - Raw TRENDS_MV response (mentions, share of voice,
 *   brand visibility).
 * @param {object} citationsRaw - Raw MARKET_CITATIONS_TREND response (citations,
 *   source visibility).
 * @param {string} brandName - Tracked brand's display name (matches its `legend`).
 * @returns {Array<object>} weeklyTrends sorted ascending by week.
 */
export function transformMarketTrackingTrends(mentionsRaw, citationsRaw, brandName) {
  const wantedBrand = String(brandName ?? '').trim().toLowerCase();
  const weeks = new Map();

  const ensureWeek = (week) => {
    let bucket = weeks.get(week);
    if (!bucket) {
      bucket = {
        week,
        mentions: 0,
        citations: 0,
        shareOfVoice: 0,
        brandVisibility: 0,
        sourceVisibility: 0,
        competitors: new Map(),
      };
      weeks.set(week, bucket);
    }
    return bucket;
  };
  const ensureCompetitor = (bucket, name) => {
    let comp = bucket.competitors.get(name);
    if (!comp) {
      comp = { name, mentions: 0, citations: 0 };
      bucket.competitors.set(name, comp);
    }
    return comp;
  };

  // `brandFields` maps this element's raw `y__*` keys to the brand-only weekly
  // fields they populate — competitor rows never get these (only mentions/citations).
  const accumulate = (raw, metric, brandFields = {}) => {
    for (const line of (raw?.blocks?.lines ?? [])) {
      if (!line || !hasText(line.legend) || typeof line.x !== 'string') {
        // eslint-disable-next-line no-continue
        continue;
      }
      const week = line.x.slice(0, 10);
      // Only bucket well-formed `YYYY-MM-DD` week starts — a malformed upstream date
      // can't derive a valid ISO week, so skip it rather than emit null weekNumber/year.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const bucket = ensureWeek(week);
      // `Number(x) || 0` (not `?? 0`) so a non-numeric value coerces to 0, not NaN.
      const value = Number(line.y__mentions) || 0;
      if (line.legend.trim().toLowerCase() === wantedBrand) {
        bucket[metric] += value;
        for (const [field, rawKey] of Object.entries(brandFields)) {
          bucket[field] += Number(line[rawKey]) || 0;
        }
      } else {
        ensureCompetitor(bucket, line.legend)[metric] += value;
      }
    }
  };

  accumulate(mentionsRaw, 'mentions', { shareOfVoice: 'y__sov', brandVisibility: 'y__visibility' });
  accumulate(citationsRaw, 'citations', { sourceVisibility: 'y__visibility' });

  return [...weeks.values()]
    .map((bucket) => {
      const [year, weekNumber] = dateToIsoWeek(bucket.week).split('-W');
      return {
        week: bucket.week,
        weekNumber: Number.parseInt(weekNumber, 10),
        year: Number.parseInt(year, 10),
        mentions: bucket.mentions,
        citations: bucket.citations,
        shareOfVoice: bucket.shareOfVoice,
        brandVisibility: bucket.brandVisibility,
        sourceVisibility: bucket.sourceVisibility,
        competitors: [...bucket.competitors.values()]
          .sort((a, b) => b.mentions - a.mentions),
      };
    })
    .sort((a, b) => a.week.localeCompare(b.week));
}
