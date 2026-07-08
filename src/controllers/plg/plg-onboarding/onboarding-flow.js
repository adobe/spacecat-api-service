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

import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import { hasText } from '@adobe/spacecat-shared-utils';
import { cleanupPlgSiteSuggestionsAndFixes } from '../plg-onboarding-cleanup.js';
import { updateRumConfig } from '../../../support/rum-config-service.js';
import { hasActiveSuggestions } from './displacement.js';
import {
  AEM_CS_AUTHOR_URL_PATTERN, EDS_HOST_PATTERN, isSafeDomain, isValidDomain, prepareDomain,
} from './validation.js';
import {
  getReviewerIdentity, isFromAsoUI, isInternalOrg, isInternalOrgDemoSite,
} from './internal-org.js';
import {
  DOMAIN_ALREADY_ASSIGNED,
  DOMAIN_ALREADY_ONBOARDED_IN_ORG,
  persistAndNotify,
  postPlgOnboardingNotification,
} from './notifications.js';
import {
  EntitlementWaitlistError,
  ensureAsoEntitlement,
  reassignSiteOrganization,
  revokeDisplacedSiteAsoEnrollment,
  revokePreviousAsoEnrollmentsForOrg,
} from './entitlement.js';
import { updateLaunchDarklyFlags } from './launchdarkly.js';
import { createOrFindProject, enrollPlgConfigHandlers } from './site-setup.js';
import { STATUSES, REVIEW_DECISIONS } from './constants.js';

const PLG_PROFILE_KEY = 'aso_plg';

/**
 * Final-stage error handler for performAsoPlgOnboarding. Persists terminal state on the
 * onboarding record (WAITLISTED for entitlement failures, ERROR for everything else),
 * notifies, and either returns the record (waitlist case) or rethrows the original error.
 *
 * @returns {Promise<object>} the onboarding record (only on the EntitlementWaitlistError branch).
 * @throws the original error in all other cases.
 */
/* eslint-disable no-param-reassign */
async function handleTerminalError(error, { onboarding, steps }, context) {
  if (error instanceof EntitlementWaitlistError) {
    steps.entitlementFailed = true;
    onboarding.setStatus(STATUSES.WAITLISTED);
    onboarding.setWaitlistReason(error.message);
    onboarding.setSteps(steps);
    await persistAndNotify(onboarding, context, {
      swallowSaveErrors: true, errorLabel: 'waitlist state',
    });
    return onboarding;
  }

  onboarding.setStatus(STATUSES.ERROR);
  onboarding.setSteps(steps);
  onboarding.setError({
    message: (error.clientError || error.conflict)
      ? error.message : 'An internal error occurred',
  });
  await persistAndNotify(onboarding, context, {
    swallowSaveErrors: true, errorLabel: 'error state',
  });
  throw error;
}
/* eslint-enable no-param-reassign */

/**
 * Sets the site's delivery type and author URL.
 *
 * Two paths: when an ESE bypass passes a preset delivery type (AEM_CS/AEM_EDGE/AEM_AMS/other),
 * apply that directly; otherwise auto-resolve from RUM. Mutates `site` and `steps` in place.
 *
 * @returns {Promise<string|null>} rumHost (only set on the auto path), or null.
 */
