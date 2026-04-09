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

import {
  badRequest,
  internalServerError,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';
import { validateRepoUrl } from '../utils/validations.js';
import { resolveHlxConfigFromGitHubURL } from '../support/hlx-config.js';

/**
 * Tools Controller. Provides generic utility endpoints not tied to a specific site.
 * @param {object} ctx - Context of the request.
 * @param {object} log - Logger instance.
 * @param {object} env - Environment variables.
 * @returns {object} Tools controller.
 */
function ToolsController(ctx, log, env) {
  /**
   * Resolves hlxConfig and code attributes from a GitHub URL by querying the
   * admin.hlx.page API and falling back to fstab.yaml. Read-only — does not
   * persist anything.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Resolved hlxConfig and code.
   */
  const resolveConfig = async (context) => {
    const { gitHubURL } = context.data;
    if (!hasText(gitHubURL)) {
      return badRequest('gitHubURL is required');
    }

    if (!validateRepoUrl(gitHubURL)) {
      return badRequest('Invalid GitHub repository URL');
    }

    const hlxAdminToken = env.HLX_ADMIN_TOKEN;
    if (!hasText(hlxAdminToken)) {
      log.error('HLX_ADMIN_TOKEN is not configured');
      return internalServerError('HLX admin token not configured');
    }

    try {
      const result = await resolveHlxConfigFromGitHubURL(gitHubURL, hlxAdminToken, log);
      return ok(result);
    } catch (e) {
      log.error(`Error resolving config from ${gitHubURL}: ${e.message}`);
      return internalServerError('Failed to resolve config');
    }
  };

  return { resolveConfig };
}

export default ToolsController;
