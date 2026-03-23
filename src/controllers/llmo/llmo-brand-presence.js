/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { ok, badRequest, forbidden } from '@adobe/spacecat-shared-http-utils';
import { hasText, isValidUUID } from '@adobe/spacecat-shared-utils';

/**
 * Brand Presence filter-dimensions handler for org-based routes.
 * Queries mysticat-data-service PostgreSQL via PostgREST.
 * spaceCatId = organization_id. brandId = 'all' or UUID.
 */

const SKIP_VALUES = new Set(['all', '', undefined, null, '*']);
const IN_FILTER_CHUNK_SIZE = 50;
const QUERY_LIMIT = 5000;
/** High row limit for weeks query — we need all rows to extract every distinct week (200K cap). */
const WEEKS_QUERY_LIMIT = 200000;

/**
 * Expected error message substrings from getOrgAndValidateAccess (see llmo-mysticat-controller).
 * Used for error classification; string matching is intentional until a shared error type exists.
 * @see llmo-mysticat-controller.js
 */
const ERR_ORG_ACCESS = 'belonging to the organization';
const ERR_NOT_FOUND = 'not found';

/**
 * Shared wrapper for Brand Presence handlers: PostgREST check + org access validation.
 * @param {Object} context - Request context (log, dataAccess, params, data)
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 * @param {string} handlerName - For error logging (e.g. 'weeks', 'filter-dimensions')
 * @param {Function} handlerFn - Async (context, client) => response. Receives PostgREST client.
 * @returns {Promise<Response>}
 */
async function withBrandPresenceAuth(context, getOrgAndValidateAccess, handlerName, handlerFn) {
  const { log, dataAccess } = context;
  const { Site } = dataAccess;

  if (!Site?.postgrestService) {
    log.error('Brand presence APIs require PostgREST (DATA_SERVICE_PROVIDER=postgres)');
    return badRequest('Brand presence data is not available. PostgreSQL data service is required.');
  }

  try {
    await getOrgAndValidateAccess(context);
  } catch (error) {
    if (error.message?.includes(ERR_ORG_ACCESS)) {
      return forbidden('Only users belonging to the organization can view brand presence data');
    }
    if (error.message?.includes(ERR_NOT_FOUND)) {
      return badRequest(error.message);
    }
    log.error(`Brand presence ${handlerName} error: ${error.message}`);
    return badRequest(error.message);
  }

  return handlerFn(context, Site.postgrestService);
}

/** @internal Exported for testing null/undefined fallbacks */
export const strCompare = (a, b) => (a || '').localeCompare(b || '');

function shouldApplyFilter(value) {
  if (value == null) return false;
  if (typeof value === 'string' && SKIP_VALUES.has(value.trim())) return false;
  return hasText(String(value));
}

/** @internal Exported for testing null/undefined fallbacks */
export function toFilterOption(id, label) {
  return { id: id ?? '', label: label ?? id ?? '' };
}

/**
 * Normalizes topicIds param to an array of valid UUIDs.
 * Accepts topicIds as: array, comma-separated string, or single UUID.
 * Non-UUID values are filtered out.
 * @returns {string[]} Array of valid topic_id UUIDs, empty if none
 */
function parseTopicIds(q) {
  const raw = q.topicIds;
  if (raw == null) return [];
  let arr;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string') {
    arr = raw.split(',').map((s) => s.trim());
  } else {
    arr = [raw];
  }
  return arr.filter((id) => id != null && isValidUUID(String(id)));
}

function parseFilterDimensionsParams(context) {
  const q = context.data || {};
  return {
    startDate: q.startDate || q.start_date,
    endDate: q.endDate || q.end_date,
    model: q.model || q.platform,
    siteId: q.siteId || q.site_id,
    categoryId: q.categoryId || q.category_id,
    topicIds: parseTopicIds(q),
    topic: q.topic,
    regionCode: q.regionCode || q.region_code || q.region,
    origin: q.origin,
    user_intent: q.user_intent || q.userIntent,
    branding: q.branding || q.promptBranding || q.prompt_branding,
    maxCompetitors: q.maxCompetitors || q.max_competitors,
  };
}

function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 28);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function buildExecutionsQuery(client, organizationId, params, defaults, filterByBrandId) {
  const startDate = params.startDate || defaults.startDate;
  const endDate = params.endDate || defaults.endDate;
  const model = params.model || 'chatgpt';
  const {
    siteId, categoryId, topicIds, regionCode, origin,
  } = params;

  let q = client
    .from('brand_presence_executions')
    .select('brand_id, brand_name, category_name, topic_id, topics, origin, region_code, site_id')
    .eq('organization_id', organizationId)
    .gte('execution_date', startDate)
    .lte('execution_date', endDate)
    .eq('model', model);

  if (shouldApplyFilter(siteId)) {
    q = q.eq('site_id', siteId);
  }
  if (filterByBrandId) {
    q = q.eq('brand_id', filterByBrandId);
  }
  if (shouldApplyFilter(categoryId)) {
    q = isValidUUID(categoryId) ? q.eq('category_id', categoryId) : q.eq('category_name', categoryId);
  }
  if (topicIds?.length > 0) {
    q = q.in('topic_id', topicIds);
  }
  if (shouldApplyFilter(regionCode)) {
    q = q.eq('region_code', regionCode);
  }
  if (shouldApplyFilter(origin)) {
    q = q.ilike('origin', origin);
  }

  return q.limit(QUERY_LIMIT);
}

/**
 * Validates that the given site belongs to the organization.
 * Used to prevent cross-tenant access when siteId is used in page_intents query.
 * @returns {Promise<boolean>} true if site exists in org, false otherwise
 * @internal Exported for testing early-return paths
 */
export async function validateSiteBelongsToOrg(client, organizationId, siteId) {
  if (!shouldApplyFilter(siteId)) return true;
  const { data, error } = await client
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('organization_id', organizationId)
    .limit(1);
  return !error && data?.length === 1;
}

/** @internal Exported for testing sites-query path coverage */
export async function resolveSiteIds(client, organizationId, siteId, filterByBrandId, rows) {
  if (shouldApplyFilter(siteId)) {
    return [siteId];
  }
  if (filterByBrandId) {
    return [...new Set(rows.map((r) => r.site_id).filter(Boolean))];
  }
  const { data: sitesData, error: sitesError } = await client
    .from('sites')
    .select('id')
    .eq('organization_id', organizationId)
    .limit(QUERY_LIMIT);
  if (!sitesError && sitesData?.length) {
    return sitesData.map((s) => s.id).filter(Boolean);
  }
  return [];
}

async function fetchPageIntents(client, organizationId, siteId, filterByBrandId, siteIds) {
  if (shouldApplyFilter(siteId)) {
    const { data: piData, error: piError } = await client
      .from('page_intents')
      .select('page_intent')
      .eq('site_id', siteId)
      .limit(QUERY_LIMIT);
    if (!piError && piData?.length) {
      const intents = [...new Set(piData.map((r) => r.page_intent).filter(Boolean))];
      const sorted = intents.toSorted(strCompare);
      return sorted.map((p) => toFilterOption(p, p));
    }
  } else if (!filterByBrandId) {
    const { data: piData, error: piError } = await client
      .from('page_intents')
      .select('page_intent,sites!inner(organization_id)')
      .eq('sites.organization_id', organizationId)
      .limit(QUERY_LIMIT);
    if (!piError && piData?.length) {
      const intents = [...new Set(piData.map((r) => r.page_intent).filter(Boolean))];
      const sorted = intents.toSorted(strCompare);
      return sorted.map((p) => toFilterOption(p, p));
    }
  } else if (siteIds.length > 0) {
    const chunks = [];
    for (let i = 0; i < siteIds.length; i += IN_FILTER_CHUNK_SIZE) {
      chunks.push(siteIds.slice(i, i + IN_FILTER_CHUNK_SIZE));
    }
    const results = await Promise.all(chunks.map((chunk) => client
      .from('page_intents')
      .select('page_intent')
      .in('site_id', chunk)
      .limit(QUERY_LIMIT)));
    const allIntents = new Set();
    results.forEach(({ data: piData, error: piError }) => {
      if (!piError && piData?.length) {
        piData.forEach((r) => r.page_intent && allIntents.add(r.page_intent));
      }
    });
    const sorted = [...allIntents].toSorted(strCompare);
    return sorted.map((p) => toFilterOption(p, p));
  }
  return [];
}

