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

import { isNonEmptyArray, isNonEmptyObject, isValidUrl } from '@adobe/spacecat-shared-utils';
import { badRequest, notFound, ok } from '@adobe/spacecat-shared-http-utils';
import { sendAuditMessage } from '../support/utils.js';

const ALL_AUDITS = [
  'broken-internal-links',
  'meta-tags',
  'alt-text',
];

/**
 * Triggers an audit for a site without requiring Slack context.
 * @param {Site} site - The site to audit.
 * @param {string} auditType - The type of audit.
 * @param {Object} context - The Lambda context object.
 * @return {Promise} - A promise representing the audit trigger operation.
 */
const triggerAuditForSiteAPI = async (site, auditType, context) => sendAuditMessage(
  context.sqs,
  context.env.AUDIT_JOBS_QUEUE_URL,
  auditType,
  {}, // Empty audit context - no Slack context needed
  site.getId(),
);

/**
 * Sandbox Audit Controller for triggering audits on sandbox sites without Slack context.
 * @param {Object} context - The context object.
 * @returns {Object} Controller with audit triggering methods.
 */
function SandboxAuditController(context) {
  const { dataAccess, log } = context;
  const { Configuration, Site } = dataAccess;

  /**
   * Triggers audit(s) for a sandbox site by baseURL.
   * GET /sandbox/audit?baseURL=https://example.com&auditType=meta-tags
   * OR
   * GET /sandbox/audit?baseURL=https://example.com (runs all audits)
   */
  const triggerAudit = async (request) => {
    try {
      const { baseURL, auditType } = request.data || {};

      if (!baseURL) {
        return badRequest('baseURL query parameter is required');
      }

      if (!isValidUrl(baseURL)) {
        return badRequest('Invalid baseURL provided');
      }

      const site = await Site.findByBaseURL(baseURL);
      const configuration = await Configuration.findLatest();

      if (!isNonEmptyObject(site)) {
        return notFound(`Site not found for baseURL: ${baseURL}`);
      }

      if (!site.isSandbox) {
        return badRequest(`Sandbox audit endpoint only supports sandbox sites. Site ${baseURL} is not a sandbox.`);
      }

      // If no auditType specified, run all audits
      if (!auditType) {
        const enabledAudits = ALL_AUDITS.filter(
          (audit) => configuration.isHandlerEnabledForSite(audit, site),
        );

        if (!isNonEmptyArray(enabledAudits)) {
          return badRequest(`No audits configured for site: ${baseURL}`);
        }

        const results = [];
        await Promise.all(
          enabledAudits.map(async (enabledAuditType) => {
            try {
              await triggerAuditForSiteAPI(site, enabledAuditType, context);
              results.push({ auditType: enabledAuditType, status: 'triggered' });
            } catch (error) {
              log.error(`Error running audit ${enabledAuditType} for site ${baseURL}`, error);
              results.push({ auditType: enabledAuditType, status: 'failed', error: error.message });
            }
          }),
        );

        const successCount = results.filter((r) => r.status === 'triggered').length;

        return ok({
          message: `Triggered ${successCount} audits for ${baseURL}`,
          siteId: site.getId(),
          baseURL,
          auditsTriggered: results.filter((r) => r.status === 'triggered').map((r) => r.auditType),
          results,
        });
      } else {
        // Run specific audit type
        if (!ALL_AUDITS.includes(auditType)) {
          return badRequest(`Invalid auditType. Supported types: ${ALL_AUDITS.join(', ')}`);
        }

        if (!configuration.isHandlerEnabledForSite(auditType, site)) {
          return badRequest(`Audits of type '${auditType}' are disabled for this site`);
        }

        await triggerAuditForSiteAPI(site, auditType, context);

        return ok({
          message: `Successfully triggered ${auditType} audit for ${baseURL}`,
          siteId: site.getId(),
          auditType,
          baseURL,
        });
      }
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
