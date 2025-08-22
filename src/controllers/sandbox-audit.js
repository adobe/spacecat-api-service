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

import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import { badRequest } from '@adobe/spacecat-shared-http-utils';
import {
  triggerAudits,
  normalizeAuditTypes,
  enforceRateLimit,
  validateSiteAccess,
  buildRateLimitResponse,
  ALL_AUDITS,
} from '../support/sandbox-audit-service.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * Validates the controller context to ensure all required dependencies are present.
 * Throws descriptive errors for missing dependencies.
 *
 * @param {Object} context - Controller context to validate
 * @throws {Error} When required context properties are missing
 */
function validateControllerContext(context) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }

  if (!isNonEmptyObject(context.dataAccess)) {
    throw new Error('Data access required');
  }
}

/**
 * Sandbox Audit Controller for triggering audits on sandbox sites
 *
 * @param {Object} context - The application context containing dataAccess, env, log, etc.
 * @returns {Object} Controller with audit triggering methods.
 */
function SandboxAuditController(ctx) {
  validateControllerContext(ctx);

  const { dataAccess, log } = ctx;
  const { Configuration, Site } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  function extractRequestParameters(requestContext) {
    // Check both locations: data (real requests) and query (tests)
    const auditTypeRaw = requestContext.data?.auditType || requestContext.query?.auditType;
    const { siteId } = requestContext.params || {};
    const auditTypes = normalizeAuditTypes(auditTypeRaw);

    return { siteId, auditTypes };
  }

  function getRateLimitHours() {
    const DEFAULT_RATE_LIMIT_HOURS = 4;
    return Number.parseFloat(ctx.env?.SANDBOX_AUDIT_RATE_LIMIT_HOURS) || DEFAULT_RATE_LIMIT_HOURS;
  }

  /**
   * Triggers audit(s) for a sandbox site.
   * Supports single audit, multiple audits, or all configured audits.
   */
  const triggerAudit = async (context) => {
    try {
      const { siteId, auditTypes } = extractRequestParameters(context);

      const siteValidation = await validateSiteAccess(siteId, Site, accessControlUtil);
      if (siteValidation.error) {
        return siteValidation.error;
      }
      const { site } = siteValidation;

      // Validate audit types are supported before rate limiting
      if (auditTypes && auditTypes.length > 0) {
        const invalid = auditTypes.filter((type) => !ALL_AUDITS.includes(type));
        if (invalid.length > 0) {
          return badRequest(
            `Invalid audit types: ${invalid.join(', ')}. Supported types: ${ALL_AUDITS.join(', ')}`,
          );
        }
      }

      const rateLimitHours = getRateLimitHours();
      const { allowed, skipped } = await enforceRateLimit(site, auditTypes, rateLimitHours, log);

      if (!allowed.length) {
        return buildRateLimitResponse(skipped, rateLimitHours);
      }

      const configuration = await Configuration.findLatest();

      log.info(`SandboxAudit: Triggering audit(s) for siteId ${siteId}, types: ${allowed.join(', ')}`);

      return triggerAudits(site, configuration, allowed, ctx, skipped);
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
