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
  isNonEmptyArray,
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import {
  badRequest,
  forbidden,
  notFound,
  ok,
  createResponse,
} from '@adobe/spacecat-shared-http-utils';

// Static list for now; will be replaced with dynamic configuration later.
export const ALL_AUDITS = [
  'meta-tags',
  'alt-text',
];

export async function validateSiteAccess(siteId, siteModel, accessControlUtil) {
  if (!hasText(siteId)) {
    return { error: badRequest('siteId path parameter is required') };
  }

  if (!isValidUUID(siteId)) {
    return { error: badRequest('Invalid siteId provided') };
  }

  const site = await siteModel.findById(siteId);
  if (!isNonEmptyObject(site)) {
    return { error: notFound(`Site not found for siteId: ${siteId}`) };
  }

  const hasAccess = await accessControlUtil.hasAccess(site);
  if (!hasAccess) {
    return { error: forbidden('User does not have access to this site') };
  }

  if (!site.getIsSandbox()) {
    return {
      error: badRequest(`Sandbox audit endpoint only supports sandbox sites. Site ${siteId} is not a sandbox.`),
    };
  }

  return { site };
}

export function buildRateLimitResponse(skipped, rateLimitHours) {
  const minMinutes = Math.min(...skipped.map((s) => s.minutesRemaining));
  const hours = Math.floor(minMinutes / 60);
  const minutes = minMinutes % 60;
  const timeString = hours > 0 ? `${hours}h ${minutes}m` : `${minutes} minutes`;

  const auditTypes = skipped.map((s) => s.auditType);
  const message = `Rate limit exceeded: audits ${auditTypes.join(', ')} were run less than ${rateLimitHours}h ago.`;

  return createResponse({
    message,
    nextAllowedIn: timeString,
    minutesRemaining: minMinutes,
    auditsSkipped: auditTypes,
    skippedDetail: skipped,
  }, 429, { 'x-error': message });
}

