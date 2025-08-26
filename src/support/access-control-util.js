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
import { Site, Organization } from '@adobe/spacecat-shared-data-access';

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { sanitizePath } from '../utils/route-utils.js';

const ANONYMOUS_ENDPOINTS = [
  /^GET \/slack\/events$/,
  /^POST \/slack\/events$/,
  /^POST \/hooks\/site-detection.+/,
];
const SERVICE_CODE = 'dx_aem_perf';

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
    this.authInfo = attributes?.authInfo;
    this.Entitlment = context.dataAccess.Entitlment;
    this.TrialUser = context.dataAccess.TrialUser;

    const endpoint = `${pathInfo?.method?.toUpperCase()} ${pathInfo?.suffix}`;
    if (isAnonymous(endpoint)) {
      log.info(`Anonymous endpoint, skipping authorization: ${sanitizePath(endpoint)}`);
      const profile = { user_id: 'anonymous' };
      this.authInfo = new AuthInfo()
        .withAuthenticated(true)
        .withProfile(profile)
        .withType(this.name);
    }

    if (!isNonEmptyObject(this.authInfo)) {
      throw new Error('Missing authInfo');
    }
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

  async validateEntitlement(org, productCode) {
    const entitlement = await org.findByOrganizationIdAndProductCode(org.getId(), productCode);
    if (!isNonEmptyObject(entitlement)) {
      throw new Error('Missing entitlement for organization');
    }
    const validEntitlement = entitlement.find((ent) => ent.productCode === productCode && ent.tier);
    if (!isNonEmptyObject(validEntitlement)) {
      throw new Error(`[Error] No Entitlement for ${productCode}`);
    }

    if (validEntitlement.tier === this.Entitlment.TIER.FREE_TRIAL) {
      // this trail_email need to be set in authInfo in IMS handlers
      const trialUser = await this.TrialUser.findByEmailId(this.authInfo.getProfile().trial_email);
      if (!isNonEmptyObject(trialUser)) {
        // create a trial user
        await this.TrialUser.create({
          emailId: this.authInfo.getProfile().trial_email,
          organizationId: org.getId(),
          status: this.TrialUser.STATUS.REGISTERED,
          provider: this.authInfo.getProfile().provider,
          externalUserId: this.authInfo.getProfile().email,
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
    if (productCode.length > 0) {
      await this.validateEntitlement(entity, productCode);
    }
    if (subService.length > 0) {
      return hasOrgAccess && authInfo.hasScope('user', `${SERVICE_CODE}_${subService}`);
    }
    return hasOrgAccess;
  }
}
