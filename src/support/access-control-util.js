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

  hasAdminAccess() {
    if (!this.isAccessTypeJWT()) {
      return true;
    }
    return this.authInfo.isAdmin();
  }

  async hasAccess(entity, subService = '') {
    if (!isNonEmptyObject(entity)) {
      throw new Error('Missing entity');
    }

    const { authInfo } = this;
    if (this.hasAdminAccess() || !this.isAccessTypeJWT()) {
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
    if (subService.length > 0) {
      return hasOrgAccess && authInfo.hasScope('user', `${SERVICE_CODE}_${subService}`);
    }
    return hasOrgAccess;
  }
}
