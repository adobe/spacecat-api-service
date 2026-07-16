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

import { resolveElementModel } from '../constants.js';
import { dateToIsoWeek } from '../week-utils.js';

// Legacy default window is a rolling 28 days (see defaultDateRange in
// llmo-brand-presence.js). Kept inline here so this definition stays pure and does
// not import controller code (support/elements must never depend on controllers).
const DEFAULT_WINDOW_DAYS = 28;

// Legacy sentiment swatch colors (llmo-brand-presence.js SENTIMENT_COLORS). Duplicated
// here — not imported — because support/elements must never depend on controllers, and
// the legacy value is a stable contract the UI keys off. Keep in sync with the legacy
// controller (a drift test would be nice; deferred with the rest of this POC's tests).
const SENTIMENT_COLORS = {
  positive: '#047857',
  neutral: '#4B5563',
  negative: '#B91C1C',
};

/* c8 ignore start -- LLMO-6300 POC endpoint; unit tests intentionally deferred */
function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - DEFAULT_WINDOW_DAYS);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

/**
 * Builds the payload for the Sentiment element
 * (f4153af8-6ce9-4058-8872-8a3cf11b9907, "powers rows 13 daily / 14 weekly Sentiment").
 *
 * Filter shape mirrors the Cited Domains element exactly (verified canonical for these
 * brand-presence elements — see cited-domains.js):
 *  - The date range is expressed as `CBF_date__start`/`CBF_date__end` and passed in BOTH
 *    the `simple` and `advanced` blocks — the element expects the duplication.
 *  - `CBF_model` sits inside an `or` block within `advanced`.
 *  - `category` (when present) → the namespaced tag `category__<label>` on `CBF_tags`.
 *  - Region scoping is the top-level `project_id` (NOT a CBF filter — ignored otherwise).
 *  - Brand scoping is NOT a filter (`CBF_ws_brand` is a no-op); it comes from the request
 *    targeting the brand's sub-workspace (resolved in the controller).
 *
 * @param {object} [params]
 * @param {string} [params.model] - AI model filter value (Semrush engine name or UI
 *   platform code). Translated + validated via {@link resolveElementModel}.
 * @param {string} [params.platform] - Legacy alias for `model`; `model` takes precedence.
 * @param {string} [params.startDate] - ISO date (YYYY-MM-DD). Defaults to 28 days ago.
 * @param {string} [params.endDate] - ISO date (YYYY-MM-DD). Defaults to today.
 * @param {string} [params.category] - Category label, pushed as the tag `category__<label>`.
 * @param {string} [params.projectId] - Semrush project id for region scoping (top-level).
 */
export function buildSentimentOverviewPayload({
  model, platform, startDate, endDate, category, projectId,
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);
  const defaults = defaultDateRange();
  const start = startDate || defaults.startDate;
  const end = endDate || defaults.endDate;

  const advancedFilters = [
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
    { op: 'gte', val: start, col: 'CBF_date__start' },
    { op: 'lte', val: end, col: 'CBF_date__end' },
  ];
  if (category) {
    advancedFilters.push({ op: 'eq', val: `category__${category}`, col: 'CBF_tags' });
  }

  return {
    ...(projectId && { project_id: projectId }),
    comparison_data_formatting: 'union',
    filters: {
      simple: { CBF_date__start: start, CBF_date__end: end },
      advanced: { op: 'and', filters: advancedFilters },
    },
  };
}

/**
 * Parses `YYYY-Wnn` into its numeric parts, mirroring the legacy toISOWeek return
 * (`{ weekNumber, year }`). Returns zeros for a malformed string.
 */
function parseIsoWeekParts(weekStr) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekStr);
  if (!match) {
    return { weekNumber: 0, year: 0 };
  }
  return { year: Number.parseInt(match[1], 10), weekNumber: Number.parseInt(match[2], 10) };
}

const SENTIMENT_BUCKETS = ['positive', 'neutral', 'negative'];

// Guard against a non-date `bar` value (e.g. a metadata / "N/A" row from the upstream
// element): an invalid day slices to junk that dateToIsoWeek turns into a "NaN-WNaN"
// key, which would surface as a phantom weeklyTrends entry (weekNumber/year 0). Only a
// real YYYY-MM-DD prefix is allowed through.
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function isoDayOf(bar) {
  const day = typeof bar === 'string' ? bar.slice(0, 10) : '';
  return YMD_RE.test(day) ? day : null;
}