function buildDimensionOptions(rows) {
  const brands = [];
  const brandIds = new Set();
  rows.forEach((r) => {
    if (r.brand_id && r.brand_name && !brandIds.has(r.brand_id)) {
      brandIds.add(r.brand_id);
      brands.push(toFilterOption(r.brand_id, r.brand_name));
    }
  });
  const sortedBrands = brands.toSorted((a, b) => strCompare(a.label, b.label));

  const catNames = [...new Set(rows.map((r) => r.category_name).filter(Boolean))];
  const categories = catNames.toSorted(strCompare).map((c) => toFilterOption(c, c));

  const topicEntries = new Map();
  rows.forEach((r) => {
    if (r.topic_id && !topicEntries.has(r.topic_id)) {
      topicEntries.set(r.topic_id, r.topics || r.topic_id);
    }
  });
  const topics = [...topicEntries.entries()]
    .toSorted((a, b) => strCompare(a[1], b[1]))
    .map(([id, label]) => toFilterOption(id, label));

  const originVals = [...new Set(
    rows.map((r) => r.origin).filter(Boolean).map((o) => o.toLowerCase()),
  )];
  const origins = originVals.toSorted(strCompare).map((o) => toFilterOption(o, o));

  const regionVals = [...new Set(rows.map((r) => r.region_code).filter(Boolean))];
  const regions = regionVals.toSorted(strCompare).map((r) => toFilterOption(r, r));

  return {
    brands: sortedBrands,
    categories,
    topics,
    origins,
    regions,
  };
}

function parseWeeksParams(context) {
  const q = context.data || {};
  return {
    model: q.model || q.platform,
    siteId: q.siteId || q.site_id,
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TRENDS_MAX_WEEKS = 8;
const TRENDS_WEEK_SIZE = 7;

/**
 * Adds days to a YYYY-MM-DD date string. Uses UTC noon to avoid DST edge cases.
 * @param {string} dateStr - YYYY-MM-DD
 * @param {number} days - Number of days to add (negative to subtract)
 * @returns {string} YYYY-MM-DD
 * @internal Exported for testing
 */
export function addDaysToDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Splits a date range into 7-day weeks, building backward from endDate.
 * Returns at most maxWeeks (8) weeks, ordered oldest-first (chronological).
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @param {number} weekSize - Days per week (default 7)
 * @param {number} maxWeeks - Max weeks to return (default 8)
 * @returns {Array<{ startDate: string, endDate: string }>}
 * @internal Exported for testing
 */
export function splitDateRangeIntoWeeksBackward(
  startDate,
  endDate,
  weekSize = TRENDS_WEEK_SIZE,
  maxWeeks = TRENDS_MAX_WEEKS,
) {
  const weeks = [];
  let weekEnd = endDate;
  let weekStart = addDaysToDate(weekEnd, -weekSize + 1);

  while (weekEnd >= startDate) {
    const actualStart = weekStart < startDate ? startDate : weekStart;
    if (actualStart <= weekEnd) {
      weeks.push({ startDate: actualStart, endDate: weekEnd });
    }
    weekEnd = addDaysToDate(weekStart, -1);
    weekStart = addDaysToDate(weekEnd, -weekSize + 1);
  }

  weeks.reverse();
  return weeks.slice(-maxWeeks);
}

/**
 * Returns startDate (Monday) and endDate (Sunday) for an ISO week string (YYYY-Wnn).
 * Uses Date.UTC for timezone-independent calendar dates.
 * @param {string} isoWeek - e.g. "2026-W11"
 * @returns {{ startDate: string, endDate: string } | null} - YYYY-MM-DD or null if invalid
 * @internal Exported for testing
 */
export function getWeekDateRange(isoWeek) {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const week = Number.parseInt(match[2], 10);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const week1MondayMs = jan4.getTime() + mondayOffset * MS_PER_DAY;
  const targetMondayMs = week1MondayMs + (week - 1) * 7 * MS_PER_DAY;
  const targetSundayMs = targetMondayMs + 6 * MS_PER_DAY;
  const toYMD = (ms) => {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return {
    startDate: toYMD(targetMondayMs),
    endDate: toYMD(targetSundayMs),
  };
}

/**
 * Builds a query to fetch week values from brand_metrics_weekly.
 * Table already has week in YYYY-Wnn format; filters: organization_id, model, site_id, brand_id.
 */
function buildWeeksQuery(client, organizationId, model, siteId, filterByBrandId) {
  let q = client
    .from('brand_metrics_weekly')
    .select('week')
    .eq('organization_id', organizationId)
    .eq('model', model);

  if (shouldApplyFilter(siteId)) {
    q = q.eq('site_id', siteId);
  }
  if (filterByBrandId) {
    q = q.eq('brand_id', filterByBrandId);
  }

  return q.order('week', { ascending: false }).limit(WEEKS_QUERY_LIMIT);
}

/**
 * Creates the getBrandPresenceWeeks handler.
 * Returns distinct ISO weeks (YYYY-Wnn) for the given model, optionally filtered by brand or site.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createBrandPresenceWeeksHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'weeks',
    async (ctx, client) => {
      const params = parseWeeksParams(ctx);
      const { model: modelParam, siteId } = params;
      const model = modelParam || 'chatgpt';
      const { spaceCatId, brandId } = ctx.params;
      const organizationId = spaceCatId;
      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;

      if (shouldApplyFilter(siteId)) {
        const siteBelongsToOrg = await validateSiteBelongsToOrg(client, organizationId, siteId);
        if (!siteBelongsToOrg) {
          return forbidden('Site does not belong to the organization');
        }
      }

      const q = buildWeeksQuery(client, organizationId, model, siteId, filterByBrandId);
      const { data, error } = await q;

      if (error) {
        ctx.log.error(`Brand presence weeks PostgREST error: ${error.message}`);
        return badRequest(error.message);
      }

      const rows = data || [];
      const weekSet = new Set();
      rows.forEach((r) => {
        const w = r.week;
        if (w && typeof w === 'string') weekSet.add(w);
      });
      const sortedWeeks = [...weekSet].sort((a, b) => b.localeCompare(a));
      const weeks = sortedWeeks.map((weekStr) => {
        const range = getWeekDateRange(weekStr);
        return {
          week: weekStr,
          startDate: range?.startDate ?? null,
          endDate: range?.endDate ?? null,
        };
      });

      return ok({ weeks });
    },
  );
}

// ── Market Tracking Trends ──────────────────────────────────────────────────

function parseMarketTrackingTrendsParams(context) {
  const q = context.data || {};
  return {
    startDate: q.startDate || q.start_date,
    endDate: q.endDate || q.end_date,
    model: q.model,
    siteId: q.siteId || q.site_id,
    categoryId: q.categoryId || q.category_id,
    regionCode: q.regionCode || q.region_code || q.region,
  };
}

/**
 * Converts a date string (YYYY-MM-DD) to an ISO week string (YYYY-Wnn).
 * @param {string} dateStr - e.g. "2026-03-15"
 * @returns {string} e.g. "2026-W11"
 * @internal Exported for testing
 */
export function dateToIsoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d - yearStart) / MS_PER_DAY + 1) / 7);
  const year = d.getUTCFullYear();
  return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

