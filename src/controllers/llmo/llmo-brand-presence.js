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

/**
 * Expected error message substrings from getOrgAndValidateAccess (see llmo-mysticat-controller).
 * Used for error classification; string matching is intentional until a shared error type exists.
 * @see llmo-mysticat-controller.js
 */
const ERR_ORG_ACCESS = 'belonging to the organization';
const ERR_NOT_FOUND = 'not found';

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
    platform: q.platform || q.model,
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
  const model = params.platform || 'chatgpt';
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

/**
 * Creates the getFilterDimensions handler.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createFilterDimensionsHandler(getOrgAndValidateAccess) {
  return async (context) => {
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
      log.error(`Brand presence filter-dimensions error: ${error.message}`);
      return badRequest(error.message);
    }

    const client = Site.postgrestService;
    const { spaceCatId, brandId } = context.params;
    const params = parseFilterDimensionsParams(context);
    const defaults = defaultDateRange();
    const organizationId = spaceCatId;
    const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;

    const q = buildExecutionsQuery(client, organizationId, params, defaults, filterByBrandId);
    const { data, error } = await q;

    if (error) {
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
  };
}
