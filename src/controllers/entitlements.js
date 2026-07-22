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
  badRequest,
  notFound,
  ok,
  forbidden,
  internalServerError,
  created,
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import TierClient from '@adobe/spacecat-shared-tier-client';
import DrsClient from '@adobe/spacecat-shared-drs-client';

import { EntitlementDto } from '../dto/entitlement.js';
import { SiteEnrollmentDto } from '../dto/site-enrollment.js';
import AccessControlUtil from '../support/access-control-util.js';
import { ensurePromptSuggestionSchedules } from '../support/prompt-suggestion-schedules.js';

const VALID_PRODUCT_CODES = new Set(Object.values(EntitlementModel.PRODUCT_CODES));
const FREE_TRIAL_TIER = EntitlementModel.TIERS.FREE_TRIAL;
const PAID_TIER = EntitlementModel.TIERS.PAID;
const LLMO_PRODUCT_CODE = EntitlementModel.PRODUCT_CODES.LLMO;

/**
 * Best-effort reaction to a trial→paid LLMO transition: (re)provisions the site's
 * recurring DRS prompt-suggestion schedules. Never throws — the entitlement
 * operation must succeed regardless of this side-effect (mirrors the best-effort
 * schedule registration on the onboarding path). The dedicated endpoint
 * (`POST /sites/:siteId/prompt-suggestion-schedules`) is the reusable equivalent;
 * this inlines the same shared helper so an admin tier flip is not silently
 * missed while the fulfillment-worker call + reconciler are still follow-ups.
 *
 * @param {object} context - Request context (for DrsClient + log).
 * @param {string} siteId - Site UUID.
 * @param {object} log - Logger.
 * @returns {Promise<void>}
 */
async function reactToLlmoTrialToPaid(context, siteId, log) {
  try {
    const drsClient = DrsClient.createFrom(context);
    if (!drsClient.isConfigured()) {
      log.debug(`[prompt-suggestion-schedules] DRS not configured, skipping trial→paid reaction for site ${siteId}`);
      return;
    }
    const { results, allSucceeded } = await ensurePromptSuggestionSchedules({
      drsClient,
      siteId,
      isPaying: true,
      log,
    });
    const summary = results.map((r) => `${r.providerId}:${r.status}`).join(',');
    if (allSucceeded) {
      log.info(`[prompt-suggestion-schedules] trial→paid provisioned recurring schedules site_id=${siteId} results=${summary}`);
    } else {
      log.error(`[prompt-suggestion-schedules] trial→paid: one or more pipelines failed site_id=${siteId} results=${summary}`);
    }
  } catch (e) {
    log.error(`[prompt-suggestion-schedules] trial→paid reaction failed for site ${siteId}: ${e.message}`);
  }
}

/**
 * Entitlements controller. Provides methods to read entitlements by organization.
 * @param {object} ctx - Context of the request.
 * @returns {object} Entitlements controller.
 * @constructor
 */
