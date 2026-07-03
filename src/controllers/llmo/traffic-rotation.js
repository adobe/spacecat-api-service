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

import { dateToIsoWeek, getWeekDateRange } from './llmo-brand-presence.js';

/**
 * Read-time rotation of frozen demo-site traffic data.
 *
 * Two internal demo sites hold exactly 4 contiguous ISO weeks (A,B,C,D,
 * oldest->newest) of hand-seeded, frozen agentic/referral traffic. Nothing
 * ingests into them, so the dashboard would show the same stale dates forever.
 *
 * This module rotates that frozen data on the fly at API read-time so the sites
 * always render a rolling "last 4 weeks" whose newest week advances week over
 * week. Rotation is a deterministic function of now() (ISO-week / Monday-UTC
 * boundaries) — no scheduler, no DB writes. DRS and mysticat-data-service SQL
 * RPCs are NOT touched; we only rewrite the inbound date range and relabel the
 * outbound dates in the SpaceCat read path.
 *
 * Model (see the approved plan for the full derivation):
 *   - anchorMonday    = Monday-UTC of the OLDEST canned week (per-site constant)
 *   - canned week i   covers [anchorMonday + i*7d, +7d), i in 0..3
 *   - phase p         = floor((thisMondayUTC - anchorMonday)/7d) mod 4
 *   - presented P0    = thisMondayUTC - 21d (window position j in 0..3 covers P0 + j*7d)
 *   - canned week shown at window position j: c(j) = (j + p) mod 4
 *
 * Whole-week shifts preserve day-of-week automatically.
 */

const MS_PER_DAY = 86_400_000;
const WEEK_MS = 7 * MS_PER_DAY;

/**
 * Per-site rotation configuration.
 *
 * Values come from the prod demo seed (project-elmo-ui branch
 * `fix/referral-demo-commerce`): rows are tagged `updated_by` =
 * 'demo-seed-frescopaadobe' / 'demo-seed-frescopacommerce', seeded into the 4
 * ISO weeks Jun 1–28 2026 (w23–26; the referral file's stray July boundary rows
 * fall outside the 4-week block and are harmlessly ignored).
 *
 * `agentic` / `referral` flag which datasets rotate.
 *   - frescopaadobe (demoStrategy, frescopa.coffee): both are frozen demo seeds.
 *   - frescopacommerce: only referral rotates. Its agentic is pre-existing
 *     (not a frozen seed), so it is intentionally left live (agentic:false).
 *
 * cannedAnchorMonday is the Monday-UTC of the OLDEST canned week. If a site's
 * agentic and referral blocks ever start on different Mondays, add
 * agenticAnchorMonday / referralAnchorMonday (getAnchorMonday reads that key).
 */
export const ROTATION_CONFIG = {
  // demoStrategy — frescopa.coffee — agentic + referral.
  '66b55446-4cc3-46f1-9cd4-9eb57601b3f1': {
    marker: 'demo-seed-frescopaadobe',
    cannedAnchorMonday: '2026-06-01',
    agentic: true,
    referral: true,
  },
  // frescopacommerce.com — referral only (agentic is live, not a frozen seed).
  '70de8f34-32f9-47dd-8b8a-5bf40b89030c': {
    marker: 'demo-seed-frescopacommerce',
    cannedAnchorMonday: '2026-06-01',
    agentic: false,
    referral: true,
  },
};

export function isRotationSite(siteId) {
  return Object.prototype.hasOwnProperty.call(ROTATION_CONFIG, siteId);
}

export function getRotationConfig(siteId) {
  return ROTATION_CONFIG[siteId] ?? null;
}

/**
 * True when rotation should apply to this (site, dataset) pair. `dataset` is
 * 'agentic' | 'referral'. Non-rotation sites and disabled datasets return false
 * so the caller keeps its exact current behavior.
 */
export function shouldRotate(siteId, dataset) {
  const config = getRotationConfig(siteId);
  return Boolean(config && config[dataset]);
}

