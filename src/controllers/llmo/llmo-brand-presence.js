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

function shouldApplyFilter(value) {
  if (value == null) return false;
  if (typeof value === 'string' && SKIP_VALUES.has(value.trim())) return false;
  return hasText(String(value));
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

function toFilterOption(id, label) {
  return { id: id ?? '', label: label ?? id ?? '' };
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
      if (error.message?.includes('belonging to the organization')) {
        return forbidden('Only users belonging to the organization can view brand presence data');
      }
      if (error.message?.includes('not found')) {
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
    const startDate = params.startDate || defaults.startDate;
    const endDate = params.endDate || defaults.endDate;
    const model = params.platform || 'chatgpt';
    const {
      siteId, categoryId, topicId, regionCode, origin,
    } = params;
    const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;

    let q = client
      .from('brand_presence_executions')
      .select('brand_id, brand_name, category_name, topics, origin, region_code, site_id')
      .eq('organization_id', organizationId)
      .gte('execution_date', startDate)
      .lte('execution_date', endDate)
      .eq('model', model);

    if (shouldApplyFilter(siteId) && siteId !== '*') {
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
    // user_intent and branding accepted as optional params for future schema support
    // (brand_presence_executions does not yet have these columns)

    const { data, error } = await q.limit(5000);

    if (error) return badRequest(error.message);

    const rows = data || [];

    let siteIds = [];
    if (shouldApplyFilter(siteId) && siteId !== '*') {
      siteIds = [siteId];
    } else if (filterByBrandId) {
      siteIds = [...new Set(rows.map((r) => r.site_id).filter(Boolean))];
    } else {
      const { data: sitesData, error: sitesError } = await client
        .from('sites')
        .select('id')
        .eq('organization_id', organizationId)
        .limit(5000);
      if (!sitesError && sitesData?.length) {
        siteIds = sitesData.map((s) => s.id).filter(Boolean);
      }
    }

    let pageIntents = [];
    // Avoid URL length limits (~2–8KB) when passing many UUIDs to .in()
    const IN_FILTER_CHUNK_SIZE = 50;

    if (shouldApplyFilter(siteId) && siteId !== '*') {
      // Explicit site filter: single site, no URL length issue
      const { data: piData, error: piError } = await client
        .from('page_intents')
        .select('page_intent')
        .eq('site_id', siteId)
        .limit(5000);
      if (!piError && piData?.length) {
        const strCompare = (a, b) => (a || '').localeCompare(b || '');
        const intents = [...new Set(piData.map((r) => r.page_intent).filter(Boolean))];
        pageIntents = intents.sort(strCompare).map((p) => toFilterOption(p, p));
      }
    } else if (!filterByBrandId) {
      // brands/all: use org-based join to avoid URL length limits with 100+ site IDs
      const { data: piData, error: piError } = await client
        .from('page_intents')
        .select('page_intent,sites!inner(organization_id)')
        .eq('sites.organization_id', organizationId)
        .limit(5000);
      if (!piError && piData?.length) {
        const strCompare = (a, b) => (a || '').localeCompare(b || '');
        const intents = [...new Set(piData.map((r) => r.page_intent).filter(Boolean))];
        pageIntents = intents.sort(strCompare).map((p) => toFilterOption(p, p));
      }
    } else if (siteIds.length > 0) {
      // specific brand: batch .in() to avoid URL length limits
      const chunks = [];
      for (let i = 0; i < siteIds.length; i += IN_FILTER_CHUNK_SIZE) {
        chunks.push(siteIds.slice(i, i + IN_FILTER_CHUNK_SIZE));
      }
      const results = await Promise.all(chunks.map((chunk) => client
        .from('page_intents')
        .select('page_intent')
        .in('site_id', chunk)
        .limit(5000)));
      const allIntents = new Set();
      results.forEach(({ data: piData, error: piError }) => {
        if (!piError && piData?.length) {
          piData.forEach((r) => r.page_intent && allIntents.add(r.page_intent));
        }
      });
      const strCompare = (a, b) => (a || '').localeCompare(b || '');
      pageIntents = [...allIntents].sort(strCompare).map((p) => toFilterOption(p, p));
    }

    const brands = [];
    const brandIds = new Set();
    rows.forEach((r) => {
      if (r.brand_id && r.brand_name && !brandIds.has(r.brand_id)) {
        brandIds.add(r.brand_id);
        brands.push(toFilterOption(r.brand_id, r.brand_name));
      }
    });
    brands.sort((a, b) => (a.label || '').localeCompare(b.label || ''));

    const strCompare = (a, b) => (a || '').localeCompare(b || '');
    const catNames = [...new Set(rows.map((r) => r.category_name).filter(Boolean))];
    const categories = catNames.sort(strCompare).map((c) => toFilterOption(c, c));
    const topicVals = [...new Set(rows.map((r) => r.topics).filter(Boolean))];
    const topics = topicVals.sort(strCompare).map((t) => toFilterOption(t, t));
    const originVals = [...new Set(rows.map((r) => r.origin).filter(Boolean))];
    const origins = originVals
      .map((o) => o.toLowerCase())
      .sort(strCompare)
      .map((o) => toFilterOption(o, o));
    const regionVals = [...new Set(rows.map((r) => r.region_code).filter(Boolean))];
    const regions = regionVals.sort(strCompare).map((r) => toFilterOption(r, r));

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