function EntitlementsController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Entitlement, Organization, Site } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Gets entitlements by organization ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of entitlements response.
   */
  const getByOrganizationID = async (context) => {
    const { organizationId } = context.params;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    try {
      // Get organization to check access control
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Only users belonging to the organization can view its entitlements');
      }

      const entitlements = await Entitlement.allByOrganizationId(organizationId);

      const orgEntitlements = entitlements
        .map((entitlement) => EntitlementDto.toJSON(entitlement));
      return ok(orgEntitlements);
    } catch (e) {
      context.log.error(`Error getting entitlements for organization ${organizationId}: ${e.message}`);
      return internalServerError('Failed to retrieve entitlements');
    }
  };

  /**
   * Creates an entitlement for an organization.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Created entitlement response.
   */
  const createEntitlement = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create entitlements');
    }
    const { organizationId } = context.params;
    const {
      productCode = EntitlementModel.PRODUCT_CODES.LLMO,
      tier = FREE_TRIAL_TIER,
    } = context.data || {};
    if (typeof tier !== 'string' || !Object.values(EntitlementModel.TIERS).includes(tier)) {
      return badRequest(`Invalid tier. Must be one of: ${Object.values(EntitlementModel.TIERS).join(', ')}`);
    }
    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }
    if (typeof productCode !== 'string' || !VALID_PRODUCT_CODES.has(productCode)) {
      return badRequest(`Invalid product code. Must be one of: ${[...VALID_PRODUCT_CODES].join(', ')}`);
    }
    try {
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }
      const tierClient = await TierClient.createForOrg(
        context,
        organization,
        productCode,
      );
      const { entitlement } = await tierClient.createEntitlement(tier);
      return created(EntitlementDto.toJSON(entitlement));
    } catch (e) {
      context.log.error(`Error creating entitlement for organization ${organizationId}: ${e.message}`);
      return internalServerError('Failed to create entitlement');
    }
  };

  /**
   * Ensures an entitlement (org-level) and a site enrollment exist for the given
   * site and product. Mirrors the Slack `ensure entitlement site` command: if the
   * site's organization has no entitlement for the product, one is created with
   * default free-trial quotas; then the site enrollment linking the site to that
   * entitlement is created. The operation is idempotent — repeating the call
   * returns the same entitlement + enrollment without duplicating rows.
   *
   * Admin-only. The route is intentionally absent from
   * `routes/required-capabilities.js` and listed in `INTERNAL_ROUTES` so S2S
   * consumers are denied by default (matches the parallel
   * `POST /organizations/:organizationId/entitlements` admin-only contract).
   *
   * Distinct from `POST /sites/:siteId/site-enrollments`
   * (SiteEnrollmentsController.createPlgEnrollment), which is a narrower,
   * ASO-only, summit-PLG-gated path that refuses to create the org entitlement
   * when missing. This endpoint is the general-purpose Slack equivalent: any
   * supported product, creates the entitlement when missing, no PLG handler
   * gate.
   *
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Created entitlement + site enrollment response.
   */
  const createSiteEntitlement = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can ensure entitlements for a site');
    }
    const { siteId } = context.params;
    const {
      productCode,
      tier = FREE_TRIAL_TIER,
    } = context.data || {};
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (typeof productCode !== 'string' || !VALID_PRODUCT_CODES.has(productCode)) {
      return badRequest(`Invalid product code. Must be one of: ${[...VALID_PRODUCT_CODES].join(', ')}`);
    }
    if (typeof tier !== 'string' || !Object.values(EntitlementModel.TIERS).includes(tier)) {
      return badRequest(`Invalid tier. Must be one of: ${Object.values(EntitlementModel.TIERS).join(', ')}`);
    }
    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }
      // TierClient.createForSite resolves the site's owning organization and
      // returns a client bound to (site, organization, productCode). Its
      // .createEntitlement(tier) is the same idempotent path the Slack command
      // uses: creates the org entitlement if missing, then the site enrollment;
      // updates a non-PAID tier if the request asks for a different one;
      // returns existing rows on repeat calls.
      const tierClient = await TierClient.createForSite(
        context,
        site,
        productCode,
      );
      // Read the prior tier BEFORE the create so we can detect a trial→paid
      // transition without changing the shared createEntitlement return shape
      // (mirrors resolveProvisioningTier in support/tier-provisioning.js).
      const existing = await tierClient.checkValidEntitlement();
      const prevTier = existing.entitlement?.getTier?.() ?? null;

      const { entitlement, siteEnrollment } = await tierClient.createEntitlement(tier);

      // LLMO trial→paid: (re)provision recurring prompt-suggestion schedules.
      // Best-effort — never fails the entitlement op.
      const resultTier = entitlement?.getTier?.();
      if (productCode === LLMO_PRODUCT_CODE
        && prevTier !== PAID_TIER
        && resultTier === PAID_TIER) {
        await reactToLlmoTrialToPaid(context, siteId, context.log);
      }

      return created({
        entitlement: EntitlementDto.toJSON(entitlement),
        siteEnrollment: SiteEnrollmentDto.toJSON(siteEnrollment),
      });
    } catch (e) {
      context.log.error(`Error ensuring entitlement for site ${siteId}: ${e.message}`);
      return internalServerError('Failed to ensure entitlement for site');
    }
  };

  return {
    getByOrganizationID,
    createEntitlement,
    createSiteEntitlement,
  };
}

export default EntitlementsController;
