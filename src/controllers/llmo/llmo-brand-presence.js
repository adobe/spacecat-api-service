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

function parseFilterDimensionsParams(context) {
  const q = context.data || {};
  return {
    startDate: q.startDate || q.start_date,
    endDate: q.endDate || q.end_date,
    model: q.model || q.platform,
    siteId: q.siteId || q.site_id,
    categoryId: q.categoryId || q.category_id,
    topicId: q.topicId || q.topic_id || q.topic || q.topics,
    regionCode: q.regionCode || q.region_code || q.region,
    origin: q.origin,
    user_intent: q.user_intent || q.userIntent,
    branding: q.branding || q.promptBranding || q.prompt_branding,
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
    siteId, categoryId, topicId, regionCode, origin,
  } = params;

  let q = client
    .from('brand_presence_executions')
    .select('brand_id, brand_name, category_name, topics, origin, region_code, site_id')
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
  if (shouldApplyFilter(topicId)) {
    q = q.eq('topics', topicId);
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

  const topicVals = [...new Set(rows.map((r) => r.topics).filter(Boolean))];
  const topics = topicVals.toSorted(strCompare).map((t) => toFilterOption(t, t));

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
      if (shouldApplyFilter(params.topicId)) q = q.eq('topics', params.topicId);
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
