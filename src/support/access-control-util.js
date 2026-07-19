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
import { resolveRouteCapability } from '@adobe/spacecat-shared-http-utils/src/auth/route-utils.js';
import { UnauthorizedProductError } from './errors.js';
import { CUSTOMER_VISIBLE_TIERS } from './utils.js';
import { listBrandIdsForSite } from './brands-storage.js';
import { listResourceIdsWithCapability } from './state-access-mapping-utils.js';
import routeFacsCapabilities from '../routes/facs-capabilities.js';

const ANONYMOUS_ENDPOINTS = [
  /^GET \/slack\/events$/,
  /^POST \/slack\/events$/,
  /^POST \/hooks\/site-detection.+/,
];
const SERVICE_CODE = 'dx_aem_perf';
export const X_PRODUCT_HEADER = 'x-product';

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
   * Fetches and validates the S2S consumer identity from the DB, covering the shared
   * denial paths (not-s2s, not-found, revoked, not-active) used by both
   * `hasS2SCapability`. Returns either a denial result or the
   * validated consumer ready for domain-specific checks.
   *
   * @returns {Promise<{ denied: true, result: object }
   *   | { denied: false, fresh: object, clientId: string }>}
   */
  async _fetchAndValidateConsumer() {
    const { s2sConsumer } = this.context;
    if (!s2sConsumer) {
      return { denied: true, result: { allowed: false, reason: 'not-s2s' } };
    }
    const clientId = s2sConsumer.getClientId();
    const fresh = await this.context.dataAccess.Consumer.findByClientIdAndImsOrgId(
      clientId,
      s2sConsumer.getImsOrgId(),
    );
    if (!fresh) {
      return { denied: true, result: { allowed: false, reason: 'not-found', clientId } };
    }
    if (fresh.isRevoked()) {
      return {
        denied: true,
        result: {
          allowed: false, reason: 'revoked', clientId, consumerId: fresh.getId(),
        },
      };
    }
    if (fresh.getStatus() !== ConsumerModel.STATUS.ACTIVE) {
      return {
        denied: true,
        result: {
          allowed: false, reason: 'not-active', clientId, consumerId: fresh.getId(),
        },
      };
    }
    return { denied: false, fresh, clientId };
  }

  /**
   * Verifies the requesting S2S consumer holds the given capability by issuing
   * a fresh DB fetch. Uses `context.s2sConsumer` (set by s2sAuthWrapper) only as
   * an identity source — extracts `clientId` and `imsOrgId` and re-queries the
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
    const validated = await this._fetchAndValidateConsumer();
    if (validated.denied) {
      return validated.result;
    }
    const { fresh, clientId } = validated;
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

  /**
   * Whether the caller may perform an LLMO admin-equivalent action on a specific
   * site under the hybrid FACS model. Two signals decide it:
   *   - the `facs_enabled` JWT claim (minted at login, present on every path) —
   *     is the caller's org FACS-enrolled?
   *   - `context.attributes.facs.enabled` (the wrapper's defer marker, set only
   *     when the wrapper could not resolve a ReBAC resource) — did the wrapper
   *     hand enforcement to the controller?
   *
   * Resolution:
   *   - Not FACS-enrolled → fall back to the legacy `isLLMOAdministrator()` claim
   *     (dual-running: legacy stays authoritative until the org migrates).
   *   - Enrolled AND not deferred → the wrapper already confirmed the route's
   *     capability upstream (JWT short-circuit or state-layer admit) → allow.
   *   - Enrolled AND deferred → the wrapper could not map the site to its LLMO
   *     ReBAC `brand`, so authorize here: the caller must hold the route's
   *     required capability via a state-layer grant on any brand linked to the
   *     site. Fail closed if the state layer is unreachable.
   *
   * The required capability is NOT passed in — it is derived from the same
   * `routeFacsCapabilities.PRODUCTS_ROUTES` map the wrapper enforced (via
   * `resolveRouteCapability` on the current request), so the controller and the
   * wrapper can never disagree and there is no hardcoded capability to drift.
   *
   * MUST only be called on FACS-governed routes (the wrapper runs ahead of the
   * controller); on a non-governed route the "not deferred" branch would admit
   * any enrolled caller.
   *
   * @param {object} site - Site model (exposes getId + getOrganizationId).
   * @returns {Promise<boolean>}
   */
  async hasLlmoCapabilityForSite(site) {
    const facsEnabled = this.authInfo.getProfile?.()?.facs_enabled === true;
    if (!facsEnabled) {
      return this.isLLMOAdministrator();
    }

    const facs = this.context.attributes?.facs;
    if (!facs?.enabled) {
      // Enrolled and the wrapper already confirmed the capability upstream.
      return true;
    }

    // Derive the route's required capability from the same map the wrapper used.
    const routeMap = routeFacsCapabilities.PRODUCTS_ROUTES?.[facs.product?.toUpperCase?.()];
    const capability = routeMap ? resolveRouteCapability(this.context, routeMap) : null;
    if (!capability) {
      this.log?.warn?.('[acl] FACS deferred but no route capability resolved - denying');
      return false;
    }

    // Deferred: resolve the site's brand(s) and check the state-layer grant.
    const postgrestClient = this.context.dataAccess?.services?.postgrestClient;
    if (!postgrestClient?.from) {
      this.log?.warn?.('[acl] FACS deferred but postgrestClient unavailable - denying');
      return false;
    }

    const orgId = site.getOrganizationId();
    const org = await this.context.dataAccess.Organization.findById(orgId);
    const imsOrgId = org?.getImsOrgId?.();
    if (!hasText(imsOrgId)) {
      return false;
    }

    const brandIds = await listBrandIdsForSite(orgId, site.getId(), postgrestClient);
    if (brandIds.size === 0) {
      return false;
    }

    const capable = await listResourceIdsWithCapability(postgrestClient, {
      imsOrgId,
      product: facs.product,
      resourceType: 'brand',
      subjectId: facs.subjectId,
      capability,
    });
    for (const id of brandIds) {
      if (capable.has(id)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Org-level counterpart of {@link hasLlmoCapabilityForSite} for FACS-governed
   * routes with no site (e.g. `POST /llmo/onboard`). The wrapper enforces the
   * route's capability upstream, so once enrolled the only question is whether
   * it confirmed:
   *   - not enrolled           → legacy `isLLMOAdministrator()`
   *   - enrolled, not deferred  → wrapper confirmed the org-wide capability → allow
   *   - enrolled, deferred      → wrapper could not confirm (caller lacks the
   *     org-wide grant and there is no resource to bind against) → deny
   *
   * MUST only be called on FACS-governed routes (see {@link hasLlmoCapabilityForSite}).
   *
   * @returns {boolean}
   */
  hasLlmoAdminCapability() {
    const facsEnabled = this.authInfo.getProfile?.()?.facs_enabled === true;
    if (!facsEnabled) {
      return this.isLLMOAdministrator();
    }
    return !this.context.attributes?.facs?.enabled;
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
    // Lazy one-time backfill of externalUserId for PAID-tier (Brandalf) users onboarded via
    // invitation. These users are created without externalUserId; we record it here on the
    // first authenticated request so the userDetails lookup can resolve their display name.
    // NOTE: profile.email is an IMS user GUID (e.g. GUID@hexOrgId.e), not an RFC-5322 address.
    // profile.trial_email is the human-readable email used as the DB row selector.
    // Both claims refer to the same identity and are attested by IMS on the same token.
    // findByEmailId runs on every non-FREE_TRIAL request (same as the FREE_TRIAL branch above),
    // so this adds no new per-request overhead relative to existing behaviour.
    } else if (!this.authInfo?.isS2SConsumer?.()) {
      const profile = this.authInfo.getProfile?.();
      if (profile?.email && profile?.trial_email) {
        try {
          const trialUser = await this.TrialUser.findByEmailId(profile.trial_email);
          if (trialUser && !trialUser.getExternalUserId()) {
            trialUser.setExternalUserId(profile.email);
            await trialUser.save();
            this.log?.info('[AccessControl] Backfilled externalUserId for PAID-tier user', {
              trialEmail: profile.trial_email,
              organizationId: org.getId(),
            });
          }
        } catch (err) {
          this.log?.warn('[AccessControl] externalUserId backfill failed; continuing', {
            trialEmail: profile.trial_email,
            error: err.message,
          });
        }
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