/* eslint-disable no-param-reassign */
async function applyDeliveryConfig({
  site, presetDeliveryType, presetAuthorUrl, presetProgramId, imsOrgId, steps,
}, context) {
  const { autoResolveAuthorUrl, log } = context;

  if (!presetDeliveryType) {
    try {
      const resolvedConfig = await autoResolveAuthorUrl(site, context);
      const rumHost = resolvedConfig?.host || null;

      const existingDeliveryConfig = site.getDeliveryConfig() || {};
      if (!existingDeliveryConfig.authorURL && resolvedConfig?.authorURL) {
        site.setDeliveryType(SiteModel.DELIVERY_TYPES.AEM_CS);
        site.setDeliveryConfig({
          ...existingDeliveryConfig,
          authorURL: resolvedConfig.authorURL,
          programId: resolvedConfig.programId,
          environmentId: resolvedConfig.environmentId,
          preferContentApi: true,
          enableDAMAltTextUpdate: true,
          imsOrgId,
        });
        log.info(`Auto-resolved author URL for site ${site.getId()}: ${resolvedConfig.authorURL}`);
        steps.authorUrlResolved = true;
      }
      return rumHost;
    } catch (error) {
      log.warn(`Failed to auto-resolve author URL for site ${site.getId()}: ${error.message}`);
      return null;
    }
  }

  // AEM_SITE_CHECK bypass: ESE provided delivery type and optional author URL
  /* c8 ignore next */
  const existingDeliveryConfig = site.getDeliveryConfig() || {};
  site.setDeliveryType(presetDeliveryType);

  if (presetDeliveryType === SiteModel.DELIVERY_TYPES.AEM_CS && presetAuthorUrl) {
    const csMatch = presetAuthorUrl.match(AEM_CS_AUTHOR_URL_PATTERN);
    /* c8 ignore next */
    const [, programId, environmentId] = csMatch || [];
    site.setDeliveryConfig({
      ...existingDeliveryConfig,
      authorURL: presetAuthorUrl,
      preferContentApi: true,
      enableDAMAltTextUpdate: true,
      ...(programId && { programId, environmentId }),
      imsOrgId,
    });
    log.info(`Set AEM CS delivery config from preset author URL: ${presetAuthorUrl}`);
    steps.authorUrlResolved = true;
  } else if (presetDeliveryType === SiteModel.DELIVERY_TYPES.AEM_EDGE && presetAuthorUrl) {
    const edsMatch = presetAuthorUrl.match(EDS_HOST_PATTERN);
    if (edsMatch) {
      const [, ref, repo, owner, tld] = edsMatch;
      site.setHlxConfig({
        hlxVersion: 5,
        rso: {
          ref, site: repo, owner, tld,
        },
      });
      log.info(`Set EDS hlxConfig from preset author URL: ${presetAuthorUrl}`);
      steps.hlxConfigSet = true;
    }
    steps.authorUrlResolved = true;
  } else if (presetDeliveryType === SiteModel.DELIVERY_TYPES.AEM_AMS) {
    /* c8 ignore next — nullish coalescing: bypass always sends programId for AEM_AMS */
    const programIdStr = String(presetProgramId ?? '').trim();
    const nextAmsDelivery = { ...existingDeliveryConfig, imsOrgId };
    if (presetAuthorUrl) {
      nextAmsDelivery.authorURL = presetAuthorUrl;
    }
    if (programIdStr !== '') {
      nextAmsDelivery.programId = programIdStr;
    }
    site.setDeliveryConfig(nextAmsDelivery);
    if (presetAuthorUrl) {
      steps.authorUrlResolved = true;
    }
    const amsLogParts = ['Set AEM AMS delivery config'];
    if (presetAuthorUrl) {
      amsLogParts.push(`author URL: ${presetAuthorUrl}`);
    }
    if (programIdStr !== '') {
      amsLogParts.push(`programId: ${programIdStr}`);
    }
    log.info(amsLogParts.join(', '));
  } else if (presetAuthorUrl) {
    site.setDeliveryConfig({ ...existingDeliveryConfig, authorURL: presetAuthorUrl, imsOrgId });
    log.info(`Set author URL from preset: ${presetAuthorUrl}`);
    steps.authorUrlResolved = true;
  }
  return null;
}
/* eslint-enable no-param-reassign */

/**
 * Enforces the "one onboarded domain per IMS org" guard.
 *
 * If another domain in the same IMS org is already ONBOARDED:
 *  - Displace it (waitlist + revoke ASO enrollment + disable summit-plg) when the existing
 *    site has no active PLG suggestions, then fall through to onboard the new domain.
 *  - Otherwise waitlist the new request and return it as the terminal result.
 *
 * NOTE: this check-then-act is not atomic. Two concurrent requests for the same IMS org
 * could both pass this check and both proceed to onboard, temporarily violating the
 * one-domain-per-org invariant. The invariant self-heals on the next onboarding attempt.
 *
 * @returns {Promise<object|null>} the waitlisted onboarding to return, or null to continue.
 */