/**
 * Per-request rotation context for a (site, dataset). Returns `{ rotate: false }`
 * for non-rotation sites/datasets (caller keeps its exact current behavior), or
 * `{ rotate: true, config, dataset, now }` with a single `now` captured for the
 * whole request so every helper resolves the same phase/window.
 */
export function rotationContext(siteId, dataset) {
  return shouldRotate(siteId, dataset)
    ? {
      rotate: true, config: getRotationConfig(siteId), dataset, now: new Date(),
    }
    : { rotate: false };
}

// --- date primitives (all UTC, calendar-day granularity) ---

function parseYmd(str) {
  return new Date(`${str}T00:00:00Z`);
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, n) {
  return new Date(date.getTime() + n * MS_PER_DAY);
}

/** Whole-day difference (b - a) rounded to the nearest day (DST-agnostic in UTC). */
function dayDiff(a, b) {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** 00:00 UTC of the Monday of the ISO week containing `date`. */
function mondayOfUtc(date) {
  const d = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  const dow = d.getUTCDay() || 7; // Mon=1..Sun=7
  return addDays(d, 1 - dow);
}

/** Resolve the canned anchor Monday for a dataset, allowing a per-dataset override. */
function getAnchorMonday(config, dataset) {
  const key = `${dataset}AnchorMonday`;
  return parseYmd(config[key] ?? config.cannedAnchorMonday);
}

// --- phase & window ---

/**
 * Rotation phase (0..3) for `now`, relative to a dataset's canned anchor Monday.
 * Advances on Monday 00:00 UTC boundaries.
 */
export function computePhase(now, config, dataset) {
  const anchorMonday = getAnchorMonday(config, dataset);
  const weeks = Math.round((mondayOfUtc(now) - anchorMonday) / WEEK_MS);
  return ((weeks % 4) + 4) % 4;
}

/** P0 = Monday of (this ISO week − 3): the oldest day of the presented window. */
function windowStart(now) {
  return addDays(mondayOfUtc(now), -21);
}

/**
 * The presented rolling window as a pure function of now().
 * P0 = Monday of (this ISO week - 3). Window position j (0=oldest..3=newest)
 * covers P0 + j*7d; the newest position is the current ISO week.
 *
 * @returns {{ P0: Date, weeks: Array<{week,startDate,endDate}> }} weeks newest-first
 */
export function computeWindow(now) {
  const p0 = windowStart(now);
  const weeks = [0, 1, 2, 3].map((j) => {
    const week = dateToIsoWeek(ymd(addDays(p0, j * 7)));
    const range = getWeekDateRange(week);
    return { week, startDate: range?.startDate ?? null, endDate: range?.endDate ?? null };
  });
  weeks.reverse(); // newest-first, matching the existing /weeks handlers
  return { P0: p0, weeks };
}

// --- date mapping (canned <-> current) ---

/**
 * Build a canned→current date relabeler for one (config, dataset, now). Phase
 * and P0 are resolved ONCE here, so the returned function is a cheap per-row
 * mapper — avoids recomputing the window for every trend point.
 * The mapper returns null for a date outside the 4-week canned block.
 */
function makeRelabeler(config, dataset, now) {
  const anchorMonday = getAnchorMonday(config, dataset);
  const p = computePhase(now, config, dataset);
  const p0 = windowStart(now);
  return (cannedDateStr) => {
    const daysFromAnchor = dayDiff(anchorMonday, parseYmd(cannedDateStr));
    if (daysFromAnchor < 0 || daysFromAnchor >= 28) {
      return null;
    }
    const i = Math.floor(daysFromAnchor / 7);
    const w = daysFromAnchor - i * 7;
    const j = ((((i - p) % 4) + 4) % 4);
    return ymd(addDays(p0, j * 7 + w));
  };
}

/**
 * Forward relabel: a canned date -> the current date the window displays it at.
 * Returns null for a date outside the 4-week canned block (skip the row).
 * Used by time-series endpoints.
 */
export function relabelCannedToCurrent(cannedDateStr, config, dataset, now) {
  return makeRelabeler(config, dataset, now)(cannedDateStr);
}

/**
 * Reverse map a requested current-date range -> the <=2 contiguous canned date
 * ranges that back it. Used by aggregate endpoints (per-segment RPC calls).
 *
 * The range is clamped to the presented window [P0, P0+28d). A cyclic arc of
 * canned weeks collapses to at most 2 contiguous date intervals. Returns [] when
 * the requested range lies entirely before the window (no older canned data).
 *
 * @returns {Array<{start:string, end:string}>} up to 2 intervals (YYYY-MM-DD)
 */
export function toCannedSegments(startStr, endStr, config, dataset, now) {
  const P0 = windowStart(now);
  const windowEnd = addDays(P0, 27); // Sunday of the newest window week
  const anchorMonday = getAnchorMonday(config, dataset);
  const p = computePhase(now, config, dataset);

  const s = parseYmd(startStr) < P0 ? P0 : parseYmd(startStr);
  const e = parseYmd(endStr) > windowEnd ? windowEnd : parseYmd(endStr);
  if (s > e) {
    return [];
  }

  const jStart = Math.floor(dayDiff(P0, s) / 7);
  const jEnd = Math.floor(dayDiff(P0, e) / 7);

  // One canned date-interval per covered window week; partial weekday offsets
  // only ever occur on the first/last (the two ends of the cyclic arc).
  const intervals = [];
  for (let j = jStart; j <= jEnd; j += 1) {
    const i = (j + p) % 4;
    const cannedMonday = addDays(anchorMonday, i * 7);
    const wLo = j === jStart ? dayDiff(P0, s) - jStart * 7 : 0;
    const wHi = j === jEnd ? dayDiff(P0, e) - jEnd * 7 : 6;
    intervals.push({
      start: addDays(cannedMonday, wLo),
      end: addDays(cannedMonday, wHi),
    });
  }

  // Merge date-contiguous intervals (the arc's <=2 linear runs collapse here).
  intervals.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.start.getTime() <= last.end.getTime() + MS_PER_DAY) {
      if (iv.end > last.end) {
        last.end = iv.end;
      }
    } else {
      merged.push({ ...iv });
    }
  }
  return merged.map((iv) => ({ start: ymd(iv.start), end: ymd(iv.end) }));
}

