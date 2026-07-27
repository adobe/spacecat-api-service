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
import { addDaysToDate } from '../week-utils.js';

/**
 * Payload builders + response transform for the Overview-SR KPI headline cards
 * (Share of Voice, Brand Visibility, Source Visibility) — LLMO-6515 follow-up
 * for exact MFE parity. `market-tracking-trends.js` already exposes these three
 * metrics as a multi-brand WEEKLY SERIES (`y__sov`/`y__visibility` per brand per
 * week); the headline number shown on each MFE card is NOT derivable from that
 * series — it comes from three separate per-brand `kpiLineChart` elements that
 * carry a Semrush-computed `mainValue` (current period) and `secondaryValue`
 * (the immediately preceding period of equal length), verified live against the
 * MFE's own network requests.
 *
 * Share of Voice / Brand Visibility are brand-NAME scoped (`CBF_ws_brand`), same
 * as the existing `/stats` elements. Source Visibility is brand-URL scoped
 * (`CBF_brand_urls`, `url_match` over every URL the brand owns — main domain +
 * tracked social profiles) — a citation is domain-cited, not brand-name-mentioned,
 * so it needs the brand's URL list first (`BRAND_URLS` filter element, `buildBrandUrlsPayload`).
 */

function orFilter(col, values) {
  return { op: 'or', filters: values.map((val) => ({ op: 'eq', val, col })) };
}

/**
 * Computes the immediately-preceding period of equal length (inclusive), matching
 * the MFE's default "Compare to: Preceding period" behavior.
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {{ comparisonStartDate: string, comparisonEndDate: string }}
 */
export function derivePreviousPeriod(startDate, endDate) {
  const spanDays = Math.round(
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000,
  ) + 1;
  const comparisonEndDate = addDaysToDate(startDate, -1);
  const comparisonStartDate = addDaysToDate(comparisonEndDate, -(spanDays - 1));
  return { comparisonStartDate, comparisonEndDate };
}

/**
 * Builds the payload for the brand-NAME-scoped KPI headline elements
 * (`KPI_SHARE_OF_VOICE`, `KPI_BRAND_VISIBILITY`) — `CBF_ws_brand` + `CBF_model`
 * + optional `CBF_project` OR-list, `comparison_data_formatting: "union"` and
 * `auto_bucketing: "date"` — confirmed against the live MFE payload.
 *
 * @param {object} params
 * @param {string} params.brandName - Brand display name (`CBF_ws_brand` value).
 * @param {string} [params.model] / [params.platform] - AI model filter.
 * @param {string} params.startDate / params.endDate - YYYY-MM-DD (main period).
 * @param {string[]} [params.projectIds] - Semrush project UUIDs to OR together.
 */
export function buildKpiHeadlinePayload({
  brandName, model, platform, startDate, endDate, projectIds = [],
}) {
  const resolvedModel = resolveElementModel(model || platform);
  const { comparisonStartDate, comparisonEndDate } = derivePreviousPeriod(startDate, endDate);
  const filters = [
    { op: 'eq', val: brandName, col: 'CBF_ws_brand' },
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
  ];
  if (Array.isArray(projectIds) && projectIds.length > 0) {
    filters.push(orFilter('CBF_project', projectIds));
  }
  return {
    comparison_data_formatting: 'union',
    auto_bucketing: 'date',
    filters: {
      simple: {
        start_date: startDate,
        end_date: endDate,
        comparison_start_date: comparisonStartDate,
        comparison_end_date: comparisonEndDate,
      },
      advanced: { op: 'and', filters },
    },
  };
}

/**
 * Builds the payload for the `BRAND_URLS` filter element — the brand's main
 * domain + every tracked social profile, scoped by `CBF_brand` (brand display
 * name). No date/model/project filters — confirmed against the live payload,
 * this is a static per-brand catalog lookup, not a metric.
 *
 * @param {object} params
 * @param {string} params.brandName - Brand display name (`CBF_brand` value).
 */