function parseIsoWeek(weekStr) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekStr);
  if (!match) return { weekNumber: 0, year: 0 };
  return {
    year: Number.parseInt(match[1], 10),
    weekNumber: Number.parseInt(match[2], 10),
  };
}

/**
 * Queries brand_presence_executions for raw execution rows.
 * Mirrors the legacy UI approach which reads from the brand_all sheet
 * (equivalent to brand_presence_executions) and deduplicates by unique prompt
 * before counting mentions and citations per week.
 *
 * Deduplication key: prompt|topics|region_code|site_id — matches the legacy UI
 * composite key (prompt|Region|Topics|siteId).
 *
 * TODO: Once prompt_id is populated on brand_presence_executions, replace the
 * composite-key deduplication with a simple distinct count on prompt_id for
 * better performance and correctness.
 */
function buildBrandExecutionsQuery(client, organizationId, params, defaults, filterByBrandId) {
  const startDate = params.startDate || defaults.startDate;
  const endDate = params.endDate || defaults.endDate;
  const model = params.model || 'chatgpt';
  const {
    siteId, categoryId, regionCode,
  } = params;

  let q = client
    .from('brand_presence_executions')
    .select('execution_date, prompt, topics, region_code, site_id, mentions, citations')
    .eq('organization_id', organizationId)
    .eq('model', model)
    .gte('execution_date', startDate)
    .lte('execution_date', endDate);

  if (shouldApplyFilter(siteId)) {
    q = q.eq('site_id', siteId);
  }
  if (filterByBrandId) {
    q = q.eq('brand_id', filterByBrandId);
  }
  if (shouldApplyFilter(categoryId)) {
    q = isValidUUID(categoryId) ? q.eq('category_id', categoryId) : q.eq('category_name', categoryId);
  }
  if (shouldApplyFilter(regionCode)) {
    q = q.eq('region_code', regionCode);
  }

  return q;
}

function buildCompetitorDataQuery(client, organizationId, params, defaults, filterByBrandId) {
  const startDate = params.startDate || defaults.startDate;
  const endDate = params.endDate || defaults.endDate;
  const model = params.model || 'chatgpt';
  const {
    siteId, categoryId, regionCode,
  } = params;

  let q = client
    .from('executions_competitor_data')
    .select('execution_date, competitor, mentions, citations')
    .eq('organization_id', organizationId)
    .eq('model', model)
    .gte('execution_date', startDate)
    .lte('execution_date', endDate);

  if (shouldApplyFilter(siteId)) {
    q = q.eq('site_id', siteId);
  }
  if (filterByBrandId) {
    q = q.eq('brand_id', filterByBrandId);
  }
  if (shouldApplyFilter(categoryId)) {
    q = isValidUUID(categoryId) ? q.eq('category_id', categoryId) : q.eq('category_name', categoryId);
  }
  if (shouldApplyFilter(regionCode)) {
    q = q.eq('region_code', regionCode);
  }

  return q;
}

function aggregateWeeklyTrends(brandRows, competitorRows) {
  // Deduplicate brand rows by unique prompt key per week before counting.
  // Key: prompt|topics|region_code|site_id — mirrors the legacy UI composite key.
  const brandByWeek = new Map();
  brandRows.forEach((r) => {
    if (!r.execution_date) return;
    const w = dateToIsoWeek(String(r.execution_date));
    if (!brandByWeek.has(w)) {
      brandByWeek.set(w, { mentionKeys: new Set(), citationKeys: new Set() });
    }
    const bucket = brandByWeek.get(w);
    const key = `${r.prompt || ''}|${r.topics || ''}|${r.region_code || ''}|${r.site_id || ''}`;
    if (r.mentions === true || r.mentions === 'true') bucket.mentionKeys.add(key);
    if (r.citations === true || r.citations === 'true') bucket.citationKeys.add(key);
  });

  const competitorByWeek = new Map();
  competitorRows.forEach((r) => {
    if (!r.execution_date || !r.competitor) return;
    const week = dateToIsoWeek(String(r.execution_date));
    if (!competitorByWeek.has(week)) {
      competitorByWeek.set(week, new Map());
    }
    const weekMap = competitorByWeek.get(week);
    const existing = weekMap.get(r.competitor) || { mentions: 0, citations: 0 };
    existing.mentions += r.mentions || 0;
    existing.citations += r.citations || 0;
    weekMap.set(r.competitor, existing);
  });

  const allWeeks = new Set([...brandByWeek.keys(), ...competitorByWeek.keys()]);
  return [...allWeeks].sort().map((weekStr) => {
    const { weekNumber, year } = parseIsoWeek(weekStr);
    const brandBucket = brandByWeek.get(weekStr);
    const brand = brandBucket
      ? { mentions: brandBucket.mentionKeys.size, citations: brandBucket.citationKeys.size }
      : { mentions: 0, citations: 0 };
    const competitorMap = competitorByWeek.get(weekStr) || new Map();

    const competitors = [...competitorMap.entries()]
      .map(([name, data]) => ({ name, mentions: data.mentions, citations: data.citations }))
      .sort((a, b) => (b.mentions + b.citations) - (a.mentions + a.citations));

    return {
      week: weekStr,
      weekNumber,
      year,
      mentions: brand.mentions,
      citations: brand.citations,
      competitors,
    };
  });
}

/**
 * Creates the getMarketTrackingTrends handler.
 * Returns weekly brand mentions/citations + per-competitor breakdowns.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createMarketTrackingTrendsHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'market-tracking-trends',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseMarketTrackingTrendsParams(ctx);
      const defaults = defaultDateRange();
      const organizationId = spaceCatId;
      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;

      if (shouldApplyFilter(params.siteId)) {
        const siteBelongsToOrg = await validateSiteBelongsToOrg(
          client,
          organizationId,
          params.siteId,
        );
        if (!siteBelongsToOrg) {
          return forbidden('Site does not belong to the organization');
        }
      }

      // eslint-disable-next-line max-len
      const brandQuery = buildBrandExecutionsQuery(client, organizationId, params, defaults, filterByBrandId);
      // eslint-disable-next-line max-len
      const competitorQuery = buildCompetitorDataQuery(client, organizationId, params, defaults, filterByBrandId);

      const [brandResult, competitorResult] = await Promise.all([brandQuery, competitorQuery]);

      if (brandResult.error) {
        ctx.log.error(`Market-tracking-trends brand query error: ${brandResult.error.message}`);
        return badRequest(brandResult.error.message);
      }
      if (competitorResult.error) {
        ctx.log.error(`Market-tracking-trends competitor query error: ${competitorResult.error.message}`);
        return badRequest(competitorResult.error.message);
      }

      const weeklyTrends = aggregateWeeklyTrends(
        brandResult.data || [],
        competitorResult.data || [],
      );

      return ok({
        weeklyTrends,
        weeklyTrendsForComparison: weeklyTrends,
      });
    },
  );
}

/**
 * Converts a YYYY-MM-DD date string to an ISO week object.
 * @param {string} dateStr - e.g. "2026-03-11"
 * @returns {{ week: string, weekNumber: number, year: number }}
 * @internal Exported for testing
 */
