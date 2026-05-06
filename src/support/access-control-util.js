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
  Consumer as ConsumerModel,
} from '@adobe/spacecat-shared-data-access';
import TierClient from '@adobe/spacecat-shared-tier-client';

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { UnauthorizedProductError } from './errors.js';
import { CUSTOMER_VISIBLE_TIERS } from './utils.js';

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
    this._lastAccessWasDelegated = false;
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

  hasAdminReadAccess() {
    return this.hasAdminAccess() || this.authInfo.isReadOnlyAdmin?.() === true;
  }

  hasS2SAdminAccess() {
    return this.authInfo.isS2SAdmin();
  }

  /**
   * Verifies the requesting S2S consumer holds the given capability by issuing
   * a fresh DB fetch. Uses `context.s2sConsumer` (set by s2sAuthWrapper) only as
   * an identity source - extracts `clientId` and `imsOrgId` and re-queries the
   * Consumer table. Capabilities are NOT read from the in-context object: a stale
   * or tampered context cannot grant access.
   *
   * Returns a result object so controllers can audit-log without re-reading
   * context. The `reason` discriminates denial paths for SOC investigation:
   * `not-s2s`, `not-found`, `revoked`, `not-active`, `missing-capability`,
   * `granted`.
   *
   * See `docs/s2s/READALL_CAPABILITY_DESIGN.md` for the trust-boundary analysis.
   *
   * @param {string} capability - Full capability string, e.g. 'site:readAll'.
   * @returns {Promise<{ allowed: boolean, reason: string,
   *   consumerId: (string|undefined), clientId: (string|undefined) }>}
   */
  async hasS2SCapability(capability) {
    const { s2sConsumer } = this.context;
    if (!s2sConsumer) {
      return { allowed: false, reason: 'not-s2s' };
    }

    const clientId = s2sConsumer.getClientId();
    const fresh = await this.context.dataAccess.Consumer.findByClientIdAndImsOrgId(
      clientId,
      s2sConsumer.getImsOrgId(),
    );
    if (!fresh) {
      return { allowed: false, reason: 'not-found', clientId };
    }
    if (fresh.isRevoked()) {
      return {
        allowed: false, reason: 'revoked', clientId, consumerId: fresh.getId(),
      };
    }
    if (fresh.getStatus() !== ConsumerModel.STATUS.ACTIVE) {
      return {
        allowed: false, reason: 'not-active', clientId, consumerId: fresh.getId(),
      };
    }
    if (!fresh.getCapabilities()?.includes(capability)) {
      return {
        allowed: false, reason: 'missing-capability', clientId, consumerId: fresh.getId(),
      };
    }
    return {
      allowed: true, reason: 'granted', clientId, consumerId: fresh.getId(),
    };
  }

  /**
   * Returns true if the authenticated user holds the LLMO administrator role
   * AND the last {@link hasAccess} check did not resolve via a delegation grant.
   *
   * **Ordering contract**: {@link hasAccess} must be called before this method
   * whenever delegation-aware behaviour is required. Without a prior `hasAccess()`
   * call the delegation flag defaults to `false` (non-delegated) and the raw JWT
   * claim is returned unchecked — meaning a delegated user would incorrectly be
   * treated as an LLMO administrator on the target org's sites.
   *
   * @returns {boolean}
   */
  isLLMOAdministrator() {
    return this.authInfo.isLLMOAdministrator() && !this._lastAccessWasDelegated;
  }

  canManageImsOrgAccess() {
    if (!this.isAccessTypeIms() && !this.isAccessTypeJWT()) {
      return false;
    }
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

    // PLG tier is internal-only; block customer-facing product access
    if (!CUSTOMER_VISIBLE_TIERS.includes(entitlement.getTier())) {
      throw new UnauthorizedProductError('[Error] Unauthorized request');
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
    this._lastAccessWasDelegated = false;
    if (!isNonEmptyObject(entity)) {
      throw new Error('Missing entity');
    }

    const { authInfo } = this;
    // Full admins and read-only admins both bypass org/product validation for data reads.
    // Write operations are protected separately: the readOnlyAdminWrapper middleware blocks
    // all non-GET requests for read-only admin tokens before they reach any controller,
    // so a read-only admin can never mutate data even though hasAccess() returns true here.
    if (this.hasAdminReadAccess()) {
      return true;
    }

    // For non-admin users, validate x-product header
    if (hasText(productCode) && this.xProductHeader !== productCode) {
      this.log.error(`Unauthorized request for product ${productCode}, x-product header: ${this.xProductHeader}`);
      throw new UnauthorizedProductError('[Error] Unauthorized request');
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
        let grant;

        if (authInfo.isDelegatedTenantsComplete()) {
          // Path A: JWT list is complete — fast deny if org not listed
          const delegatedTenant = authInfo.getDelegatedTenant(imsOrgId, productCode);
          if (!delegatedTenant) {
            return false; // zero DB calls
          }
          sourceOrganizationId = delegatedTenant.sourceOrganizationId;
          if (!sourceOrganizationId) {
            this.log.warn('[AccessControl] Path A: missing sourceOrganizationId in delegatedTenant');
            return false;
          }
          const now = new Date();
          const candidate = await this.SiteImsOrgAccess
            .findBySiteIdAndOrganizationIdAndProductCode(siteId, sourceOrganizationId, productCode);
          // Expiry checked here so the outer if(grant) is unconditional for both paths
          const notExpired = !candidate?.getExpiresAt()
            || new Date(candidate.getExpiresAt()) > now;
          if (candidate && notExpired) {
            grant = candidate;
          }
        } else {
          // Path B: JWT list was truncated — query all site grants and match against any of
          // the user's source org IDs (one DB call avoids N queries for multi-org users).
          const tenantOrgIds = new Set(
            authInfo.getDelegatedTenants().map((t) => t.sourceOrganizationId).filter(Boolean),
          );
          if (tenantOrgIds.size === 0) {
            this.log.warn('[AccessControl] Path B: no sourceOrganizationId in delegatedTenants');
            return false;
          }
          const now = new Date();
          const siteGrants = await this.SiteImsOrgAccess.allBySiteId(siteId);
          grant = siteGrants.find(
            (g) => g.getProductCode() === productCode
              && tenantOrgIds.has(g.getOrganizationId())
              && (!g.getExpiresAt() || new Date(g.getExpiresAt()) > now),
          );
          if (grant) {
            sourceOrganizationId = grant.getOrganizationId();
          }
        }

        // grant is either null or an already-verified active grant from either path
        if (grant) {
          this.log.info('[AccessControl] Delegated access granted', {
            actorOrg: sourceOrganizationId,
            resourceOrg: imsOrgId,
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

    this._lastAccessWasDelegated = isDelegatedAccess;

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
      if (isDelegatedAccess) {
        return hasOrgAccess; // productCode scoping replaces subService check
      }
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
