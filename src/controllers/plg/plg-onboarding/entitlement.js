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

import TierClient from '@adobe/spacecat-shared-tier-client';
import { isInternalOrg } from './internal-org.js';
import { ASO_PRODUCT_CODE, ASO_TIER } from './constants.js';

export { ASO_PRODUCT_CODE, ASO_TIER };

export class EntitlementWaitlistError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EntitlementWaitlistError';
  }
}

export async function reassignSiteOrganization(site, organizationId) {
  site.setOrganizationId(organizationId);
  return site.save();
}

/**
 * Disables the summit-plg config handler for a given site. Non-fatal.
 */
async function disableSummitPlgHandler(site, context) {
  const { dataAccess, log } = context;
  const { Configuration } = dataAccess;
  try {
    const configuration = await Configuration.findLatest();
    configuration.disableHandlerForSite('summit-plg', site);
    await configuration.save();
    log.info(`Disabled summit-plg handler for site ${site.getId()}`);
  } catch (error) {
    log.warn(`Failed to disable summit-plg handler for site ${site.getId()}: ${error.message}`);
  }
}

// Resolves entitlement against the IMS-derived organization (passed in by the caller),
// then enrollment for the site. Step 1 deliberately ignores site.getOrganizationId()
// so the entitlement is bound to the customer org we resolved from imsOrgId — not to
// whatever org the site currently points at (which may still be an internal/demo org
// pre-reassignment).
export async function ensureAsoEntitlement(site, organization, context) {
  const { log } = context;
  const siteId = site.getId();
  const organizationId = organization.getId();

  // Step 1: ensure entitlement on the IMS-resolved organization (no site bound).
  const orgClient = TierClient.createForOrg(context, organization, ASO_PRODUCT_CODE);
  let entitlement;
  try {
    ({ entitlement } = await orgClient.createEntitlement(ASO_TIER));
  } catch (createError) {
    log.error(`ensureAsoEntitlement: createEntitlement failed for org ${organizationId}: ${createError.message}, fetching existing`);
    try {
      ({ entitlement } = await orgClient.checkValidEntitlement());
    } catch (fetchError) {
      log.error(`ensureAsoEntitlement: checkValidEntitlement also failed for org ${organizationId}: ${fetchError.message}`);
    }
  }
  if (!entitlement) {
    throw new EntitlementWaitlistError(`Unable to create or fetch ASO entitlement for org ${organizationId}`);
  }
  const entitlementOrgId = entitlement.getOrganizationId();

  if (entitlementOrgId !== organizationId) {
    throw new EntitlementWaitlistError(
      `ASO entitlement org drift: expected ${organizationId}, got ${entitlementOrgId} (site ${siteId})`,
    );
  }

  // Step 2: create site enrollment bound directly to the entitlement ID above.
  // We bypass TierClient.createForSite to avoid re-deriving org from site.getOrganizationId(),
  // which may lag behind the DB if org reassignment just happened.
  const { SiteEnrollment } = context.dataAccess;
  let siteEnrollment;
  const entitlementId = entitlement.getId();
  try {
    const existingEnrollments = await SiteEnrollment.allBySiteId(siteId);
    siteEnrollment = existingEnrollments.find((se) => se.getEntitlementId() === entitlementId);
    if (!siteEnrollment) {
      siteEnrollment = await SiteEnrollment.create({ siteId, entitlementId });
    }
  } catch (enrollError) {
    log.warn(`ensureAsoEntitlement: site enrollment failed for site ${siteId}: ${enrollError.message}`);
  }
  if (!siteEnrollment) {
    throw new EntitlementWaitlistError(`Unable to create or fetch ASO enrollment for site ${siteId}`);
  }

  return { entitlement, siteEnrollment };
}

/**
 * Revokes all ASO site enrollments for the site linked to a given onboarding record.
 * Called when transitioning an ONBOARDED domain to WAITLISTED.
 */
export async function revokeAsoSiteEnrollments(onboarding, context) {
  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  const siteId = onboarding.getSiteId();
  if (!siteId) {
    log.info(`No site linked to onboarding ${onboarding.getId()}, skipping enrollment revocation`);
    return;
  }

  const site = await Site.findById(siteId);
  if (!site) {
    log.warn(`Site ${siteId} not found for onboarding ${onboarding.getId()}, skipping enrollment revocation`);
    return;
  }

  const enrollments = await site.getSiteEnrollments();
  if (!enrollments || enrollments.length === 0) {
    log.info(`No enrollments to revoke for site ${siteId}`);
  } else {
    const entitlements = await Promise.all(enrollments.map((e) => e.getEntitlement()));
    const asoEnrollments = enrollments.filter(
      (_, i) => entitlements[i]?.getProductCode() === ASO_PRODUCT_CODE,
    );

    if (asoEnrollments.length === 0) {
      log.info(`No ASO enrollments to revoke for site ${siteId}`);
    } else {
      try {
        await Promise.all(asoEnrollments.map((enrollment) => {
          log.info(`Revoking ASO enrollment ${enrollment.getId()} for offboarded site ${siteId}`);
          return enrollment.remove();
        }));
      } catch (revokeError) {
        log.warn(`Failed to revoke one or more ASO enrollments for site ${siteId}: ${revokeError.message}`);
      }
    }
  }

  await disableSummitPlgHandler(site, context);
}

