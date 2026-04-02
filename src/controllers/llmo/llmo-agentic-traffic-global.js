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

import {
  badRequest,
  createResponse,
  forbidden,
  internalServerError,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { AgenticTrafficGlobalDto } from '../../dto/agentic-traffic-global.js';

function requirePostgrest(context) {
  const postgrestClient = context.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    return createResponse(
      { message: 'Global agentic traffic requires Postgres / mysticat PostgREST (DATA_SERVICE_PROVIDER=postgres)' },
      503,
    );
  }
  return null;
}

function getQueryParams(context) {
  const rawQueryString = context.invocation?.event?.rawQueryString;
  if (!rawQueryString) return {};

  const params = {};
  rawQueryString.split('&').forEach((param) => {
    const [key, value] = param.split('=');
    if (key) {
      params[decodeURIComponent(key)] = value !== undefined
        ? decodeURIComponent(value)
        : '';
    }
  });
  return params;
}

function normalizeInteger(value, fieldName, {
  minimum,
  maximum,
} = {}) {
  if (value === undefined || value === null || value === '') {
    return { value: null };
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) {
    return { error: `${fieldName} must be an integer` };
  }
  if (minimum != null && parsed < minimum) {
    return { error: `${fieldName} must be greater than or equal to ${minimum}` };
  }
  if (maximum != null && parsed > maximum) {
    return { error: `${fieldName} must be less than or equal to ${maximum}` };
  }
  return { value: parsed };
}

function resolveUpdatedBy(context) {
  const authInfo = context.attributes?.authInfo;
  const profile = authInfo?.getProfile?.() ?? authInfo?.profile;
  if (profile?.user_id) return String(profile.user_id);
  if (profile?.sub) return String(profile.sub);
  return 'spacecat-api-service';
}

export function createAgenticTrafficGlobalGetHandler(accessControlUtil) {
  return async function getAgenticTrafficGlobal(context) {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view global agentic traffic');
    }

    const unavailable = requirePostgrest(context);
    if (unavailable) return unavailable;

    const query = getQueryParams(context);
    const yearResult = normalizeInteger(query.year, 'year', { minimum: 2000, maximum: 9999 });
    if (yearResult.error) return badRequest(yearResult.error);

    const weekResult = normalizeInteger(query.week, 'week', { minimum: 1, maximum: 53 });
    if (weekResult.error) return badRequest(weekResult.error);

    const limitResult = normalizeInteger(query.limit, 'limit', { minimum: 1, maximum: 520 });
    if (limitResult.error) return badRequest(limitResult.error);

    try {
      const { postgrestClient } = context.dataAccess.services;
      let dbQuery = postgrestClient
        .from('agentic_traffic_global')
        .select('*')
        .order('year', { ascending: false })
        .order('week', { ascending: false });

      if (yearResult.value != null) {
        dbQuery = dbQuery.eq('year', yearResult.value);
      }
      if (weekResult.value != null) {
        dbQuery = dbQuery.eq('week', weekResult.value);
      }
      if (limitResult.value != null) {
        dbQuery = dbQuery.limit(limitResult.value);
      }

      const { data, error } = await dbQuery;
      if (error) {
        throw new Error(error.message);
      }

      return ok((data || []).map((row) => AgenticTrafficGlobalDto.toJSON(row)));
    } catch (e) {
      context.log.error(`Error listing global agentic traffic: ${e.message}`);
      return internalServerError('Failed to list global agentic traffic');
    }
  };
}

export function createAgenticTrafficGlobalPostHandler(accessControlUtil) {
  return async function postAgenticTrafficGlobal(context) {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can update global agentic traffic');
    }

    const unavailable = requirePostgrest(context);
    if (unavailable) return unavailable;

    if (!context.data || typeof context.data !== 'object' || Array.isArray(context.data)) {
      return badRequest('Request body must be an object');
    }

    const yearResult = normalizeInteger(context.data.year, 'year', { minimum: 2000, maximum: 9999 });
    if (yearResult.error || yearResult.value == null) {
      return badRequest(yearResult.error || 'year is required');
    }

    const weekResult = normalizeInteger(context.data.week, 'week', { minimum: 1, maximum: 53 });
    if (weekResult.error || weekResult.value == null) {
      return badRequest(weekResult.error || 'week is required');
    }

    const hitsResult = normalizeInteger(context.data.hits, 'hits', { minimum: 0 });
    if (hitsResult.error || hitsResult.value == null) {
      return badRequest(hitsResult.error || 'hits is required');
    }

    try {
      const { postgrestClient } = context.dataAccess.services;
      const row = {
        year: yearResult.value,
        week: weekResult.value,
        hits: hitsResult.value,
        updated_by: resolveUpdatedBy(context),
      };

      const { data, error } = await postgrestClient
        .from('agentic_traffic_global')
        .upsert(row, { onConflict: 'year,week' })
        .select()
        .single();

      if (error) {
        throw new Error(error.message);
      }

      return ok(AgenticTrafficGlobalDto.toJSON(data));
    } catch (e) {
      context.log.error(`Error upserting global agentic traffic: ${e.message}`);
      return internalServerError('Failed to update global agentic traffic');
    }
  };
}
