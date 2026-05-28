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

/**
 * Structured log marker when a site was persisted but entitlement/enrollment failed.
 * Use in CloudWatch queries: `event=site_orphaned_after_create`.
 */
export const SITE_ORPHANED_AFTER_CREATE_EVENT = 'site_orphaned_after_create';

/**
 * Reads and validates the `x-product` header for write-time tier provisioning.
 * The header is set at the CDN layer; when absent, provisioning is skipped.
 *
 * @param {object} context - Request context with `pathInfo.headers`.
 * @returns {{ productCode: string } | { error: string }} Validated product code or error message.
 */
export function resolveProductCode(context) {
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
 * @param {object} tierClient - TierClient instance with `checkValidEntitlement`.
 * @returns {Promise<string>} Tier to pass to `createEntitlement`.
 */
async function resolveProvisioningTier(tierClient) {
  const existing = await tierClient.checkValidEntitlement();
  return existing.entitlement?.getTier?.() ?? FREE_TRIAL_TIER;
}

/**
 * Ensures org-level entitlement for `productCode` on newly created organizations.
 *
 * @param {object} context - Request context.
 * @param {object} organization - Organization entity.
 * @param {string} productCode - Validated product code.
 * @param {object} log - Logger.
 * @returns {Promise<object>} Created or updated entitlement entity.
 */
export async function ensureOrgEntitlement(context, organization, productCode, log) {
  const tierClient = TierClient.createForOrg(context, organization, productCode);
  const tier = await resolveProvisioningTier(tierClient);
  const { entitlement } = await tierClient.createEntitlement(tier);
  log.info(`Ensured ${productCode} entitlement ${entitlement.getId()} for organization ${organization.getId()}`);
  return entitlement;
}

/**
 * Ensures org entitlement and site enrollment for `productCode` on newly created sites.
 *
 * @param {object} context - Request context.
 * @param {object} site - Site entity.
 * @param {string} productCode - Validated product code.
 * @param {object} log - Logger.
 * @returns {Promise<{ entitlement: object, siteEnrollment?: object }>}
 */
export async function ensureSiteEntitlementAndEnrollment(context, site, productCode, log) {
  const tierClient = await TierClient.createForSite(context, site, productCode);
  const tier = await resolveProvisioningTier(tierClient);
  const {
    entitlement,
    siteEnrollment,
  } = await tierClient.createEntitlement(tier);
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
