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
const DEFAULT_URL_LIMIT = 200;
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

const BP_SOURCES_SELECT = [
  'content_type',
  'execution_date',
  'source_urls!inner(url,hostname)',
  'brand_presence_executions!inner(prompt,category_name,region_code,topics)',
].join(',');

function buildDomainQuery(client, params) {
  const {
    siteId, domain, startDate, endDate, brandId,
  } = params;

  let q = client
    .from('brand_presence_sources')
    .select(BP_SOURCES_SELECT)
    .eq('site_id', siteId)
    .eq('source_urls.hostname', domain);

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
  const src = row.source_urls || {};
  return {
    url: src.url,
    content_type: row.content_type,
    prompt: exec.prompt,
    citation_count: 1,
    category: exec.category_name,
    region: exec.region_code,
    topics: exec.topics,
    week: dateToIsoWeek(row.execution_date),
    normalized_url_path: null,
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

function extractUrlPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** @internal Exported for testing */
export function aggregateDomainDetails(rows, params) {
  const filtered = applyJsFilters(rows, params);
  const urlLimit = params.urlLimit || DEFAULT_URL_LIMIT;

  const totalCitations = filtered.reduce((sum, r) => sum + (r.citation_count || 0), 0);
  const allUrls = new Set(filtered.map((r) => r.url).filter(Boolean));
  const totalUrls = allUrls.size;

  const promptKeys = new Set();
  filtered.forEach((r) => {
    promptKeys.add(`${r.prompt}|${r.region}|${r.topics}`);
  });
  const promptsCited = promptKeys.size;

  const ctCounts = new Map();
  filtered.forEach((r) => {
    const ct = r.content_type || 'unknown';
    ctCounts.set(ct, (ctCounts.get(ct) || 0) + 1);
  });
  let contentType = 'unknown';
  let maxCtCount = 0;
  ctCounts.forEach((count, ct) => {
    if (count > maxCtCount) {
      maxCtCount = count;
      contentType = ct;
    }
  });

  const urlMap = new Map();
  filtered.forEach((r) => {
    if (!r.url) return;
    if (!urlMap.has(r.url)) {
      urlMap.set(r.url, {
        citations: 0, promptKeys: new Set(), regions: new Set(), categories: new Set(),
      });
    }
    const entry = urlMap.get(r.url);
    entry.citations += r.citation_count || 0;
    entry.promptKeys.add(`${r.prompt}|${r.region}|${r.topics}`);
    if (r.region) entry.regions.add(r.region);
    if (r.category) entry.categories.add(r.category);
  });

  const totalUrlCount = urlMap.size;

  const urls = [...urlMap.entries()]
    .map(([url, entry]) => ({
      url,
      citations: entry.citations,
      promptsCited: entry.promptKeys.size,
      regions: [...entry.regions],
      categories: [...entry.categories],
    }))
    .sort((a, b) => b.citations - a.citations)
    .slice(0, urlLimit);

  const weekMap = new Map();
  filtered.forEach((r) => {
    if (!r.week) return;
    if (!weekMap.has(r.week)) {
      weekMap.set(r.week, { citations: 0, urls: new Set(), promptKeys: new Set() });
    }
    const entry = weekMap.get(r.week);
    entry.citations += r.citation_count || 0;
    if (r.url) entry.urls.add(r.url);
    entry.promptKeys.add(`${r.prompt}|${r.region}|${r.topics}`);
  });

  const sortedWeeks = [...weekMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const weeklyTrends = {
    weeklyDates: sortedWeeks.map(([w]) => w),
    totalCitations: sortedWeeks.map(([, e]) => e.citations),
    uniqueUrls: sortedWeeks.map(([, e]) => e.urls.size),
    promptsCited: sortedWeeks.map(([, e]) => e.promptKeys.size),
    citationsPerUrl: sortedWeeks.map(([, e]) => {
      const urlCount = e.urls.size;
      return urlCount > 0 ? Math.round((e.citations / urlCount) * 10) / 10 : 0;
    }),
  };

  const pathSet = new Set();
  filtered.forEach((r) => {
    const path = r.normalized_url_path || extractUrlPath(r.url);
    if (path) pathSet.add(path);
  });
  const urlPaths = [...pathSet].sort();

  return {
    domain: params.domain,
    totalCitations,
    totalUrls,
    promptsCited,
    contentType,
    urls,
    totalUrlCount,
    weeklyTrends,
    urlPaths,
  };
}

/**
 * GET /org/:spaceCatId/brands/:brandId/url-inspector/domain-details
 * Domain-level detail view with URLs, weekly trends, and URL paths.
 * @see elmo-ui/docs/api-specs/06-domain-details-dialog.md
 */
export function createDomainDetailsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'domain-details',
    async (ctx, client) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      if (!hasText(params.domain)) {
        return badRequest('domain query parameter is required');
      }

      const q = ctx.data || {};
      const urlLimit = q.urlLimit ? Number(q.urlLimit) : (params.limit || DEFAULT_URL_LIMIT);

      const { data, error } = await buildDomainQuery(client, params);

      if (error) {
        ctx.log.error(`URL Inspector domain-details PostgREST error: ${error.message}`);
        return badRequest(error.message);
      }

      const rows = (data || []).map(flattenRow);
      return ok(aggregateDomainDetails(rows, { ...params, urlLimit }));
    },
  );
}
