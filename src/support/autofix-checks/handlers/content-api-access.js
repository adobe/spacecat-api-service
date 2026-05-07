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

import { tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import { Site } from '@adobe/spacecat-shared-data-access';

const CHECK_TYPE = 'content-api-access';

/**
 * Two-step Content API probe paths (per terinmez / Content MCP Server approach):
 *  1. Experimental ASPM path — works for modern AEM CS instances
 *  2. Stable path — works for AEM CS instances where experimental path is not available
 *
 * If both return 404 → Content API is not deployed on this instance.
 * A 2xx on either path confirms the API is reachable and the caller has access.
 */
const PROBE_PATHS = [
  '/adobe/experimental/aspm-expires-20251231/pages?limit=1',
  '/adobe/pages?limit=1',
];

/**
 * Probes a single URL and returns the HTTP status (or null on network error).
 *
 * @param {string} url
 * @param {string} authorization
 * @returns {Promise<number|null>}
 */
async function probeUrl(url, authorization) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authorization },
    });
    return response.status;
  } catch {
    return null;
  }
}

/**
 * Probes the AEM Author Content API to verify it is reachable and the caller
 * has sufficient permissions. Only supported for AEM CS (aem_cs) delivery type.
 *
 * Uses a two-step probe strategy (per AEM Content MCP Server approach):
 *  1. Try experimental ASPM path (/adobe/experimental/aspm-expires-20251231/pages?limit=1)
 *  2. If 404, fall back to stable path (/adobe/pages?limit=1)
 *  3. If both 404 → Content API not deployed on this instance
 *
 * Granular failure detection:
 *  - Non-AEM CS delivery type  → SKIPPED (check not applicable)
 *  - No authorURL configured    → FAILED
 *  - Missing auth header        → FAILED
 *  - Network error / timeout    → FAILED (author instance unreachable)
 *  - Both paths return 404      → FAILED (Content API not deployed)
 *  - 401 / 403                  → FAILED (insufficient permissions)
 *  - 2xx on either path         → PASSED
 *
 * @param {Object} site       - Site entity
 * @param {Object} context    - Request context (pathInfo.headers.authorization)
 * @param {Object} log        - Logger
 * @returns {Promise<{type: string, status: string, message: string}>}
 */
const SUPPORTED_DELIVERY_TYPES = [Site.DELIVERY_TYPES.AEM_CS, Site.DELIVERY_TYPES.AEM_AMS];

export default async function contentApiAccessHandler(site, context, log) {
  // Only supported for AEM CS and AEM AMS — other delivery types use different deploy mechanisms
  if (!SUPPORTED_DELIVERY_TYPES.includes(site.getDeliveryType())) {
    return {
      type: CHECK_TYPE,
      status: 'SKIPPED',
      message: 'Content API check is only applicable to AEM CS and AEM AMS sites',
    };
  }

  const deliveryConfig = site.getDeliveryConfig();
  const authorURL = deliveryConfig?.authorURL;

  if (!authorURL) {
    return {
      type: CHECK_TYPE,
      status: 'FAILED',
      message: 'Site has no authorURL configured',
    };
  }

  const authorization = context.pathInfo?.headers?.authorization;
  if (!authorization) {
    return {
      type: CHECK_TYPE,
      status: 'FAILED',
      message: 'Missing authorization header',
    };
  }

  // Two-step probe: try experimental path first, then stable fallback
  for (const probePath of PROBE_PATHS) {
    const probeURL = `${authorURL}${probePath}`;
    // eslint-disable-next-line no-await-in-loop
    const status = await probeUrl(probeURL, authorization);

    if (status === null) {
      log.error(`Content API probe failed for ${authorURL}: network error`);
      return {
        type: CHECK_TYPE,
        status: 'FAILED',
        message: 'Author instance is not reachable',
      };
    }

    if (status >= 200 && status < 300) {
      return {
        type: CHECK_TYPE,
        status: 'PASSED',
        message: 'Content API is accessible',
      };
    }

    if (status === 401 || status === 403) {
      return {
        type: CHECK_TYPE,
        status: 'FAILED',
        message: 'Insufficient permissions for Content API',
      };
    }

    if (status === 404) {
      // Try next probe path
      continue; // eslint-disable-line no-continue
    }

    return {
      type: CHECK_TYPE,
      status: 'FAILED',
      message: `Content API returned unexpected status ${status}`,
    };
  }

  // Both probe paths returned 404 → Content API not deployed
  return {
    type: CHECK_TYPE,
    status: 'FAILED',
    message: 'Content API is not available on this AEM instance',
  };
}
