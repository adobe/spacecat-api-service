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

// TODO: re-export from @adobe/spacecat-shared-data-access package root
import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';
import PlgOnboardingModel from '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js';
import LaunchDarklyClient from '@adobe/spacecat-shared-launchdarkly-client';
import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';
import TierClient from '@adobe/spacecat-shared-tier-client';
import {
  badRequest, createResponse, created, forbidden, internalServerError, noContent, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  composeBaseURL,
  detectBotBlocker,
  detectLocale,
  hasText,
  isValidIMSOrgId,
  resolveCanonicalUrl,
} from '@adobe/spacecat-shared-utils';

import {
  createOrFindOrganization,
  enableAudits,
  enableImports,
  triggerAudits,
} from '../llmo/llmo-onboarding.js';
import {
  autoResolveAuthorUrl,
  findDeliveryType,
  deriveProjectName,
  updateCodeConfig,
  queueDeliveryConfigWriter,
} from '../../support/utils.js';
import { loadProfileConfig } from '../../utils/slack/base.js';
import { triggerBrandProfileAgent } from '../../support/brand-profile-trigger.js';
import { PlgOnboardingDto } from '../../dto/plg-onboarding.js';
import AccessControlUtil from '../../support/access-control-util.js';

const { STATUSES, REVIEW_DECISIONS } = PlgOnboardingModel;
const ASO_PRODUCT_CODE = EntitlementModel.PRODUCT_CODES.ASO;
const ASO_TIER = EntitlementModel.TIERS.PLG;
const PLG_PROFILE_KEY = 'aso_plg';
const LD_FF_PROJECT_NAME = 'experience-success-studio';
const LD_API_TOKEN_ENV_VAR = 'LD_EXPERIENCE_SUCCESS_API_TOKEN';
const LD_AUTO_FIX_FLAGS = [
  'FF_cwv-auto-fix',
  'FF_alt-text-auto-fix',
  'FF_broken-backlinks-auto-fix',
];

const REVIEW_REASONS = {
  DOMAIN_ALREADY_ONBOARDED_IN_ORG: 'DOMAIN_ALREADY_ONBOARDED_IN_ORG',
  AEM_SITE_CHECK: 'AEM_SITE_CHECK',
  DOMAIN_ALREADY_ASSIGNED: 'DOMAIN_ALREADY_ASSIGNED',
};

const DOMAIN_ALREADY_ASSIGNED = 'already assigned to another organization';
const DOMAIN_ALREADY_ONBOARDED_IN_ORG = 'another domain is already onboarded for this IMS org';

/**
 * Derives the review check key from the onboarding record's current state.
 * @param {object} onboarding - The PlgOnboarding record.
 * @returns {string|null} The check key enum value, or null if unknown.
 */
function deriveCheckKey(onboarding) {
  /* c8 ignore next */
  const waitlistReason = onboarding.getWaitlistReason() || '';
  if (waitlistReason.includes(DOMAIN_ALREADY_ONBOARDED_IN_ORG)) {
    return REVIEW_REASONS.DOMAIN_ALREADY_ONBOARDED_IN_ORG;
  }
  if (waitlistReason.includes('is not an AEM site')) {
    return REVIEW_REASONS.AEM_SITE_CHECK;
  }
  if (waitlistReason.includes(DOMAIN_ALREADY_ASSIGNED)) {
    return REVIEW_REASONS.DOMAIN_ALREADY_ASSIGNED;
  }

  return null;
}

/**
 * Checks whether a specific blocking reason has been bypassed by the most recent review.
 * Only the last review in the array is considered — if a newer bypass was added for a
 * different reason (e.g. DOMAIN_ALREADY_ONBOARDED_IN_ORG after AEM_SITE_CHECK), the
 * earlier bypass is no longer active and the check will run again.
 * @param {Array} reviews - The reviews array from the onboarding record.
 * @param {string} reasonSubstring - Substring to match against the review reason.
 * @returns {boolean} True if the most recent review matches the reason and is BYPASSED.
 */
function isBypassed(reviews, reasonSubstring) {
  /* c8 ignore next 3 */
  const last = (reviews || []).at(-1);
  return last?.reason?.includes(reasonSubstring) && last?.decision === REVIEW_DECISIONS.BYPASSED;
}

// EDS host pattern: ref--repo--owner.aem.live (or hlx.live)
const EDS_HOST_PATTERN = /^([\w-]+)--([\w-]+)--([\w-]+)\.(aem\.live|hlx\.live)$/i;

// AEM CS publish host pattern: publish-p{programId}-e{environmentId}.adobeaemcloud.(com|net)
const AEM_CS_PUBLISH_HOST_PATTERN = /^publish-p(\d+)-e(\d+)\.adobeaemcloud\.(com|net)$/i;

// RFC 1123 hostname: labels of 1-63 alphanumeric/hyphen chars, separated by dots, max 253 chars
const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

/**
 * Validates that a domain is a syntactically valid hostname (RFC 1123).
 * @param {string} domain - The domain to validate.
 * @returns {boolean} true if valid hostname, false otherwise.
 */
function isValidHostname(domain) {
  return HOSTNAME_RE.test(domain);
}

/**
 * Validates that a domain is not a private/internal address to prevent SSRF.
 * @param {string} domain - The domain to validate.
 * @returns {boolean} true if safe, false if potentially dangerous.
 */
function isSafeDomain(domain) {
  const blocked = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^\[::1\]/,
    /\.local$/i,
    /\.internal$/i,
    /\.private\./i,
  ];
  return !blocked.some((pattern) => pattern.test(domain));
}