/**
 * Transforms the raw Sentiment element response into the legacy Brand Presence
 * `sentiment-overview` contract so the sentiment chart is drop-in compatible:
 *   { weeklyTrends: [{ week, weekNumber, year,
 *       sentiment: [{ name, value, color } x Positive/Neutral/Negative],
 *       totalPrompts, promptsWithSentiment, mentions, citations,
 *       visibilityScore, competitors }] }
 * ordered oldest-first (matches the legacy aggregateSentimentByWeek sort).
 *
 * VERIFIED ELEMENT SHAPE (probed live on dev, workspace 3cbb3c36…, 2026-07-16):
 *   { type: 'bar', blocks: {
 *       data: [{ bar: '<ISO day>', legend: 'Positive'|'Neutral'|'Negative',
 *                value: <mentions>, value__prompts: <prompts> }],   // one row per (day × legend)
 *       line: [{ bar: '<ISO day>', value: <total prompts that day> }],
 *   } }
 * The element returns DAILY rows (this is the "row 13 daily" payload); we roll them
 * up into ISO weeks here (the "row 14 weekly" view the chart wants). Field mapping:
 *   positive/neutral/negative prompt counts ← Σ `value__prompts` per legend over the week
 *   totalPrompts                            ← Σ `blocks.line[].value` over the week's days
 *   mentions/citations/visibilityScore/competitors — stubbed 0/[] (as in the legacy handler)
 *
 * WIKI DISCREPANCY / SEMANTIC NOTE: the three legends are OVERLAPPING sets, not a
 * partition — a prompt with mixed-sentiment mentions is counted in every legend it
 * appears in. So Σ(value__prompts across legends) for a day (~1318 in the probe)
 * EXCEEDS blocks.line for that day (~750 total prompts). Consequences:
 *   - `promptsWithSentiment` is defined as positive+neutral+negative (the legacy
 *     invariant in aggregateSentimentByWeek where the three counts sum to it), so it
 *     can exceed `totalPrompts`. Do NOT compute promptsWithSentiment/totalPrompts as a
 *     coverage ratio in the UI — it can exceed 100%. (Flag for the UI-wiring follow-up.)
 *   - The sentiment PERCENTAGES are internal ratios of the three legend counts and are
 *     unaffected by this overlap; they are the chart's load-bearing content.
 * Percentages are computed exactly as the legacy handler: round positive & negative,
 * neutral = 100 − positive − negative (so the three always sum to 100).
 *
 * @param {object} raw - Raw response from the Sentiment element.
 * @returns {{ weeklyTrends: Array<object> }}
 */
export function transformSentimentOverviewResponse(raw) {
  const rows = Array.isArray(raw?.blocks?.data) ? raw.blocks.data : [];
  const lineRows = Array.isArray(raw?.blocks?.line) ? raw.blocks.line : [];

  // week -> { positive, neutral, negative, totalPrompts }
  const weekMap = new Map();
  const ensureWeek = (week) => {
    if (!weekMap.has(week)) {
      weekMap.set(week, {
        positive: 0, neutral: 0, negative: 0, totalPrompts: 0,
      });
    }
    return weekMap.get(week);
  };

  rows.forEach((row) => {
    const day = isoDayOf(row?.bar);
    const bucket = typeof row?.legend === 'string' ? row.legend.toLowerCase().trim() : '';
    if (!day || !SENTIMENT_BUCKETS.includes(bucket)) {
      return;
    }
    const week = dateToIsoWeek(day);
    // `Number(x) || 0` (not `?? 0`) so a non-numeric value coerces to 0, not NaN.
    ensureWeek(week)[bucket] += Number(row.value__prompts) || 0;
  });

  // The total-prompts line is a separate per-day series; fold it into the same weeks.
  lineRows.forEach((row) => {
    const day = isoDayOf(row?.bar);
    if (!day) {
      return;
    }
    ensureWeek(dateToIsoWeek(day)).totalPrompts += Number(row.value) || 0;
  });

  const weeklyTrends = [...weekMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, entry]) => {
      const { weekNumber, year } = parseIsoWeekParts(week);
      const promptsWithSentiment = entry.positive + entry.neutral + entry.negative;
      const positivePct = promptsWithSentiment > 0
        ? Math.round((entry.positive / promptsWithSentiment) * 100) : 0;
      const negativePct = promptsWithSentiment > 0
        ? Math.round((entry.negative / promptsWithSentiment) * 100) : 0;
      // Clamp to 0: independent rounding of positive & negative can push their sum
      // over 100 (e.g. 50.5→51 and 49.5→50), which would make the remainder negative
      // and violate the schema's 0-100 contract. 0 is the correct floor for the UI.
      const neutralPct = promptsWithSentiment > 0
        ? Math.max(0, 100 - positivePct - negativePct) : 0;

      return {
        week,
        weekNumber,
        year,
        sentiment: [
          { name: 'Positive', value: positivePct, color: SENTIMENT_COLORS.positive },
          { name: 'Neutral', value: neutralPct, color: SENTIMENT_COLORS.neutral },
          { name: 'Negative', value: negativePct, color: SENTIMENT_COLORS.negative },
        ],
        totalPrompts: entry.totalPrompts,
        promptsWithSentiment,
        mentions: 0,
        citations: 0,
        visibilityScore: 0,
        competitors: [],
      };
    });

  return { weeklyTrends };
}

export { SENTIMENT_COLORS };
/* c8 ignore stop */
