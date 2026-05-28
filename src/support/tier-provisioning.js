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

import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import { hasText } from '@adobe/spacecat-shared-utils';
import TierClient from '@adobe/spacecat-shared-tier-client';

import { X_PRODUCT_HEADER } from './access-control-util.js';

export { X_PRODUCT_HEADER };

const VALID_PRODUCT_CODES = new Set(Object.values(EntitlementModel.PRODUCT_CODES));
const FREE_TRIAL_TIER = EntitlementModel.TIERS.FREE_TRIAL;
const PAID_TIER = EntitlementModel.TIERS.PAID;

/**
 * Structured log marker when a site was persisted but entitlement/enrollment failed.
 * Use in CloudWatch queries: `event=site_orphaned_after_create`.
 */
export const SITE_ORPHANED_AFTER_CREATE_EVENT = 'site_orphaned_after_create';

/**
 * Reads and validates the `x-product` header for write-time tier provisioning.
 *
 * Write-time contract (`x-product` header, documented at the CDN/gateway layer):
 * - Optional; when absent, callers manage entitlements separately.
 * - When present, provisions a single product at FREE_TRIAL only (no tier override field).
 * - Does not downgrade an existing non-PAID entitlement that is already above FREE_TRIAL
 *   (e.g. PLG, PRE_ONBOARD); missing site enrollments are still created when possible.
 *
 * @param {object} context - Request context with `pathInfo.headers`.
 * @returns {{ productCode: string } | { error: string }} Validated product code or error message.
 */
export function resolveWriteTimeProductCode(context) {
  const raw = context.pathInfo?.headers?.[X_PRODUCT_HEADER];
  if (!hasText(raw)) {
    return { error: null, productCode: null };
  }
  const productCode = raw.trim();
  if (!VALID_PRODUCT_CODES.has(productCode)) {
    const allowed = [...VALID_PRODUCT_CODES].join(', ');
    return { error: `Unsupported product code. Must be one of: ${allowed}` };
  }
  return { error: null, productCode };
}

/**
 * Returns true when `createEntitlement(FREE_TRIAL)` must not be called because it would
 * mutate an existing entitlement tier (TierClient downgrades non-PAID tiers to the requested tier).
 *
 * @param {string} currentTier - Existing entitlement tier.
 * @param {string} targetTier - Tier we would pass to createEntitlement.
 * @returns {boolean}
 */
export function wouldDowngradeExistingTier(currentTier, targetTier) {
  return currentTier !== targetTier
    && currentTier !== PAID_TIER
    && currentTier !== FREE_TRIAL_TIER;
}

/**
 * Returns true when an existing entitlement tier must not be passed through
 * `createEntitlement` (PAID must stay PAID; PLG/PRE_ONBOARD must not downgrade).
 *
 * @param {string} currentTier - Existing entitlement tier.
 * @returns {boolean}
 */
export function shouldPreserveExistingEntitlementTier(currentTier) {
  return currentTier === PAID_TIER || wouldDowngradeExistingTier(currentTier, FREE_TRIAL_TIER);
}

/**
 * Ensures org-level FREE_TRIAL entitlement for `productCode` without downgrading existing tiers.
 *
 * @param {object} context - Request context.
 * @param {object} organization - Organization entity.
 * @param {string} productCode - Validated product code.
 * @param {object} log - Logger.
 * @returns {Promise<object>} Created or existing entitlement entity.
 */
export async function ensureOrgEntitlement(context, organization, productCode, log) {
  const tierClient = TierClient.createForOrg(context, organization, productCode);
  const existing = await tierClient.checkValidEntitlement();

  if (
    existing.entitlement?.getTier
    && shouldPreserveExistingEntitlementTier(existing.entitlement.getTier())
  ) {
    const currentTier = existing.entitlement.getTier();
    log.info(
      `${productCode} entitlement already exists at tier ${currentTier} for organization `
      + `${organization.getId()}; skipping tier mutation`,
    );
    return existing.entitlement;
  }

  const { entitlement } = await tierClient.createEntitlement(FREE_TRIAL_TIER);
  log.info(`Ensured ${productCode} entitlement ${entitlement.getId()} for organization ${organization.getId()}`);
  return entitlement;
}

/**
 * Ensures org entitlement and site enrollment for `productCode` without downgrading existing tiers.
 *
 * @param {object} context - Request context.
 * @param {object} site - Site entity.
 * @param {string} productCode - Validated product code.
 * @param {object} log - Logger.
 * @returns {Promise<{ entitlement: object, siteEnrollment?: object }>}
 */
export async function ensureSiteEntitlementAndEnrollment(context, site, productCode, log) {
  const tierClient = await TierClient.createForSite(context, site, productCode);
  const existing = await tierClient.checkValidEntitlement();

  if (
    existing.entitlement?.getTier
    && shouldPreserveExistingEntitlementTier(existing.entitlement.getTier())
  ) {
    const currentTier = existing.entitlement.getTier();
    log.info(
      `${productCode} entitlement already exists at tier ${currentTier} for organization `
      + `${(await site.getOrganizationId())}; skipping tier mutation`,
    );
    if (existing.siteEnrollment) {
      return { entitlement: existing.entitlement, siteEnrollment: existing.siteEnrollment };
    }
    const { SiteEnrollment } = context.dataAccess;
    const siteEnrollment = await SiteEnrollment.create({
      siteId: site.getId(),
      entitlementId: existing.entitlement.getId(),
    });
    const enrollmentSuffix = ` and enrollment ${siteEnrollment.getId()}`;
    log.info(`Ensured ${productCode} entitlement ${existing.entitlement.getId()}${enrollmentSuffix} for site ${site.getId()}`);
    return { entitlement: existing.entitlement, siteEnrollment };
  }

  const {
    entitlement,
    siteEnrollment,
  } = await tierClient.createEntitlement(FREE_TRIAL_TIER);
  const enrollmentSuffix = siteEnrollment ? ` and enrollment ${siteEnrollment.getId()}` : '';
  log.info(`Ensured ${productCode} entitlement ${entitlement.getId()}${enrollmentSuffix} for site ${site.getId()}`);
  return { entitlement, siteEnrollment };
}

/**
 * Logs a structured orphan-site event after site create succeeded but provisioning failed.
 *
 * @param {object} log - Logger.
 * @param {object} site - Persisted site entity.
 * @param {string} productCode - Product code from the request header.
 * @param {Error} error - Provisioning error.
 */
export function logSiteOrphanedAfterCreate(log, site, productCode, error) {
  log.error(
    `event=${SITE_ORPHANED_AFTER_CREATE_EVENT} siteId=${site.getId()} productCode=${productCode} `
    + `message=${error.message}`,
    error,
  );
}