async function ensureAsoEntitlement(site, context) {
  const { log } = context;
  const tierClient = await TierClient.createForSite(context, site, ASO_PRODUCT_CODE);
  try {
    const result = await tierClient.createEntitlement(ASO_TIER);
    log.info(`ASO entitlement ${result.entitlement.getId()} and enrollment ${result.siteEnrollment?.getId()} ensured for site ${site.getId()}`);
    return result;
  } catch (error) {
    if (error.message?.includes('already exists') || error.message?.includes('Already enrolled')) {
      log.info(`ASO entitlement already exists for site ${site.getId()}, fetching existing`);
      return tierClient.checkValidEntitlement();
    }
    throw error;
  }
}

/**
 * Revokes the ASO site enrollment for any other site under the same entitlement.
 * Used to enforce one active PLG enrollment per org when upgrading from PRE_ONBOARD.
 * @param {object} site - The newly enrolled site.
 * @param {object} entitlement - The ASO entitlement for the org.
 * @param {object} context - Request context.
 */
async function revokePreOnboardedSiteEnrollment(site, entitlement, context) {
  const { dataAccess, log } = context;
  const { SiteEnrollment } = dataAccess;

  const enrollments = await SiteEnrollment.allByEntitlementId(entitlement.getId());
  const toRevoke = enrollments.filter((e) => e.getSiteId() !== site.getId());

  await Promise.all(toRevoke.map((e) => {
    log.info(`Revoking ASO enrollment ${e.getId()} for previously enrolled site ${e.getSiteId()}`);
    return e.remove();
  }));
}

/**
 * Upserts a single LaunchDarkly flag's variation 0 to include the org + site.
 * Variation 0 value is a JSON object: { [imsOrgId]: [siteIds] }.
 *
 * NOTE: This function performs a read-modify-write on the flag variation without
 * locking. Two concurrent onboardings could overwrite each other's addition. The
 * idempotent check makes this self-healing on retry (re-running onboarding will
 * re-add a lost entry), but a missed write will not be detected automatically.
 * @param {object} ldClient - LaunchDarklyClient instance.
 * @param {string} flagKey - Flag key.
 * @param {string} imsOrgId - IMS org ID.
 * @param {string} siteId - Site ID.
 * @param {object} log - Logger.
 */
async function upsertLdFlag(ldClient, flagKey, imsOrgId, siteId, log) {
  const flag = await ldClient.getFeatureFlag(LD_FF_PROJECT_NAME, flagKey);
  const rawValue = flag.variations?.[0]?.value;

  if (rawValue === undefined) {
    log.warn(`LaunchDarkly flag ${flagKey} has no variations`);
    return;
  }

  const isStringWrapped = typeof rawValue === 'string';
  let parsed;
  try {
    parsed = isStringWrapped ? JSON.parse(rawValue) : rawValue;
  } catch (e) {
    log.warn(`LaunchDarkly flag ${flagKey} has malformed JSON in variation 0, skipping: ${e.message}`);
    return;
  }

  const existingSites = parsed[imsOrgId] ?? [];
  if (existingSites.includes(siteId)) {
    log.info(`LaunchDarkly: site ${siteId} already in ${flagKey} for org ${imsOrgId}`);
    return;
  }

  const merged = { ...parsed, [imsOrgId]: [...existingSites, siteId] };
  const newValue = isStringWrapped ? JSON.stringify(merged) : merged;

  await ldClient.updateVariationValue(
    LD_FF_PROJECT_NAME,
    flagKey,
    0,
    newValue,
    `plg-onboarding: enable ${flagKey} for ${imsOrgId} / ${siteId}`,
  );

  log.info(`LaunchDarkly: enabled ${flagKey} for org ${imsOrgId}, site ${siteId}`);
}

/**
 * Enables all PLG auto-fix LaunchDarkly feature flags for the given site's org.
 * Uses the experience-success-studio project token (LD_EXPERIENCE_SUCCESS_API_TOKEN).
 * Each flag update is non-fatal — onboarding continues even if one fails.
 * @param {object} site - The onboarded site.
 * @param {object} context - Request context.
 */
async function updateLaunchDarklyFlags(site, context) {
  const { log, env } = context;

  const apiToken = env[LD_API_TOKEN_ENV_VAR];
  if (!apiToken) {
    log.warn(`Cannot update LaunchDarkly flags: ${LD_API_TOKEN_ENV_VAR} is not set`);
    return;
  }

  const ldClient = new LaunchDarklyClient({ apiToken }, log);

  const imsOrgId = (await context.dataAccess.Organization.findById(
    site.getOrganizationId(),
  ))?.getImsOrgId();

  if (!imsOrgId) {
    log.warn(`Cannot update LaunchDarkly flags: no IMS org ID for site ${site.getId()}`);
    return;
  }

  const siteId = site.getId();

  const results = await Promise.allSettled(
    LD_AUTO_FIX_FLAGS.map((flagKey) => upsertLdFlag(ldClient, flagKey, imsOrgId, siteId, log)),
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      log.error(`Failed to update LaunchDarkly flag ${LD_AUTO_FIX_FLAGS[i]}: ${result.reason?.message}`);
    }
  });
}

const PLG_OPPORTUNITY_TYPES = ['cwv', 'alt-text', 'broken-backlinks'];

/**
 * Returns true if the given site has active PLG work that should block displacement.
 * Blocks displacement if any PLG opportunity (cwv, alt-text, broken-backlinks) has:
 *   - open suggestions (NEW or IN_PROGRESS), OR
 *   - a completed audit (lastAuditedAt set) with no suggestions — meaning the audit ran
 *     and suggestions were all resolved, indicating the site has been actively used.
 * Returns true (conservative) on any lookup failure so we never accidentally displace
 * a site that may still have active work.
 * @param {string} siteId - The site ID to check.
 * @param {object} dataAccess - Data access layer.
 * @param {object} log - Logger.
 * @returns {Promise<boolean>}
 */