export function buildBrandUrlsPayload({ brandName }) {
  return {
    filters: {
      simple: {},
      advanced: { op: 'and', filters: [{ op: 'eq', val: brandName, col: 'CBF_brand' }] },
    },
  };
}

/**
 * Extracts the brand's URL list from the `BRAND_URLS` response
 * (`blocks.value[].value`).
 * @param {object} raw - Raw response from the Elements API.
 * @returns {string[]}
 */
export function transformBrandUrlsResponse(raw) {
  const rows = raw?.blocks?.value ?? [];
  return rows
    .map((row) => row?.value)
    .filter((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Builds the payload for the Source Visibility KPI headline element
 * (`KPI_SOURCE_VISIBILITY`) — scoped via `CBF_brand_urls` (`url_match` OR-list
 * over every URL {@link transformBrandUrlsResponse} returns), NOT `CBF_ws_brand`
 * — confirmed against the live MFE payload (a citation is domain-cited, not
 * brand-name-mentioned).
 *
 * @param {object} params
 * @param {string[]} params.brandUrls - URLs from {@link transformBrandUrlsResponse}.
 * @param {string} [params.model] / [params.platform] - AI model filter.
 * @param {string} params.startDate / params.endDate - YYYY-MM-DD (main period).
 * @param {string[]} [params.projectIds] - Semrush project UUIDs to OR together.
 */
export function buildSourceVisibilityPayload({
  brandUrls, model, platform, startDate, endDate, projectIds = [],
}) {
  const resolvedModel = resolveElementModel(model || platform);
  const { comparisonStartDate, comparisonEndDate } = derivePreviousPeriod(startDate, endDate);
  const filters = [
    {
      op: 'or',
      filters: (brandUrls ?? []).map((val) => ({ op: 'url_match', val, col: 'CBF_brand_urls' })),
    },
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
  ];
  if (Array.isArray(projectIds) && projectIds.length > 0) {
    filters.push(orFilter('CBF_project', projectIds));
  }
  return {
    comparison_data_formatting: 'union',
    auto_bucketing: 'date',
    filters: {
      simple: {
        start_date: startDate,
        end_date: endDate,
        comparison_start_date: comparisonStartDate,
        comparison_end_date: comparisonEndDate,
      },
      advanced: { op: 'and', filters },
    },
  };
}

/**
 * Extracts `{ value, comparisonValue }` from a `kpiLineChart` element response:
 * `blocks.mainValue[0].mainValue` (current period) and the `secondaryValue`
 * entry whose `period` is `"previous"` (comparison period). Both `current`/
 * `previous` entries were verified identical live, but matched by `period`
 * rather than positionally — a positional `[0]` read would silently return the
 * wrong figure if the two ever diverge or the array is ever reordered upstream.
 * `value` defaults to 0 when missing; `comparisonValue` is `null` (not 0) when Semrush has
 * no numeric data for the comparison period, so callers can distinguish "no data" from a
 * real 0% and show e.g. "N/A" instead of computing a fake delta against a 0 baseline.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {{ value: number, comparisonValue: number | null }}
 */
export function transformKpiHeadlineResponse(raw) {
  const value = raw?.blocks?.mainValue?.[0]?.mainValue;
  const secondaryValues = raw?.blocks?.secondaryValue ?? [];
  const previous = secondaryValues.find((s) => s?.period === 'previous');
  const comparisonValue = previous?.secondaryValue;
  return {
    value: typeof value === 'number' ? value : 0,
    // null (not 0) when Semrush has no data for the comparison period (e.g. a comparison
    // window predating data collection) — a real 0% and "no data" must stay distinguishable
    // so consumers can show "N/A" instead of computing a fake delta against a 0 baseline.
    comparisonValue: typeof comparisonValue === 'number' ? comparisonValue : null,
  };
}
