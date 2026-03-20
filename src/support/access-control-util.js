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

import { isNonEmptyObject, hasText } from '@adobe/spacecat-shared-utils';
import {
  TrialUser as TrialUserModel,
  Entitlement as EntitlementModel,
} from '@adobe/spacecat-shared-data-access';
import TierClient from '@adobe/spacecat-shared-tier-client';

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

const ANONYMOUS_ENDPOINTS = [
  /^GET \/slack\/events$/,
  /^POST \/slack\/events$/,
  /^POST \/hooks\/site-detection.+/,
];
const SERVICE_CODE = 'dx_aem_perf';
const X_PRODUCT_HEADER = 'x-product';

function isAnonymous(endpoint) {
  return ANONYMOUS_ENDPOINTS.some((rgx) => rgx.test(endpoint));
}

export default class AccessControlUtil {
  static fromContext(context) {
    if (!isNonEmptyObject(context)) {
      throw new Error('Missing context');
    }

    return new AccessControlUtil(context);
  }

  constructor(context) {
    const { log, pathInfo, attributes } = context;
    const endpoint = `${pathInfo?.method?.toUpperCase()} ${pathInfo?.suffix}`;
    if (isAnonymous(endpoint)) {
      const profile = { user_id: 'anonymous' };
      this.authInfo = new AuthInfo()
        .withAuthenticated(true)
        .withProfile(profile)
        .withType(this.name);
    } else {
      if (!isNonEmptyObject(attributes?.authInfo)) {
        throw new Error('Missing authInfo');
      }
      this.authInfo = attributes?.authInfo;
      this.Entitlement = context.dataAccess.Entitlement;
      this.SiteEnrollment = context.dataAccess.SiteEnrollment;
      this.TrialUser = context.dataAccess.TrialUser;
      this.IdentityProvider = context.dataAccess.OrganizationIdentityProvider;
      this.SiteImsOrgAccess = context.dataAccess.SiteImsOrgAccess;
      this.xProductHeader = pathInfo.headers[X_PRODUCT_HEADER];
    }

    // Store context for TierClient usage
    this.context = context;
    // Always assign the log property
    this.log = log;
  }

  isAccessTypeJWT() {
    return this.authInfo.getType() === 'jwt';
  }

  isAccessTypeIms() {
    return this.authInfo.getType() === 'ims';
  }

  isScopeAdmin() {
    return this.authInfo.getScopes().some((scope) => scope.name === 'admin');
  }

  hasAdminAccess() {
    if (!this.isAccessTypeIms() && !this.isAccessTypeJWT()) {
      return true;
    }
    if (!this.isAccessTypeJWT() && this.isScopeAdmin()) {
      return true;
    }
    return this.authInfo.isAdmin();
  }

  hasS2SAdminAccess() {
    return this.authInfo.isS2SAdmin();
  }

  isLLMOAdministrator() {
    return this.authInfo.isLLMOAdministrator();
  }

  canManageImsOrgAccess() {
    if (!this.isAccessTypeIms() && !this.isAccessTypeJWT()) return false;
    return this.authInfo.isAdmin();
  }

  async validateEntitlement(org, site, productCode) {
    // Use TierClient to fetch entitlement
    let tierClient;
    if (site) {
      tierClient = await TierClient.createForSite(this.context, site, productCode);
    } else {
      tierClient = TierClient.createForOrg(this.context, org, productCode);
    }

    const { entitlement, siteEnrollment } = await tierClient.checkValidEntitlement();

    if (!entitlement) {
      throw new Error('Missing entitlement for organization');
    }

    if (!hasText(entitlement.getTier())) {
      throw new Error(`[Error] Entitlement tier is not set for ${productCode}`);
    }

    if (site && !siteEnrollment) {
      throw new Error('Missing enrollment for site');
    }

    if (entitlement.getTier() === EntitlementModel.TIERS.FREE_TRIAL) {
      const profile = this.authInfo.getProfile();
      const trialUser = await this.TrialUser.findByEmailId(profile.trial_email);

      if (!trialUser && !this.authInfo?.isS2SConsumer?.()) {
        await this.TrialUser.create({
          emailId: profile.trial_email,
          firstName: profile.first_name || '-',
          lastName: profile.last_name || '-',
          organizationId: org.getId(),
          status: TrialUserModel.STATUSES.REGISTERED,
          externalUserId: profile.email,
          lastSeenAt: new Date().toISOString(),
        });
      }
    }
  }

