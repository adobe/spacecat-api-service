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
import { ErrorWithStatusCode } from '../../utils.js';

/**
 * Resolves and validates SEMRUSH_BP_ELEMENT_ID from the environment.
 * Throws ErrorWithStatusCode(503) when the env var is missing — mirrors the
 * same guard used for SEMRUSH_PROJECTS_BASE_URL in rest-transport.js.
 */
function resolveElementId(env) {
  const raw = typeof env?.SEMRUSH_BP_ELEMENT_ID === 'string'
    ? env.SEMRUSH_BP_ELEMENT_ID.trim()
    : env?.SEMRUSH_BP_ELEMENT_ID;
  if (!hasText(raw)) {
    throw new ErrorWithStatusCode(
      'SEMRUSH_BP_ELEMENT_ID is not set. Configure it via Vault '
      + '(dx_mysticat/<env>/api-service) or .env for local dev.',
      503,
    );
  }
  return raw;
}

/**
 * Builds the render_data body for a Brand Presence citation query.
 *
 * @param {string} semrushProjectId - The Semrush project id for this brand slice.
 * @param {string} urlFragment - URL fragment to filter by (contains match).
 * @param {string} domain - Domain to filter on (CBF_domain eq).
 * @param {string} startDate - ISO date string for start of range.
 * @param {string} endDate - ISO date string for end of range.
 * @returns {object} The render_data payload.
 */
function buildRenderData(semrushProjectId, urlFragment, domain, startDate, endDate) {
  return {
    comparison_data_formatting: 'join',
    project_id: semrushProjectId,
    filters: {
      simple: { project_id: semrushProjectId },
      advanced: {
        op: 'and',
        filters: [
          { col: 'source', op: 'contains', val: urlFragment },
          { op: 'eq', val: domain, col: 'CBF_domain' },
          { op: 'gte', val: startDate, col: 'CBF_date__start' },
          { op: 'lte', val: endDate, col: 'CBF_date__end' },
        ],
      },
    },
  };
}

/**
 * Extracts citation metrics from the raw Semrush BP API response.
 * The upstream response shape is: { data: { rows: [...], columns: [...] } }
 * or similar. We extract total citation count, per-day breakdown,
 * prompts-cited count, and the prompt list.
 *
 * When the upstream returns an unexpected shape we default to zero/empty
 * rather than throwing — partial data is better than a 500 for the caller.
 *
 * @param {object} raw - Raw response from queryBrandPresenceResults.
 * @returns {{ citations: number, citationsByDay: Array, promptsCited: number, prompts: Array }}
 */
function extractCitationMetrics(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      citations: 0, citationsByDay: [], promptsCited: 0, prompts: [],
    };
  }

  // The Semrush BP API returns rows in `data.rows` (array of objects).
  // Each row represents one prompt occurrence; it may carry fields like
  // `source` (cited URL), `CBF_date` (date), `prompt` (prompt text),
  // `domain` (domain), etc. The exact column names depend on the element
  // configuration — we treat them as best-effort and default to zero.
  const rows = Array.isArray(raw?.data?.rows) ? raw.data.rows : [];

  const citations = rows.length;
  const promptSet = new Set();
  const dayMap = new Map();

  for (const row of rows) {
    const prompt = row.prompt ?? row.Prompt ?? null;
    if (prompt) {
      promptSet.add(prompt);
    }
    const date = row.CBF_date ?? row.date ?? null;
    if (date) {
      dayMap.set(date, (dayMap.get(date) ?? 0) + 1);
    }
  }

  const citationsByDay = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  const prompts = [...promptSet].map((prompt) => ({ prompt }));
  const promptsCited = promptSet.size;

  return {
    citations, citationsByDay, promptsCited, prompts,
  };
}

/**
 * Queries Brand Presence citation data for a URL from Semrush.
 *
 * Iterates over all BrandSemrushProject rows for the brand (all market slices),
 * calls the BP reporting API for each, then merges the results.
 *
 * Returns null when:
 *   - dataAccess.BrandSemrushProject is unavailable
 *   - no project rows exist for the brand
 *
 * Throws ErrorWithStatusCode(503) when SEMRUSH_BP_ELEMENT_ID is not set.
 *
 * @param {object} transport - Serenity transport from createSerenityTransport.
 * @param {object} dataAccess - SpaceCat data access object.
 * @param {string} brandId - SpaceCat brand UUID.
 * @param {string} semrushWorkspaceId - Semrush workspace id for the org.
 * @param {object} env - Environment object (reads SEMRUSH_BP_ELEMENT_ID).
 * @param {object} query - Query parameters.
 * @param {string} query.urlFragment - URL or URL fragment to filter citations by.
 * @param {string} query.domain - Domain to filter on.
 * @param {string} query.startDate - ISO date for range start.
 * @param {string} query.endDate - ISO date for range end.
 * @returns {Promise<{citations: number, citationsByDay: Array,
 *   promptsCited: number, prompts: Array}|null>}
 */
export async function queryBpCitationsByUrl(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  env,
  query,
) {
  if (!dataAccess?.BrandSemrushProject) {
    return null;
  }

  const elementId = resolveElementId(env);

  const rows = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  if (!rows || rows.length === 0) {
    return {
      citations: 0, citationsByDay: [], promptsCited: 0, prompts: [],
    };
  }

  const {
    urlFragment, domain, startDate, endDate,
  } = query;

  const results = await Promise.all(
    rows.map(async (row) => {
      const semrushProjectId = row.getSemrushProjectId();
      const renderData = buildRenderData(
        semrushProjectId,
        urlFragment,
        domain,
        startDate,
        endDate,
      );
      const raw = await transport.queryBrandPresenceResults(
        semrushWorkspaceId,
        elementId,
        renderData,
      );
      return extractCitationMetrics(raw);
    }),
  );

  // Merge across slices: sum citations and prompts-cited, union prompts,
  // merge citationsByDay (sum by date).
  const dayTotals = new Map();
  const promptSet = new Set();
  let totalCitations = 0;

  for (const r of results) {
    totalCitations += r.citations;
    for (const { date, count } of r.citationsByDay) {
      dayTotals.set(date, (dayTotals.get(date) ?? 0) + count);
    }
    for (const { prompt } of r.prompts) {
      promptSet.add(prompt);
    }
  }

  const citationsByDay = [...dayTotals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  return {
    citations: totalCitations,
    citationsByDay,
    promptsCited: promptSet.size,
    prompts: [...promptSet].map((prompt) => ({ prompt })),
  };
}
