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

import { badRequest, ok, notFound } from '@adobe/spacecat-shared-http-utils';
import AccessControlUtil from '../../support/access-control-util.js';
import {
  getDimension,
  getMetadataCatalog,
  getMetric,
  FILTER_OPERATORS_BY_DIMENSION_TYPE,
} from '../../support/analytics/analytics-metadata.js';
import { generateAnalyticsRows } from '../../support/analytics/fixture-data.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** `@adobe/spacecat-shared-utils`'s `isIsoDate` requires a full ISO datetime string
 * (`toISOString()` round-trip) — the query API takes date-only strings, so it needs its
 * own date-only check rather than that helper. */
const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isIsoCalendarDate(str) {
  if (typeof str !== 'string' || !ISO_CALENDAR_DATE.test(str)) {
    return false;
  }
  const date = new Date(`${str}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime());
}

/**
 * Validates a requested Analysis (metric + dimensions + time + filters + sort + limit)
 * against the governed metadata catalog. Returns `{ error }` with a client-safe message
 * on the first violation, or `{ value }` with the normalized request otherwise. This is
 * the ONE governance boundary for the query endpoint — a request that passes here is one
 * a real (future) data source's RPC allowlist would also have to accept, so validation
 * lives here rather than being re-derived per data source later.
 */
export function validateAnalysisRequest(body) {
  const {
    metric: metricId, dimensions: dimensionIds = [], time, filters = [], sort, limit,
  } = body ?? {};

  const metric = getMetric(metricId);
  if (!metric) {
    return { error: `Unsupported metric: "${metricId}"` };
  }

  if (!Array.isArray(dimensionIds)) {
    return { error: 'dimensions must be an array' };
  }
  for (const dimensionId of dimensionIds) {
    if (!metric.supportedDimensions.includes(dimensionId)) {
      return { error: `Unsupported metric/dimension combination: "${metricId}"/"${dimensionId}"` };
    }
  }

  if (!time || typeof time !== 'object') {
    return { error: 'time is required' };
  }
  const { grain, dateFrom, dateTo } = time;
  if (!metric.supportedGrains.includes(grain)) {
    return { error: `Unsupported grain for metric "${metricId}": "${grain}"` };
  }
  if (!isIsoCalendarDate(dateFrom) || !isIsoCalendarDate(dateTo)) {
    return { error: 'time.dateFrom and time.dateTo must be ISO dates (YYYY-MM-DD)' };
  }
  if (dateFrom > dateTo) {
    return { error: 'time.dateFrom must not be after time.dateTo' };
  }

  if (!Array.isArray(filters)) {
    return { error: 'filters must be an array' };
  }
  for (const filter of filters) {
    const dimension = getDimension(filter?.dimension);
    if (!dimension || !dimension.supportsFiltering) {
      return { error: `Dimension is not filterable: "${filter?.dimension}"` };
    }
    if (!metric.supportedDimensions.includes(dimension.id)) {
      return { error: `Unsupported metric/dimension combination: "${metricId}"/"${dimension.id}"` };
    }
    const allowedOperators = FILTER_OPERATORS_BY_DIMENSION_TYPE[dimension.type] ?? [];
    if (!allowedOperators.includes(filter.operator)) {
      return { error: `Unsupported filter operator "${filter.operator}" for dimension "${dimension.id}"` };
    }
    if (!Array.isArray(filter.values) || filter.values.length === 0) {
      return { error: `filters.values must be a non-empty array for dimension "${dimension.id}"` };
    }
    const invalidValue = filter.values.find((v) => !dimension.allowedValues?.includes(v));
    if (invalidValue) {
      return { error: `Unsupported value "${invalidValue}" for dimension "${dimension.id}"` };
    }
  }

  const sortableIds = [metricId, ...dimensionIds];
  if (sort !== undefined && sort !== null) {
    if (!sortableIds.includes(sort.by) || !['asc', 'desc'].includes(sort.direction)) {
      return { error: 'sort.by must be the metric or a requested dimension, sort.direction must be "asc"/"desc"' };
    }
  }

  let normalizedLimit = DEFAULT_LIMIT;
  if (limit !== undefined && limit !== null) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return { error: `limit must be an integer between 1 and ${MAX_LIMIT}` };
    }
    normalizedLimit = limit;
  }

  return {
    value: {
      metricId,
      dimensionIds,
      grain,
      dateFrom,
      dateTo,
      filters,
      sort: sort ?? null,
      limit: normalizedLimit,
    },
  };
}

function sortRows(rows, sort) {
  if (!sort) {
    return rows;
  }
  const direction = sort.direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[sort.by];
    const bv = b[sort.by];
    if (av === bv) {
      return 0;
    }
    return av > bv ? direction : -direction;
  });
}

/**
 * Controller for the ABV custom-dashboard analytics query API
 * (`GET/POST .../analytics/*`). v1 has zero database dependency: `getMetadata` returns
 * the in-repo governed catalog and `runQuery` returns deterministic fixture rows — see
 * `src/support/analytics/fixture-data.js` for why, and how to swap to a real data source
 * later without changing this controller's contract.
 */
function LlmoAnalyticsController(context) {
  const accessControlUtil = AccessControlUtil.fromContext(context);
  const hasLlmoOrganizationAccess = (organization) => accessControlUtil
    .hasAccess(organization, '', 'LLMO');

  const getOrgAndValidateAccess = async (ctx) => {
    const { spaceCatId } = ctx.params;
    const { Organization } = ctx.dataAccess;
    const organization = await Organization.findById(spaceCatId);
    if (!organization) {
      return { error: notFound(`Organization not found: ${spaceCatId}`) };
    }
    if (!await hasLlmoOrganizationAccess(organization)) {
      return { error: notFound(`Organization not found: ${spaceCatId}`) };
    }
    return { organization };
  };

  const getMetadata = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    return ok(getMetadataCatalog());
  };

  const runQuery = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }

    const { spaceCatId, brandId } = ctx.params;
    const { value, error: validationError } = validateAnalysisRequest(ctx.data);
    if (validationError) {
      return badRequest(validationError);
    }

    const rows = generateAnalyticsRows({
      orgId: spaceCatId,
      brandId,
      metricId: value.metricId,
      dimensionIds: value.dimensionIds,
      dateFrom: value.dateFrom,
      dateTo: value.dateTo,
      filters: value.filters,
    });

    const sorted = sortRows(rows, value.sort);
    const limited = sorted.slice(0, value.limit);

    return ok({
      metric: getMetric(value.metricId),
      dimensions: value.dimensionIds.map(getDimension),
      rows: limited,
      meta: {
        rowCount: limited.length,
        truncated: sorted.length > limited.length,
      },
    });
  };

  return { getMetadata, runQuery };
}

export default LlmoAnalyticsController;
