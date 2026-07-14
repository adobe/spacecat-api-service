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

import { SPACECAT_USER_AGENT, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import { createResponse, internalServerError } from '@adobe/spacecat-shared-http-utils';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';

const TIMEOUT_MS = 15000;

// Discriminator header so clients can tell "provisioned-but-empty" (header
// absent) from "not provisioned yet" (header present), while the body stays a
// valid empty sheet envelope.
export const NOT_PROVISIONED_HEADER = 'x-llmo-data-status';
export const NOT_PROVISIONED_VALUE = 'not-provisioned';

// Captured live from elmo-ui-data (SITES-43989 Phase 0). MUST deep-equal
// test/fixtures/llmo/empty-sheet.json. A real provisioned-empty sheet also
// carries a sheet-specific `columns` array; not-provisioned has no schema, so
// we omit it and rely on NOT_PROVISIONED_HEADER as the discriminator.
export const EMPTY_SHEET_PAYLOAD = {
  total: 0,
  offset: 0,
  limit: 0,
  data: [],
  ':type': 'sheet',
};

/**
 * Fetch a single elmo-ui-data source URL with a 15s timeout and the LLMO key.
 * Reports HTTP semantics only (backend-agnostic):
 *  - 2xx          -> { status, data: <parsed json>, headers }
 *  - 404          -> { status: 404, noData: true }            (no throw)
 *  - other non-OK -> throws Error with `upstreamStatus`
 *  - abort/timeout-> throws Error with `isTimeout = true`
 *  - missing key  -> throws Error with `isConfigError = true` (before any fetch)
 */
export const fetchLlmoSource = async (context, url) => {
  const { log, env } = context;

  if (!env.LLMO_HLX_API_KEY) {
    const err = new Error('LLMO_HLX_API_KEY environment variable is not configured');
    err.isConfigError = true;
    throw err;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `token ${env.LLMO_HLX_API_KEY}`,
        'User-Agent': SPACECAT_USER_AGENT,
        'Accept-Encoding': 'br',
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      // Drain the unread body so the underlying connection can be reused; undici
      // pins the socket until the body is consumed/cancelled, which matters on
      // the high-frequency not-provisioned path.
      await response.body?.cancel?.();
      return { status: 404, noData: true };
    }

    if (!response.ok) {
      log.debug(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
      await response.body?.cancel?.();
      const err = new Error(`External API returned ${response.status}: ${response.statusText}`);
      err.upstreamStatus = response.status;
      throw err;
    }

    // Timer stays armed through the body read so TIMEOUT_MS bounds fetch+read
    // end-to-end (an abort mid-read surfaces as AbortError below).
    const data = await response.json();
    return {
      status: response.status,
      data,
      headers: response.headers ? Object.fromEntries(response.headers.entries()) : {},
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutErr = new Error(`Request timeout after ${TIMEOUT_MS}ms`);
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Maps a fetchLlmoSource error to an honest HTTP response, or null if the error
 * is not a recognized source failure (caller keeps its own 400 fallback).
 */
export const llmoSourceErrorResponse = (error) => {
  if (error.isConfigError) {
    // internalServerError() sets the standard x-error header itself.
    return internalServerError(cleanupHeaderValue(error.message));
  }
  if (error.isTimeout) {
    const message = cleanupHeaderValue(error.message);
    return createResponse({ message }, 504, { 'x-error': message });
  }
  if (typeof error.upstreamStatus === 'number') {
    // upstream 5xx -> 502; non-404 4xx -> passthrough. createResponse (unlike
    // badRequest/internalServerError) does not set the x-error header, so set it
    // explicitly to keep the error contract (and responses.yaml) consistent.
    const message = cleanupHeaderValue(error.message);
    const status = error.upstreamStatus >= 500 ? 502 : error.upstreamStatus;
    return createResponse({ message }, status, { 'x-error': message });
  }
  return null;
};

/**
 * Structured, queryable not-provisioned signal. Emitted at `info` (NOT debug):
 * prod suppresses debug, and the Coralogix events2metrics rule keyed on
 * `event=llmo_data_not_provisioned` must see this line (SITES-43989 Phase 0).
 */
export const logNotProvisioned = (log, siteId, dataFolder) => {
  log.info('llmo_data_not_provisioned', { event: 'llmo_data_not_provisioned', siteId, dataFolder });
};