/**
 * Enforces the "one active ASO enrollment per org" business rule by revoking every ASO
 * enrollment under the target entitlement other than the newly onboarded site's.
 *
 * The previous incident (2026-04-21) showed this pattern is dangerous when entitlement
 * resolution drifts to the wrong org — a single mis-resolution mass-deletes unrelated sites.
 * Two invariants guard against that here:
 *
 *   1. The entitlement's org MUST equal the customer org we resolved from the request's
 *      imsOrgId. If they disagree, entitlement resolution drifted — abort loudly, don't delete.
 *   2. The target customer org MUST NOT be internal/demo. Caller-level mistake guard.
 */
export async function revokePreviousAsoEnrollmentsForOrg(
  newSite,
  organization,
  entitlement,
  context,
) {
  const { dataAccess, log, env } = context;
  const { SiteEnrollment } = dataAccess;

  const expectedOrgId = organization.getId();

  // Guard 1: caller-level mistake — never mass-revoke under an internal/demo org.
  if (isInternalOrg(expectedOrgId, env)) {
    log.error(`Refusing to revoke sibling ASO enrollments: target organization ${expectedOrgId} is internal/demo.`);
    return;
  }

  // Guard 2: tight invariant — the entitlement we got back must belong to the expected customer
  // org. If TierClient ever drifts and hands back an entitlement for a different org, abort.
  const entitlementOrgId = entitlement.getOrganizationId();
  /* c8 ignore next 4 */
  if (entitlementOrgId !== expectedOrgId) {
    log.error(`Refusing to revoke sibling ASO enrollments: entitlement ${entitlement.getId()} belongs to org ${entitlementOrgId} but expected ${expectedOrgId} (resolved from request imsOrgId). Possible entitlement-resolution drift.`);
    return;
  }

  const enrollments = await SiteEnrollment.allByEntitlementId(entitlement.getId());
  const newSiteId = newSite.getId();
  const toRevoke = enrollments.filter((e) => e.getSiteId() !== newSiteId);

  if (toRevoke.length === 0) {
    return;
  }

  // Normally at most 1 sibling (previous PRE_ONBOARD site); more than 3 suggests drift or a bug.
  if (toRevoke.length > 3) {
    log.warn(`Found ${toRevoke.length} other ASO enrollments under entitlement ${entitlement.getId()} for org ${expectedOrgId}; revoking all. Investigate if unexpected.`);
  }

  await Promise.all(toRevoke.map(async (e) => {
    const prevSiteId = e.getSiteId();
    try {
      log.info(`Revoking ASO enrollment ${e.getId()} for previously enrolled site ${prevSiteId} (org ${expectedOrgId})`);
      await e.remove();
    } catch (err) {
      log.warn(`Failed to revoke ASO enrollment ${e.getId()} for site ${prevSiteId}: ${err.message}`);
    }
  }));
}

/**
 * Revokes the ASO enrollment for a displaced site. Best-effort: caller continues
 * onboarding the new domain regardless of revocation outcome.
 */
export async function revokeDisplacedSiteAsoEnrollment(displacedSiteId, oldOrgId, context) {
  const { dataAccess, env, log } = context;

  if (oldOrgId && isInternalOrg(oldOrgId, env)) {
    log.error(`Refusing to revoke ASO enrollment for displaced site ${displacedSiteId}: previous org ${oldOrgId} is internal/demo.`);
    return;
  }
  if (!oldOrgId) {
    log.warn(`Cannot revoke ASO enrollment for displaced site ${displacedSiteId}: no org ID on onboarding record`);
    return;
  }

  const { SiteEnrollment, Entitlement } = dataAccess;
  try {
    const entitlements = await Entitlement.allByOrganizationId(oldOrgId);
    const asoEntitlement = entitlements.find((e) => e.getProductCode() === ASO_PRODUCT_CODE);
    if (!asoEntitlement) {
      log.warn(`No ASO entitlement found for org ${oldOrgId}, nothing to revoke`);
      return;
    }
    const asoEnrollments = await SiteEnrollment.allByEntitlementId(asoEntitlement.getId());
    const toRevoke = asoEnrollments.filter((e) => e.getSiteId() === displacedSiteId);
    await Promise.all(toRevoke.map((e) => {
      log.info(`Revoking ASO enrollment ${e.getId()} for displaced site ${displacedSiteId}`);
      return e.remove();
    }));
  } catch (revokeError) {
    log.error(`Failed to revoke ASO enrollment for displaced site ${displacedSiteId}: ${revokeError.message}`);
  }
}