async function handleExistingOnboardedDomain({
  onboarding, domain, imsOrgId,
}, context) {
  const { dataAccess, log } = context;
  const { Site, PlgOnboarding, Organization } = dataAccess;

  const existingRecords = await PlgOnboarding.allByImsOrgId(imsOrgId);

  // Mark any WAITLISTED or WAITING_FOR_IP_ALLOWLISTING records for other domains in this org
  // as OUTDATED — a new onboarding attempt supersedes these pending/blocked domains.
  const waitlistedRecords = existingRecords.filter(
    (r) => r.getDomain() !== domain && [
      STATUSES.WAITLISTED,
      STATUSES.WAITING_FOR_IP_ALLOWLISTING,
    ].includes(r.getStatus()),
  );
  await Promise.allSettled(waitlistedRecords.map(async (r) => {
    const waitlistReason = r.getWaitlistReason();
    r.setStatus(STATUSES.OUTDATED);
    r.setWaitlistReason(null);
    r.setUpdatedBy('system');
    const existingReviews = r.getReviews() || [];
    r.setReviews([...existingReviews, {
      reason: waitlistReason,
      decision: REVIEW_DECISIONS.CLOSED,
      reviewedBy: 'system',
      reviewedAt: new Date().toISOString(),
      justification: `Automatically closed by system — superseded by new onboarding for domain ${domain}.`,
    }]);
    await r.save();
    try {
      await postPlgOnboardingNotification(r, context);
    } catch (notifyErr) {
      log.warn(`Failed to post OUTDATED notification for domain ${r.getDomain()}: ${notifyErr.message}`);
    }
  }));

  const alreadyOnboarded = existingRecords
    .find((r) => r.getDomain() !== domain && r.getStatus() === STATUSES.ONBOARDED);
  if (!alreadyOnboarded) {
    return null;
  }

  const alreadyOnboardedSiteId = alreadyOnboarded.getSiteId();
  if (!alreadyOnboardedSiteId) {
    log.info(`IMS org ${imsOrgId}: onboarded domain ${alreadyOnboarded.getDomain()} has no siteId, skipping displacement and waitlisting ${domain}`);
  }
  const canDisplace = alreadyOnboardedSiteId
    && !(await hasActiveSuggestions(alreadyOnboardedSiteId, dataAccess, log));

  if (canDisplace) {
    log.info(`IMS org ${imsOrgId}: displacing domain ${alreadyOnboarded.getDomain()} (site ${alreadyOnboardedSiteId}) for new domain ${domain}`);
    alreadyOnboarded.setStatus(STATUSES.OUTDATED);
    alreadyOnboarded.setWaitlistReason(null);
    alreadyOnboarded.setUpdatedBy('system');
    const existingAlreadyOnboardedReviews = alreadyOnboarded.getReviews() || [];
    alreadyOnboarded.setReviews([...existingAlreadyOnboardedReviews, {
      reason: null,
      decision: REVIEW_DECISIONS.OFFBOARDED,
      reviewedBy: 'system',
      reviewedAt: new Date().toISOString(),
      justification: `Automatically offboarded by system — displaced by new onboarding for domain ${domain}.`,
    }]);
    await alreadyOnboarded.save();
    await postPlgOnboardingNotification(alreadyOnboarded, context);
    // NOTE: the underlying Site record is intentionally left unchanged. The Site model does
    // not carry PLG lifecycle state — PlgOnboarding is the sole source of truth for whether
    // a domain is actively enrolled in PLG. Audit scheduling and other downstream systems
    // should gate on PlgOnboarding status, not the Site record directly.

    // Only revoke ASO enrollments — leave other product enrollments untouched.
    await revokeDisplacedSiteAsoEnrollment(
      alreadyOnboardedSiteId,
      alreadyOnboarded.getOrganizationId(),
      context,
    );
    try {
      const displacedSite = await Site.findById(alreadyOnboardedSiteId);
      if (displacedSite) {
        const { Configuration } = dataAccess;
        const configuration = await Configuration.findLatest();
        configuration.disableHandlerForSite('summit-plg', displacedSite);
        await configuration.save();
        log.info(`Disabled summit-plg handler for site ${displacedSite.getId()}`);
      }
    } catch (disableError) {
      /* c8 ignore next 2 */
      log.warn(`Failed to disable summit-plg for displaced site ${alreadyOnboardedSiteId}: ${disableError.message}`);
    }
    return null;
  }

  const existingOrgForOnboarded = alreadyOnboarded.getOrganizationId()
    ? await Organization.findById(alreadyOnboarded.getOrganizationId())
    /* c8 ignore next */
    : null;
  /* c8 ignore next */
  const existingOrgName = existingOrgForOnboarded?.getName?.()
    || alreadyOnboarded.getOrganizationId();
  log.info(`IMS org ${imsOrgId} already has onboarded domain ${alreadyOnboarded.getDomain()}, waitlisting ${domain}`);
  if (alreadyOnboarded.getOrganizationId()) {
    onboarding.setOrganizationId(alreadyOnboarded.getOrganizationId());
  }
  onboarding.setStatus(STATUSES.WAITLISTED);
  onboarding.setWaitlistReason(`Domain ${alreadyOnboarded.getDomain()} is ${DOMAIN_ALREADY_ONBOARDED_IN_ORG} (org: ${existingOrgName}, id: ${imsOrgId})`);
  await persistAndNotify(onboarding, context);
  return onboarding;
}

/**
 * Fast path for preonboarded records (status PRE_ONBOARDING with a linked siteId): the site
 * already exists, so the only work left is org reassignment (if it lives in an internal/demo
 * org), ASO entitlement + enrollment, LaunchDarkly flags, and ONBOARDED.
 *
 * @returns {Promise<object|null>} the onboarding record on a terminal outcome, or null to
 *   fall through to the full onboarding flow (e.g. site not found).
 */
