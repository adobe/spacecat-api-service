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

/**
 * Brand24 proxy controller (POC — project-elmo-ui's Offsite Visibility
 * dashboard). Brand24's own API (api-data.brand24.com) sends no CORS headers
 * and its key must never reach a browser bundle, so the SPA calls this route
 * instead: it holds BRAND24_API_KEY server-side and forwards the request.
 *
 * Single static route (`GET /tools/brand24`, wired in src/index.js +
 * src/routes/index.js), `?endpoint=` selects the upstream Brand24 REST path
 * via the registry in support/brand24/endpoints.js — mirrors the same-shaped
 * `/api/b24` route in the brand24-project-explorer POC app this was ported
 * from, so the two are easy to diff against each other.
 */

import { ok, badRequest, internalServerError } from '@adobe/spacecat-shared-http-utils';
import { getBrand24Endpoint, buildBrand24Path } from '../support/brand24/endpoints.js';
import { parsePositiveInt, validateDateRange } from '../support/brand24/validation.js';

const BRAND24_BASE_URL = 'https://api-data.brand24.com';

function Brand24Controller(context, log, env) {
  const getData = async (reqContext) => {
    const apiKey = env?.BRAND24_API_KEY;
    if (!apiKey) {
      return internalServerError('BRAND24_API_KEY is not configured');
    }

    const params = new URL(reqContext.request.url).searchParams;

    const endpointKey = params.get('endpoint');
    if (!endpointKey) {
      return badRequest('endpoint query parameter is required');
    }
    const endpointDef = getBrand24Endpoint(endpointKey);
    if (!endpointDef) {
      return badRequest(`Unknown endpoint "${endpointKey}"`);
    }

    const pathValues = {};
    for (const pathParam of endpointDef.pathParams) {
      // account_id defaults server-side (POC is scoped to a single Brand24 account,
      // so the caller never needs to know or pass it) — every other path param
      // (project_id) still comes from the request.
      const rawValue = pathParam === 'account_id' && !params.get(pathParam)
        ? env?.BRAND24_ACCOUNT_ID
        : params.get(pathParam);
      const parsed = parsePositiveInt(rawValue);
      if (parsed === null) {
        return badRequest(pathParam === 'account_id'
          ? 'Missing or invalid account_id, and BRAND24_ACCOUNT_ID is not configured'
          : `Missing or invalid ${pathParam}`);
      }
      pathValues[pathParam] = parsed;
    }

    const upstreamQuery = new URLSearchParams();
    for (const queryParam of endpointDef.allowedQuery) {
      const value = params.get(queryParam);
      if (value !== null && value !== '') {
        upstreamQuery.set(queryParam, value);
      }
    }

    // Range param names vary per endpoint — `daily-metrics` uses `from`/`to`, everything else
    // uses `date_from`/`date_to` (see support/brand24/endpoints.js). Falls back to the common
    // pair for any endpoint definition that predates `rangeParamNames`.
    const [rangeFromParam, rangeToParam] = endpointDef.rangeParamNames ?? ['date_from', 'date_to'];
    const rangeError = validateDateRange(
      upstreamQuery.get(rangeFromParam),
      upstreamQuery.get(rangeToParam),
      endpointDef.maxRangeDays,
    );
    if (rangeError) {
      return badRequest(rangeError);
    }

    const upstreamUrl = `${BRAND24_BASE_URL}${buildBrand24Path(endpointDef, pathValues)}?${upstreamQuery.toString()}`;

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      log.error('[brand24] upstream request failed', error);
      return internalServerError('Failed to reach Brand24');
    }

    let upstreamBody;
    try {
      upstreamBody = await upstreamResponse.json();
    } catch {
      return internalServerError('Malformed response from Brand24');
    }

    if (upstreamBody?.status === 'success') {
      return ok(upstreamBody.data ?? upstreamBody.message);
    }
    const message = typeof upstreamBody?.message === 'string' ? upstreamBody.message : 'Brand24 request failed';
    log.warn(`[brand24] endpoint=${endpointKey} upstreamStatus=${upstreamResponse.status} message=${message}`);
    return badRequest(message);
  };

  return { getData };
}

export default Brand24Controller;