export function normalizeAuditTypes(auditTypeRaw) {
  if (!auditTypeRaw) {
    return null;
  }

  if (Array.isArray(auditTypeRaw)) {
    return auditTypeRaw;
  }

  return auditTypeRaw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Checks rate limit for a single audit type.
 *
 * @param {object} site - Site object
 * @param {string} auditType - Audit type to check
 * @param {number} windowMs - Rate limit window in milliseconds
 * @returns {Promise<{allowed: boolean, skipDetail?: object}>} Rate limit result
 */
async function checkAuditRateLimit(site, auditType, windowMs) {
  const lastAudit = await site.getLatestAuditByAuditType?.(auditType);

  if (!lastAudit) {
    return { allowed: true };
  }

  const now = Date.now();
  const lastRunMs = new Date(lastAudit.getAuditedAt()).getTime();
  const delta = now - lastRunMs;

  if (delta >= windowMs) {
    return { allowed: true };
  }

  // Rate limit exceeded
  const nextAllowedMs = lastRunMs + windowMs;
  const minutesRemaining = Math.ceil((nextAllowedMs - now) / 60000);

  return {
    allowed: false,
    skipDetail: {
      auditType,
      nextAllowedAt: new Date(nextAllowedMs).toISOString(),
      minutesRemaining,
    },
  };
}

/**
 * Enforce a minimum time gap between audits for the given site.
 * Determines which audits are allowed and which should be skipped due to rate limiting.
 *
 * @param {Readonly<Site>} site - Site object to check audits for
 * @param {string[]|null} auditTypes - List of audits to check; null means ALL_AUDITS
 * @param {number} rateLimitHours - Minimum gap in hours between audit runs
 * @param {object} log - Logger instance
 * @returns {Promise<{allowed: string[], skipped: object[]}>} Rate limit enforcement result
 */
export async function enforceRateLimit(site, auditTypes, rateLimitHours, log) {
  const types = auditTypes && auditTypes.length > 0 ? auditTypes : ALL_AUDITS;

  // Rate limiting disabled - allow all
  if (!Number.isFinite(rateLimitHours) || rateLimitHours <= 0) {
    return { allowed: types, skipped: [] };
  }

  const windowMs = rateLimitHours * 60 * 60 * 1000;
  const allowed = [];
  const skipped = [];

  // Check each audit type against rate limits
  for (const auditType of types) {
    // eslint-disable-next-line no-await-in-loop
    const rateLimitResult = await checkAuditRateLimit(site, auditType, windowMs);

    if (rateLimitResult.allowed) {
      allowed.push(auditType);
    } else {
      skipped.push(rateLimitResult.skipDetail);
    }
  }

  // Log rate limit information if any audits were skipped
  if (skipped.length > 0) {
    log.info({
      skipped: skipped.map((s) => s.auditType),
      baseURL: site.getBaseURL(),
      rateLimitHours,
    }, 'Rate-limit: some audits skipped');
  }

  return { allowed, skipped };
}

/**
 * Enqueues a single audit job for execution.
 *
 * @param {object} site - Site object
 * @param {string} auditType - Type of audit to trigger
 * @param {object} context - Application context
 * @returns {Promise<void>} Job enqueue result
 */
async function enqueueAuditJob(site, auditType, context) {
  const message = {
    type: auditType,
    siteId: site.getId(),
    auditContext: {}, // Empty context for sandbox audits (no Slack integration)
  };

  return context.sqs.sendMessage(context.env.AUDIT_JOBS_QUEUE_URL, message);
}

/**
 * Executes a single audit and returns the result.
 *
 * @param {object} site - Site object
 * @param {string} auditType - Type of audit to execute
 * @param {string} baseURL - Site base URL for logging
 * @param {object} context - Application context
 * @returns {Promise<{auditType: string, status: string, error?: string}>} Execution result
 */
async function executeAudit(site, auditType, baseURL, context) {
  try {
    await enqueueAuditJob(site, auditType, context);
    return { auditType, status: 'triggered' };
  } catch (error) {
    context.log.error(`Error running audit ${auditType} for site ${baseURL}`, error);
    return {
      auditType,
      status: 'failed',
      error: error.message,
    };
  }
}

/**
 * Executes multiple audits concurrently.
 *
 * @param {object} site - Site object
 * @param {string[]} auditTypes - Array of audit types to execute
 * @param {string} baseURL - Site base URL for logging
 * @param {object} context - Application context
 * @returns {Promise<Array>} Array of execution results
 */
async function executeBatch(site, auditTypes, baseURL, context) {
  const executionPromises = auditTypes.map(
    (auditType) => executeAudit(site, auditType, baseURL, context),
  );
  return Promise.all(executionPromises);
}

/**
 * Determines which audit types to execute based on input and configuration.
 *
 * @param {string[]|string|null} auditTypeRaw - Raw audit type input
 * @param {object} site - Site object
 * @param {string} baseURL - Site base URL for logging
 * @param {object} configuration - System configuration
 * @param {object} logger - Logger instance
 * @returns {{auditTypes: string[], error?: Response}} Processing result
 */
function determineAuditTypes(auditTypeRaw, site, baseURL, configuration, logger) {
  let auditTypes;

  if (!auditTypeRaw) {
    // No specific types requested - use all enabled audits
    auditTypes = ALL_AUDITS.filter((audit) => configuration.isHandlerEnabledForSite(audit, site));

    logger.info(`SandboxAuditService: enabled audits for ${baseURL}: ${auditTypes.join(', ')}`);

    if (!isNonEmptyArray(auditTypes)) {
      return {
        error: badRequest(`No audits configured for site: ${baseURL}`),
      };
    }
  } else {
    // Specific types requested - normalize the input
    auditTypes = Array.isArray(auditTypeRaw)
      ? auditTypeRaw
      : auditTypeRaw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  return { auditTypes };
}

/**
 * Validates that audit types are supported.
 *
 * @param {string[]} auditTypes - Array of audit types to validate
 * @returns {{error?: Response}} Validation result
 */
function validateAuditTypes(auditTypes) {
  const invalid = auditTypes.filter((type) => !ALL_AUDITS.includes(type));

  if (invalid.length > 0) {
    return {
      error: badRequest(
        `Invalid audit types: ${invalid.join(', ')}. Supported types: ${ALL_AUDITS.join(', ')}`,
      ),
    };
  }

  return {};
}

/**
 * Validates that audit types are enabled for the site.
 *
 * @param {string[]} auditTypes - Array of audit types to validate
 * @param {object} site - Site object
 * @param {object} configuration - System configuration
 * @returns {{error?: Response}} Validation result
 */
function validateEnabledAudits(auditTypes, site, configuration) {
  const disabled = auditTypes.filter((type) => !configuration.isHandlerEnabledForSite(type, site));

  if (disabled.length > 0) {
    return {
      error: badRequest(
        `The following audit types are disabled for this site: ${disabled.join(', ')}`,
      ),
    };
  }

  return {};
}

/**
 * Orchestrates the complete audit triggering process.
 * Main entry point that coordinates validation, execution, and response building.
 *
 * @param {object} site - Site object to audit
 * @param {object} configuration - System configuration
 * @param {string[]|string|null} auditTypeRaw - Raw audit type specification
 * @param {object} ctx - Application context (sqs, env, log)
 * @param {Array} skippedDetail - Details of rate-limited audits
 * @returns {Promise<import('@adobe/spacecat-shared-http-utils').Response>} Audit response
 */
export async function triggerAudits(
  site,
  configuration,
  auditTypeRaw,
  ctx,
  skippedDetail = [],
) {
  const { log } = ctx;
  const baseURL = site.getBaseURL();

  // Determine which audit types to run
  const typeResult = determineAuditTypes(auditTypeRaw, site, baseURL, configuration, log);
  if (typeResult.error) {
    return typeResult.error;
  }

  const { auditTypes } = typeResult;

  // Validate audit types are supported
  const supportValidation = validateAuditTypes(auditTypes);
  if (supportValidation.error) {
    return supportValidation.error;
  }

  // Validate audit types are enabled for this site
  const enabledValidation = validateEnabledAudits(auditTypes, site, configuration);
  if (enabledValidation.error) {
    return enabledValidation.error;
  }

  // Execute audits
  const results = await executeBatch(site, auditTypes, baseURL, ctx);

  // Add skipped audit details to results
  const allResults = [...results];
  skippedDetail.forEach((skipDetail) => {
    allResults.push({
      auditType: skipDetail.auditType,
      status: 'skipped',
      nextAllowedAt: skipDetail.nextAllowedAt,
      minutesRemaining: skipDetail.minutesRemaining,
    });
  });

  // Build and return response
  const triggered = allResults.filter((r) => r.status === 'triggered');
  return ok({
    message: `Triggered ${triggered.length} of ${allResults.length} audits for ${baseURL}`,
    siteId: site.getId(),
    baseURL,
    auditsTriggered: triggered.map((r) => r.auditType),
    auditsSkipped: skippedDetail.map((s) => s.auditType),
    results: allResults,
  });
}