async function handlePreonboardedFastPath({
  onboarding, domain, imsOrgId,
}, context) {
  const {
    createOrFindOrganization, dataAccess, env, log,
  } = context;
  const { Site, Organization } = dataAccess;

  log.info(`Fast-tracking preonboarded record ${onboarding.getId()}`);
  onboarding.setSteps({ ...(onboarding.getSteps() || {}), preOnboarded: true });
  let site = await Site.findById(onboarding.getSiteId());
  if (!site) {
    log.warn(`Preonboarded site ${onboarding.getSiteId()} not found, falling through to full onboarding`);
    return null;
  }

  try {
    const organization = await createOrFindOrganization(imsOrgId, context);
    const customerOrgId = organization.getId();
    // Anchor the onboarding record to the resolved customer org up-front, regardless of
    // whether the site itself needs to be reassigned. Preonboarding records created earlier
    // may carry a stale organizationId (e.g. the internal/demo org used during preonboard),
    // and downstream consumers (notifications, displacement scoping) read it directly.
    onboarding.setOrganizationId(customerOrgId);

    const currentSiteOrgId = site.getOrganizationId();
    let needsOrgReassignment = false;

    // Note: On retry, currentSiteOrgId may already equal customerOrgId if a previous
    // attempt successfully saved the org reassignment but failed during entitlement creation
    if (currentSiteOrgId !== customerOrgId) {
      if (isInternalOrg(currentSiteOrgId, env) && !isInternalOrgDemoSite(site.getId(), env)) {
        log.info(`Preonboarded site ${site.getId()} is in internal org ${currentSiteOrgId}, will reassign to customer org ${customerOrgId}`);
        needsOrgReassignment = true;
      } else {
        const existingOrg = await Organization.findById(currentSiteOrgId);
        /* c8 ignore next */
        const existingImsOrgId = existingOrg?.getImsOrgId?.() || currentSiteOrgId;
        /* c8 ignore next */
        const existingOrgName = existingOrg?.getName?.() || currentSiteOrgId;
        const customerOrgName = organization.getName();
        let waitlistReason = `Domain ${domain} is ${DOMAIN_ALREADY_ASSIGNED} (org: ${existingOrgName}, id: ${existingImsOrgId}).`;
        const siteEnrollments = await site.getSiteEnrollments();
        if (!siteEnrollments || siteEnrollments.length === 0) {
          waitlistReason += ` This domain has no active products in its existing org '${existingOrgName}'. It can be safely moved to '${customerOrgName}'.`;
        } else {
          waitlistReason += ` This domain cannot be moved to '${customerOrgName}' — it is already set up with active products in its existing org ('${existingOrgName}').`;
        }

        log.warn(`Preonboarded site ${site.getId()} is in different customer org ${currentSiteOrgId}, expected ${customerOrgId} - waitlisting`);

        onboarding.setStatus(STATUSES.WAITLISTED);
        onboarding.setWaitlistReason(waitlistReason);
        const steps = { ...(onboarding.getSteps() || {}), orgResolutionFailed: true };
        onboarding.setSteps(steps);
        await persistAndNotify(onboarding, context);
        return onboarding;
      }
    }

    // Reassign site org if needed BEFORE entitlement operations.
    if (needsOrgReassignment) {
      site = await reassignSiteOrganization(site, customerOrgId);
      log.info(`Reassigned preonboarded site ${site.getId()} from internal org to customer org ${customerOrgId}`);
    }

    const { entitlement } = await ensureAsoEntitlement(site, organization, context);
    await revokePreviousAsoEnrollmentsForOrg(site, organization, entitlement, context);
    await updateLaunchDarklyFlags(site, organization, context);
    await enrollPlgConfigHandlers(site, context);

    const steps = { ...(onboarding.getSteps() || {}), entitlementCreated: true };
    if (needsOrgReassignment) {
      steps.siteOrgReassigned = true;
    }
    // Best-effort: clear out any stale FIXED suggestions and FixEntity rows from a
    // prior onboarding lifecycle so the newly onboarded site starts from a clean slate.
    await cleanupPlgSiteSuggestionsAndFixes(site.getId(), context);
    onboarding.setStatus(STATUSES.ONBOARDED);
    onboarding.setWaitlistReason(null);
    onboarding.setBotBlocker(null);
    onboarding.setSteps(steps);
    onboarding.setCompletedAt(new Date().toISOString());
    await persistAndNotify(onboarding, context, { hints: { fastOnboarded: true } });
    return onboarding;
  } catch (error) {
    if (error instanceof EntitlementWaitlistError) {
      onboarding.setStatus(STATUSES.WAITLISTED);
      onboarding.setWaitlistReason(error.message);
      onboarding.setSteps({ ...(onboarding.getSteps() || {}), entitlementFailed: true });
      await persistAndNotify(onboarding, context, {
        swallowSaveErrors: true, errorLabel: 'waitlist state',
      });
      return onboarding;
    }
    throw error;
  }
}

