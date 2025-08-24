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
import { createResponse } from '@adobe/spacecat-shared-http-utils';
import {
  triggerAudits,
  normalizeAndValidateAuditTypes,
  enforceRateLimit,
  validateSiteAccess,
} from '../support/sandbox-audit-service.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * Sandbox Audit Controller for triggering audits on sandbox sites
 *
 * @param {Object} context - The application context containing dataAccess, env, log, etc.
 * @returns {Object} Controller with audit triggering methods.
 * @throws {Error} When data access configuration is missing or invalid
 */
function SandboxAuditController(ctx) {
  if (!isNonEmptyObject(ctx?.dataAccess)) {
    throw new Error('Valid data access configuration required');
  }

  const { dataAccess, log } = ctx;
  const { Configuration, Site } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  function extractRequestParameters(requestContext) {
    const auditTypeRaw = requestContext.data?.auditType;
    const { siteId } = requestContext.params || {};
    return { siteId, auditTypeRaw };
  }

  /**
   * Triggers audit(s) for a sandbox site.
   * Supports single audit, multiple audits, or all configured audits.
   */
  const triggerAudit = async (context) => {
    try {
      const { siteId, auditTypeRaw } = extractRequestParameters(context);

      // Validate site access
      const siteValidation = await validateSiteAccess(siteId, Site, accessControlUtil);
      if (siteValidation.error) {
        return siteValidation.error;
      }
      const { site } = siteValidation;

      // Normalize and validate audit types
      const { auditTypes, error } = normalizeAndValidateAuditTypes(auditTypeRaw);
      if (error) {
        return error;
      }

      // Check rate limits
      const rateLimitResult = await enforceRateLimit(site, auditTypes, ctx, log);
      const { response, allowed = [], skipped = [] } = rateLimitResult;
      if (response) {
        return response;
      }

      const configuration = await Configuration.findLatest();
      log.info(`SandboxAudit: Triggering audit(s) for siteId ${siteId}, types: ${allowed.join(', ')}`);

      return triggerAudits(site, configuration, allowed, ctx, skipped);
    } catch (error) {
      log.error(`Error triggering audit: ${error.message}`, error);
      return createResponse(
        { message: 'Failed to trigger sandbox audit' },
        error.status || 500,
        { 'x-error': error.message },
      );
    }
  };

  return {
    triggerAudit,
  };
}

export default SandboxAuditController;