  async hasAccess(entity, subService = '', productCode = '') {
    if (!isNonEmptyObject(entity)) {
      throw new Error('Missing entity');
    }

    const { authInfo } = this;
    // Check admin access first - admins bypass product code validation
    if (this.hasAdminAccess()) {
      return true;
    }

    // For non-admin users, validate x-product header
    if (hasText(productCode) && this.xProductHeader !== productCode) {
      this.log.error(`Unauthorized request for product ${productCode}, x-product header: ${this.xProductHeader}`);
      throw new Error('[Error] Unauthorized request');
    }

    let imsOrgId;
    if (entity.constructor.ENTITY_NAME === 'Site' || entity.constructor.ENTITY_NAME === 'Project') {
      const org = await entity.getOrganization();
      if (!isNonEmptyObject(org)) {
        throw new Error('Missing organization for site');
      }
      imsOrgId = org.getImsOrgId();
    } else if (entity.constructor.ENTITY_NAME === 'Organization') {
      imsOrgId = entity.getImsOrgId();
    }

    let hasOrgAccess = authInfo.hasOrganization(imsOrgId);
    let isDelegatedAccess = false;

    if (!hasOrgAccess && this.SiteImsOrgAccess && productCode) {
      // Phase 1: Site entities only
      if (entity.constructor.ENTITY_NAME === 'Site') {
        const siteId = entity.getId();
        let sourceOrganizationId;

        if (authInfo.isDelegatedTenantsComplete()) {
          // Path A: JWT list is complete — fast deny if org not listed
          const delegatedTenant = authInfo.getDelegatedTenant(imsOrgId, productCode);
          if (!delegatedTenant) {
            return false; // zero DB calls
          }
          sourceOrganizationId = delegatedTenant.sourceOrganizationId;
        } else {
          // Path B: list was truncated — skip JWT gate, go DB-direct
          sourceOrganizationId = authInfo.getDelegatedTenants()[0]?.sourceOrganizationId;
        }

        if (!sourceOrganizationId) {
          this.log.warn('[AccessControl] Delegation fallthrough: missing sourceOrganizationId');
          return false;
        }

        const grant = await this.SiteImsOrgAccess
          .findBySiteIdAndOrganizationIdAndProductCode(siteId, sourceOrganizationId, productCode);

        if (grant && (!grant.getExpiresAt() || new Date(grant.getExpiresAt()) > new Date())) {
          this.log.info('[AccessControl] Delegated access granted', {
            actorOrg: imsOrgId,
            resourceOrg: grant.getTargetOrganizationId(),
            grantId: grant.getId(),
            role: grant.getRole(),
            productCode,
            siteId,
          });
          hasOrgAccess = true;
          isDelegatedAccess = true;
        }
      }
    }

    if (hasOrgAccess && productCode.length > 0) {
      let org;
      let site;
      if (entity.constructor.ENTITY_NAME === 'Site') {
        site = entity;
        org = await entity.getOrganization();
      } else if (entity.constructor.ENTITY_NAME === 'Organization') {
        org = entity;
      }
      await this.validateEntitlement(org, site, productCode);
    }
    if (subService.length > 0) {
      if (isDelegatedAccess) return hasOrgAccess; // productCode scoping replaces subService check
      return hasOrgAccess && authInfo.hasScope('user', `${SERVICE_CODE}_${subService}`);
    }
    return hasOrgAccess;
  }

  /**
   * Method to check if the user is the owner of a site.
   * @param {any} entity - The entity to check access for.
   * @returns {boolean} True if the user is part of the organization that owns the site
   * false otherwise , for admin user as well as for other users.
   */
  async isOwnerOfSite(entity) {
    if (!isNonEmptyObject(entity)) {
      throw new Error('Missing entity');
    }
    const { authInfo } = this;
    if (entity.constructor.ENTITY_NAME === 'Site') {
      const org = await entity.getOrganization();
      if (!isNonEmptyObject(org)) {
        throw new Error('Missing organization for site');
      }
      const imsOrgId = org.getImsOrgId();
      const hasOrgAccess = authInfo.hasOrganization(imsOrgId);
      return hasOrgAccess;
    } else if (entity.constructor.ENTITY_NAME === 'Organization') {
      const imsOrgId = entity.getImsOrgId();
      const hasOrgAccess = authInfo.hasOrganization(imsOrgId);
      return hasOrgAccess;
    }
    return false;
  }
}
