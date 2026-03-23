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

import { badRequest, ok } from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';
import {
  withUrlInspectorAuth, parseUrlInspectorParams, requireSiteId, shouldApplyFilter,
} from './llmo-url-inspector.js';

const QUERY_LIMIT = 50000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** @internal Exported for testing */
export function dateToIsoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d - yearStart) / MS_PER_DAY + 1) / 7);
  const year = d.getUTCFullYear();
  return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

/** @internal Exported for testing */
export function parseIsoWeek(weekStr) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekStr);
  if (!match) return { weekNumber: 0, year: 0 };
  return {
    year: Number.parseInt(match[1], 10),
    weekNumber: Number.parseInt(match[2], 10),
  };
}

const BP_SOURCES_SELECT = [
  'content_type',
  'execution_date',
  'source_urls!inner(url,hostname)',
  'brand_presence_executions!inner(prompt,category_name,region_code,topics)',
].join(',');

function buildUrlDetailsQuery(client, params) {
  const {
    siteId, url, startDate, endDate, brandId,
  } = params;

  let q = client
    .from('brand_presence_sources')
    .select(BP_SOURCES_SELECT)
    .eq('site_id', siteId)
    .eq('source_urls.url', url);

  if (hasText(startDate)) {
    q = q.gte('execution_date', startDate);
  }
  if (hasText(endDate)) {
    q = q.lte('execution_date', endDate);
  }
  if (brandId) {
    q = q.eq('brand_presence_executions.brand_id', brandId);
  }

  return q.limit(QUERY_LIMIT);
}

function flattenRow(row) {
  const exec = row.brand_presence_executions || {};
  return {
    content_type: row.content_type,
    prompt: exec.prompt,
    citation_count: 1,
    category: exec.category_name,
    region: exec.region_code,
    topics: exec.topics,
    week: dateToIsoWeek(row.execution_date),
  };
}

function applyJsFilters(rows, params) {
  let filtered = rows;
  if (shouldApplyFilter(params.category)) {
    filtered = filtered.filter((r) => r.category === params.category);
  }
  if (shouldApplyFilter(params.region)) {
    filtered = filtered.filter((r) => r.region === params.region);
  }
  if (shouldApplyFilter(params.channel)) {
    filtered = filtered.filter((r) => r.content_type === params.channel);
  }
  return filtered;
}

/** @internal Exported for testing */
export function aggregateUrlDetails(rows, params) {
  const isOwned = rows.some((r) => r.content_type === 'owned');
  const filtered = applyJsFilters(rows, params);

  const totalCitations = filtered.reduce((sum, r) => sum + (r.citation_count || 0), 0);

  const promptKeys = new Set();
  filtered.forEach((r) => {
    promptKeys.add(`${r.prompt}|${r.region}|${r.topics}`);
  });
  const promptsCited = promptKeys.size;

  const products = [...new Set(filtered.map((r) => r.category).filter(Boolean))];
  const regions = [...new Set(filtered.map((r) => r.region).filter(Boolean))];

  // Prompt citations: group by (prompt, category, region, topics)
  const promptMap = new Map();
  filtered.forEach((r) => {
    const key = `${r.prompt}|${r.category}|${r.region}|${r.topics}`;
    if (!promptMap.has(key)) {
      promptMap.set(key, {
        prompt: r.prompt,
        category: r.category,
        region: r.region,
        topics: r.topics,
        count: 0,
        weeks: new Set(),
      });
    }
    const entry = promptMap.get(key);
    entry.count += r.citation_count || 0;
    if (r.week) entry.weeks.add(r.week);
  });

  const promptCitations = [...promptMap.values()]
    .map((e) => ({
      prompt: e.prompt,
      count: e.count,
      id: `${e.topics}_${e.prompt}_${e.region}`,
      products: [e.category].filter(Boolean),
      topics: e.topics || '',
      region: e.region || '',
      executionCount: e.weeks.size,
    }))
    .sort((a, b) => b.count - a.count);

  // Weekly trends: group by week
  const weekMap = new Map();
  filtered.forEach((r) => {
    if (!r.week) return;
    if (!weekMap.has(r.week)) {
      weekMap.set(r.week, { citations: 0, promptKeys: new Set() });
    }
    const entry = weekMap.get(r.week);
    entry.citations += r.citation_count || 0;
    entry.promptKeys.add(`${r.prompt}|${r.region}|${r.topics}`);
  });

  const weeklyTrends = [...weekMap.entries()]
    .map(([week, entry]) => {
      const { year, weekNumber } = parseIsoWeek(week);
      return {
        week,
        weekNumber,
        year,
        totalCitations: entry.citations,
        totalPromptsCited: entry.promptKeys.size,
        uniqueUrls: 1,
      };
    })
    .sort((a, b) => a.week.localeCompare(b.week));

  return {
    url: params.url,
    isOwned,
    totalCitations,
    promptsCited,
    products,
    regions,
    promptCitations,
    weeklyTrends,
  };
}

/**
 * GET /org/:spaceCatId/brands/:brandId/url-inspector/url-details
 * Detailed citation data for a single URL.
 * @see elmo-ui/docs/api-specs/05-url-details-dialog.md
 */
export function createUrlDetailsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'url-details',
    async (ctx, client) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      if (!hasText(params.url)) {
        return badRequest('url query parameter is required');
      }

      const { data, error } = await buildUrlDetailsQuery(client, params);

      if (error) {
        ctx.log.error(`URL Inspector url-details PostgREST error: ${error.message}`);
        return badRequest(error.message);
      }

      const rows = (data || []).map(flattenRow);
      return ok(aggregateUrlDetails(rows, params));
    },
  );
}