async function hasOpenPlgSuggestions(siteId, dataAccess, log) {
  const { Opportunity, Suggestion } = dataAccess;
  try {
    const opportunities = await Opportunity.allBySiteId(siteId);
    const plgOpportunities = opportunities.filter(
      (o) => PLG_OPPORTUNITY_TYPES.includes(o.getType()),
    );

    if (plgOpportunities.length === 0) {
      return false;
    }

    const suggestionLists = await Promise.all(
      plgOpportunities.map((o) => Suggestion.allByOpportunityId(o.getId())),
    );

    // Block displacement if any PLG opportunity has open suggestions.
    if (suggestionLists.some(
      (suggestions) => suggestions.some(
        (s) => s.getStatus() === 'NEW' || s.getStatus() === 'IN_PROGRESS',
      ),
    )) {
      return true;
    }

    // Also block displacement if any PLG opportunity has been audited (lastAuditedAt set)
    // and has no suggestions — the audit completed and suggestions were resolved, so the
    // site has been actively used.
    return plgOpportunities.some(
      (o, i) => o.getLastAuditedAt() && suggestionLists[i].length === 0,
    );
  } catch (error) {
    log.warn(`Failed to check PLG suggestions for site ${siteId}: ${error.message}`);
    return true; // conservative: do not displace if check fails
  }
}

async function createOrFindProject(baseURL, organizationId, context) {
  const { dataAccess, log } = context;
  const { Project } = dataAccess;
  const projectName = deriveProjectName(baseURL);

  const existingProject = (
    await Project.allByOrganizationId(organizationId)
  ).find((p) => p.getProjectName() === projectName);

  if (existingProject) {
    log.debug(`Found existing project ${existingProject.getId()}`);
    return existingProject;
  }

  const newProject = await Project.create({
    projectName, organizationId,
  });
  log.info(`Created project ${newProject.getId()} for ${baseURL}`);
  return newProject;
}

/**
 * Performs ASO PLG onboarding for a given domain and IMS org.
 * Creates and maintains a PlgOnboarding record to track the lifecycle.
 *
 * @param {object} params
 * @param {string} params.domain - The domain to onboard
 * @param {string} params.imsOrgId - The IMS Organization ID
 * @param {string} [params.rumHost] - Optional pre-provided RUM host (for AEM_SITE_CHECK bypass)
 * @param {object} context - The request context
 * @returns {Promise<object>} PlgOnboarding record
 */
