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

const AUDIT_TYPE = 'llmo-customer-analysis';
const ONBOARDING_MODE_V2 = 'v2';

/**
 * Allowed values for the `changeKind` field. Audit-worker
 * (`spacecat-audit-worker/src/llmo-customer-analysis/handler.js`) routes by
 * this discriminant — keep both repos in sync when adding new kinds.
 */
export const CUSTOMER_ANALYSIS_CHANGE_KINDS = Object.freeze({
  BRANDS: 'brands',
  COMPETITORS: 'competitors',
  CATEGORIES: 'categories',
  TOPICS: 'topics',
  ENTITIES: 'entities',
  PROMPTS: 'prompts',
});

const VALID_CHANGE_KINDS = new Set(Object.values(CUSTOMER_ANALYSIS_CHANGE_KINDS));

const NOOP_LOG = Object.freeze({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
});

/**
 * Dispatch one `llmo-customer-analysis` audit message per site for the given
 * organization. Used after every v2 (brandalf) customer-config mutation in
 * BrandsController so the audit-worker can fan out brand-detection and
 * brand-presence-refresh triggers.
 *
 * Never throws. Failures are logged at warn level so the original mutation's
 * HTTP response is unaffected. The audit-worker performs its own brandalf
 * feature-flag check and silently no-ops for non-brandalf orgs (LLMO-4744),
 * so this helper does not need to gate.
 *
 * @param {object} context - Request context (sqs, env, dataAccess)
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} changeKind - One of CUSTOMER_ANALYSIS_CHANGE_KINDS values
 * @param {object} [log] - Logger; falls back to a no-op logger when omitted
 * @returns {Promise<void>}
 */
export async function dispatchCustomerAnalysisV2(context, organizationId, changeKind, log) {
  const logger = log || context?.log || NOOP_LOG;

  if (!VALID_CHANGE_KINDS.has(changeKind)) {
    logger.warn(`[${AUDIT_TYPE}] Refusing to dispatch with invalid changeKind="${changeKind}" for org ${organizationId}`);
    return;
  }

  try {
    const Site = context?.dataAccess?.Site;
    const queueUrl = context?.env?.AUDIT_JOBS_QUEUE_URL;

    if (!queueUrl) {
      logger.warn(`[${AUDIT_TYPE}] AUDIT_JOBS_QUEUE_URL not configured; skipping dispatch for org ${organizationId} changeKind=${changeKind}`);
      return;
    }

    if (!Site || typeof Site.allByOrganizationId !== 'function') {
      logger.warn(`[${AUDIT_TYPE}] Site.allByOrganizationId not available; skipping dispatch for org ${organizationId} changeKind=${changeKind}`);
      return;
    }

    const sites = await Site.allByOrganizationId(organizationId);
    if (!Array.isArray(sites) || sites.length === 0) {
      logger.warn(`[${AUDIT_TYPE}] No sites found for org ${organizationId}; skipping dispatch (changeKind=${changeKind})`);
      return;
    }

    let sent = 0;
    await Promise.all(sites.map(async (site) => {
      const siteId = site.getId?.() || site.getSiteId?.();
      if (!siteId) {
        logger.warn(`[${AUDIT_TYPE}] Site without id encountered for org ${organizationId}; skipping`);
        return;
      }
      try {
        await context.sqs.sendMessage(queueUrl, {
          type: AUDIT_TYPE,
          siteId,
          auditContext: {
            onboardingMode: ONBOARDING_MODE_V2,
            organizationId,
            changeKind,
          },
        });
        sent += 1;
      } catch (sendError) {
        logger.warn(`[${AUDIT_TYPE}] Failed to dispatch for site ${siteId} (org ${organizationId}, changeKind=${changeKind}): ${sendError.message}`);
      }
    }));

    logger.info(`[${AUDIT_TYPE}] Dispatched ${sent}/${sites.length} message(s) for org ${organizationId} changeKind=${changeKind}`);
  } catch (error) {
    logger.warn(`[${AUDIT_TYPE}] Unexpected error during dispatch for org ${organizationId} changeKind=${changeKind}: ${error.message}`);
  }
}
