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
  isNonEmptyArray,
} from '@adobe/spacecat-shared-utils';
import {
  badRequest,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { sendAuditMessage } from './utils.js';

// Static list for now; will be replaced with dynamic configuration later.
export const ALL_AUDITS = [
  'meta-tags',
  'alt-text',
];

/**
 * Enqueue an individual audit for the given site.
 */
async function triggerAuditForSiteAPI(site, auditType, ctx) {
  return sendAuditMessage(
    ctx.sqs,
    ctx.env.AUDIT_JOBS_QUEUE_URL,
    auditType,
    {}, // Empty audit context – no Slack context needed
    site.getId(),
  );
}

/**
 * Trigger all configuration-enabled audits for a site.
 */
async function triggerAllEnabledAudits(site, configuration, ctx, baseURL) {
  const { log } = ctx;
  const enabledAudits = ALL_AUDITS.filter(
    (audit) => configuration.isHandlerEnabledForSite(audit, site),
  );

  log.info(`SandboxAuditService: enabled audits for ${baseURL}: ${enabledAudits.join(', ')}`);

  if (!isNonEmptyArray(enabledAudits)) {
    return badRequest(`No audits configured for site: ${baseURL}`);
  }

  const results = [];
  await Promise.all(
    enabledAudits.map(async (auditType) => {
      try {
        await triggerAuditForSiteAPI(site, auditType, ctx);
        results.push({ auditType, status: 'triggered' });
      } catch (error) {
        log.error(`Error running audit ${auditType} for site ${baseURL}`, error);
        results.push({ auditType, status: 'failed', error: error.message });
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
}

/**
 * Trigger a specific list of audit types for a site.
 */
async function triggerSpecificAudits(site, configuration, auditTypesInput, ctx, baseURL) {
  const { log } = ctx;
  const auditTypes = Array.isArray(auditTypesInput) ? auditTypesInput : [auditTypesInput];

  log.info(`SandboxAuditService: requested audits [${auditTypes.join(', ')}] for ${baseURL}`);

  // Validate audit types
  const invalidTypes = auditTypes.filter((t) => !ALL_AUDITS.includes(t));
  if (invalidTypes.length > 0) {
    return badRequest(`Invalid audit types: ${invalidTypes.join(', ')}. Supported types: ${ALL_AUDITS.join(', ')}`);
  }

  // Ensure they are enabled
  const disabledTypes = auditTypes.filter((t) => !configuration.isHandlerEnabledForSite(t, site));
  if (disabledTypes.length > 0) {
    return badRequest(`The following audit types are disabled for this site: ${disabledTypes.join(', ')}`);
  }

  const results = [];
  await Promise.all(
    auditTypes.map(async (type) => {
      try {
        await triggerAuditForSiteAPI(site, type, ctx);
        results.push({ auditType: type, status: 'triggered' });
      } catch (error) {
        log.error(`Error running audit ${type} for site ${baseURL}`, error);
        results.push({ auditType: type, status: 'failed', error: error.message });
      }
    }),
  );

  const successCount = results.filter((r) => r.status === 'triggered').length;

  if (auditTypes.length === 1) {
    return ok({
      message: `Successfully triggered ${auditTypes[0]} audit for ${baseURL}`,
      siteId: site.getId(),
      auditType: auditTypes[0],
      baseURL,
    });
  }

  return ok({
    message: `Triggered ${successCount} of ${auditTypes.length} audits for ${baseURL}`,
    siteId: site.getId(),
    baseURL,
    auditsTriggered: results.filter((r) => r.status === 'triggered').map((r) => r.auditType),
    results,
  });
}

/**
 * Public API combining the above helpers.
 *
 * @param {Site} site
 * @param {Configuration} configuration
 * @param {string|Array|undefined} auditType – undefined = all enabled audits
 * @param {object} ctx – universal context (sqs, env, log…)
 * @param {string} baseURL – original base URL (for messaging only)
 */
export async function triggerAudits(site, configuration, auditType, ctx, baseURL) {
  if (!auditType) {
    return triggerAllEnabledAudits(site, configuration, ctx, baseURL);
  }
  return triggerSpecificAudits(site, configuration, auditType, ctx, baseURL);
}
