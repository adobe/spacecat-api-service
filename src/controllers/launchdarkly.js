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

import { forbidden, internalServerError, ok } from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';

const LD_FF_PROJECT_NAME = 'experience-success-studio';
const LD_API_TOKEN_ENV_VAR = 'LD_EXPERIENCE_SUCCESS_API_TOKEN';
const LD_API_BASE_URL = 'https://app.launchdarkly.com';
const LD_FLAGS_PATH = `/api/v2/flags/${encodeURIComponent(LD_FF_PROJECT_NAME)}`;
// LD's default page size is 20; ask for the max per page to minimize round trips.
const LD_PAGE_LIMIT = 50;
// Safety bound on pagination follow — LD projects here run in the low hundreds
// of flags, so this comfortably covers real growth while still failing closed
// against a malformed/looping `_links.next`.
const MAX_PAGES = 50;

/**
 * Fetches every flag for the project, following LaunchDarkly's `_links.next`
 * pagination until exhausted (LD paginates "list flags" at 20/page by default).
 * @param {string} apiToken - LaunchDarkly API token
 * @param {object} log - Logger
 * @returns {Promise<object[]>} All flag objects across all pages
 */
async function fetchAllFlags(apiToken, log) {
  const items = [];
  let url = new URL(`${LD_FLAGS_PATH}?limit=${LD_PAGE_LIMIT}`, LD_API_BASE_URL);

  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: apiToken },
    });

    if (!response.ok) {
      // Error bodies aren't guaranteed to be JSON (e.g. an upstream 502 HTML page),
      // so don't risk a JSON.parse failure masking the real HTTP status.
      const error = new Error(`LaunchDarkly API error: ${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }

    // eslint-disable-next-line no-await-in-loop
    const body = await response.json();
    items.push(...(body.items ?? []));

    // LD's response envelope names this field `_links` — destructure-rename sidesteps
    // the no-underscore-dangle lint rule for this external, non-negotiable name.
    const { _links: links } = body;
    const nextHref = links?.next?.href ?? null;
    url = null;
    if (nextHref) {
      // Defense-in-depth: resolve the link against our own base and check the
      // *resolved* origin/pathname, not the raw string. A naive `startsWith`
      // prefix check on the raw href would miss a `../` path-traversal segment
      // or an absolute different-origin URL, either of which would leak the LD
      // API token to an unexpected destination via the Authorization header.
      const resolvedNext = new URL(nextHref, LD_API_BASE_URL);
      const isAllowed = resolvedNext.origin === LD_API_BASE_URL
        && resolvedNext.pathname.startsWith(LD_FLAGS_PATH);
      if (!isAllowed) {
        throw new Error(`Unexpected LaunchDarkly pagination path: ${nextHref}`);
      }
      url = resolvedNext;
    }
  }

  if (url) {
    log.warn(`LaunchDarkly flags pagination stopped at ${MAX_PAGES} pages with more remaining for project ${LD_FF_PROJECT_NAME}`);
  }

  return items;
}

/**
 * Reduces a raw LaunchDarkly flag object to the shape backoffice actually consumes:
 * the flag key and its variation-0 value (the org/site targeting map, or a plain
 * boolean/string for simple flags) — mirrors what `plg-onboarding/launchdarkly.js`
 * already reads via `flag.variations?.[0]?.value` and what
 * `experience-success-studio-backoffice`'s `featureFlagParser.js` expects
 * (`{ name, value }` per flag).
 * @param {object} flag - Raw LaunchDarkly flag object
 * @returns {{key: string, value: *}}
 */
function toFlagSummary(flag) {
  return {
    key: flag.key,
    // `?? null` keeps the response shape uniform (`value` is always present,
    // never silently dropped by JSON.stringify) for a flag with no variations.
    value: flag.variations?.[0]?.value ?? null,
  };
}

/**
 * Admin-only LaunchDarkly flags endpoint for the `experience-success-studio` project.
 * Fetches every flag (paginating through LD's REST API) and returns only the fields
 * UI consumers actually use, instead of the full raw LD payload.
 * @param {object} ctx - Request context (injected)
 */
function LaunchDarklyController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * GET /tools/launchdarkly/flags
   * @param {object} context - Request context with env, log.
   * @returns {Promise<Response>} `{ items: [{ key, value }], totalCount }`
   */
  const getFlags = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view LaunchDarkly flags');
    }

    const { env, log } = context;
    const apiToken = env?.[LD_API_TOKEN_ENV_VAR];
    if (!apiToken) {
      log.error(`${LD_API_TOKEN_ENV_VAR} is not configured`);
      return internalServerError('LaunchDarkly is not configured');
    }

    try {
      const flags = await fetchAllFlags(apiToken, log);
      return ok({ items: flags.map(toFlagSummary), totalCount: flags.length });
    } catch (e) {
      log.error(`Error fetching LaunchDarkly flags for project ${LD_FF_PROJECT_NAME}: ${e.message}`);
      return internalServerError('Failed to fetch LaunchDarkly flags');
    }
  };

  return { getFlags };
}

export default LaunchDarklyController;
