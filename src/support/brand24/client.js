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
 * Server-to-server Brand24 caller (POC) — extracted from `Brand24Controller.getData`'s inline
 * fetch logic so a NEW controller can call Brand24 multiple times per request (once per project,
 * for the multi-project market-topics relevance computation) without re-deriving path building,
 * date-range validation, and error handling from scratch. `Brand24Controller.getData` itself is
 * left untouched — it's the one already-working, untested route in this POC, so this is additive
 * rather than a risky refactor of it.
 */

import { getBrand24Endpoint, buildBrand24Path } from './endpoints.js';
import { validateDateRange } from './validation.js';

const BRAND24_BASE_URL = 'https://api-data.brand24.com';

/**
 * @param {object} args
 * @param {string} args.endpointKey - Key into `BRAND24_ENDPOINTS` (see `endpoints.js`).
 * @param {Record<string, string|number>} [args.pathValues] - e.g. `{ project_id: 123 }`.
 *   `account_id` defaults from `env.BRAND24_ACCOUNT_ID` when the endpoint needs it and the
 *   caller didn't supply one.
 * @param {Record<string, string|number|undefined>} [args.query] - Only keys in the endpoint's own
 *   `allowedQuery` are forwarded upstream.
 * @param {object} args.env - Request env, for `BRAND24_API_KEY`/`BRAND24_ACCOUNT_ID`.
 * @returns {Promise<unknown>} The upstream `data` (or `message`) on `status: "success"`.
 * @throws {Error} On a missing/unknown endpoint, a missing API key, an invalid date range, a
 *   network failure, or a non-success upstream response — callers are expected to catch and map
 *   to their own HTTP response (see `brand24-market-topics.js`).
 */
export async function callBrand24Endpoint({
  endpointKey, pathValues = {}, query = {}, env,
}) {
  const endpointDef = getBrand24Endpoint(endpointKey);
  if (!endpointDef) {
    throw new Error(`Unknown Brand24 endpoint "${endpointKey}"`);
  }

  const apiKey = env?.BRAND24_API_KEY;
  if (!apiKey) {
    throw new Error('BRAND24_API_KEY is not configured');
  }

  const resolvedPathValues = { ...pathValues };
  if (endpointDef.pathParams.includes('account_id') && !resolvedPathValues.account_id) {
    resolvedPathValues.account_id = env?.BRAND24_ACCOUNT_ID;
  }

  const upstreamQuery = new URLSearchParams();
  for (const queryParam of endpointDef.allowedQuery) {
    const value = query[queryParam];
    if (value !== undefined && value !== null && value !== '') {
      upstreamQuery.set(queryParam, String(value));
    }
  }

  const [rangeFromParam, rangeToParam] = endpointDef.rangeParamNames ?? ['date_from', 'date_to'];
  const rangeError = validateDateRange(
    upstreamQuery.get(rangeFromParam),
    upstreamQuery.get(rangeToParam),
    endpointDef.maxRangeDays,
  );
  if (rangeError) {
    throw new Error(rangeError);
  }

  const upstreamUrl = `${BRAND24_BASE_URL}${buildBrand24Path(endpointDef, resolvedPathValues)}?${upstreamQuery.toString()}`;

  const upstreamResponse = await fetch(upstreamUrl, {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  const upstreamBody = await upstreamResponse.json();

  if (upstreamBody?.status === 'success') {
    return upstreamBody.data ?? upstreamBody.message;
  }
  const message = typeof upstreamBody?.message === 'string' ? upstreamBody.message : 'Brand24 request failed';
  throw new Error(message);
}