export function toISOWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const thursday = new Date(d);
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((thursday - yearStart) / MS_PER_DAY + 1) / 7);
  const year = thursday.getUTCFullYear();
  return { week: `${year}-W${String(weekNumber).padStart(2, '0')}`, weekNumber, year };
}

const SENTIMENT_COLORS = {
  positive: '#047857',
  neutral: '#4B5563',
  negative: '#B91C1C',
};

/**
 * Builds a deduplication key matching the original UI's `buildPromptKey`:
 *   prompt | region | topics
 * @internal Exported for testing
 */
export function buildPromptKey(row) {
  const prompt = row.prompt || '';
  const region = row.region_code || 'Unknown';
  const topics = row.topics || 'Unknown';
  return `${prompt}|${region}|${topics}`;
}

/**
 * Aggregates execution rows into per-week sentiment percentages.
 * Deduplicates by (prompt, region_code, topics) within each week to match
 * the original brand-presence UI which counts unique prompts, not raw rows.
 * When the same prompt appears for multiple brands, only the first-seen
 * sentiment is used — this avoids inflating counts when using brands=all.
 *
 * @param {Array<{execution_date: string, sentiment: string|null, prompt: string|null,
 *   region_code: string|null, topics: string|null}>} rows
 * @returns {Array<Object>} weeklyTrends sorted by week ascending
 * @internal Exported for testing
 */
