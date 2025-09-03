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
  Site, Organization, TrialUser as TrialUserModel,
  Entitlement as EntitlementModel,
  OrganizationIdentityProvider as OrganizationIdentityProviderModel,
} from '@adobe/spacecat-shared-data-access';

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { sanitizePath } from '../utils/route-utils.js';

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
    log.info(`Path info: ${JSON.stringify(pathInfo)}`);
    const endpoint = `${pathInfo?.method?.toUpperCase()} ${pathInfo?.suffix}`;
    if (isAnonymous(endpoint)) {
      log.info(`Anonymous endpoint, skipping authorization: ${sanitizePath(endpoint)}`);
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
      this.xProductHeader = pathInfo.headers[X_PRODUCT_HEADER];
    }

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

  async validateEntitlement(org, site, productCode) {
    this.log.info(`X-Product header: ${this.xProductHeader}`);
    if (this.xProductHeader !== productCode) {
      throw new Error('[Error] Invalid origin of request');
    }
    // eslint-disable-next-line max-len
    const entitlement = await this.Entitlement.findByOrganizationIdAndProductCode(org.getId(), productCode);
    if (!isNonEmptyObject(entitlement)) {
      throw new Error('Missing entitlement for organization');
    }
    if (!hasText(entitlement.getTier())) {
      throw new Error(`[Error] Entitlement tier is not set for ${productCode}`);
    }
    if (site) {
      const siteEnrollments = await this.SiteEnrollment.allBySiteId(site.getId());
      // eslint-disable-next-line max-len
      const validSiteEnrollment = siteEnrollments.find((se) => se.getEntitlementId() === entitlement.getId());
      if (!validSiteEnrollment) {
        throw new Error('[Error] Valid site enrollment not found');
      }
    }

    if (entitlement.getTier() === EntitlementModel.TIERS.FREE_TRIAL) {
      const profile = this.authInfo.getProfile();
      const trialUser = await this.TrialUser.findByEmailId(profile.trial_email);

      // First check if the profile provider is one of the supported provider types
      const supportedProviders = Object.values(OrganizationIdentityProviderModel.PROVIDER_TYPES);
      if (!supportedProviders.includes(profile.provider)) {
        throw new Error('[Error] IDP not supported');
      }

      // Check if the organization already has an identity provider for this provider
      const identityProviders = await this.IdentityProvider.allByOrganizationId(org.getId());
      let providerId = identityProviders.find((idp) => idp.getProvider() === profile.provider);

      // If no identity provider exists for this provider, create one
      if (!providerId) {
        providerId = await this.IdentityProvider.create({
          organizationId: org.getId(),
          provider: profile.provider,
          // TODO: it should IDP subject/identifier not sure at the moment
          externalId: profile.provider,
        });
      }

      if (!trialUser) {
        await this.TrialUser.create({
          emailId: profile.trial_email,
          firstName: profile.first_name,
          lastName: profile.last_name,
          provider: providerId.provider,
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
    if (this.hasAdminAccess()) {
      return true;
    }

    let imsOrgId;
    if (entity instanceof Site) {
      const org = await entity.getOrganization();
      if (!isNonEmptyObject(org)) {
        throw new Error('Missing organization for site');
      }
      imsOrgId = org.getImsOrgId();
    } else if (entity instanceof Organization) {
      imsOrgId = entity.getImsOrgId();
    }

    const hasOrgAccess = authInfo.hasOrganization(imsOrgId);
    if (hasOrgAccess && productCode.length > 0) {
      let org;
      let site;
      if (entity instanceof Site) {
        site = entity;
        org = await entity.getOrganization();
      } else if (entity instanceof Organization) {
        org = entity;
      }
      await this.validateEntitlement(org, site, productCode);
    }
    if (subService.length > 0) {
      return hasOrgAccess && authInfo.hasScope('user', `${SERVICE_CODE}_${subService}`);
    }
    return hasOrgAccess;
  }
}
