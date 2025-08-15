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
 * Normalize raw auditType query parameter into an array of strings or null.
 * @param {string|string[]|undefined} auditTypeRaw
 * @returns {string[]|null}
 */
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
 * Enforce a minimum time gap between audits for the given site.
 * Returns an HTTP 400 Response if the limit is violated, otherwise null.
 *
 * @param {Readonly<Site>} site
 * @param {string[]|null} auditTypes – list of audits to check; null ⇒ ALL_AUDITS
 * @param {number} rateLimitHours – minimum gap in hours
 * @param {object} log – logger
 * @returns {Promise<import('@adobe/spacecat-shared-http-utils').Response|null>}
 */
export async function enforceRateLimit(site, auditTypes, rateLimitHours, log) {
  if (!Number.isFinite(rateLimitHours) || rateLimitHours <= 0) {
    return null; // rate limiting disabled
  }

  const now = Date.now();
  const windowMs = rateLimitHours * 60 * 60 * 1000;
  const typesToCheck = auditTypes && auditTypes.length > 0 ? auditTypes : ALL_AUDITS;

  const siteId = site.getId?.();
  const baseURL = site.getBaseURL?.();

  // eslint-disable-next-line no-restricted-syntax
  for (const auditType of typesToCheck) {
    // eslint-disable-next-line no-await-in-loop
    const lastAudit = await site.getLatestAuditByAuditType?.(auditType);
    if (lastAudit) {
      const lastRunMs = new Date(lastAudit.getAuditedAt()).getTime();
      const delta = now - lastRunMs;
      if (delta < windowMs) {
        const hrsAgo = (delta / (1000 * 60 * 60)).toFixed(2);
        log.info(
          {
            siteId,
            baseURL,
            auditType,
            hoursSinceLastRun: hrsAgo,
            rateLimitHours,
          },
          'Rate-limit hit: audit ran too recently',
        );
        return badRequest(`Rate limit exceeded: Audit '${auditType}' was run less than ${rateLimitHours}h ago`);
      }
    }
  }

  log.info(
    {
      siteId,
      baseURL,
      rateLimitHours,
    },
    'Rate-limit check passed',
  );
  return null;
}

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
 * Execute a batch of audits and collect per-audit status information.
 * @param {Readonly<Site>} site
 * @param {string[]} auditTypes – list of audit identifiers to run
 * @param {object} ctx – universal context (sqs, env, log)
 * @param {string} baseURL – site base URL (for logging)
 * @returns {Promise<Array<{auditType:string,status:string,error?:string}>>}
 */
async function runAuditBatch(site, auditTypes, ctx, baseURL) {
  const { log } = ctx;
  const results = [];

  await Promise.all(
    auditTypes.map(async (type) => {
      try {
        await triggerAuditForSiteAPI(site, type, ctx);
        results.push({ auditType: type, status: 'triggered' });
      } catch (err) {
        log.error(`Error running audit ${type} for site ${baseURL}`, err);
        results.push({ auditType: type, status: 'failed', error: err.message });
      }
    }),
  );

  return results;
}

function buildAuditResponse(site, baseURL, results) {
  const triggered = results.filter((r) => r.status === 'triggered');
  if (results.length === 1) {
    const { auditType } = results[0];
    return ok({
      message: `Successfully triggered ${auditType} audit for ${baseURL}`,
      siteId: site.getId(),
      auditType,
      baseURL,
    });
  }
  return ok({
    message: `Triggered ${triggered.length} of ${results.length} audits for ${baseURL}`,
    siteId: site.getId(),
    baseURL,
    auditsTriggered: triggered.map((r) => r.auditType),
    results,
  });
}

/**
 * Trigger all configuration-enabled audits for a site.
 */
export async function triggerAudits(site, configuration, auditTypeRaw, ctx, baseURL) {
  const { log } = ctx;
  let auditTypes;
  if (!auditTypeRaw) {
    auditTypes = ALL_AUDITS.filter((a) => configuration.isHandlerEnabledForSite(a, site));
    log.info(`SandboxAuditService: enabled audits for ${baseURL}: ${auditTypes.join(', ')}`);
    if (!isNonEmptyArray(auditTypes)) {
      return badRequest(`No audits configured for site: ${baseURL}`);
    }
  } else if (Array.isArray(auditTypeRaw)) {
    auditTypes = auditTypeRaw;
  } else {
    auditTypes = auditTypeRaw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const invalid = auditTypes.filter((t) => !ALL_AUDITS.includes(t));
  if (invalid.length) {
    return badRequest(`Invalid audit types: ${invalid.join(', ')}. Supported types: ${ALL_AUDITS.join(', ')}`);
  }
  const disabled = auditTypes.filter((t) => !configuration.isHandlerEnabledForSite(t, site));
  if (disabled.length) {
    return badRequest(`The following audit types are disabled for this site: ${disabled.join(', ')}`);
  }

  const results = await runAuditBatch(site, auditTypes, ctx, baseURL);
  return buildAuditResponse(site, baseURL, results);
}
