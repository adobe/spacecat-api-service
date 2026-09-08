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

/**
 * Admin-only passthrough to LaunchDarkly's "list flags for project" REST API
 * (`GET /api/v2/flags/:projectKey`). Returns the raw LD response as-is, with no
 * DTO/reshaping — an exploratory endpoint to inspect exactly what LD serves for this
 * project before deciding how UI consumers should shape it.
 * @param {object} ctx - Request context (injected)
 */
function LaunchDarklyController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * GET /tools/launchdarkly/flags
   * Query params are forwarded as-is to the LaunchDarkly API (e.g. `env`, `summary`, `tag`).
   * @param {object} context - Request context with request.url, env, log.
   * @returns {Promise<Response>} The raw LaunchDarkly response body.
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

    const search = context.request?.url ? new URL(context.request.url).search : '';
    const url = `${LD_API_BASE_URL}/api/v2/flags/${encodeURIComponent(LD_FF_PROJECT_NAME)}${search}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: apiToken },
      });
      const body = await response.json();

      if (!response.ok) {
        log.error(`LaunchDarkly API error ${response.status} for project ${LD_FF_PROJECT_NAME}`);
        return internalServerError('Failed to fetch LaunchDarkly flags');
      }

      return ok(body);
    } catch (e) {
      log.error(`Error fetching LaunchDarkly flags for project ${LD_FF_PROJECT_NAME}: ${e.message}`);
      return internalServerError('Failed to fetch LaunchDarkly flags');
    }
  };

  return { getFlags };
}

export default LaunchDarklyController;
