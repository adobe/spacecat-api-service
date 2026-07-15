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

/**
 * Payload builders + response transformers backing `GET .../brand-presence/stats`
 * (rows 4, 6, 7, 8 — Total Executions, Mentions, Visibility, Citations). See
 * docs/elements/brand-presence-stats-plan.md for the full design + resolved
 * decisions this file implements.
 *
 * `comparison_start_date`/`comparison_end_date`/`comparison_data_formatting` are
 * intentionally omitted — the `/stats` contract has no period-over-period
 * comparison field, so only `blocks.firstSectionMainValue` is read; Semrush's
 * `firstSectionSecondaryValue` (previous/current) is unused.
 */

function orProjectFilter(col, projectIds) {
  if (!Array.isArray(projectIds) || projectIds.length === 0) {
    return null;
  }
  return { op: 'or', filters: projectIds.map((val) => ({ op: 'eq', val, col })) };
}

/**
 * Extracts the single numeric value from a `simpleNumeric` element response.
 * @param {object} raw - Raw response from the Elements API.
 * @returns {number}
 */
export function transformStatsSimpleNumericResponse(raw) {
  const value = raw?.blocks?.firstSectionMainValue?.[0]?.firstSectionMainValue;
  return typeof value === 'number' ? value : 0;
}

/**
 * Builds the payload for Total Executions (row 4, `TOTAL_EXECUTIONS`). Project
 * scoping is a top-level `project_id` (singular) — omitted entirely for the
 * aggregate "all regions" view, where Semrush combines all of the subworkspace's
 * projects automatically (resolved decision — see plan §4.1).
 *
 * @param {object} params
 * @param {string} [params.model] / [params.platform] - AI model filter.
 * @param {string} params.startDate / params.endDate - YYYY-MM-DD.
 * @param {string} [params.projectId] - Single Semrush project UUID (one region selected).
 */
export function buildStatsTotalExecutionsPayload({
  model, platform, startDate, endDate, projectId,
}) {
  const resolvedModel = resolveElementModel(model || platform);
  const payload = {
    filters: {
      simple: { start_date: startDate, end_date: endDate },
      advanced: { op: 'and', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
    },
  };
  if (projectId) {
    payload.project_id = projectId;
  }
  return payload;
}

export const transformStatsTotalExecutionsResponse = transformStatsSimpleNumericResponse;

/**
 * Builds the payload for Mentions (row 6, `MENTIONS`). Always scopes to the brand
 * via `CBF_ws_brand` (resolved decision — see plan §4.4).
 *
 * @param {object} params
 * @param {string} params.brandName - Brand display name (Semrush `CBF_ws_brand` value).
 * @param {string} [params.model] / [params.platform] - AI model filter.
 * @param {string} params.startDate / params.endDate - YYYY-MM-DD.
 * @param {string[]} [params.projectIds] - Semrush project UUIDs to OR together.
 */
export function buildStatsMentionsPayload({
  model, platform, startDate, endDate, projectIds, brandName,
}) {
  const resolvedModel = resolveElementModel(model || platform);
  const filters = [
    { op: 'eq', val: brandName, col: 'CBF_ws_brand' },
    { op: 'eq', val: resolvedModel, col: 'CBF_model' },
  ];
  const projectFilter = orProjectFilter('CBF_project', projectIds);
  if (projectFilter) {
    filters.push(projectFilter);
  }
  return { filters: { simple: { start_date: startDate, end_date: endDate }, advanced: { op: 'and', filters } } };
}

export const transformStatsMentionsResponse = transformStatsSimpleNumericResponse;

/**
 * Builds the payload for Visibility (row 7, `VISIBILITY`). Same scoping as
 * Mentions; the raw value comes back as a 0-1 fraction — the transform below
 * converts it to a 0-100 percentage (resolved decision — see plan §4.3).
 *
 * @param {object} params - Same shape as {@link buildStatsMentionsPayload}.
 */
export function buildStatsVisibilityPayload({
  model, platform, startDate, endDate, projectIds, brandName,
}) {
  const resolvedModel = resolveElementModel(model || platform);
  const filters = [
    { op: 'eq', val: brandName, col: 'CBF_ws_brand' },
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
  ];
  const projectFilter = orProjectFilter('CBF_project', projectIds);
  if (projectFilter) {
    filters.push(projectFilter);
  }
  return { filters: { simple: { start_date: startDate, end_date: endDate }, advanced: { op: 'and', filters } } };
}

/**
 * @param {object} raw - Raw response from the Elements API.
 * @returns {number} 0-100 percentage (raw value is a 0-1 fraction).
 */
export function transformStatsVisibilityResponse(raw) {
  return transformStatsSimpleNumericResponse(raw) * 100;
}

/**
 * Builds the payload for Citations (row 8, `CITATIONS_KPI`). Differs from
 * Mentions/Visibility: uses `CBF_brand` (not `CBF_ws_brand`) and `CBF_projects`
 * (plural column, not `CBF_project`) — confirmed against live sample payloads.
 *
 * @param {object} params - Same shape as {@link buildStatsMentionsPayload}.
 */
export function buildStatsCitationsPayload({
  model, platform, startDate, endDate, projectIds, brandName,
}) {
  const resolvedModel = resolveElementModel(model || platform);
  const filters = [
    { op: 'eq', val: brandName, col: 'CBF_brand' },
    { op: 'eq', val: resolvedModel, col: 'CBF_model' },
  ];
  const projectFilter = orProjectFilter('CBF_projects', projectIds);
  if (projectFilter) {
    filters.push(projectFilter);
  }
  return { filters: { simple: { start_date: startDate, end_date: endDate }, advanced: { op: 'and', filters } } };
}

export const transformStatsCitationsResponse = transformStatsSimpleNumericResponse;
