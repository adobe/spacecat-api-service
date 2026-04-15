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

const DEFAULT_LIMIT = 52;

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
  if (!rawQueryString) {
    return {};
  }

  const params = {};
  rawQueryString.split('&').forEach((param) => {
    const [key, value = ''] = param.split('=');
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(value);
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

function isObjectPayload(data) {
  return data !== null && typeof data === 'object' && !Array.isArray(data);
}

function normalizeIntegerFields(source, specs) {
  const values = {};

  for (const [fieldName, options] of Object.entries(specs)) {
    const { required = false, ...constraints } = options;
    const { value, error } = normalizeInteger(source[fieldName], fieldName, constraints);

    if (error) {
      return { error };
    }
    if (required && value == null) {
      return { error: `${fieldName} is required` };
    }

    values[fieldName] = value;
  }

  return { values };
}

function resolveUpdatedBy(context) {
  const authInfo = context.attributes?.authInfo;
  const profile = authInfo?.getProfile?.() ?? authInfo?.profile;
  if (profile?.user_id) {
    return String(profile.user_id);
  }
  if (profile?.sub) {
    return String(profile.sub);
  }
  return 'spacecat-api-service';
}

export function createAgenticTrafficGlobalGetHandler(validateReadAccess) {
  return async function getAgenticTrafficGlobal(context) {
    try {
      await validateReadAccess(context);
    } catch (e) {
      return forbidden(e.message || 'Only admins or users with LLMO organization access can view global agentic traffic');
    }

    const unavailable = requirePostgrest(context);
    if (unavailable) {
      return unavailable;
    }

    const query = getQueryParams(context);
    const { values, error: validationError } = normalizeIntegerFields(query, {
      year: { minimum: 2000, maximum: 9999 },
      week: { minimum: 1, maximum: 53 },
      limit: { minimum: 1, maximum: 520 },
    });
    if (validationError) {
      return badRequest(validationError);
    }

    try {
      const { postgrestClient } = context.dataAccess.services;
      let dbQuery = postgrestClient
        .from('agentic_traffic_global')
        .select('*')
        .order('year', { ascending: false })
        .order('week', { ascending: false });

      if (values.year != null) {
        dbQuery = dbQuery.eq('year', values.year);
      }
      if (values.week != null) {
        dbQuery = dbQuery.eq('week', values.week);
      }
      dbQuery = dbQuery.limit(values.limit ?? DEFAULT_LIMIT);

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
    if (!accessControlUtil.hasAdminAccess() && !context.s2sConsumer) {
      return forbidden('Only admins or S2S consumers can update global agentic traffic');
    }

    const unavailable = requirePostgrest(context);
    if (unavailable) {
      return unavailable;
    }

    if (!isObjectPayload(context.data)) {
      return badRequest('Request body must be an object');
    }

    const { values, error: validationError } = normalizeIntegerFields(context.data, {
      year: { required: true, minimum: 2000, maximum: 9999 },
      week: { required: true, minimum: 1, maximum: 53 },
      hits: { required: true, minimum: 0 },
    });
    if (validationError) {
      return badRequest(validationError);
    }

    try {
      const { postgrestClient } = context.dataAccess.services;
      const row = {
        year: values.year,
        week: values.week,
        hits: values.hits,
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
