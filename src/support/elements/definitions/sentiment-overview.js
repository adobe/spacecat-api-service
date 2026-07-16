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
// Defensive default only: the controller requires + validates startDate/endDate
// before calling the service, so this fallback is not reached via the HTTP path. It
// is retained for parity with the sibling definitions (e.g. cited-domains.js).
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
 * CONTRACT VERIFIED against the legacy Semrush MFE (which hits this SAME element) — it
 * differs from Cited Domains, so an earlier CBF_date-based payload was silently ignored:
 *  - Date range → `filters.simple.start_date` / `filters.simple.end_date` (YYYY-MM-DD).
 *    This element does NOT read `CBF_date__start`/`CBF_date__end` (Cited Domains' convention);
 *    sending those made it fall back to a fixed ~45-day window, ignoring the requested range.
 *  - `auto_bucketing` controls server-side time bucketing (`day`|`week`|`month`). We request
 *    `week` so the element returns weekly buckets within the range — no client-side daily
 *    rollup, and the date range is honored upstream.
 *  - `CBF_model` sits inside an `or` block within `advanced`.
 *  - Region scoping → `CBF_project` (Semrush project id) inside an `or` block within
 *    `advanced` (NOT a top-level `project_id`, which this element ignores).
 *  - `category` (when present) → the namespaced tag `category__<label>` on `CBF_tags`.
 *  - Brand scoping comes from the request targeting the brand's sub-workspace (resolved in
 *    the controller); the MFE also passes `CBF_brand` (name), but the sub-workspace already
 *    scopes to the brand, so we don't duplicate it here.
 *
 * @param {object} [params]
 * @param {string} [params.model] - AI model filter value (Semrush engine name or UI
 *   platform code). Translated + validated via {@link resolveElementModel}.
 * @param {string} [params.platform] - Legacy alias for `model`; `model` takes precedence.
 * @param {string} [params.startDate] - ISO date (YYYY-MM-DD). Defaults to 28 days ago.
 * @param {string} [params.endDate] - ISO date (YYYY-MM-DD). Defaults to today.
 * @param {string} [params.category] - Category label, pushed as the tag `category__<label>`.
 * @param {string} [params.projectId] - Semrush project id for region scoping (as `CBF_project`).
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
  ];
  // Region: this element scopes by CBF_project (a Semrush project id), NOT a top-level
  // project_id. Resolved from the UI region code by the controller (via the Markets element).
  if (projectId) {
    advancedFilters.push({ op: 'or', filters: [{ op: 'eq', val: projectId, col: 'CBF_project' }] });
  }
  if (category) {
    advancedFilters.push({ op: 'eq', val: `category__${category}`, col: 'CBF_tags' });
  }

  return {
    auto_bucketing: 'week',
    filters: {
      simple: { start_date: start, end_date: end },
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
 * VERIFIED ELEMENT SHAPE (probed live on dev + the legacy Semrush MFE, 2026-07-16):
 *   { type: 'bar', blocks: {
 *       data: [{ bar: '<ISO week-start>', legend: 'Positive'|'Neutral'|'Negative',
 *                value: <mentions>, value__prompts: <prompts> }],  // one row per (week × legend)
 *       line: [{ bar: '<ISO week-start>', value: <total prompts that week> }],
 *   } }
 * With `auto_bucketing: 'week'` (see buildSentimentOverviewPayload) the element returns
 * WEEKLY buckets directly, honoring the requested date range — so this transform no longer
 * rolls daily→weekly; it just maps each weekly `bar` to its ISO-week label. (The aggregation
 * below is granularity-agnostic: one row per week means the per-week sums are identities, and
 * it would still correctly roll up were the element ever queried at daily granularity.)
 * Field mapping:
 *   positive/neutral/negative prompt counts ← `value__prompts` per legend for the week
 *   totalPrompts                            ← `blocks.line[].value` for the week
 *   mentions/citations/visibilityScore/competitors — stubbed 0/[] (as in the legacy handler)
 *
 * SEMANTIC NOTE: the three legends are OVERLAPPING sets, not a partition — a prompt with
 * mixed-sentiment mentions is counted in every legend it appears in. So Σ(value__prompts
 * across legends) for a week EXCEEDS blocks.line for that week (the distinct total).
 * Consequences:
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
      let positivePct = 0;
      let negativePct = 0;
      let neutralPct = 0;
      if (promptsWithSentiment > 0) {
        positivePct = Math.round((entry.positive / promptsWithSentiment) * 100);
        negativePct = Math.round((entry.negative / promptsWithSentiment) * 100);
        neutralPct = 100 - positivePct - negativePct;
        // Independent rounding of positive & negative can push their sum to 101
        // (e.g. 50.5→51 and 49.5→50), making the neutral remainder negative. Absorb
        // that 1-point overflow from the larger of the two so all three stay
        // non-negative AND sum to exactly 100 — the contract the comment/schema state.
        if (neutralPct < 0) {
          if (positivePct >= negativePct) {
            positivePct += neutralPct;
          } else {
            negativePct += neutralPct;
          }
          neutralPct = 0;
        }
      }

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
