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

const CHECK_TYPE = 'content-api-access';

/**
 * Content API probe path — matches the UI-side probe
 * (contentApiAccessCheck.ts in experience-success-studio-ui).
 * Uses the experimental endpoint that AEM CS instances expose;
 * returns 404 when Content API is not deployed (Rotary Release < 23963).
 */
const CONTENT_API_PROBE_PATH = '/adobe/experimental/expires-20251231/pages?limit=1';

/**
 * Probes the AEM Author Content API to verify it is reachable and the caller
 * has sufficient permissions.
 *
 * Endpoint: {authorURL}/adobe/experimental/expires-20251231/pages?limit=1
 *
 * Granular failure detection:
 *  - Edge Delivery site        → skipped (different deploy mechanism)
 *  - Network error / timeout   → author instance unreachable
 *  - 404                       → Content API not deployed
 *  - 401 / 403                 → insufficient permissions
 *  - 2xx                       → Content API is accessible
 *
 * @param {Object} site       - Site entity
 * @param {Object} context    - Request context (pathInfo.headers.authorization)
 * @param {Object} log        - Logger
 * @returns {Promise<{type: string, status: string, message: string}>}
 */
export default async function contentApiAccessHandler(site, context, log) {
  // Edge Delivery sites use a different deploy mechanism — skip
  if (site.getDeliveryType() === 'aem_edge') {
    return {
      type: CHECK_TYPE,
      status: 'PASSED',
      message: 'Edge Delivery site — Content API check not required',
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

  const probeUrl = `${authorURL}${CONTENT_API_PROBE_PATH}`;

  try {
    const response = await fetch(probeUrl, {
      method: 'GET',
      headers: { Authorization: authorization },
    });

    if (response.ok) {
      return {
        type: CHECK_TYPE,
        status: 'PASSED',
        message: 'Content API is accessible',
      };
    }

    if (response.status === 404) {
      return {
        type: CHECK_TYPE,
        status: 'FAILED',
        message: 'Content API is not available on this AEM instance',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        type: CHECK_TYPE,
        status: 'FAILED',
        message: 'Insufficient permissions for Content API',
      };
    }

    return {
      type: CHECK_TYPE,
      status: 'FAILED',
      message: `Content API returned unexpected status ${response.status}`,
    };
  } catch (error) {
    log.error(`Content API probe failed for ${authorURL}: ${error.message}`);
    return {
      type: CHECK_TYPE,
      status: 'FAILED',
      message: 'Author instance is not reachable',
    };
  }
}
