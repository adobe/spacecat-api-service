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
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import {
  badRequest,
  forbidden,
  notFound,
  ok,
  createResponse,
} from '@adobe/spacecat-shared-http-utils';

// TODO: Move ALL_AUDITS to spacecat-shared-data-access configuration object
export const ALL_AUDITS = [
  'meta-tags',
  'product-metatags',
  'alt-text',
];

// Constants
const MILLISECONDS_PER_MINUTE = 60000;
const DEFAULT_RATE_LIMIT_HOURS = 4;

// Audit status enum
const AUDIT_STATUS = {
  TRIGGERED: 'triggered',
  SKIPPED: 'skipped',
  FAILED: 'failed',
};

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

/**
 * Normalizes and validates audit types in one pass.
 *
 * @param {string[]|string|null} auditTypeRaw - Raw audit type input
 * @returns {{auditTypes: string[], error?: Response}} Normalized and validated audit types
 */
export function normalizeAndValidateAuditTypes(auditTypeRaw) {
  // Handle empty input
  if (!auditTypeRaw) {
    return { auditTypes: [] };
  }

  // Normalize to array
  const auditTypes = Array.isArray(auditTypeRaw)
    ? auditTypeRaw
    : auditTypeRaw.split(',').map((s) => s.trim()).filter(Boolean);

  // Empty array is valid - means "all audits"
  if (auditTypes.length === 0) {
    return { auditTypes };
  }

  // Validate types
  const invalidTypes = auditTypes.filter((type) => !ALL_AUDITS.includes(type));
  if (invalidTypes.length > 0) {
    // FIX: Wrap the response in an error object
    return {
      error: badRequest(`Invalid audit types: ${invalidTypes.join(', ')}. Supported types: ${ALL_AUDITS.join(', ')}`),
    };
  }

  return { auditTypes };
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
  const minutesRemaining = Math.ceil((nextAllowedMs - now) / MILLISECONDS_PER_MINUTE);

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
 * Enforce rate limits and build appropriate response.
 *
 * @param {Readonly<Site>} site - Site object to check audits for
 * @param {string[]} auditTypes - List of audits to check; empty array means ALL_AUDITS
 * @param {object} ctx - Application context containing env vars
 * @param {object} log - Logger instance
 * @returns {Promise<{allowed: string[], skipped: object[], response?: Response}>} Rate limit result
 */
export async function enforceRateLimit(site, auditTypes, ctx, log) {
  // Properly handle environment variable that could be "0"
  const envValue = ctx.env.SANDBOX_AUDIT_RATE_LIMIT_HOURS;
  const rateLimitHours = envValue !== undefined && envValue !== ''
    ? parseInt(envValue, 10)
    : DEFAULT_RATE_LIMIT_HOURS;
  const types = auditTypes.length > 0 ? auditTypes : ALL_AUDITS;

  // Rate limiting disabled - allow all
  if (!Number.isFinite(rateLimitHours) || rateLimitHours <= 0) {
    log.debug('Rate limiting disabled (rateLimitHours is 0 or invalid), allowing all audits');
    return { allowed: auditTypes, skipped: [] };
  }

  const windowMs = rateLimitHours * 60 * 60 * 1000; // hours -> minutes -> seconds -> ms
  const allowed = [];
  const skipped = [];

  // Check each audit type
  for (const auditType of types) {
    // eslint-disable-next-line no-await-in-loop
    const rateLimitResult = await checkAuditRateLimit(site, auditType, windowMs);
    if (rateLimitResult.allowed) {
      allowed.push(auditType);
    } else {
      skipped.push(rateLimitResult.skipDetail);
    }
  }

  // Log if any audits were skipped
  if (skipped.length > 0) {
    log.info({
      skipped: skipped.map((skippedAudit) => skippedAudit.auditType),
      allowed: allowed.map((auditType) => auditType),
      baseURL: site.getBaseURL(),
      rateLimitHours,
    }, 'Some audits skipped due to rate limit, others allowed');
  }

  // If ALL audits were skipped, return 429
  if (allowed.length === 0) {
    const message = `Rate limit exceeded: audits ${skipped.map((skippedAudit) => skippedAudit.auditType).join(', ')} were run less than ${rateLimitHours}h ago.`;

    return {
      allowed,
      skipped,
      response: createResponse({
        message,
        siteId: site.getId(),
        baseURL: site.getBaseURL(),
        results: skipped.map((skippedAudit) => ({
          auditType: skippedAudit.auditType,
          status: AUDIT_STATUS.SKIPPED,
          nextAllowedAt: skippedAudit.nextAllowedAt,
          minutesRemaining: skippedAudit.minutesRemaining,
        })),
      }, 429, { 'x-error': message }),
    };
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
    return { auditType, status: AUDIT_STATUS.TRIGGERED };
  } catch (error) {
    context.log.error(`Error running audit ${auditType} for site ${baseURL}`, error);
    return {
      auditType,
      status: AUDIT_STATUS.FAILED,
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
/**
 * Determines and validates audit types to run.
 * Handles both cases: no specific types (use all enabled) and specific types requested.
 *
 * @param {string[]|string|null} auditTypeRaw - Raw audit type input
 * @param {object} site - Site object
 * @param {string} baseURL - Site base URL for logging
 * @param {object} configuration - System configuration
 * @param {object} logger - Logger instance
 * @returns {{auditTypes: string[], error?: Response}} Processing result
 */
function determineAuditTypes(auditTypeRaw, site, baseURL, configuration, logger) {
  // First normalize input if specific types requested
  const normalizedResult = auditTypeRaw
    ? normalizeAndValidateAuditTypes(auditTypeRaw)
    : { auditTypes: ALL_AUDITS };

  if (normalizedResult.error) {
    return normalizedResult;
  }

  // Filter to enabled audit types
  const enabled = normalizedResult.auditTypes.filter(
    (type) => configuration.isHandlerEnabledForSite(type, site),
  );
  const disabled = normalizedResult.auditTypes.filter(
    (type) => !configuration.isHandlerEnabledForSite(type, site),
  );

  // Log enabled audits when no specific types requested
  if (!auditTypeRaw) {
    logger.info(`SandboxAuditService: enabled audits for ${baseURL}: ${enabled.join(', ')}`);
  }

  // Handle case where no audits are enabled
  if (enabled.length === 0) {
    const message = auditTypeRaw
      ? `The following audit types are disabled for this site: ${disabled.join(', ')}`
      : `No audits configured for site: ${baseURL}`;
    return { error: badRequest(message) };
  }

  return { auditTypes: enabled };
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

  // Determine and validate audit types
  const typeResult = determineAuditTypes(auditTypeRaw, site, baseURL, configuration, log);
  if (typeResult.error) {
    return typeResult.error;
  }

  // Execute audits (only enabled ones)
  const results = await executeBatch(site, typeResult.auditTypes, baseURL, ctx);

  // Add skipped audit details to results
  const allResults = [...results];
  skippedDetail.forEach((skipDetail) => {
    allResults.push({
      auditType: skipDetail.auditType,
      status: AUDIT_STATUS.SKIPPED,
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
    results: allResults,
  });
}
