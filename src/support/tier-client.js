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
import { Entitlement as EntitlementModel, OrganizationIdentityProvider as OrganizationIdentityProviderModel } from '@adobe/spacecat-shared-data-access';

/**
 * TierClient provides methods to manage entitlements and site enrollments.
 * @param {object} context - Context of the request.
 * @param {string} orgId - Organization ID.
 * @param {string} siteId - Site ID.
 * @param {string} productCode - Product code.
 * @returns {object} TierClient instance.
 * @constructor
 */
function TierClient(context, orgId, siteId, productCode) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }

  if (!orgId) {
    throw new Error('Organization ID required');
  }

  // siteId is optional - can be null/undefined for organization-only operations

  if (!productCode) {
    throw new Error('Product code required');
  }

  const { dataAccess } = context;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const {
    Entitlement,
    SiteEnrollment,
    Organization,
    Site,
    OrganizationIdentityProvider,
  } = dataAccess;

  const { log } = context;

  /**
   * Checks for valid entitlement on organization and valid site enrollment on site.
   * @returns {Promise<object>} Object with entitlement and/or siteEnrollment based on what exists.
   */
  const checkValidEntitlement = async () => {
    try {
      log.info(`Checking for valid entitlement for org ${orgId} and product ${productCode}`);

      const entitlement = await Entitlement.findByOrganizationIdAndProductCode(orgId, productCode);

      if (!entitlement) {
        log.info(`No valid entitlement found for org ${orgId} and product ${productCode}`);
        return {};
      }

      log.info(`Found valid entitlement: ${entitlement.getId()}`);

      // Only check for site enrollment if siteId is provided
      if (siteId) {
        log.info(`Checking for valid site enrollment for site ${siteId} and entitlement ${entitlement.getId()}`);

        const siteEnrollments = await SiteEnrollment.allBySiteId(siteId);
        const validSiteEnrollment = siteEnrollments.find(
          (se) => se.getEntitlementId() === entitlement.getId(),
        );

        if (!validSiteEnrollment) {
          log.info(`No valid site enrollment found for site ${siteId} and entitlement ${entitlement.getId()}`);
          return { entitlement };
        }

        log.info(`Found valid site enrollment: ${validSiteEnrollment.getId()}`);

        return {
          entitlement,
          siteEnrollment: validSiteEnrollment,
        };
      } else {
        log.info(`No siteId provided, returning entitlement only for org ${orgId}`);
        return { entitlement };
      }
    } catch (error) {
      log.error(`Error checking valid entitlement and site enrollment: ${error.message}`);
      throw error;
    }
  };

  /**
   * Creates entitlement for organization and site enrollment for site.
   * First validates that org and site don't already have an entitlement for this product.
   * @param {string} tier - Entitlement tier.
   * @returns {Promise<object>} Object with created entitlement and siteEnrollment.
   */
  const createEntitlement = async (tier) => {
    try {
      log.info(`Creating entitlement for org ${orgId}, site ${siteId}, product ${productCode}, tier ${tier}`);

      // Validate tier
      if (!Object.values(EntitlementModel.TIERS).includes(tier)) {
        throw new Error(`Invalid tier: ${tier}. Valid tiers: ${Object.values(EntitlementModel.TIERS).join(', ')}`);
      }

      // Site ID is required for creating entitlements
      if (!siteId) {
        throw new Error('Site ID required for creating entitlements');
      }

      // Check if organization exists
      const organization = await Organization.findById(orgId);
      if (!organization) {
        throw new Error(`Organization not found: ${orgId}`);
      }

      // Check if site exists
      const site = await Site.findById(siteId);
      if (!site) {
        throw new Error(`Site not found: ${siteId}`);
      }

      // Check what already exists
      const existing = await checkValidEntitlement();

      // If both entitlement and site enrollment exist, return them
      if (existing.entitlement && existing.siteEnrollment) {
        log.info(`Entitlement and site enrollment already exist for org ${orgId}, site ${siteId} and product ${productCode}`);
        return existing;
      }

      // If only entitlement exists, we need to create site enrollment
      if (existing.entitlement && !existing.siteEnrollment) {
        log.info(`Entitlement exists but site enrollment missing for org ${orgId}, site ${siteId} and product ${productCode}`);

        // Create site enrollment for existing entitlement
        const siteEnrollment = await SiteEnrollment.create({
          siteId,
          entitlementId: existing.entitlement.getId(),
        });

        log.info(`Created site enrollment: ${siteEnrollment.getId()}`);

        return {
          entitlement: existing.entitlement,
          siteEnrollment,
        };
      }

      // Create organization identity provider if not exists
      const identityProviders = await OrganizationIdentityProvider.allByOrganizationId(orgId);
      const defaultProvider = OrganizationIdentityProviderModel.PROVIDER_TYPES.IMS;
      let providerId = identityProviders.find((idp) => idp.getProvider() === defaultProvider);

      // If no identity provider exists for this provider, create one
      if (!providerId) {
        providerId = await OrganizationIdentityProvider.create({
          organizationId: orgId,
          provider: defaultProvider,
          externalId: organization.getImsOrgId(),
        });
        log.info(`Created identity provider: ${providerId.getId()}`);
      } else {
        log.info(`Identity provider already exists: ${providerId.getId()}`);
      }

      // Create entitlement
      const entitlement = await Entitlement.create({
        organizationId: orgId,
        productCode,
        tier,
        quotas: { llmo_trial_prompts: 200 },
      });

      log.info(`Created entitlement: ${entitlement.getId()}`);

      // Create site enrollment
      const siteEnrollment = await SiteEnrollment.create({
        siteId,
        entitlementId: entitlement.getId(),
      });

      log.info(`Created site enrollment: ${siteEnrollment.getId()}`);

      return {
        entitlement,
        siteEnrollment,
      };
    } catch (error) {
      log.error(`Error creating entitlement and site enrollment: ${error.message}`);
      throw error;
    }
  };

  return {
    checkValidEntitlement,
    createEntitlement,
  };
}

export default TierClient;
