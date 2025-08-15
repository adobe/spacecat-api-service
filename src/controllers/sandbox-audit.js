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
  hasText,
  isNonEmptyObject,
  isValidUrl,
} from '@adobe/spacecat-shared-utils';
import {
  badRequest,
  forbidden,
  notFound,
} from '@adobe/spacecat-shared-http-utils';
import { triggerAudits, normalizeAuditTypes, enforceRateLimit } from '../support/sandbox-audit-service.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * Sandbox Audit Controller for triggering audits on sandbox sites without Slack context.
 * @param {Object} context - The context object.
 * @returns {Object} Controller with audit triggering methods.
 */
function SandboxAuditController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess, log } = ctx;

  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Configuration, Site } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Validates baseURL and authorization, returns either Response or the site.
   * @param {string} baseURL
   * @returns {Promise<{site: object}|import('@adobe/spacecat-shared-http-utils').Response>}
   */
  const validateRequest = async (baseURL) => {
    if (!hasText(baseURL)) {
      return badRequest('baseURL query parameter is required');
    }

    if (!isValidUrl(baseURL)) {
      return badRequest('Invalid baseURL provided');
    }

    const site = await Site.findByBaseURL(baseURL);
    if (!isNonEmptyObject(site)) {
      return notFound(`Site not found for baseURL: ${baseURL}`);
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not have access to this site');
    }

    if (!site.getIsSandbox()) {
      return badRequest(`Sandbox audit endpoint only supports sandbox sites. Site ${baseURL} is not a sandbox.`);
    }

    return { site };
  };

  // Default gap (hrs) between audit runs when env var is not set
  const DEFAULT_RATE_LIMIT_HOURS = 4;

  /**
   * Triggers audit(s) for a sandbox site by baseURL.
   * GET /sandbox/audit?baseURL=https://example.com&auditType=meta-tags
   * GET /sandbox/audit?baseURL=https://example.com&auditType=[meta-tags,broken-internal-links]
   * OR
   * GET /sandbox/audit?baseURL=https://example.com (runs all audits)
   */
  const triggerAudit = async (context) => {
    try {
      const { baseURL, auditType: auditTypeRaw } = context.data || {};
      const auditTypes = normalizeAuditTypes(auditTypeRaw);
      const validation = await validateRequest(baseURL);
      if (validation.site === undefined) {
        return validation;
      }
      const { site } = validation;
      const rateLimitHours = Number.parseFloat(ctx.env?.SANDBOX_AUDIT_RATE_LIMIT_HOURS)
        || DEFAULT_RATE_LIMIT_HOURS;
      const rateLimitResp = await enforceRateLimit(site, auditTypes, rateLimitHours, log);
      if (rateLimitResp) {
        return rateLimitResp;
      }

      const configuration = await Configuration.findLatest();
      log.info(`SandboxAudit: Triggering audit(s) for ${baseURL}`);
      return triggerAudits(site, configuration, auditTypes, ctx, baseURL);
    } catch (error) {
      log.error(`Error triggering audit: ${error.message}`, error);
      throw error;
    }
  };

  return {
    triggerAudit,
  };
}

export default SandboxAuditController;
