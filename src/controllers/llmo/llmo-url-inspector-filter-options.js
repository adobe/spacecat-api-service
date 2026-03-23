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

import { ok, badRequest } from '@adobe/spacecat-shared-http-utils';
import {
  withUrlInspectorAuth, parseUrlInspectorParams, requireSiteId, shouldApplyFilter,
} from './llmo-url-inspector.js';

const QUERY_LIMIT = 100000;

const CONTENT_TYPE_MAP = {
  competitor: 'others',
};

/**
 * Extracts distinct non-empty values from a column, splitting comma-separated
 * entries and sorting alphabetically.
 * @param {Array<Object>} rows - Query result rows
 * @param {string} key - Column name to extract
 * @returns {string[]} Sorted distinct values
 */
export function extractDistinct(rows, key) {
  const values = new Set();
  for (const row of rows) {
    const raw = row[key];
    if (raw != null && raw !== '') {
      const parts = String(raw).split(',');
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed) values.add(trimmed);
      }
    }
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

/**
 * Extracts distinct channel values from source rows, mapping DB values
 * (e.g. "competitor") to UI values (e.g. "others").
 * @param {Array<Object>} rows - Query result rows with content_type
 * @returns {string[]} Sorted distinct channel values
 */
export function extractDistinctChannels(rows) {
  const values = new Set();
  for (const row of rows) {
    const raw = row.content_type;
    if (raw != null && raw !== '') {
      const mapped = CONTENT_TYPE_MAP[raw] || raw;
      values.add(mapped);
    }
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

/**
 * GET /org/:spaceCatId/brands/:brandId/url-inspector/filter-options
 * Distinct filter values (regions, categories, channels) for dropdown population.
 *
 * Runs two parallel PostgREST queries:
 *   1. brand_presence_executions → category_name, region_code
 *   2. brand_presence_sources → content_type
 * Both filtered by siteId, date range, and optional platform.
 * Results are deduplicated, sorted alphabetically, with nulls/empty excluded.
 *
 * @see elmo-ui/docs/api-specs/07-filter-options.md
 */
export function createFilterOptionsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'filter-options',
    async (ctx, client) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      let execQuery = client
        .from('brand_presence_executions')
        .select('category_name, region_code')
        .eq('site_id', params.siteId);

      let srcQuery = client
        .from('brand_presence_sources')
        .select('content_type')
        .eq('site_id', params.siteId);

      if (params.startDate) {
        execQuery = execQuery.gte('execution_date', params.startDate);
        srcQuery = srcQuery.gte('execution_date', params.startDate);
      }
      if (params.endDate) {
        execQuery = execQuery.lte('execution_date', params.endDate);
        srcQuery = srcQuery.lte('execution_date', params.endDate);
      }
      if (shouldApplyFilter(params.platform)) {
        execQuery = execQuery.eq('model', params.platform);
        srcQuery = srcQuery.eq('model', params.platform);
      }
      if (params.brandId) {
        execQuery = execQuery.eq('brand_id', params.brandId);
      }

      const [execResult, srcResult] = await Promise.all([
        execQuery.limit(QUERY_LIMIT),
        srcQuery.limit(QUERY_LIMIT),
      ]);

      if (execResult.error) {
        ctx.log.error(`URL Inspector filter-options executions query error: ${execResult.error.message}`);
        return badRequest(execResult.error.message);
      }
      if (srcResult.error) {
        ctx.log.error(`URL Inspector filter-options sources query error: ${srcResult.error.message}`);
        return badRequest(srcResult.error.message);
      }

      const execRows = execResult.data || [];
      const srcRows = srcResult.data || [];

      return ok({
        regions: extractDistinct(execRows, 'region_code'),
        categories: extractDistinct(execRows, 'category_name'),
        channels: extractDistinctChannels(srcRows),
      });
    },
  );
}