// --- aggregate recombination across <=2 segments ---

/**
 * Weighted mean of a rate/average across segments, weighted by the additive
 * weight (total_hits / total_pageviews). Exact when the metric's denominator is
 * the weight (e.g. success_rate over total_hits); a small, invisible
 * approximation otherwise. Null rows are excluded; null result when total
 * weight is 0.
 */
function weightedRate(values, weights) {
  let num = 0;
  let den = 0;
  for (let k = 0; k < values.length; k += 1) {
    const v = values[k];
    const w = weights[k];
    if (v != null && w != null) {
      num += Number(v) * Number(w);
      den += Number(w);
    }
  }
  return den > 0 ? num / den : null;
}

/**
 * Combine a single-row aggregate (e.g. kpis, business-impact) across segments.
 * `rowsPerSegment` is an array of RPC data arrays; each is expected to hold one
 * row. Sums `additiveKeys`, weighted-averages `rateKeys` by `weightKey`.
 */
export function combineSingleRow(rowsPerSegment, { additiveKeys, rateKeys, weightKey }) {
  const rows = rowsPerSegment.map((seg) => (seg || [])[0] || {});
  // Always return a fresh object (never a live reference into the RPC response).
  if (rows.length === 1) {
    return { ...rows[0] };
  }
  const weights = rows.map((r) => Number(r[weightKey] ?? 0));
  // Base on the heaviest segment so fields outside additive/rate (labels etc.)
  // stay present and consistent, matching the single-segment shape.
  const heaviest = rows[weights.indexOf(Math.max(...weights))] ?? rows[0];
  const out = { ...heaviest };
  additiveKeys.forEach((key) => {
    out[key] = rows.reduce((sum, r) => sum + Number(r[key] ?? 0), 0);
  });
  rateKeys.forEach((key) => {
    out[key] = weightedRate(rows.map((r) => r[key]), weights);
  });
  return out;
}

/**
 * Relabel a nested time-series array (e.g. hits_trend) from canned to current
 * dates via a prebuilt `relabel` fn, dropping out-of-block points, sorted
 * ascending by date.
 */