/**
 * Performs ASO PLG onboarding for a given domain and IMS org.
 * Creates and maintains a PlgOnboarding record to track the lifecycle.
 *
 * @param {object} params
 * @param {string} params.domain - The domain to onboard
 * @param {string} params.imsOrgId - The IMS Organization ID
 * @param {string} [params.presetDeliveryType] - Delivery type override for AEM_SITE_CHECK bypass
 * @param {string} [params.presetAuthorUrl] - Optional author URL override for AEM CS / AMS / EDS
 * @param {string} [params.presetProgramId] - Optional Cloud Manager program id (AEM_AMS bypass)
 * @param {object} context - The request context
 * @returns {Promise<object>} PlgOnboarding record
 */
export async function performAsoPlgOnboarding({
  domain: rawDomain, imsOrgId, presetDeliveryType, presetAuthorUrl, presetProgramId,
}, context) {
  const domain = prepareDomain(rawDomain);
  const callerIdentity = getReviewerIdentity(context);
  const {
    Config,
    RUMAPIClient,
    composeBaseURL,
    detectBotBlocker,
    detectLocale,
    resolveCanonicalUrl,
    createOrFindOrganization,
    enableAudits,
    enableImports,
    triggerAudits,
    findDeliveryType,
    resolveWwwUrl,
    updateCodeConfig,
    queueDeliveryConfigWriter,
    loadProfileConfig,
    triggerBrandProfileAgent,
    dataAccess,
    env,
    log,
  } = context;
  const { Site, PlgOnboarding, Organization } = dataAccess;

  // Defense-in-depth: outer entry points (onboard, alternateDomain bypass) already
  // prepareDomain + isValidDomain + isSafeDomain. These inner checks guard against any
  // future caller that constructs an unvalidated payload (admin tooling, backfill scripts).
  if (!isValidDomain(domain)) {
    /* c8 ignore next 5 */
    throw Object.assign(
      new Error('Invalid domain: must be a valid hostname or hostname/path (e.g. nba.com or nba.com/kings)'),
      { clientError: true },
    );
  }

  if (!isSafeDomain(domain)) {
    /* c8 ignore next 5 */
    throw Object.assign(new Error('Invalid domain'), { clientError: true });
  }

  const baseURL = composeBaseURL(domain);
  log.info(`Starting PLG ASO onboarding for IMS org ${imsOrgId}, baseURL ${baseURL}`);

  const profile = loadProfileConfig(PLG_PROFILE_KEY);

  let onboarding = await PlgOnboarding.findByImsOrgIdAndDomain(imsOrgId, domain);
  if (onboarding?.getStatus() === STATUSES.ONBOARDED) {
    log.info(`Domain ${domain} is already onboarded for IMS org ${imsOrgId}, returning existing record`);
    return onboarding;
  }
  if (!onboarding) {
    try {
      onboarding = await PlgOnboarding.create({
        imsOrgId, domain, baseURL, status: STATUSES.IN_PROGRESS, createdBy: callerIdentity,
      });
      log.info(`Created PlgOnboarding record ${onboarding.getId()}`);
    } catch (createError) {
      // Handle race condition: concurrent request may have created the record
      onboarding = await PlgOnboarding.findByImsOrgIdAndDomain(imsOrgId, domain);
      if (!onboarding) {
        throw createError;
      }
      if (onboarding.getStatus() === STATUSES.ONBOARDED) {
        log.info(`Domain ${domain} was onboarded concurrently for IMS org ${imsOrgId}, returning existing record`);
        return onboarding;
      }
      log.info(`Concurrent create detected, resuming PlgOnboarding record ${onboarding.getId()}`);
    }
  }
  onboarding.setUpdatedBy(callerIdentity);
  if (isFromAsoUI(context)) {
    onboarding.setCreatedBy(callerIdentity);
  }

  // Early rejection: demo/internal sites must never be onboarded regardless of flow path.
  // Check before any org resolution, RUM verification, or entitlement work.
  const existingSiteForDemoCheck = onboarding.getSiteId()
    ? await Site.findById(onboarding.getSiteId())
    : await Site.findByBaseURL(baseURL);
  if (
    existingSiteForDemoCheck
    && isInternalOrgDemoSite(existingSiteForDemoCheck.getId(), env)
  ) {
    log.info(`Site ${existingSiteForDemoCheck.getId()} is a demo/internal site — rejecting onboarding request`);
    const existingReviews = onboarding.getReviews() || [];
    onboarding.setReviews([...existingReviews, {
      reason: null,
      decision: REVIEW_DECISIONS.UPHELD,
      reviewedBy: 'system',
      reviewedAt: new Date().toISOString(),
      justification: 'Automatically rejected by system — this domain is reserved as a demo/internal site and cannot be onboarded.',
    }]);
    onboarding.setStatus(STATUSES.REJECTED);
    onboarding.setWaitlistReason(null);
    onboarding.setSiteId(existingSiteForDemoCheck.getId());
    await persistAndNotify(onboarding, context);
    return onboarding;
  }

  const terminalFromGuard = await handleExistingOnboardedDomain({
    onboarding, domain, imsOrgId,
  }, context);
  if (terminalFromGuard) {
    return terminalFromGuard;
  }

  // Fast path: preonboarded sites just need enrollment + ONBOARDED.
  if (onboarding.getStatus() === STATUSES.PRE_ONBOARDING && onboarding.getSiteId()) {
    const fastPathResult = await handlePreonboardedFastPath({
      onboarding, domain, imsOrgId,
    }, context);
    if (fastPathResult) {
      return fastPathResult;
    }
  }

  if (onboarding.getStatus() !== STATUSES.IN_PROGRESS) {
    onboarding.setStatus(STATUSES.IN_PROGRESS);
    onboarding.setError(null);
    log.info(`Resuming PlgOnboarding record ${onboarding.getId()}`);
  }

  const steps = { ...(onboarding.getSteps() || {}) };

  try {
    // Step 1: Resolve organization
    const organization = await createOrFindOrganization(imsOrgId, context);
    const organizationId = organization.getId();
    onboarding.setOrganizationId(organizationId);
    steps.orgResolved = true;

    // Step 2: AEM verification — domain must be an AEM site (RUM check OR delivery type).
    let site = await Site.findByBaseURL(baseURL);
    const rumApiClient = RUMAPIClient.createFrom(context);
    let cachedDeliveryType = null;
    try {
      const siteProxy = site ?? { getBaseURL: () => baseURL, getConfig: () => null };
      const rumDomain = await resolveWwwUrl(siteProxy, context);
      await rumApiClient.retrieveDomainkey(rumDomain);
      steps.rumVerified = true;
    } catch {
      steps.rumVerified = false;
      log.info(`No RUM data for ${domain}, checking delivery type`);
      const siteDeliveryType = site?.getDeliveryType?.();
      if (hasText(siteDeliveryType) && siteDeliveryType !== SiteModel.DELIVERY_TYPES.OTHER) {
        cachedDeliveryType = siteDeliveryType;
        log.info(`Using existing site delivery type ${cachedDeliveryType} for ${domain}`);
      } else {
        cachedDeliveryType = await findDeliveryType(baseURL);
      }
      if (!presetDeliveryType && cachedDeliveryType === SiteModel.DELIVERY_TYPES.OTHER) {
        log.info(`Domain ${domain} is not an AEM site, moving to waitlist`);
        onboarding.setStatus(STATUSES.WAITLISTED);
        onboarding.setWaitlistReason(`Domain ${domain} is not an AEM site`);
        onboarding.setSteps(steps);
        await persistAndNotify(onboarding, context);
        return onboarding;
      }
    }

    // Step 3: Check site ownership
    let needsOrgReassignment = false;
    if (site) {
      const existingOrgId = site.getOrganizationId();

      if (existingOrgId !== organizationId) {
        if (isInternalOrg(existingOrgId, env) && !isInternalOrgDemoSite(site.getId(), env)) {
          log.info(`Site ${site.getId()} org ${existingOrgId} is internal/demo — will reassign to new org ${organizationId} before entitlement operations`);
          needsOrgReassignment = true;
        } else {
          const existingOrg = await Organization.findById(existingOrgId);
          /* c8 ignore next */
          const existingImsOrgId = existingOrg?.getImsOrgId?.() || existingOrgId;
          /* c8 ignore next */
          const existingOrgName = existingOrg?.getName?.() || existingOrgId;
          let waitlistReason = `Domain ${domain} is ${DOMAIN_ALREADY_ASSIGNED} (org: ${existingOrgName}, id: ${existingImsOrgId}).`;
          const siteEnrollments = await site.getSiteEnrollments();
          if (!siteEnrollments || siteEnrollments.length === 0) {
            waitlistReason += ` This domain has no active products in its existing org '${existingOrgName}'. It can be safely moved to '${organization.getName()}'.`;
          } else {
            waitlistReason += ` This domain cannot be moved to '${organization.getName()}' — it is already set up with active products in its existing org ('${existingOrgName}').`;
          }
          onboarding.setStatus(STATUSES.WAITLISTED);
          onboarding.setWaitlistReason(waitlistReason);
          onboarding.setSiteId(site.getId());
          onboarding.setSteps(steps);
          await persistAndNotify(onboarding, context);
          return onboarding;
        }
      }
    }

    // Step 4: Bot blocker check
    const botBlockerResult = await detectBotBlocker({ baseUrl: baseURL });
    if (!botBlockerResult.crawlable) {
      if (site) {
        await site.save();
      }

      // eslint-disable-next-line id-match
      const botBlockerInfo = {
        type: botBlockerResult.type,
        ipsToAllowlist: botBlockerResult.ipsToAllowlist || botBlockerResult.ipsToWhitelist,
        userAgent: botBlockerResult.userAgent,
      };

      let waitlistReason = `Domain ${domain} is blocked by a bot blocker of type '${botBlockerInfo.type}'.`;
      if (botBlockerInfo.ipsToAllowlist?.length) {
        waitlistReason += ` The following IPs must be allowlisted: ${botBlockerInfo.ipsToAllowlist.join(', ')}.`;
      }
      if (botBlockerInfo.userAgent) {
        waitlistReason += ` User-agent used: ${botBlockerInfo.userAgent}.`;
      }

      onboarding.setStatus(STATUSES.WAITING_FOR_IP_ALLOWLISTING);
      onboarding.setWaitlistReason(waitlistReason);
      onboarding.setBotBlocker(botBlockerInfo);
      onboarding.setSiteId(site?.getId() || null);
      onboarding.setSteps(steps);
      await persistAndNotify(onboarding, context);
      return onboarding;
    }

    // Step 5: Create site if new
    if (!site) {
      const deliveryType = cachedDeliveryType ?? await findDeliveryType(baseURL);
      site = await Site.create({
        baseURL,
        organizationId,
        ...(deliveryType && { deliveryType }),
      });
      log.info(`Created site ${site.getId()} for ${baseURL}`);
      steps.siteCreated = true;
    }
    onboarding.setSiteId(site.getId());
    steps.siteResolved = true;

    // Step 5a: Alert when detected delivery type differs from the stored one.
    // Skip for newly created sites — delivery type was just set from findDeliveryType in Step 5.
    // We alert instead of auto-correcting because findDeliveryType is not 100% reliable.
    if (!presetDeliveryType && !steps.siteCreated) {
      const existingDeliveryType = site.getDeliveryType();
      let detectedDeliveryType;
      try {
        detectedDeliveryType = await findDeliveryType(baseURL);
      } catch (e) {
        log.warn(`Failed to detect delivery type for ${baseURL}: ${e.message}`);
      }
      if (
        detectedDeliveryType
        && detectedDeliveryType !== SiteModel.DELIVERY_TYPES.OTHER
        && detectedDeliveryType !== existingDeliveryType
      ) {
        log.warn(`Delivery type mismatch for site ${site.getId()} (${baseURL}): stored=${existingDeliveryType} detected=${detectedDeliveryType}`);
        const channelId = env.SLACK_PLG_ONBOARDING_CHANNEL_ID;
        const token = env.SLACK_BOT_TOKEN;
        /* c8 ignore next */
        if (channelId && token) {
          const message = ':warning: *PLG Onboarding — Delivery Type Mismatch*\n\n'
            + `• *Site ID:* \`${site.getId()}\`\n`
            + `• *Domain:* \`${baseURL}\`\n`
            + `• *Org ID:* \`${organizationId}\`\n`
            + `• *Org:* ${organization.getName()} (\`${imsOrgId}\`)\n`
            + `• *Stored delivery type:* \`${existingDeliveryType}\`\n`
            + `• *Detected delivery type:* \`${detectedDeliveryType}\``;
          try {
            await context.postSlackMessage(channelId, message, token);
          } catch (err) {
            log.error(`Failed to post delivery type mismatch alert: ${err.message}`);
          }
        }
      }
    }

    // Step 5b: Resolve canonical URL early so the RUM lookup uses the correct hostname
    const siteConfig = site.getConfig();
    const currentFetchConfig = siteConfig.getFetchConfig() || {};
    if (!currentFetchConfig.overrideBaseURL) {
      try {
        const resolvedUrl = await resolveCanonicalUrl(baseURL);
        if (resolvedUrl) {
          const { pathname: basePath, origin: baseOrigin } = new URL(baseURL);
          const { pathname: resolvedPath, origin: resolvedOrigin } = new URL(resolvedUrl);

          if (basePath !== resolvedPath || baseOrigin !== resolvedOrigin) {
            const overrideBaseURL = basePath !== '/'
              ? `${resolvedOrigin}${basePath}`
              : resolvedOrigin;
            siteConfig.updateFetchConfig({ ...currentFetchConfig, overrideBaseURL });
            log.info(`Set overrideBaseURL to ${overrideBaseURL} for site ${site.getId()}`);
          }
        }
      } catch (error) {
        log.warn(`Failed to resolve canonical URL for ${baseURL}: ${error.message}`);
      }
    }

    // Step 5c: Set delivery type and author URL
    const rumHost = await applyDeliveryConfig({
      site, presetDeliveryType, presetAuthorUrl, presetProgramId, imsOrgId, steps,
    }, context);

    // Step 5d: Resolve EDS code config and hlxConfig from RUM host
    try {
      await updateCodeConfig(site, rumHost, { say: () => {} }, log);
      if (site.getCode()?.owner) {
        steps.codeConfigResolved = true;
      }
    } catch (error) {
      log.warn(`Failed to resolve code config for site ${site.getId()}: ${error.message}`);
    }

    // Step 5e: Set hlxConfig for EDS sites from RUM host
    if (rumHost && !site.getHlxConfig()) {
      const edsMatch = rumHost.match(EDS_HOST_PATTERN);
      if (edsMatch) {
        const [, ref, repo, owner, tld] = edsMatch;
        site.setHlxConfig({
          hlxVersion: 5,
          rso: {
            ref, site: repo, owner, tld,
          },
        });
        site.setDeliveryType(SiteModel.DELIVERY_TYPES.AEM_EDGE);
        log.info(`Set hlxConfig for site ${site.getId()}: ${ref}--${repo}--${owner}.${tld}`);
        steps.hlxConfigSet = true;
      }
    }

    // Step 6: Update configs
    const importDefs = Object.keys(profile.imports || {}).map((type) => ({ type }));
    await enableImports(siteConfig, importDefs, log);

    if (!site.getLanguage() || !site.getRegion()) {
      try {
        const locale = await detectLocale({ baseUrl: baseURL });
        if (!site.getLanguage() && locale.language) {
          site.setLanguage(locale.language);
        }
        if (!site.getRegion() && locale.region) {
          site.setRegion(locale.region);
        }
      } catch (error) {
        log.warn(`Locale detection failed for ${baseURL}: ${error.message}`);
        if (!site.getLanguage()) {
          site.setLanguage('en');
        }
        if (!site.getRegion()) {
          site.setRegion('US');
        }
      }
    }

    const project = await createOrFindProject(baseURL, organizationId, context);
    if (!site.getProjectId()) {
      site.setProjectId(project.getId());
    }

    // Perform a live RUM domain-key check and persist the result.
    const hasDomainKey = await updateRumConfig(site, context, { save: false });
    siteConfig.updateRumConfig(hasDomainKey);

    site.setConfig(Config.toDynamoItem(siteConfig));
    await site.save();
    steps.configUpdated = true;

    // Step 7: Queue delivery config writer for AEM CS/CW sites
    const deliveryConfigResult = await queueDeliveryConfigWriter(
      {
        site,
        baseURL,
        minutes: 2000,
        updateRedirects: true,
        slackContext: {},
      },
      context,
    );

    if (deliveryConfigResult.ok) {
      steps.deliveryConfigQueued = true;
    } else {
      steps.deliveryConfigQueued = false;
      log.warn(`Failed to queue delivery config writer for site ${site.getId()}: ${deliveryConfigResult.error}`);
    }

    // Step 8: Enable audits from PLG profile
    const auditTypes = Object.keys(profile.audits || {});
    await enableAudits(site, context, auditTypes);
    steps.auditsEnabled = true;

    await enrollPlgConfigHandlers(site, context);

    // Step 9: Reassign site org if it was previously in an internal/demo org.
    // Must happen BEFORE entitlement operations to ensure we get the correct org's entitlement.
    if (needsOrgReassignment) {
      log.info(`Reassigning site ${site.getId()} to org ${organizationId} (was in internal/demo org)`);
      site = await reassignSiteOrganization(site, organizationId);
      onboarding.setOrganizationId(organizationId);
      steps.siteOrgReassigned = true;
    }

    // Step 10: Add ASO entitlement, revoke any previous ASO enrollments for this org, update FF.
    const { entitlement } = await ensureAsoEntitlement(site, organization, context);
    await revokePreviousAsoEnrollmentsForOrg(site, organization, entitlement, context);
    await updateLaunchDarklyFlags(site, organization, context);
    steps.entitlementCreated = true;

    // Step 11: Trigger audit runs
    await triggerAudits(auditTypes, context, site);

    // Step 12: Trigger brand profile (non-blocking)
    try {
      await triggerBrandProfileAgent({ context, site, reason: 'plg-onboarding' });
    } catch (error) {
      log.warn(`Failed to trigger brand-profile for site ${site.getId()}: ${error.message}`);
    }

    // Best-effort cleanup of stale FIXED suggestions from prior onboarding lifecycle.
    await cleanupPlgSiteSuggestionsAndFixes(site.getId(), context);

    onboarding.setStatus(STATUSES.ONBOARDED);
    onboarding.setWaitlistReason(null);
    onboarding.setBotBlocker(null);
    onboarding.setSteps(steps);
    onboarding.setCompletedAt(new Date().toISOString());
    await persistAndNotify(onboarding, context);
    return onboarding;
  } catch (error) {
    return handleTerminalError(error, { onboarding, steps }, context);
  }
}
