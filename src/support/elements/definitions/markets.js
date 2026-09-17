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

/**
 * Builds the payload for the Markets filter-dimensions element (row 2).
 * Returns available markets (Semrush projects) for a selected brand.
 * Each market corresponds to one location + language combination.
 *
 * @param {object} params
 * @param {string} [params.brand] - Brand name to scope the lookup (e.g. "Adobe").
 *   When omitted, returns all markets across the workspace with no brand filter.
 */
export function buildMarketsPayload({ brand } = {}) {
  if (!brand) {
    return { comparison_data_formatting: 'union' };
  }
  return {
    comparison_data_formatting: 'union',
    filters: {
      simple: {},
      advanced: {
        op: 'and',
        filters: [{ op: 'eq', val: brand, col: 'CBF_ws_brand' }],
      },
    },
  };
}

/**
 * @typedef {object} FilterDimensionRegion
 * @property {null} id - Always null; no stable SpaceCat region ID exists.
 * @property {string} semrush_project_id - Semrush project UUID for this market.
 * @property {string} label - Human-readable market label (e.g. "AU-en").
 */

/**
 * Transforms the raw Semrush Markets element response into URL Inspector filter-dimension regions.
 * Each entry is enriched with SpaceCat brand and project metadata when a matching
 * BrandSemrushProject row exists (joined on semrushProjectId).
 *
 * @param {object} raw - Raw response from the Elements API.
 * @param {object[]} [brandSemrushProjects=[]] - Flattened BrandSemrushProject rows for the org,
 *   each with { brandId, semrushProjectId, geoTargetId, languageCode }.
 * @returns {FilterDimensionRegion[]}
 */
export function transformMarketsToFilterDimensions(raw, brandSemrushProjects = []) {
  // semrushProjectId is globally UNIQUE in brand_to_semrush_projects
  // (uq_brand_to_semrush_project) — one project ↔ one brand, so keying by it is safe.
  // Skip rows without a semrushProjectId so a null key can't swallow enrichment.
  const projectMap = new Map(
    brandSemrushProjects
      .filter((p) => p.semrushProjectId)
      .map((p) => [p.semrushProjectId, p]),
  );
  return (raw?.blocks?.value ?? []).map((item) => {
    const semrushProjectId = item.value || null;
    const project = (semrushProjectId && projectMap.get(semrushProjectId)) || {};
    const label = item.label ?? '';
    const id = label.includes('-') ? label.split('-')[0] : null;
    return {
      id,
      semrush_project_id: semrushProjectId,
      label,
      spacecat_brand_id: project.brandId ?? null,
      geoTargetId: project.geoTargetId ?? null,
      languageCode: project.languageCode ?? null,
    };
  });
}