function relabelTrendPoints(points, dateField, relabel) {
  return (Array.isArray(points) ? points : [])
    .map((pt) => {
      const relabelled = relabel(pt[dateField]);
      return relabelled ? { ...pt, [dateField]: relabelled } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(a[dateField]).localeCompare(String(b[dateField])));
}

/** Relabel a nested trend field on each row for the single-segment path. */
function relabelRowsTrend(rows, trend, relabel) {
  if (!trend) {
    return rows;
  }
  return rows.map((row) => (
    Array.isArray(row[trend.key])
      ? { ...row, [trend.key]: relabelTrendPoints(row[trend.key], trend.dateField, relabel) }
      : row
  ));
}

/**
 * Combine grouped-list aggregates (by-region, by-platform, by-url, ...) across
 * segments. Rows are grouped by the tuple `groupKeys`; within a group, sums
 * `additiveKeys`, weighted-averages `rateKeys` by `weightKey`, unions
 * `unionKeys` (array-valued), and — when `trend` is given — relabels+concatenates
 * a nested time-series ({key, dateField}) into current dates.
 *
 * Non-additive scalar fields (e.g. top_agent, page_intent) are taken from the
 * segment with the largest weight, keeping the row self-consistent.
 *
 * Result rows are sorted by `weightKey` descending. On a wrap-spanning sub-range
 * this overrides a caller-requested non-default sort (documented limitation);
 * the single-segment path preserves the RPC's own ordering.
 */
export function combineGroupedRows(rowsPerSegment, spec) {
  const {
    groupKeys, additiveKeys = [], rateKeys = [], weightKey,
    unionKeys = [], carryKeys = [], countFromUnion = {}, trend = null,
    limit = null, config, dataset, now,
  } = spec;

  const relabel = trend ? makeRelabeler(config, dataset, now) : null;

  if (rowsPerSegment.length === 1) {
    return relabelRowsTrend(rowsPerSegment[0] || [], trend, relabel);
  }

  const groups = new Map();
  for (const seg of rowsPerSegment) {
    for (const row of (seg || [])) {
      // NUL-separated + string-coerced so values with spaces or a null
      // don't collide across distinct group tuples.
      const gk = groupKeys.map((k) => String(row[k] ?? '')).join('\u0000');
      let g = groups.get(gk);
      if (!g) {
        g = {
          weight: 0,
          best: { weight: -1, row: null },
          trend: [],
          row: Object.fromEntries([
            ...groupKeys.map((k) => [k, row[k]]),
            ...additiveKeys.map((k) => [k, 0]),
          ]),
          unions: Object.fromEntries(unionKeys.map((k) => [k, new Set()])),
          rateNum: Object.fromEntries(rateKeys.map((k) => [k, 0])),
          rateDen: Object.fromEntries(rateKeys.map((k) => [k, 0])),
        };
        groups.set(gk, g);
      }
      const w = Number(row[weightKey] ?? 0);
      g.weight += w;
      additiveKeys.forEach((k) => {
        g.row[k] += Number(row[k] ?? 0);
      });
      rateKeys.forEach((k) => {
        if (row[k] != null) {
          g.rateNum[k] += Number(row[k]) * w;
          g.rateDen[k] += w;
        }
      });
      unionKeys.forEach((k) => {
        (Array.isArray(row[k]) ? row[k] : []).forEach((v) => g.unions[k].add(v));
      });
      if (w > g.best.weight) {
        g.best = { weight: w, row };
      }
      if (trend) {
        g.trend.push(...relabelTrendPoints(row[trend.key], trend.dateField, relabel));
      }
    }
  }

  const countEntries = Object.entries(countFromUnion);
  const result = [];
  for (const g of groups.values()) {
    const row = { ...g.row };
    rateKeys.forEach((k) => {
      row[k] = g.rateDen[k] > 0 ? g.rateNum[k] / g.rateDen[k] : null;
    });
    unionKeys.forEach((k) => {
      row[k] = [...g.unions[k]];
    });
    carryKeys.forEach((k) => {
      row[k] = g.best.row?.[k];
    });
    // Distinct counts come from the union cardinality, not a segment sum.
    countEntries.forEach(([countKey, unionKey]) => {
      row[countKey] = g.unions[unionKey] ? g.unions[unionKey].size : 0;
    });
    if (trend) {
      g.trend.sort((a, b) => String(a[trend.dateField]).localeCompare(String(b[trend.dateField])));
      row[trend.key] = g.trend;
    }
    result.push(row);
  }
  result.sort((a, b) => Number(b[weightKey] ?? 0) - Number(a[weightKey] ?? 0));
  // Wrap path can yield up to 2*limit rows; cap to the requested page size so
  // page 1 matches the grid (offset/total_count remain best-effort — see docs).
  return limit != null ? result.slice(0, limit) : result;
}

// --- high-level helpers the controllers call ---

/**
 * Run an aggregate RPC under rotation: split the requested range into <=2 canned
 * segments, call the RPC per segment (overriding p_start_date/p_end_date), and
 * combine. `combine(rowsPerSegment)` receives one data array per segment and
 * returns the merged data (array, or single-element array for one-row RPCs).
 *
 * Returns the same `{ data, error }` shape as `client.rpc` so the caller's
 * existing response mapping is unchanged. An empty (before-window) range yields
 * `{ data: [] }` without an RPC round-trip.
 *
 * Pagination caveat: `p_offset`/`p_limit`/sort in `baseParams` are passed
 * unchanged to each segment, so on a 2-segment wrap only page 1 is exact — an
 * `offset > 0` page is approximate (there is no global re-pagination across the
 * two non-contiguous canned weeks). This is unreachable for the current demo
 * sites, which have well under one page of URLs; `combineGroupedRows` also caps
 * the merged rows to the requested `limit`. Revisit if a rotation site ever
 * exceeds a single page.
 */
export async function runRotatedAggregate(client, rpcName, baseParams, {
  config, dataset, now, combine,
}) {
  const { p_start_date: start, p_end_date: end } = baseParams;
  const segments = toCannedSegments(start, end, config, dataset, now);
  if (segments.length === 0) {
    return { data: [] };
  }
  const responses = await Promise.all(segments.map((seg) => client.rpc(rpcName, {
    ...baseParams,
    p_start_date: seg.start,
    p_end_date: seg.end,
  })));
  const failedIdx = responses.findIndex((r) => r.error);
  if (failedIdx !== -1) {
    const seg = segments[failedIdx];
    const { error } = responses[failedIdx];
    // Name the failing canned segment so the caller's error log is actionable.
    return {
      error: {
        ...error,
        message: `${rpcName} segment ${failedIdx + 1}/${segments.length} `
          + `[${seg.start}..${seg.end}] failed: ${error.message}`,
      },
    };
  }
  return { data: combine(responses.map((r) => r.data || [])) };
}

/**
 * Full canned block [anchorMonday, +28d) as { p_start_date, p_end_date }, for
 * time-series endpoints that fetch the whole block once then relabel + filter.
 */
export function cannedBlockRange(config, dataset) {
  const anchorMonday = getAnchorMonday(config, dataset);
  return {
    p_start_date: ymd(anchorMonday),
    p_end_date: ymd(addDays(anchorMonday, 27)),
  };
}

/**
 * Relabel a fetched time-series to current dates and filter to the requested
 * window slice. `dateField` is the row's date column (e.g. 'period_start',
 * 'traffic_date', 'week_start'). Rows outside the canned block or outside the
 * requested [startStr, endStr] are dropped; the result is sorted ascending.
 */
export function relabelAndFilterSeries(rows, dateField, {
  config, dataset, now, startStr, endStr,
}) {
  return (rows || [])
    .map((row) => {
      const current = relabelCannedToCurrent(row[dateField], config, dataset, now);
      return current ? { ...row, [dateField]: current } : null;
    })
    .filter((row) => row && row[dateField] >= startStr && row[dateField] <= endStr)
    .sort((a, b) => String(a[dateField]).localeCompare(String(b[dateField])));
}