export function aggregateSentimentByWeek(rows) {
  const weekMap = new Map();

  rows.forEach((row) => {
    const { week, weekNumber, year } = toISOWeek(row.execution_date);
    if (!weekMap.has(week)) {
      weekMap.set(week, {
        week,
        weekNumber,
        year,
        positive: 0,
        neutral: 0,
        negative: 0,
        totalPrompts: 0,
        promptsWithSentiment: 0,
        seenKeys: new Set(),
      });
    }
    const entry = weekMap.get(week);

    const key = buildPromptKey(row);
    if (entry.seenKeys.has(key)) return;
    entry.seenKeys.add(key);

    entry.totalPrompts += 1;

    const sentiment = (row.sentiment || '').toLowerCase().trim();
    if (sentiment === 'positive') {
      entry.positive += 1;
      entry.promptsWithSentiment += 1;
    } else if (sentiment === 'neutral') {
      entry.neutral += 1;
      entry.promptsWithSentiment += 1;
    } else if (sentiment === 'negative') {
      entry.negative += 1;
      entry.promptsWithSentiment += 1;
    }
  });

  return [...weekMap.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((entry) => {
      const total = entry.promptsWithSentiment;
      const positivePct = total > 0 ? Math.round((entry.positive / total) * 100) : 0;
      const negativePct = total > 0 ? Math.round((entry.negative / total) * 100) : 0;
      const neutralPct = total > 0 ? 100 - positivePct - negativePct : 0;

      return {
        week: entry.week,
        weekNumber: entry.weekNumber,
        year: entry.year,
        sentiment: [
          { name: 'Positive', value: positivePct, color: SENTIMENT_COLORS.positive },
          { name: 'Neutral', value: neutralPct, color: SENTIMENT_COLORS.neutral },
          { name: 'Negative', value: negativePct, color: SENTIMENT_COLORS.negative },
        ],
        totalPrompts: entry.totalPrompts,
        promptsWithSentiment: entry.promptsWithSentiment,
        mentions: 0,
        citations: 0,
        visibilityScore: 0,
        competitors: [],
      };
    });
}

/**
 * Creates the getSentimentOverview handler.
 * Returns per-week sentiment counts (positive, neutral, negative) and prompt metrics.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createSentimentOverviewHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'sentiment-overview',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const defaults = defaultDateRange();
      const organizationId = spaceCatId;
      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;

      const startDate = params.startDate || defaults.startDate;
      const endDate = params.endDate || defaults.endDate;
      const model = params.model || 'chatgpt';

      let q = client
        .from('brand_presence_executions')
        .select('execution_date, sentiment, prompt, region_code, topics')
        .eq('organization_id', organizationId)
        .gte('execution_date', startDate)
        .lte('execution_date', endDate)
        .eq('model', model);

      if (shouldApplyFilter(params.siteId)) q = q.eq('site_id', params.siteId);
      if (filterByBrandId) q = q.eq('brand_id', filterByBrandId);
      if (shouldApplyFilter(params.categoryId)) {
        q = isValidUUID(params.categoryId)
          ? q.eq('category_id', params.categoryId)
          : q.eq('category_name', params.categoryId);
      }
      if (params.topicIds?.length > 0) q = q.in('topic_id', params.topicIds);
      if (shouldApplyFilter(params.regionCode)) q = q.eq('region_code', params.regionCode);
      if (shouldApplyFilter(params.origin)) q = q.ilike('origin', params.origin);

      const { data, error } = await q.limit(WEEKS_QUERY_LIMIT);

      if (error) {
        ctx.log.error(`Brand presence sentiment-overview PostgREST error: ${error.message}`);
        return badRequest(error.message);
      }

      if (shouldApplyFilter(params.siteId)) {
        const siteBelongsToOrg = await validateSiteBelongsToOrg(
          client,
          organizationId,
          params.siteId,
        );
        if (!siteBelongsToOrg) {
          return forbidden('Site does not belong to the organization');
        }
      }

      const weeklyTrends = aggregateSentimentByWeek(data || []);
      return ok({ weeklyTrends });
    },
  );
}

// ── Topics (Data Insights Table) ────────────────────────────────────────────

const SORT_FIELD_MAP = {
  name: 'topic',
  visibility: 'averageVisibilityScore',
  mentions: 'brandMentions',
  citations: 'brandCitations',
  sentiment: 'averageSentiment',
  popularity: 'popularityVolume',
  position: 'averagePosition',
};

/**
 * Builds a deduplication key for prompts within a single topic.
 * Since all rows in the group already share the same topic name,
 * the dedup key is prompt|region_code (not including topics).
 * @internal Exported for testing
 */
export function buildTopicPromptKey(row) {
  const prompt = row.prompt || '';
  const region = row.region_code || 'Unknown';
  return `${prompt}|${region}`;
}

/**
 * Converts the average of imputed volume values to a categorical label.
 * Backend encoding: -30 = High, -20 = Medium, -10 = Low.
 * @param {number} volumeSum - Sum of volume values
 * @param {number} volumeCount - Number of volume values
 * @returns {string} 'High', 'Medium', 'Low', or 'N/A'
 */
function volumeToCategory(volumeSum, volumeCount) {
  if (volumeCount === 0) return 'N/A';
  const avg = volumeSum / volumeCount;
  if (avg <= -25) return 'High';
  if (avg <= -15) return 'Medium';
  if (avg < 0) return 'Low';
  return 'N/A';
}

/**
 * Aggregates raw execution rows into topic-level summary objects.
 * Groups by topic name, deduplicates prompts by prompt|region_code within
 * each topic, keeps the latest execution per unique prompt, and computes
 * topic-level aggregate metrics. Does NOT return individual prompt items
 * (those are loaded separately via the /topics/:topicId/prompts endpoint).
 *
 * @param {Array<Object>} rows - Raw brand_presence_executions rows
 *   (with embedded brand_presence_sources)
 * @returns {Array<Object>} TopicDetail-compatible objects (without items)
 * @internal Exported for testing
 */
export function aggregateTopicData(rows) {
  // First pass: group ALL rows by topic and accumulate counts from every
  // execution (matching the original UI which counts across all dates).
  const topicAgg = new Map();

  rows.forEach((row) => {
    const topicName = row.topics || 'Unknown';
    if (!topicAgg.has(topicName)) {
      topicAgg.set(topicName, {
        promptMap: new Map(),
        totalMentions: 0,
        totalCitations: 0,
        uniqueSourceUrlIds: new Set(),
        visibilitySum: 0,
        visibilityCount: 0,
        positionSum: 0,
        positionCount: 0,
        sentimentSum: 0,
        sentimentCount: 0,
        volumeSum: 0,
        volumeCount: 0,
      });
    }
    const agg = topicAgg.get(topicName);

    // Dedup prompts (keep latest execution) — used only for promptCount
    const key = buildTopicPromptKey(row);
    const existing = agg.promptMap.get(key);
    if (!existing || (row.execution_date > existing.execution_date)) {
      agg.promptMap.set(key, row);
    }

    // Count mentions/citations from EVERY execution row
    if (row.mentions === true || row.mentions === 'true') agg.totalMentions += 1;
    if (row.citations === true || row.citations === 'true') agg.totalCitations += 1;

    if (Array.isArray(row.brand_presence_sources)) {
      row.brand_presence_sources.forEach((s) => {
        if (s.url_id) agg.uniqueSourceUrlIds.add(s.url_id);
      });
    }

    const vs = row.visibility_score != null ? Number(row.visibility_score) : NaN;
    if (!Number.isNaN(vs)) {
      agg.visibilitySum += vs;
      agg.visibilityCount += 1;
    }

    const pos = row.position;
    if (pos && pos !== 'Not Mentioned' && /^\d+\.?\d*$/.test(String(pos))) {
      agg.positionSum += Number(pos);
      agg.positionCount += 1;
    }

    const sentiment = (row.sentiment || '').toLowerCase().trim();
    if (sentiment === 'positive') {
      agg.sentimentSum += 100;
      agg.sentimentCount += 1;
    } else if (sentiment === 'neutral') {
      agg.sentimentSum += 50;
      agg.sentimentCount += 1;
    } else if (sentiment === 'negative') {
      agg.sentimentCount += 1;
    }

    const vol = row.volume != null ? Number(row.volume) : NaN;
    if (!Number.isNaN(vol)) {
      agg.volumeSum += vol;
      agg.volumeCount += 1;
    }
  });

  return [...topicAgg.entries()].map(([topicName, agg]) => {
    const avgVisibility = agg.visibilityCount > 0
      ? Math.round((agg.visibilitySum / agg.visibilityCount) * 100) / 100 : 0;
    const avgPosition = agg.positionCount > 0
      ? Math.round((agg.positionSum / agg.positionCount) * 100) / 100 : 0;
    const avgSentiment = agg.sentimentCount > 0
      ? Math.round(agg.sentimentSum / agg.sentimentCount) : -1;
    const avgVolume = volumeToCategory(agg.volumeSum, agg.volumeCount);

    return {
      topic: topicName,
      promptCount: agg.promptMap.size,
      brandMentions: agg.totalMentions,
      brandCitations: agg.totalCitations,
      sourceCount: agg.uniqueSourceUrlIds.size,
      popularityVolume: avgVolume,
      averageVisibilityScore: avgVisibility,
      averagePosition: avgPosition,
      averageSentiment: avgSentiment,
    };
  });
}

/**
 * Builds PromptDetail items from raw execution rows for a specific topic.
 * Deduplicates by prompt|region_code, keeping the latest execution.
 *
 * @param {Array<Object>} rows - Raw brand_presence_executions rows (pre-filtered by topic)
 * @returns {Array<Object>} PromptDetail-compatible objects
 * @internal Exported for testing
 */
export function buildPromptDetails(rows) {
  const promptMap = new Map();

  rows.forEach((row) => {
    const key = buildTopicPromptKey(row);
    const existing = promptMap.get(key);
    if (!existing || (row.execution_date > existing.execution_date)) {
      promptMap.set(key, row);
    }
  });

  return [...promptMap.values()].map((r) => {
    const mentioned = r.mentions === true || r.mentions === 'true';
    const cited = r.citations === true || r.citations === 'true';
    const vs = r.visibility_score != null ? Number(r.visibility_score) : NaN;

    return {
      topic: r.topics || 'Unknown',
      prompt: r.prompt || '',
      region: r.region_code || '',
      category: r.category_name || '',
      executionDate: r.execution_date || '',
      answer: '',
      sources: '',
      relatedURL: r.url || '',
      citationsCount: cited ? 1 : 0,
      mentionsCount: mentioned ? 1 : 0,
      isAnswered: !(r.error_code),
      visibilityScore: Number.isNaN(vs) ? 0 : vs,
      position: r.position ? String(r.position) : '',
      sentiment: r.sentiment || '',
      errorCode: r.error_code || '',
      origin: r.origin || '',
    };
  });
}

function parsePaginationParams(context) {
  const q = context.data || {};
  return {
    sortBy: q.sortBy || 'name',
    sortOrder: q.sortOrder || 'asc',
    page: Number.parseInt(q.page, 10) || 0,
    pageSize: Number.parseInt(q.pageSize, 10) || 20,
  };
}

function sortTopicDetails(topicDetails, sortBy, sortOrder) {
  const field = SORT_FIELD_MAP[sortBy] || 'topic';
  const dir = sortOrder === 'desc' ? -1 : 1;

  return topicDetails.sort((a, b) => {
    const va = a[field];
    const vb = b[field];
    if (typeof va === 'string' && typeof vb === 'string') {
      return dir * va.localeCompare(vb);
    }
    return dir * ((Number(va) || 0) - (Number(vb) || 0));
  });
}

// eslint-disable-next-line max-len
const TOPICS_SELECT = 'id, topics, prompt, region_code, mentions, citations, visibility_score, position, sentiment, volume, origin, category_name, execution_date, url, error_code, brand_presence_sources(url_id)';

/**
 * Creates the getTopics handler.
 * Returns topic-level aggregated data (without individual prompts) for the
 * Data Insights table. Supports pagination, sorting, and filtering.
 * Prompts are loaded separately via the /topics/:topicId/prompts endpoint.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createTopicsHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'topics',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const pagination = parsePaginationParams(ctx);
      const defaults = defaultDateRange();
      const organizationId = spaceCatId;
      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;

      const startDate = params.startDate || defaults.startDate;
      const endDate = params.endDate || defaults.endDate;
      const model = params.model || 'chatgpt';

      let q = client
        .from('brand_presence_executions')
        .select(TOPICS_SELECT)
        .eq('organization_id', organizationId)
        .gte('execution_date', startDate)
        .lte('execution_date', endDate)
        .eq('model', model);

      if (shouldApplyFilter(params.siteId)) q = q.eq('site_id', params.siteId);
      if (filterByBrandId) q = q.eq('brand_id', filterByBrandId);
      if (shouldApplyFilter(params.categoryId)) {
        q = isValidUUID(params.categoryId)
          ? q.eq('category_id', params.categoryId)
          : q.eq('category_name', params.categoryId);
      }
      if (shouldApplyFilter(params.topic)) q = q.eq('topics', params.topic);
      if (params.topicIds?.length > 0) q = q.in('topic_id', params.topicIds);
      if (shouldApplyFilter(params.regionCode)) {
        q = q.eq('region_code', params.regionCode);
      }
      if (shouldApplyFilter(params.origin)) q = q.ilike('origin', params.origin);

      const { data, error } = await q.limit(WEEKS_QUERY_LIMIT);

      if (error) {
        ctx.log.error(`Brand presence topics PostgREST error: ${error.message}`);
        return badRequest(error.message);
      }

      if (shouldApplyFilter(params.siteId)) {
        const siteBelongsToOrg = await validateSiteBelongsToOrg(
          client,
          organizationId,
          params.siteId,
        );
        if (!siteBelongsToOrg) {
          return forbidden('Site does not belong to the organization');
        }
      }

      const topicDetails = aggregateTopicData(data || []);
      sortTopicDetails(topicDetails, pagination.sortBy, pagination.sortOrder);

      const totalCount = topicDetails.length;
      const start = pagination.page * pagination.pageSize;
      const paged = topicDetails.slice(start, start + pagination.pageSize);

      return ok({ topicDetails: paged, totalCount });
    },
  );
}

// eslint-disable-next-line max-len
const PROMPTS_SELECT = 'topics, prompt, region_code, mentions, citations, visibility_score, position, sentiment, volume, origin, category_name, execution_date, url, error_code';

/**
 * Creates the getTopicPrompts handler.
 * Returns prompt-level data for a single topic (loaded on expansion).
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createTopicPromptsHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'topic-prompts',
    async (ctx, client) => {
      const { spaceCatId, brandId, topicId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const pagination = parsePaginationParams(ctx);
      const defaults = defaultDateRange();
      const organizationId = spaceCatId;
      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;

      const startDate = params.startDate || defaults.startDate;
      const endDate = params.endDate || defaults.endDate;
      const model = params.model || 'chatgpt';

      let topicName;
      try {
        topicName = decodeURIComponent(topicId);
      } catch {
        return badRequest('Invalid topic ID encoding');
      }

      let q = client
        .from('brand_presence_executions')
        .select(PROMPTS_SELECT)
        .eq('organization_id', organizationId)
        .eq('topics', topicName)
        .gte('execution_date', startDate)
        .lte('execution_date', endDate)
        .eq('model', model);

      if (shouldApplyFilter(params.siteId)) {
        q = q.eq('site_id', params.siteId);
      }
      if (filterByBrandId) {
        q = q.eq('brand_id', filterByBrandId);
      }
      if (shouldApplyFilter(params.regionCode)) {
        q = q.eq('region_code', params.regionCode);
      }
      if (shouldApplyFilter(params.origin)) {
        q = q.ilike('origin', params.origin);
      }

      const { data, error } = await q.limit(WEEKS_QUERY_LIMIT);

      if (error) {
        ctx.log.error(`Brand presence topic-prompts PostgREST error: ${error.message}`);
        return badRequest(error.message);
      }

      if (shouldApplyFilter(params.siteId)) {
        const siteBelongsToOrg = await validateSiteBelongsToOrg(
          client,
          organizationId,
          params.siteId,
        );
        if (!siteBelongsToOrg) {
          return forbidden('Site does not belong to the organization');
        }
      }

      const items = buildPromptDetails(data || []);

      const totalCount = items.length;
      const start = pagination.page * pagination.pageSize;
      const paged = items.slice(start, start + pagination.pageSize);

      return ok({ items: paged, totalCount });
    },
  );
}

// ── Search ──────────────────────────────────────────────────────────────────

function parseSearchPaginationParams(context) {
  const q = context.data || {};
  return {
    sortBy: q.sortBy || 'name',
    sortOrder: q.sortOrder || 'asc',
    page: Number.parseInt(q.page, 10) || 0,
    pageSize: Number.parseInt(q.pageSize, 10) || 100,
  };
}

/**
 * Creates the search handler.
 * Full-text search across topics and prompts; returns matching
 * topic summaries with a `matchType` field indicating whether
 * the match was on the topic name or a prompt within the topic.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createSearchHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'search',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const pagination = parseSearchPaginationParams(ctx);
      const defaults = defaultDateRange();
      const organizationId = spaceCatId;
      const filterByBrandId = brandId && brandId !== 'all'
        ? brandId : null;

      const query = (ctx.data?.query ?? '').trim();
      if (!query) {
        return ok({ topicDetails: [], totalCount: 0 });
      }

      const startDate = params.startDate || defaults.startDate;
      const endDate = params.endDate || defaults.endDate;
      const model = params.model || 'chatgpt';

      const pattern = `%${query}%`;

      let q = client
        .from('brand_presence_executions')
        .select(TOPICS_SELECT)
        .eq('organization_id', organizationId)
        .gte('execution_date', startDate)
        .lte('execution_date', endDate)
        .eq('model', model)
        .or(`topics.ilike.${pattern},prompt.ilike.${pattern}`);

      if (shouldApplyFilter(params.siteId)) {
        q = q.eq('site_id', params.siteId);
      }
      if (filterByBrandId) q = q.eq('brand_id', filterByBrandId);
      if (shouldApplyFilter(params.categoryId)) {
        q = isValidUUID(params.categoryId)
          ? q.eq('category_id', params.categoryId)
          : q.eq('category_name', params.categoryId);
      }
      if (params.topicIds?.length > 0) {
        q = q.in('topic_id', params.topicIds);
      }
      if (shouldApplyFilter(params.regionCode)) {
        q = q.eq('region_code', params.regionCode);
      }
      if (shouldApplyFilter(params.origin)) {
        q = q.ilike('origin', params.origin);
      }

      const { data, error } = await q.limit(WEEKS_QUERY_LIMIT);

      if (error) {
        ctx.log.error(
          `Brand presence search PostgREST error: ${error.message}`,
        );
        return badRequest(error.message);
      }

      if (shouldApplyFilter(params.siteId)) {
        const siteBelongsToOrg = await validateSiteBelongsToOrg(
          client,
          organizationId,
          params.siteId,
        );
        if (!siteBelongsToOrg) {
          return forbidden(
            'Site does not belong to the organization',
          );
        }
      }

      const topicDetails = aggregateTopicData(data || []);
      const queryLower = query.toLowerCase();
      topicDetails.forEach((td) => {
        // eslint-disable-next-line no-param-reassign
        td.matchType = td.topic.toLowerCase().includes(queryLower)
          ? 'topic' : 'prompt';
      });

      sortTopicDetails(topicDetails, pagination.sortBy, pagination.sortOrder);

      const totalCount = topicDetails.length;
      const start = pagination.page * pagination.pageSize;
      const paged = topicDetails.slice(start, start + pagination.pageSize);

      return ok({ topicDetails: paged, totalCount });
    },
  );
}

// ── Share of Voice ───────────────────────────────────────────────────────────

const TOP_COMPETITORS_DISPLAYED = 5; // max entities (brand + competitors) in the response slice
const DEFAULT_MAX_COMPETITORS = 5; // max competitors the RPC returns from the DB

/**
 * Maps the imputed volume integer to a popularity category.
 * Negative sentinel values are canonical (set by the projector pipeline):
 *   -30 → High, -20 → Medium, -10 → Low.
 * Positive values use legacy percentile bucketing against the per-query average.
 * Zero / null → 'Low'.
 * @internal Exported for testing
 */
export function volumeToPopularity(volume, avgPositiveVolume) {
  if (volume === -30) return 'High';
  if (volume === -20) return 'Medium';
  if (volume === -10) return 'Low';
  if (volume > 0 && avgPositiveVolume > 0) {
    const low = avgPositiveVolume * 0.33;
    const med = avgPositiveVolume * 0.66;
    if (volume <= low) return 'Low';
    if (volume <= med) return 'Medium';
    return 'High';
  }
  return 'Low';
}

function callShareOfVoiceRpc(client, organizationId, params, defaults, filterByBrandId) {
  const startDate = params.startDate || defaults.startDate;
  const endDate = params.endDate || defaults.endDate;
  const model = params.model || 'chatgpt';

  return client.rpc('rpc_share_of_voice', {
    p_organization_id: organizationId,
    p_start_date: startDate,
    p_end_date: endDate,
    p_model: model,
    p_brand_id: filterByBrandId || null,
    p_site_id: shouldApplyFilter(params.siteId) ? params.siteId : null,
    p_category_id: shouldApplyFilter(params.categoryId) && isValidUUID(params.categoryId)
      ? params.categoryId : null,
    p_topic_ids: params.topicIds?.length > 0 ? params.topicIds : null,
    p_origin: shouldApplyFilter(params.origin) ? params.origin : null,
    p_region_code: shouldApplyFilter(params.regionCode) ? params.regionCode : null,
    p_max_competitors: params.maxCompetitors
      ? Number(params.maxCompetitors) : DEFAULT_MAX_COMPETITORS,
  });
}

async function fetchConfiguredCompetitorNames(client, organizationId, filterByBrandId) {
  let q = client
    .from('competitors')
    .select('name, aliases')
    .eq('organization_id', organizationId);
  if (filterByBrandId) q = q.eq('brand_id', filterByBrandId);
  const { data, error } = await q.limit(QUERY_LIMIT);
  if (error || !data) return new Set();
  const names = new Set();
  data.forEach((c) => {
    if (c.name) names.add(c.name.toLowerCase().trim());
    if (Array.isArray(c.aliases)) {
      c.aliases.forEach((a) => {
        if (a) names.add(a.toLowerCase().trim());
      });
    }
  });
  return names;
}

/**
 * Reshapes flat RPC rows (one per topic+competitor) into ShareOfVoiceData[].
 * Each RPC row has: { topic, brand_mentions, competitor_name, competitor_mentions, volume }.
 * competitor_name is NULL for topics with no competitors (LEFT JOIN).
 * @internal Exported for testing
 */
export function aggregateShareOfVoice(rpcRows, configuredNames, brandName) {
  // Group RPC rows by topic
  const topicMap = new Map();
  rpcRows.forEach((r) => {
    const topic = r.topic || 'Unknown';
    if (!topicMap.has(topic)) {
      topicMap.set(topic, {
        brandMentions: Number(r.brand_mentions) || 0,
        volume: r.volume,
        competitors: new Map(),
      });
    }
    const m = topicMap.get(topic);
    if (r.competitor_name) {
      const key = r.competitor_name.toLowerCase().trim();
      m.competitors.set(key, (m.competitors.get(key) || 0) + (Number(r.competitor_mentions) || 0));
    }
  });

  // Compute average positive volume for legacy percentile bucketing
  const positiveVolumes = [];
  topicMap.forEach((m) => {
    if (m.volume > 0) positiveVolumes.push(m.volume);
  });
  const avgPositiveVolume = positiveVolumes.length > 0
    ? positiveVolumes.reduce((s, v) => s + v, 0) / positiveVolumes.length
    : 0;

  const shareOfVoiceData = [];

  topicMap.forEach((m, topic) => {
    const totalCompetitorMentions = [...m.competitors.values()].reduce((s, c) => s + c, 0);
    const totalMentions = m.brandMentions + totalCompetitorMentions;

    const shareOfVoice = m.brandMentions > 0 && totalMentions > 0
      ? (m.brandMentions / totalMentions) * 100
      : null;

    const allEntities = [];

    m.competitors.forEach((mentions, name) => {
      const sov = totalMentions > 0 ? (mentions / totalMentions) * 100 : 0;
      allEntities.push({
        name,
        mentions,
        shareOfVoice: sov,
        isBrand: false,
        source: configuredNames.size > 0 && configuredNames.has(name) ? 'configured' : 'detected',
      });
    });

    if (m.brandMentions > 0) {
      const brandSov = (m.brandMentions / totalMentions) * 100;
      allEntities.push({
        name: brandName || 'Our Brand',
        mentions: m.brandMentions,
        shareOfVoice: brandSov,
        isBrand: true,
        source: 'configured',
      });
    }

    allEntities.sort((a, b) => {
      const diff = b.shareOfVoice - a.shareOfVoice;
      if (diff !== 0) return diff;
      return Number(b.isBrand) - Number(a.isBrand);
    });

    const topEntities = allEntities.slice(0, TOP_COMPETITORS_DISPLAYED);
    const brandEntity = topEntities.find((e) => e.isBrand);
    const topCompetitors = topEntities
      .filter((e) => !e.isBrand)
      .map(({
        name, mentions, shareOfVoice: sov, source,
      }) => ({
        name, mentions, shareOfVoice: sov, source,
      }));
    const allCompetitors = allEntities
      .filter((e) => !e.isBrand)
      .map(({
        name, mentions, shareOfVoice: sov, source,
      }) => ({
        name, mentions, shareOfVoice: sov, source,
      }));

    const brandShareOfVoice = brandEntity ? {
      name: brandEntity.name,
      mentions: brandEntity.mentions,
      shareOfVoice: brandEntity.shareOfVoice,
    } : undefined;

    let ranking = null;
    if (brandEntity) {
      ranking = allEntities.findIndex((e) => e.isBrand) + 1;
    }

    const popularity = volumeToPopularity(m.volume, avgPositiveVolume);

    shareOfVoiceData.push({
      id: `${topic}-${totalMentions}-${m.brandMentions}`,
      topic,
      popularity,
      brandMentions: m.brandMentions,
      totalMentions,
      shareOfVoice,
      ranking,
      topCompetitors,
      allCompetitors,
      brandShareOfVoice,
    });
  });

  const getPriorityValue = (p) => {
    switch (p.toLowerCase()) {
      case 'high': return 3;
      case 'medium': return 2;
      case 'low': return 1;
      /* c8 ignore next */ // volumeToPopularity always returns High/Medium/Low
      default: return 0;
    }
  };
  shareOfVoiceData.sort((a, b) => {
    const pDiff = getPriorityValue(b.popularity) - getPriorityValue(a.popularity);
    if (pDiff !== 0) return pDiff;
    return (b.shareOfVoice || 0) - (a.shareOfVoice || 0);
  });

  return shareOfVoiceData;
}

/**
 * Creates the getShareOfVoice handler.
 * Returns per-topic share-of-voice, ranking, popularity and competitor breakdown.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createShareOfVoiceHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'share-of-voice',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const defaults = defaultDateRange();
      const organizationId = spaceCatId;
      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;

      if (shouldApplyFilter(params.siteId)) {
        const siteBelongsToOrg = await validateSiteBelongsToOrg(
          client,
          organizationId,
          params.siteId,
        );
        if (!siteBelongsToOrg) {
          return forbidden('Site does not belong to the organization');
        }
      }

      const [rpcResult, configuredNames] = await Promise.all([
        callShareOfVoiceRpc(client, organizationId, params, defaults, filterByBrandId),
        fetchConfiguredCompetitorNames(client, organizationId, filterByBrandId),
      ]);

      if (rpcResult.error) {
        ctx.log.error(`Share-of-voice RPC error: ${rpcResult.error.message}`);
        return badRequest(rpcResult.error.message);
      }

      const rpcRows = rpcResult.data || [];

      // Resolve brand name for display
      let brandName = 'Our Brand';
      if (filterByBrandId) {
        const { data: brandData } = await client
          .from('brands')
          .select('name')
          .eq('id', filterByBrandId)
          .limit(1);
        if (brandData?.[0]?.name) brandName = brandData[0].name;
      }

      const shareOfVoiceData = aggregateShareOfVoice(
        rpcRows,
        configuredNames,
        brandName,
      );

      return ok({ shareOfVoiceData });
    },
  );
}

/**
 * Creates the getFilterDimensions handler.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createFilterDimensionsHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'filter-dimensions',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const defaults = defaultDateRange();
      const organizationId = spaceCatId;
      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;

      const q = buildExecutionsQuery(client, organizationId, params, defaults, filterByBrandId);
      const { data, error } = await q;

      if (error) {
        ctx.log.error(`Brand presence filter-dimensions PostgREST error: ${error.message}`);
        return badRequest(error.message);
      }

      const rows = data || [];
      const siteFilter = params.siteId;
      if (shouldApplyFilter(siteFilter)) {
        const siteBelongsToOrg = await validateSiteBelongsToOrg(client, organizationId, siteFilter);
        if (!siteBelongsToOrg) {
          return forbidden('Site does not belong to the organization');
        }
      }
      const siteIds = (filterByBrandId || shouldApplyFilter(siteFilter))
        ? await resolveSiteIds(client, organizationId, siteFilter, filterByBrandId, rows)
        : [];
      const pageIntents = await fetchPageIntents(
        client,
        organizationId,
        siteFilter,
        filterByBrandId,
        siteIds,
      );
      const {
        brands,
        categories,
        topics,
        origins,
        regions,
      } = buildDimensionOptions(rows);

      return ok({
        brands,
        categories,
        topics,
        origins,
        regions,
        page_intents: pageIntents,
      });
    },
  );
}

/**
 * Creates the getSentimentMovers handler.
 * Calls rpc_sentiment_movers PostgreSQL function via PostgREST.
 * Returns top or bottom sentiment movers ranked by execution count.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createSentimentMoversHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'sentiment-movers',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const defaults = defaultDateRange();
      const organizationId = spaceCatId;
      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;

      const startDate = params.startDate || defaults.startDate;
      const endDate = params.endDate || defaults.endDate;
      const model = params.model || 'chatgpt';

      const q = ctx.data || {};
      const type = (q.type || 'top').toLowerCase();
      if (type !== 'top' && type !== 'bottom') {
        return badRequest('Invalid type parameter. Must be "top" or "bottom".');
      }

      if (shouldApplyFilter(params.siteId)) {
        const siteBelongsToOrg = await validateSiteBelongsToOrg(
          client,
          organizationId,
          params.siteId,
        );
        if (!siteBelongsToOrg) {
          return forbidden('Site does not belong to the organization');
        }
      }

      const rpcParams = {
        p_organization_id: organizationId,
        p_start_date: startDate,
        p_end_date: endDate,
        p_model: model,
        p_type: type,
      };

      if (filterByBrandId) rpcParams.p_brand_id = filterByBrandId;
      if (shouldApplyFilter(params.siteId)) rpcParams.p_site_id = params.siteId;
      if (shouldApplyFilter(params.categoryId)) {
        rpcParams.p_category_id = isValidUUID(params.categoryId)
          ? params.categoryId
          : undefined;
      }
      if (shouldApplyFilter(params.origin)) rpcParams.p_origin = params.origin;
      if (shouldApplyFilter(params.regionCode)) rpcParams.p_region_code = params.regionCode;
      if (params.topicIds?.length > 0) rpcParams.p_topic_ids = params.topicIds;

      const { data, error } = await client.rpc('rpc_sentiment_movers', rpcParams);

      if (error) {
        ctx.log.error(`Brand presence sentiment-movers PostgREST error: ${error.message}`);
        return badRequest(error.message);
      }

      const movers = (data || []).map((row) => ({
        promptId: row.prompt_id,
        prompt: row.prompt,
        topicId: row.topic_id,
        topic: row.topic,
        categoryId: row.category_id,
        category: row.category,
        region: row.region,
        origin: row.origin,
        popularity: row.popularity,
        fromSentiment: row.from_sentiment,
        toSentiment: row.to_sentiment,
        fromDate: row.from_date,
        toDate: row.to_date,
        executionCount: row.execution_count,
      }));

      return ok({ movers });
    },
  );
}

function parseShowTrends(q) {
  const v = q?.showTrends ?? q?.show_trends;
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    return s === 'true' || s === '1';
  }
  return false;
}

function rowToStats(row) {
  if (!row) {
    return {
      total_executions: 0,
      average_visibility_score: 0,
      total_mentions: 0,
      total_citations: 0,
    };
  }
  return {
    total_executions: Number(row.total_executions ?? 0),
    average_visibility_score: Number(row.average_visibility_score ?? 0),
    total_mentions: Number(row.total_mentions ?? 0),
    total_citations: Number(row.total_citations ?? 0),
  };
}

function buildRpcParams(organizationId, startDate, endDate, model, filterByBrandId, params) {
  const topicIds = params.topicIds?.length ? params.topicIds : null;
  const categoryId = shouldApplyFilter(params.categoryId) && isValidUUID(params.categoryId)
    ? params.categoryId
    : null;
  return {
    p_organization_id: organizationId,
    p_start_date: startDate,
    p_end_date: endDate,
    p_model: model,
    p_brand_id: filterByBrandId,
    p_site_id: shouldApplyFilter(params.siteId) ? params.siteId : null,
    p_category_id: categoryId,
    p_topic_ids: topicIds,
    p_origin: shouldApplyFilter(params.origin) ? params.origin : null,
    p_region_code: shouldApplyFilter(params.regionCode) ? params.regionCode : null,
  };
}

/**
 * Creates the getBrandPresenceStats handler.
 * Returns aggregated visibility stats
 * (total_executions, average_visibility_score, total_mentions, total_citations)
 * via the rpc_brand_presence_stats RPC in mysticat-data-service.
 * When showTrends=true, adds weekly trends (max 8 weeks, backward from endDate).
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createBrandPresenceStatsHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'stats',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const q = ctx.data || {};
      const defaults = defaultDateRange();
      const organizationId = spaceCatId;
      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;

      const startDate = params.startDate || defaults.startDate;
      const endDate = params.endDate || defaults.endDate;
      const model = params.model || 'chatgpt';
      const showTrends = parseShowTrends(q);

      if (shouldApplyFilter(params.siteId)) {
        const siteBelongsToOrg = await validateSiteBelongsToOrg(
          client,
          organizationId,
          params.siteId,
        );
        if (!siteBelongsToOrg) {
          return forbidden('Site does not belong to the organization');
        }
      }

      const rpcParams = buildRpcParams(
        organizationId,
        startDate,
        endDate,
        model,
        filterByBrandId,
        params,
      );

      const { data, error } = await client.rpc('rpc_brand_presence_stats', rpcParams);

      if (error) {
        ctx.log.error(`Brand presence stats RPC error: ${error.message}`);
        return badRequest(error.message);
      }

      const row = Array.isArray(data) && data.length > 0 ? data[0] : data;
      const stats = rowToStats(row);
      const response = { stats };

      if (showTrends) {
        const weeks = splitDateRangeIntoWeeksBackward(startDate, endDate);
        if (weeks.length > 0) {
          const trendResults = await Promise.all(
            weeks.map((w) => client.rpc('rpc_brand_presence_stats', {
              ...rpcParams,
              p_start_date: w.startDate,
              p_end_date: w.endDate,
            })),
          );

          const failed = trendResults.find((r) => r.error);
          if (failed) {
            ctx.log.error(`Brand presence stats trends RPC error: ${failed.error.message}`);
            return badRequest(failed.error.message);
          }

          response.trends = trendResults.map((r, i) => {
            const weekRow = Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : r.data;
            return {
              startDate: weeks[i].startDate,
              endDate: weeks[i].endDate,
              data: { stats: rowToStats(weekRow) },
            };
          }).reverse();
        }
      }

      return ok(response);
    },
  );
}
