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

import { DIMENSIONS } from './analytics-metadata.js';

/**
 * Deterministic fixture data generator for the ABV custom-dashboard analytics query
 * endpoint. Deliberately has ZERO database dependency (see the v1 plan: no migrations,
 * no live Postgres/PostgREST connection) — every value is derived from a seeded PRNG so
 * the same request returns the same numbers on refresh, without persisting anything.
 *
 * Swapping this module for real PostgREST/RPC calls later is a one-file change behind
 * `llmo-analytics.js`'s controller — the request/response contract does not change.
 */

/** Typical value range per metric, used only to scale the fixture PRNG output. Not part
 * of the public metadata catalog — a real data source won't need this at all. */
const METRIC_RANGES = {
  visibilityScore: { min: 8, max: 92 },
  brandMentions: { min: 0, max: 480 },
  citations: { min: 0, max: 1800 },
  sentimentScore: { min: -1, max: 1 },
};

/** Park-Miller (Lehmer) LCG — small, deterministic, arithmetic-only (no bitwise ops, so
 * it doesn't need a lint carve-out). Good enough for fixture data; not for anything
 * security-sensitive. */
function createRandom(seed) {
  let state = seed % 2147483647;
  if (state <= 0) {
    state += 2147483646;
  }
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** Simple additive/multiplicative string hash → positive int seed. Not cryptographic —
 * only needs to be deterministic and reasonably well-distributed for fixture data. */
function hashToSeed(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) % 2147483647;
  }
  return hash + 1;
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** Weekly (Monday-aligned) date strings covering [dateFrom, dateTo], inclusive. */
export function generateWeeks(dateFrom, dateTo) {
  const weeks = [];
  const start = new Date(`${dateFrom}T00:00:00.000Z`);
  const end = new Date(`${dateTo}T00:00:00.000Z`);
  // Align to the Monday on/before `start`.
  const dayOffset = (start.getUTCDay() + 6) % 7;
  const cursor = new Date(start);
  cursor.setUTCDate(cursor.getUTCDate() - dayOffset);
  while (cursor <= end) {
    weeks.push(toIsoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return weeks;
}

function valuesForDimension(dimensionId, dateFrom, dateTo) {
  if (dimensionId === 'week') {
    return generateWeeks(dateFrom, dateTo);
  }
  return DIMENSIONS[dimensionId]?.allowedValues ?? [];
}

/** Narrows a dimension's candidate values to whatever an `equals`/`in` filter allows,
 * before the cartesian product is built — keeps row counts (and PRNG calls) down for
 * narrow queries instead of generating-then-discarding. */
function applyFilterToValues(values, filter) {
  if (!filter) {
    return values;
  }
  const filterValues = new Set(filter.values ?? []);
  if (filter.operator === 'equals' || filter.operator === 'in') {
    return values.filter((v) => filterValues.has(v));
  }
  if (filter.operator === 'notEquals' || filter.operator === 'notIn') {
    return values.filter((v) => !filterValues.has(v));
  }
  return values;
}

function cartesianProduct(arraysById) {
  const dimensionIds = Object.keys(arraysById);
  if (dimensionIds.length === 0) {
    return [{}];
  }
  return dimensionIds.reduce((rows, dimensionId) => {
    const values = arraysById[dimensionId];
    const next = [];
    for (const row of rows) {
      for (const value of values) {
        next.push({ ...row, [dimensionId]: value });
      }
    }
    return next;
  }, [{}]);
}

/**
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.brandId
 * @param {string} params.metricId
 * @param {string[]} params.dimensionIds
 * @param {string} params.dateFrom - ISO date
 * @param {string} params.dateTo - ISO date
 * @param {Array<{dimension: string, operator: string, values: string[]}>} [params.filters]
 * @returns {Array<Object>} rows shaped `{ [dimensionId]: value, ..., [metricId]: number }`,
 *   unsorted and unlimited — the controller applies sort/limit.
 */
export function generateAnalyticsRows({
  orgId, brandId, metricId, dimensionIds, dateFrom, dateTo, filters = [],
}) {
  const filterByDimension = new Map(filters.map((f) => [f.dimension, f]));
  const valuesById = {};
  for (const dimensionId of dimensionIds) {
    const candidates = valuesForDimension(dimensionId, dateFrom, dateTo);
    valuesById[dimensionId] = applyFilterToValues(candidates, filterByDimension.get(dimensionId));
  }

  const combinations = cartesianProduct(valuesById);
  const range = METRIC_RANGES[metricId] ?? { min: 0, max: 100 };

  return combinations.map((combo) => {
    const seedKey = [orgId, brandId, metricId, ...dimensionIds.map((id) => `${id}=${combo[id]}`)]
      .join('|');
    const rand = createRandom(hashToSeed(seedKey));
    const value = range.min + (rand() * (range.max - range.min));
    const rounded = metricId === 'sentimentScore' ? Math.round(value * 100) / 100 : Math.round(value);
    return { ...combo, [metricId]: rounded };
  });
}