async function performAsoPlgOnboarding({ domain, imsOrgId, rumHost: presetRumHost }, context) {
  const { dataAccess, log } = context;
  const { Site, PlgOnboarding, Organization } = dataAccess;

  if (!isValidHostname(domain)) {
    throw Object.assign(
      new Error('Invalid domain: must be a valid hostname'),
      { clientError: true },
    );
  }

  if (!isSafeDomain(domain)) {
    throw Object.assign(
      new Error('Invalid domain'),
      { clientError: true },
    );
  }

  const baseURL = composeBaseURL(domain);
  log.info(`Starting PLG ASO onboarding for IMS org ${imsOrgId}, baseURL ${baseURL}`);

  const profile = loadProfileConfig(PLG_PROFILE_KEY);

  // Create or find existing PlgOnboarding record for this imsOrgId + domain
  let onboarding = await PlgOnboarding.findByImsOrgIdAndDomain(imsOrgId, domain);
  if (!onboarding) {
    try {
      onboarding = await PlgOnboarding.create({
        imsOrgId,
        domain,
        baseURL,
        status: STATUSES.IN_PROGRESS,
      });
      log.info(`Created PlgOnboarding record ${onboarding.getId()}`);
    } catch (createError) {
      // Handle race condition: concurrent request may have created the record
      onboarding = await PlgOnboarding.findByImsOrgIdAndDomain(imsOrgId, domain);
      if (!onboarding) {
        throw createError;
      }
      log.info(`Concurrent create detected, resuming PlgOnboarding record ${onboarding.getId()}`);
    }
  }
  // Guard: only one domain per IMS org can be onboarded
  const reviews = onboarding.getReviews() || [];
  const existingRecords = await PlgOnboarding.allByImsOrgId(imsOrgId);
  const alreadyOnboarded = existingRecords
    .find((r) => r.getDomain() !== domain && r.getStatus() === STATUSES.ONBOARDED);
  if (alreadyOnboarded) {
    // If the existing onboarded site has no active PLG work (no open suggestions, and no
    // completed audit with resolved suggestions), displace it: waitlist the old domain,
    // revoke its ASO enrollment, and continue onboarding the new domain.
    // NOTE: this check-then-act is not atomic. Two concurrent requests for the same IMS org
    // could both pass this check and both proceed to onboard, temporarily violating the
    // one-domain-per-org invariant. The invariant self-heals on the next onboarding attempt.
    const alreadyOnboardedSiteId = alreadyOnboarded.getSiteId();
    const canDisplace = alreadyOnboardedSiteId
      && !(await hasOpenPlgSuggestions(alreadyOnboardedSiteId, dataAccess, log));

    if (canDisplace) {
      log.info(`IMS org ${imsOrgId}: displacing domain ${alreadyOnboarded.getDomain()} (site ${alreadyOnboardedSiteId}) for new domain ${domain}`);
      alreadyOnboarded.setStatus(STATUSES.WAITLISTED);
      alreadyOnboarded.setWaitlistReason(`Displaced by new domain ${domain} for IMS org ${imsOrgId}`);
      await alreadyOnboarded.save();

      // Only revoke ASO enrollments — leave other product enrollments untouched.
      // Revocation failure is non-fatal: log the error and continue so the new domain
      // still gets onboarded. Orphaned enrollments can be cleaned up out-of-band.
      const { SiteEnrollment, Entitlement } = dataAccess;
      const oldOrgId = alreadyOnboarded.getOrganizationId();
      if (oldOrgId) {
        try {
          const entitlements = await Entitlement.allByOrganizationId(oldOrgId);
          const asoEntitlement = entitlements.find((e) => e.getProductCode() === ASO_PRODUCT_CODE);
          if (asoEntitlement) {
            const asoEnrollments = await SiteEnrollment.allByEntitlementId(asoEntitlement.getId());
            const toRevoke = asoEnrollments.filter((e) => e.getSiteId() === alreadyOnboardedSiteId);
            await Promise.all(toRevoke.map((e) => {
              log.info(`Revoking ASO enrollment ${e.getId()} for displaced site ${alreadyOnboardedSiteId}`);
              return e.remove();
            }));
          } else {
            log.info(`No ASO entitlement found for org ${oldOrgId}, nothing to revoke`);
          }
        } catch (revokeError) {
          log.error(`Failed to revoke ASO enrollment for displaced site ${alreadyOnboardedSiteId}: ${revokeError.message}`);
        }
      } else {
        log.warn(`Cannot revoke ASO enrollment for displaced site ${alreadyOnboardedSiteId}: no org ID on onboarding record`);
      }
      // Fall through to continue onboarding the new domain
    } else {
      /* c8 ignore next 3 */
      const existingOrgForOnboarded = alreadyOnboarded.getOrganizationId()
        ? await Organization.findById(alreadyOnboarded.getOrganizationId())
        : null;
      /* c8 ignore next */
      const existingOrgName = existingOrgForOnboarded?.getName?.()
        || alreadyOnboarded.getOrganizationId();
      log.info(`IMS org ${imsOrgId} already has onboarded domain ${alreadyOnboarded.getDomain()}, waitlisting ${domain}`);
      onboarding.setStatus(STATUSES.WAITLISTED);
      onboarding.setWaitlistReason(`Domain ${alreadyOnboarded.getDomain()} is ${DOMAIN_ALREADY_ONBOARDED_IN_ORG} (org: ${existingOrgName}, id: ${imsOrgId})`);
      await onboarding.save();
      return onboarding;
    }
  }

  // Fast path: preonboarded sites just need enrollment + ONBOARDED
  if (onboarding.getStatus() === STATUSES.PRE_ONBOARDING && onboarding.getSiteId()) {
    log.info(`Fast-tracking preonboarded record ${onboarding.getId()}`);
    const site = await Site.findById(onboarding.getSiteId());
    if (site) {
      const { entitlement } = await ensureAsoEntitlement(site, context);
      await revokePreOnboardedSiteEnrollment(site, entitlement, context);
      await updateLaunchDarklyFlags(site, context);
      const steps = { ...(onboarding.getSteps() || {}), entitlementCreated: true };
      onboarding.setStatus(STATUSES.ONBOARDED);
      onboarding.setSteps(steps);
      onboarding.setCompletedAt(new Date().toISOString());
      await onboarding.save();
      return onboarding;
    }
    log.warn(`Preonboarded site ${onboarding.getSiteId()} not found, falling through to full onboarding`);
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

    // Step 2: AEM verification — domain must be an AEM site (RUM check OR delivery type)
    const rumApiClient = RUMAPIClient.createFrom(context);
    let cachedDeliveryType = null;
    try {
      await rumApiClient.retrieveDomainkey(domain);
      steps.rumVerified = true;
    } catch {
      steps.rumVerified = false;
      log.info(`No RUM data for ${domain}, checking delivery type`);
      cachedDeliveryType = await findDeliveryType(baseURL);
      if (!isBypassed(reviews, 'is not an AEM site')
        && cachedDeliveryType === SiteModel.DELIVERY_TYPES.OTHER) {
        log.info(`Domain ${domain} is not an AEM site, moving to waitlist`);
        onboarding.setStatus(STATUSES.WAITLISTED);
        onboarding.setWaitlistReason(`Domain ${domain} is not an AEM site`);
        onboarding.setSteps(steps);
        await onboarding.save();
        return onboarding;
      }
    }

    // Step 3: Check site ownership
    let site = await Site.findByBaseURL(baseURL);

    if (site) {
      const existingOrgId = site.getOrganizationId();

      if (existingOrgId !== organizationId) {
        const existingOrg = await Organization.findById(existingOrgId);
        /* c8 ignore next */
        const existingImsOrgId = existingOrg?.getImsOrgId?.() || existingOrgId;
        /* c8 ignore next */
        const existingOrgName = existingOrg?.getName?.() || existingOrgId;
        onboarding.setStatus(STATUSES.WAITLISTED);
        onboarding.setWaitlistReason(`Domain ${domain} is ${DOMAIN_ALREADY_ASSIGNED} (org: ${existingOrgName}, id: ${existingImsOrgId})`);
        onboarding.setSiteId(site.getId());
        onboarding.setSteps(steps);
        await onboarding.save();
        return onboarding;
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
        ipsToAllowlist: botBlockerResult.ipsToAllowlist
          || botBlockerResult.ipsToWhitelist,
        userAgent: botBlockerResult.userAgent,
      };

      onboarding.setStatus(STATUSES.WAITING_FOR_IP_ALLOWLISTING);
      onboarding.setBotBlocker(botBlockerInfo);
      onboarding.setSiteId(site?.getId() || null);
      onboarding.setSteps(steps);
      await onboarding.save();

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

    // Step 5b: Resolve canonical URL early so the RUM lookup uses the correct hostname
    // (e.g. example.com may redirect to www.example.com which is what RUM is keyed on)
    const siteConfig = site.getConfig();
    const currentFetchConfig = siteConfig.getFetchConfig() || {};
    if (!currentFetchConfig.overrideBaseURL) {
      try {
        const resolvedUrl = await resolveCanonicalUrl(baseURL);
        if (resolvedUrl) {
          const { pathname: basePath, origin: baseOrigin } = new URL(baseURL);
          const {
            pathname: resolvedPath, origin: resolvedOrigin,
          } = new URL(resolvedUrl);

          if (basePath !== resolvedPath
            || baseOrigin !== resolvedOrigin) {
            const overrideBaseURL = basePath !== '/'
              ? `${resolvedOrigin}${basePath}`
              : resolvedOrigin;
            siteConfig.updateFetchConfig({
              ...currentFetchConfig, overrideBaseURL,
            });
            log.info(`Set overrideBaseURL to ${overrideBaseURL} for site ${site.getId()}`);
          }
        }
      } catch (error) {
        log.warn(`Failed to resolve canonical URL for ${baseURL}: ${error.message}`);
      }
    }

    // Step 5c: Auto-resolve author URL and RUM host
    let rumHost = presetRumHost || null;
    if (presetRumHost) {
      // Derive AEM CS delivery config directly from preset rumHost
      /* c8 ignore next */
      const existingDeliveryConfig = site.getDeliveryConfig() || {};
      if (!existingDeliveryConfig.authorURL) {
        const csMatch = presetRumHost.match(AEM_CS_PUBLISH_HOST_PATTERN);
        if (csMatch) {
          const [, programId, environmentId] = csMatch;
          const authorURL = `https://author-p${programId}-e${environmentId}.adobeaemcloud.com`;
          site.setDeliveryConfig({
            ...existingDeliveryConfig,
            authorURL,
            programId,
            environmentId,
            preferContentApi: true,
            imsOrgId,
          });
          site.setDeliveryType(SiteModel.DELIVERY_TYPES.AEM_CS);
          log.info(`Derived author URL from preset rumHost: ${authorURL}`);
          steps.authorUrlResolved = true;
        }
      }
    } else {
      try {
        const resolvedConfig = await autoResolveAuthorUrl(site, context);
        rumHost = resolvedConfig?.host || null;

        // Only update deliveryConfig if authorURL is not already set
        const existingDeliveryConfig = site.getDeliveryConfig() || {};
        if (!existingDeliveryConfig.authorURL && resolvedConfig?.authorURL) {
          site.setDeliveryConfig({
            ...existingDeliveryConfig,
            authorURL: resolvedConfig.authorURL,
            programId: resolvedConfig.programId,
            environmentId: resolvedConfig.environmentId,
            preferContentApi: true,
            imsOrgId,
          });
          log.info(`Auto-resolved author URL for site ${site.getId()}: ${resolvedConfig.authorURL}`);
          steps.authorUrlResolved = true;
        }
      } catch (error) {
        log.warn(`Failed to auto-resolve author URL for site ${site.getId()}: ${error.message}`);
      }
    }

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

    // Enable imports from PLG profile
    const importDefs = Object.keys(profile.imports || {})
      .map((type) => ({ type }));
    await enableImports(siteConfig, importDefs, log);

    // Detect and set locale
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

    // Create/assign project
    const project = await createOrFindProject(baseURL, organizationId, context);
    if (!site.getProjectId()) {
      site.setProjectId(project.getId());
    }

    // Save site with updated config
    site.setConfig(Config.toDynamoItem(siteConfig));
    await site.save();
    steps.configUpdated = true;

    // Step 7: update redirects source and mode for AEM CS/CW site.
    // Skip for non-CS/CW sites, or if programID and environmentID are missing
    const deliveryConfigResult = await queueDeliveryConfigWriter(
      {
        site,
        baseURL,
        minutes: 2000, // 33 hours, same as default. Lower values may miss redirects.
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

    // Step 8b: Enroll site in config handlers (summit-plg + auto-suggest/auto-fix)
    try {
      const { Configuration } = dataAccess;
      const configuration = await Configuration.findLatest();
      const configHandlers = [
        'summit-plg',
        'broken-backlinks-auto-suggest',
        'broken-backlinks-auto-fix',
        'alt-text-auto-fix',
        'alt-text-auto-suggest-mystique',
        'alt-text',
        'cwv-auto-fix',
        'cwv-auto-suggest',
        'cwv',
      ];
      configHandlers.forEach((handler) => {
        configuration.enableHandlerForSite(handler, site);
      });
      await configuration.save();
      log.info(`Enrolled site ${site.getId()} in config handlers: ${configHandlers.join(', ')}`);
    } catch (error) {
      log.warn(`Failed to enroll site in config handlers: ${error.message}`);
    }

    // Step 9: Add ASO entitlement, revoke any pre-onboarded site's enrollment, update FF
    const { entitlement } = await ensureAsoEntitlement(site, context);
    await revokePreOnboardedSiteEnrollment(site, entitlement, context);
    await updateLaunchDarklyFlags(site, context);

    steps.entitlementCreated = true;

    // Step 10: Trigger audit runs
    await triggerAudits(auditTypes, context, site);

    // Step 11: Trigger brand profile (non-blocking)
    try {
      await triggerBrandProfileAgent({
        context, site, reason: 'plg-onboarding',
      });
    } catch (error) {
      log.warn(`Failed to trigger brand-profile for site ${site.getId()}: ${error.message}`);
    }

    // Mark as completed
    onboarding.setStatus(STATUSES.ONBOARDED);
    onboarding.setSteps(steps);
    onboarding.setCompletedAt(new Date().toISOString());
    await onboarding.save();

    return onboarding;
  } catch (error) {
    // Persist the error in the onboarding record
    onboarding.setStatus(STATUSES.ERROR);
    onboarding.setSteps(steps);
    onboarding.setError({
      message: (error.clientError || error.conflict)
        ? error.message : 'An internal error occurred',
    });
    try {
      await onboarding.save();
    } catch (saveError) {
      log.error(`Failed to persist error state for onboarding ${onboarding.getId()}: ${saveError.message}`);
    }
    throw error;
  }
}

/**
 * PLG Onboarding controller.
 * @param {object} ctx - Context of the request.
  * @returns {object} Controller with onboard, getStatus, and getAllOnboardings methods.
 */
function PlgOnboardingController(ctx) {
  const { log } = ctx;

  // Authorization: any authenticated org member can onboard their own domains.
  const onboard = async (context) => {
    const { data, attributes } = context;

    if (!data || typeof data !== 'object') {
      return badRequest('Request body is required');
    }

    const { domain, imsOrgId: requestedImsOrgId } = data;

    if (!hasText(domain)) {
      return badRequest('domain is required');
    }

    const { authInfo } = attributes;

    if (!authInfo) {
      return badRequest('Authentication information is required');
    }

    const accessControlUtil = AccessControlUtil.fromContext(context);
    const isAdmin = accessControlUtil.hasAdminAccess();

    // Admins can onboard on behalf of any IMS org — imsOrgId must be explicitly provided
    let imsOrgId;
    if (isAdmin) {
      if (!hasText(requestedImsOrgId) || !isValidIMSOrgId(requestedImsOrgId)) {
        return badRequest('Valid imsOrgId is required when onboarding as admin');
      }
      imsOrgId = requestedImsOrgId;
    } else {
      const profile = authInfo.getProfile();

      if (!profile?.tenants?.[0]?.id) {
        return badRequest('User profile or organization ID not found in authentication token');
      }

      // If caller specifies an imsOrgId, validate it matches one of their token's tenants
      if (hasText(requestedImsOrgId)) {
        const matchedTenant = profile.tenants
          .find((t) => `${t.id}@AdobeOrg` === requestedImsOrgId);
        if (!matchedTenant) {
          return forbidden('Requested imsOrgId does not match any tenant in authentication token');
        }
        imsOrgId = requestedImsOrgId;
      } else {
        imsOrgId = `${profile.tenants[0].id}@AdobeOrg`;
      }
    }

    try {
      const onboarding = await performAsoPlgOnboarding({ domain, imsOrgId }, context);
      return ok(PlgOnboardingDto.toJSON(onboarding));
    } catch (error) {
      log.error(`PLG onboarding failed for domain ${domain}: ${error.message}`);

      if (error.conflict) {
        return createResponse({ message: error.message }, 409);
      }
      if (error.clientError) {
        return badRequest(error.message);
      }
      return internalServerError('Onboarding failed. Please try again later.');
    }
  };

  const getStatus = async (context) => {
    const { dataAccess: da, params, attributes } = context;
    const { imsOrgId: requestedImsOrgId } = params;

    if (!hasText(requestedImsOrgId) || !isValidIMSOrgId(requestedImsOrgId)) {
      return badRequest('Valid imsOrgId is required');
    }

    const { authInfo } = attributes;

    if (!authInfo) {
      return badRequest('Authentication information is required');
    }

    // Admin/API key holders can access any org's status
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!accessControlUtil.hasAdminAccess()) {
      // Non-admin: validate caller's IMS tenant matches requested imsOrgId
      const profile = authInfo.getProfile();

      if (!profile?.tenants?.[0]?.id) {
        return badRequest('User profile or organization ID not found in authentication token');
      }

      const matchedTenant = profile.tenants
        .find((t) => `${t.id}@AdobeOrg` === requestedImsOrgId);
      if (!matchedTenant) {
        return forbidden('Not authorized for this IMS org');
      }
    }

    const { PlgOnboarding } = da;
    const records = await PlgOnboarding.allByImsOrgId(requestedImsOrgId);

    if (!records || records.length === 0) {
      return notFound(`No onboarding records found for IMS org ${requestedImsOrgId}`);
    }

    return ok(records.map(PlgOnboardingDto.toJSON));
  };

  /**
   * Handler for `GET /plg/sites`. Lists rows in the PLG onboardings store (`plg_onboardings`
   * via PostgREST; schema in `@adobe/spacecat-shared-data-access` plg-onboarding.schema.js).
   * Each record is one PLG site onboarding (domain, baseURL, optional SpaceCat siteId).
   * Cross-tenant; restricted to SpaceCat admins.
   *
   * Query `limit` (optional): caps how many rows are returned. When omitted, all pages are
   * loaded until exhaustion (unbounded client-side cap; payload can be very large).
   * @param {object} context - Request context.
   * @returns {Promise<Response>} Array of onboarding DTOs.
   */
  const getAllOnboardings = async (context) => {
    try {
      const accessControlUtil = AccessControlUtil.fromContext(context);
      if (!accessControlUtil.hasAdminAccess()) {
        return forbidden('Only admins can list all PLG onboarding records');
      }

      const rawLimit = context.data?.limit;
      let listOptions;
      if (rawLimit === undefined || rawLimit === null || rawLimit === '') {
        // TODO: implement proper pagination or filtering to stay under AWS Lambda
        // response size limits (6MB). Without `limit`, all pages are loaded into memory before
        // responding (OOM / timeout risk as the table grows).
        listOptions = { fetchAllPages: true };
      } else {
        const limitStr = String(rawLimit).trim();
        if (!/^\d+$/.test(limitStr)) {
          return badRequest('limit must be a positive integer');
        }
        const n = Number.parseInt(limitStr, 10);
        if (n < 1) {
          return badRequest('limit must be a positive integer');
        }
        listOptions = { limit: n };
      }

      const { PlgOnboarding } = context.dataAccess;
      const raw = await PlgOnboarding.all({}, listOptions);
      // Data access returns a single instance when limit === 1, not an array (BaseCollection).
      let records;
      if (Array.isArray(raw)) {
        records = raw;
      } else if (raw === null || raw === undefined) {
        records = [];
      } else if (typeof raw === 'object' && typeof raw.getId === 'function') {
        records = [raw];
      } else {
        log.error(
          `Unexpected PLG onboarding list result shape from data access: ${Object.prototype.toString.call(raw)}`,
        );
        return internalServerError('Failed to list PLG onboarding records');
      }

      let payload;
      try {
        payload = records.map(PlgOnboardingDto.toJSON);
      } catch (serializationError) {
        const serMsg = serializationError instanceof Error
          ? serializationError.message
          : String(serializationError);
        log.error(`Failed to serialize PLG onboarding records: ${serMsg}`, serializationError);
        return internalServerError('Failed to serialize PLG onboarding records');
      }
      return ok(payload);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to list PLG onboardings: ${errMsg}`, error);
      return internalServerError('Failed to list PLG onboarding records');
    }
  };

  /**
   * PATCH /plg/onboard/:onboardingId
   * Admin-only: review a blocked onboarding (BYPASS or UPHOLD).
   * On BYPASS, performs scenario-specific prep and re-runs the PLG flow.
   */
  const update = async (context) => {
    const {
      dataAccess: da, params, data, attributes,
    } = context;

    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can review onboarding records');
    }

    const { onboardingId } = params;
    if (!hasText(onboardingId)) {
      return badRequest('onboardingId is required');
    }

    if (!data || typeof data !== 'object') {
      return badRequest('Request body is required');
    }

    const { decision, justification, siteConfig } = data;

    if (!hasText(decision)
      || !Object.values(REVIEW_DECISIONS).includes(decision)) {
      return badRequest(`decision is required and must be one of: ${Object.values(REVIEW_DECISIONS).join(', ')}`);
    }

    if (!hasText(justification)) {
      return badRequest('justification is required');
    }

    const { PlgOnboarding, Site } = da;
    const onboarding = await PlgOnboarding.findById(onboardingId);

    if (!onboarding) {
      return notFound('Onboarding record not found');
    }

    const status = onboarding.getStatus();
    if (status !== STATUSES.WAITLISTED) {
      return badRequest('Onboarding record is not in a waitlisted state');
    }

    const checkKey = deriveCheckKey(onboarding);
    if (!checkKey) {
      return badRequest('Unable to determine the review reason from the onboarding record');
    }

    /* c8 ignore next */
    const reason = onboarding.getWaitlistReason() || '';

    // Get reviewer identity from auth
    const { authInfo } = attributes;
    /* c8 ignore next */
    const reviewedBy = authInfo?.getProfile()?.email || 'admin';

    // Build review entry
    const reviewEntry = {
      reason,
      decision,
      reviewedBy,
      reviewedAt: new Date().toISOString(),
      justification,
    };

    const existingReviews = onboarding.getReviews() || [];
    const updatedReviews = [...existingReviews, reviewEntry];
    onboarding.setReviews(updatedReviews);

    // UPHOLD: just store the review and return
    if (decision === REVIEW_DECISIONS.UPHELD) {
      await onboarding.save();
      return ok(PlgOnboardingDto.toJSON(onboarding));
    }

    // BYPASS: scenario-specific prep, then re-run the flow
    try {
      switch (checkKey) {
        case REVIEW_REASONS.DOMAIN_ALREADY_ONBOARDED_IN_ORG: {
          // Find and offboard the old onboarded domain
          const imsOrgId = onboarding.getImsOrgId();
          const records = await PlgOnboarding.allByImsOrgId(imsOrgId);
          const oldOnboarded = records.find(
            (r) => r.getDomain() !== onboarding.getDomain()
              && r.getStatus() === STATUSES.ONBOARDED,
          );
          if (oldOnboarded) {
            oldOnboarded.setStatus(STATUSES.INACTIVE);
            // Add offboard review to old record
            const oldReviews = oldOnboarded.getReviews() || [];
            oldOnboarded.setReviews([...oldReviews, {
              reason: `Offboarded to onboard ${onboarding.getDomain()} for same IMS org`,
              decision: REVIEW_DECISIONS.BYPASSED,
              reviewedBy,
              reviewedAt: reviewEntry.reviewedAt,
              justification: `Offboarded to onboard ${onboarding.getDomain()} for same IMS org`,
            }]);
            await oldOnboarded.save();
            log.info(`Offboarded old domain ${oldOnboarded.getDomain()} for IMS org ${imsOrgId}`);
          }
          // Re-run PLG flow for the current domain
          await onboarding.save();
          const result = await performAsoPlgOnboarding(
            { domain: onboarding.getDomain(), imsOrgId },
            context,
          );
          return ok(PlgOnboardingDto.toJSON(result));
        }

        case REVIEW_REASONS.AEM_SITE_CHECK: {
          // Validate siteConfig — rumHost is always required
          if (!siteConfig || !hasText(siteConfig.rumHost)) {
            return badRequest('siteConfig with rumHost is required for AEM_SITE_CHECK bypass');
          }
          if (!AEM_CS_PUBLISH_HOST_PATTERN.test(siteConfig.rumHost)
            && !EDS_HOST_PATTERN.test(siteConfig.rumHost)) {
            return badRequest(
              'rumHost must be a valid AEM CS publish host (publish-pXXX-eYYY.adobeaemcloud.com) '
              + 'or EDS host (ref--repo--owner.aem.live / hlx.live)',
            );
          }

          // Re-run PLG flow with pre-set rumHost
          // Step 5c will derive CS delivery config (authorURL, programId, environmentId)
          // from rumHost if it matches AEM_CS_PUBLISH_HOST_PATTERN
          // Steps 5d/5e will derive EDS config (code config, hlxConfig)
          // from rumHost if it matches EDS_HOST_PATTERN
          await onboarding.save();
          const result = await performAsoPlgOnboarding(
            {
              domain: onboarding.getDomain(),
              imsOrgId: onboarding.getImsOrgId(),
              rumHost: siteConfig.rumHost,
            },
            context,
          );
          return ok(PlgOnboardingDto.toJSON(result));
        }

        case REVIEW_REASONS.DOMAIN_ALREADY_ASSIGNED: {
          // Find the existing org that owns the site
          const domain = onboarding.getDomain();
          const baseURL = onboarding.getBaseURL();
          const site = await Site.findByBaseURL(baseURL);

          if (!site) {
            return badRequest('Site no longer exists for this domain');
          }

          const existingOrgId = site.getOrganizationId();
          // Derive the IMS org ID for the existing org
          const { Organization } = da;
          const existingOrg = await Organization.findById(existingOrgId);
          if (!existingOrg || !existingOrg.getImsOrgId()) {
            return badRequest('Cannot determine IMS org for the existing site owner');
          }

          const existingImsOrgId = existingOrg.getImsOrgId();

          // Offboard the original record (OrgA's) since domain belongs to OrgB
          onboarding.setStatus(STATUSES.INACTIVE);
          await onboarding.save();
          log.info(`Offboarded onboarding ${onboarding.getId()} for domain ${domain} (belongs to org ${existingImsOrgId})`);

          // Check if PLG onboarding already exists for (domain, existingOrg)
          const existingPlgOnboarding = await PlgOnboarding
            .findByImsOrgIdAndDomain(existingImsOrgId, domain);
          if (existingPlgOnboarding) {
            return createResponse(
              { message: 'There is already an onboarding entry for this domain and org' },
              409,
            );
          }

          // Run the flow under the existing org — it will create the PlgOnboarding record
          const result = await performAsoPlgOnboarding(
            { domain, imsOrgId: existingImsOrgId },
            context,
          );
          return ok(PlgOnboardingDto.toJSON(result));
        }

        /* c8 ignore next 2 */
        default:
          return badRequest('Unknown review reason');
      }
    } catch (error) {
      log.error(`PLG onboarding bypass failed for ${onboarding.getId()}: ${error.message}`);

      if (error.conflict) {
        return createResponse({ message: error.message }, 409);
      }
      if (error.clientError) {
        return badRequest(error.message);
      }
      return internalServerError('Onboarding bypass failed. Please try again later.');
    }
  };

  /**
   * POST /plg/records
   * Admin: create a PLG onboarding record with a given status (defaults to INACTIVE).
   * Body: { imsOrgId, domain, status? }
   */
  const createOnboarding = async (context) => {
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create PLG onboarding records');
    }

    const { data } = context;
    const { imsOrgId, domain, status = STATUSES.INACTIVE } = data || {};

    if (!hasText(imsOrgId) || !isValidIMSOrgId(imsOrgId)) {
      return badRequest('Valid imsOrgId is required');
    }
    if (!hasText(domain)) {
      return badRequest('domain is required');
    }
    if (!Object.values(STATUSES).includes(status)) {
      return badRequest(`Invalid status. Must be one of: ${Object.values(STATUSES).join(', ')}`);
    }

    const { PlgOnboarding } = context.dataAccess;

    const existing = await PlgOnboarding.findByImsOrgIdAndDomain(imsOrgId, domain);
    if (existing) {
      return createResponse({ message: `Record already exists for ${imsOrgId} / ${domain}` }, 409);
    }

    const baseURL = composeBaseURL(domain);
    const onboarding = await PlgOnboarding.create({
      imsOrgId, domain, baseURL, status,
    });
    return created(PlgOnboardingDto.toJSON(onboarding));
  };

  /**
   * PATCH /plg/records/:plgOnboardingId
   * Admin: update the status of a PLG onboarding record.
   * Body: { status }
   */
  const updateOnboardingStatus = async (context) => {
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can update PLG onboarding records');
    }

    const { data, params } = context;
    const { plgOnboardingId } = params;
    const { status } = data || {};

    if (!hasText(status) || !Object.values(STATUSES).includes(status)) {
      return badRequest(`Invalid status. Must be one of: ${Object.values(STATUSES).join(', ')}`);
    }

    const { PlgOnboarding } = context.dataAccess;
    const onboarding = await PlgOnboarding.findById(plgOnboardingId);
    if (!onboarding) {
      return notFound(`PLG onboarding record ${plgOnboardingId} not found`);
    }

    onboarding.setStatus(status);
    await onboarding.save();
    return ok(PlgOnboardingDto.toJSON(onboarding));
  };

  /**
   * DELETE /plg/records/:plgOnboardingId
   * Admin: delete a PLG onboarding record.
   */
  const deleteOnboarding = async (context) => {
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can delete PLG onboarding records');
    }

    const { params } = context;
    const { plgOnboardingId } = params;

    const { PlgOnboarding } = context.dataAccess;
    const onboarding = await PlgOnboarding.findById(plgOnboardingId);
    if (!onboarding) {
      return notFound(`PLG onboarding record ${plgOnboardingId} not found`);
    }

    await onboarding.remove();
    return noContent();
  };

  return {
    onboard,
    getStatus,
    getAllOnboardings,
    update,
    createOnboarding,
    updateOnboardingStatus,
    deleteOnboarding,
  };
}

export default PlgOnboardingController;
