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
import { loadProfileConfig, postSlackMessage } from '../../utils/slack/base.js';
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

function parseCommaSeparatedEnvList(value) {
  return (value || '').split(',').map((id) => id.trim()).filter(Boolean);
}

function isInternalOrg(orgId, env) {
  return parseCommaSeparatedEnvList(env.ASO_PLG_EXCLUDED_ORGS).includes(orgId);
}

/**
 * Site IDs that must not use the internal-org waitlist bypass, even when the site lives in an
 * org listed in ASO_PLG_EXCLUDED_ORGS (e.g. customer demo sites in a shared internal org).
 * Comma-separated UUIDs in env ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS.
 */
function isInternalOrgDemoSite(siteId, env) {
  return parseCommaSeparatedEnvList(env.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS).includes(siteId);
}

// EDS host pattern: ref--repo--owner.aem.live (or hlx.live)
const EDS_HOST_PATTERN = /^([\w-]+)--([\w-]+)--([\w-]+)\.(aem\.live|hlx\.live)$/i;

const PLG_STATUS_NOTIFICATION_CONFIG = {
  [STATUSES.ONBOARDED]: { emoji: ':white_check_mark:', label: 'Onboarded' },
  [STATUSES.WAITLISTED]: { emoji: ':warning:', label: 'Waitlisted' },
  [STATUSES.WAITING_FOR_IP_ALLOWLISTING]: { emoji: ':warning:', label: 'Waiting for IP Allowlisting' },
  [STATUSES.ERROR]: { emoji: ':red_circle:', label: 'Error' },
  [STATUSES.INACTIVE]: { emoji: ':zzz:', label: 'Inactive' },
};

/**
 * Posts a PLG onboarding status notification to the configured ESE Slack channel.
 * Fires on terminal/actionable status transitions. Fails gracefully.
 * @param {object} onboarding - The PlgOnboarding record after save.
 * @param {object} context - The request context containing env and log.
 * @returns {Promise<void>}
 */
async function postPlgOnboardingNotification(onboarding, context) {
  const { env, log } = context;
  const channelId = env.SLACK_PLG_ONBOARDING_CHANNEL_ID;
  const token = env.SLACK_BOT_TOKEN;

  if (!channelId || !token) {
    return;
  }

  const status = onboarding.getStatus();
  const config = PLG_STATUS_NOTIFICATION_CONFIG[status];
  /* c8 ignore next 3 */
  if (!config) {
    return;
  }

  const domain = onboarding.getDomain();
  const imsOrgId = onboarding.getImsOrgId();
  const siteId = onboarding.getSiteId();
  const organizationId = onboarding.getOrganizationId();

  let orgName = null;
  if (organizationId) {
    try {
      const org = await context.dataAccess.Organization.findById(organizationId);
      orgName = org?.getName?.() || null;
    } catch (orgLookupError) {
      log.warn(`Failed to look up org name for onboarding notification: ${orgLookupError.message}`);
    }
  }

  let message = `${config.emoji} *PLG Onboarding — ${config.label}*\n\n`
    + `• *Domain:* \`${domain}\`\n`
    + `• *IMS Org:* \`${imsOrgId}\``;

  if (orgName) {
    message += `\n• *Org Name:* ${orgName}`;
  }
  if (organizationId) {
    message += `\n• *Org ID:* \`${organizationId}\``;
  }
  if (siteId) {
    message += `\n• *Site ID:* \`${siteId}\``;
  }

  if ([STATUSES.WAITLISTED, STATUSES.WAITING_FOR_IP_ALLOWLISTING].includes(status)) {
    const waitlistReason = onboarding.getWaitlistReason();
    if (waitlistReason) {
      message += `\n• *Reason:* ${waitlistReason}`;
    }

    const botBlocker = onboarding.getBotBlocker();
    if (botBlocker?.type) {
      message += `\n• *Bot Blocker:* ${botBlocker.type}`;
      if (botBlocker.ipsToAllowlist?.length) {
        message += ` (IPs to allowlist: ${botBlocker.ipsToAllowlist.join(', ')})`;
      }
    }
  }

  const error = onboarding.getError();
  if (error?.message) {
    message += `\n• *Error:* ${error.message}`;
  }

  try {
    await postSlackMessage(channelId, message, token);
  } catch (slackError) {
    log.error(`Failed to post PLG onboarding notification to Slack: ${slackError.message}`);
  }
}

// AEM CS author URL pattern: https://author-p{programId}-e{environmentId}[-suffix].adobeaemcloud.com
const AEM_CS_AUTHOR_URL_PATTERN = /^https?:\/\/author-p(\d+)-e(\d+)(?:-[^.]+)?\.adobeaemcloud\.(?:com|net)/i;

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

function getReviewerIdentity(context) {
  const authInfo = context.attributes?.authInfo;
  const profile = authInfo?.getProfile?.() ?? authInfo?.profile;
  return hasText(profile?.email) ? profile.email : 'admin';
}

/**
 * Assigns a site to the given organization and persists. After save, if the in-memory getter
 * does not reflect the new value (observed drift where save() reassignment did not surface to
 * the next read), logs a loud warning and re-applies on the in-memory instance so downstream
 * reads on the same request see the intended value.
 * @param {object} site - The site to reassign.
 * @param {string} organizationId - Target org id.
 * @param {object} log - Logger.
 */
async function reassignSiteOrganization(site, organizationId, log) {
  site.setOrganizationId(organizationId);
  await site.save();
  if (site.getOrganizationId() !== organizationId) {
    log.warn(`Site ${site.getId()} org drift after save: in-memory ${site.getOrganizationId()}, expected ${organizationId}. Re-applying on instance.`);
    site.setOrganizationId(organizationId);
  }
}

async function ensureAsoEntitlement(site, organization, context) {
  const { log } = context;
  // Ground truth for the entitlement is the customer org resolved from the request's imsOrgId,
  // not whatever the site currently reports. If the two disagree, realign the in-memory site
  // so TierClient.createForSite resolves to the correct (customer) org. Guards against the
  // case where an earlier site.save() reassignment did not surface to the next read.
  const expectedOrgId = organization.getId();
  if (site.getOrganizationId() !== expectedOrgId) {
    log.warn(`Site ${site.getId()} org drift before ASO entitlement: in-memory ${site.getOrganizationId()}, expected ${expectedOrgId}. Realigning.`);
    site.setOrganizationId(expectedOrgId);
  }
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
 * Disables the summit-plg config handler for a given site. Non-fatal.
 * @param {object} site - The site to disable the handler for.
 * @param {object} context - Request context.
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

/**
 * Revokes all ASO site enrollments for the site linked to a given onboarding record.
 * Called when transitioning an ONBOARDED domain to WAITLISTED.
 * @param {object} onboarding - The PlgOnboarding record being offboarded.
 * @param {object} context - Request context.
 */
async function revokeAsoSiteEnrollments(onboarding, context) {
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
 *
 * @param {object} newSite - The newly onboarded site (kept active).
 * @param {object} organization - The customer organization resolved from imsOrgId (ground truth).
 * @param {object} entitlement - The ASO entitlement returned by ensureAsoEntitlement.
 * @param {object} context - Request context.
 */
async function revokePreviousAsoEnrollmentsForOrg(newSite, organization, entitlement, context) {
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
 *
 * Takes the target organization explicitly (resolved upstream from the request's imsOrgId)
 * rather than re-deriving it from site.getOrganizationId(). An earlier production incident
 * flipped flags under the wrong IMS org id because the in-memory site still reported its
 * pre-reassignment (internal) org after save.
 * @param {object} site - The onboarded site.
 * @param {object} organization - The target customer organization.
 * @param {object} context - Request context.
 */
async function updateLaunchDarklyFlags(site, organization, context) {
  const { log, env } = context;

  const apiToken = env[LD_API_TOKEN_ENV_VAR];
  if (!apiToken) {
    log.warn(`Cannot update LaunchDarkly flags: ${LD_API_TOKEN_ENV_VAR} is not set`);
    return;
  }

  const ldClient = new LaunchDarklyClient({ apiToken }, log);

  const imsOrgId = organization?.getImsOrgId?.();

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

// The PLG opportunity types that are relevant for the displacement check.
// Must stay in sync with LD_AUTO_FIX_FLAGS above, which enables auto-fix for the same types.
const PLG_OPPORTUNITY_TYPES = ['cwv', 'alt-text', 'broken-backlinks'];

/**
 * Returns true if the given site has suggestions that should block displacement.
 * Blocks displacement if any PLG opportunity (cwv, alt-text, broken-backlinks) has
 * suggestions in any status except PENDING_VALIDATION or OUTDATED — meaning the customer
 * has engaged with the suggestions (NEW, IN_PROGRESS, FIXED, SKIPPED, etc.).
 * Returns true (conservative) on any lookup failure so we never accidentally displace
 * a site that may still have active work.
 * @param {string} siteId - The site ID to check.
 * @param {object} dataAccess - Data access layer.
 * @param {object} log - Logger.
 * @returns {Promise<boolean>}
 */
async function hasActiveSuggestions(siteId, dataAccess, log) {
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

    // Block displacement if any PLG opportunity has suggestions the customer engaged with.
    // PENDING_VALIDATION and OUTDATED are excluded — they indicate stale/unconfirmed work.
    const IGNORED_STATUSES = new Set(['PENDING_VALIDATION', 'OUTDATED']);
    return suggestionLists.some(
      (suggestions) => suggestions.some(
        (s) => !IGNORED_STATUSES.has(s.getStatus()),
      ),
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
 * @param {string} [params.presetDeliveryType] - Delivery type override for AEM_SITE_CHECK bypass
 * @param {string} [params.presetAuthorUrl] - Optional author URL override for AEM CS / AMS / EDS
 * @param {string} [params.presetProgramId] - Optional Cloud Manager program id (AEM_AMS bypass)
 * @param {object} context - The request context
 * @returns {Promise<object>} PlgOnboarding record
 */
async function performAsoPlgOnboarding({
  domain, imsOrgId, presetDeliveryType, presetAuthorUrl, presetProgramId, updatedBy,
}, context) {
  const { dataAccess, env, log } = context;
  const {
    Site, PlgOnboarding, Organization,
  } = dataAccess;

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
  if (onboarding?.getStatus() === STATUSES.ONBOARDED) {
    log.info(`Domain ${domain} is already onboarded for IMS org ${imsOrgId}, returning existing record`);
    return onboarding;
  }
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
      if (onboarding.getStatus() === STATUSES.ONBOARDED) {
        log.info(`Domain ${domain} was onboarded concurrently for IMS org ${imsOrgId}, returning existing record`);
        return onboarding;
      }
      log.info(`Concurrent create detected, resuming PlgOnboarding record ${onboarding.getId()}`);
    }
  }
  // Guard: only one domain per IMS org can be onboarded
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
    if (!alreadyOnboardedSiteId) {
      log.info(`IMS org ${imsOrgId}: onboarded domain ${alreadyOnboarded.getDomain()} has no siteId, skipping displacement and waitlisting ${domain}`);
    }
    const canDisplace = alreadyOnboardedSiteId
      && !(await hasActiveSuggestions(alreadyOnboardedSiteId, dataAccess, log));

    if (canDisplace) {
      log.info(`IMS org ${imsOrgId}: displacing domain ${alreadyOnboarded.getDomain()} (site ${alreadyOnboardedSiteId}) for new domain ${domain}`);
      alreadyOnboarded.setStatus(STATUSES.WAITLISTED);
      alreadyOnboarded.setWaitlistReason(`Domain ${alreadyOnboarded.getDomain()} was replaced by ${domain} — it had no active suggestions and a new domain '${domain}' started onboarding for current org.`);
      await alreadyOnboarded.save();
      await postPlgOnboardingNotification(alreadyOnboarded, context);
      // NOTE: the underlying Site record is intentionally left unchanged. The Site model does
      // not carry PLG lifecycle state — PlgOnboarding is the sole source of truth for whether
      // a domain is actively enrolled in PLG. Audit scheduling and other downstream systems
      // should gate on PlgOnboarding status, not the Site record directly.

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
            log.warn(`No ASO entitlement found for org ${oldOrgId}, nothing to revoke`);
          }
        } catch (revokeError) {
          log.error(`Failed to revoke ASO enrollment for displaced site ${alreadyOnboardedSiteId}: ${revokeError.message}`);
        }
      } else {
        log.warn(`Cannot revoke ASO enrollment for displaced site ${alreadyOnboardedSiteId}: no org ID on onboarding record`);
      }
      try {
        const displacedSite = await Site.findById(alreadyOnboardedSiteId);
        if (displacedSite) {
          await disableSummitPlgHandler(displacedSite, context);
        }
      } catch (disableError) {
        log.warn(`Failed to disable summit-plg for displaced site ${alreadyOnboardedSiteId}: ${disableError.message}`);
      }
      // Fall through to continue onboarding the new domain
    } else {
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
      if (updatedBy) {
        onboarding.setUpdatedBy(updatedBy);
      }
      await onboarding.save();
      await postPlgOnboardingNotification(onboarding, context);
      return onboarding;
    }
  }

  // Fast path: preonboarded sites just need enrollment + ONBOARDED
  if (onboarding.getStatus() === STATUSES.PRE_ONBOARDING && onboarding.getSiteId()) {
    log.info(`Fast-tracking preonboarded record ${onboarding.getId()}`);
    const site = await Site.findById(onboarding.getSiteId());
    if (site) {
      // Resolve customer's organization from imsOrgId
      const organization = await createOrFindOrganization(imsOrgId, context);
      const customerOrgId = organization.getId();
      // Anchor the onboarding record to the resolved customer org up-front, regardless of
      // whether the site itself needs to be reassigned. Preonboarding records created earlier
      // may carry a stale organizationId (e.g. the internal/demo org used during preonboard),
      // and downstream consumers (notifications, displacement scoping) read it directly.
      onboarding.setOrganizationId(customerOrgId);

      // Check if site needs to be moved from internal org to customer org
      const currentSiteOrgId = site.getOrganizationId();
      let needsOrgReassignment = false;

      // Note: On retry, currentSiteOrgId may already equal customerOrgId if a previous
      // attempt successfully saved the org reassignment but failed during entitlement creation
      if (currentSiteOrgId !== customerOrgId) {
        if (isInternalOrg(currentSiteOrgId, env) && !isInternalOrgDemoSite(site.getId(), env)) {
          log.info(`Preonboarded site ${site.getId()} is in internal org ${currentSiteOrgId}, will reassign to customer org ${customerOrgId}`);
          needsOrgReassignment = true;
        } else {
          // Site is in different customer org - cannot reassign, must waitlist
          const existingOrg = await Organization.findById(currentSiteOrgId);
          /* c8 ignore next */
          const existingImsOrgId = existingOrg?.getImsOrgId?.() || currentSiteOrgId;
          /* c8 ignore next */
          const existingOrgName = existingOrg?.getName?.() || currentSiteOrgId;
          const customerOrgName = organization.getName();
          const waitlistReason = `Preonboarded site is assigned to different organization (org: ${existingOrgName}, id: ${existingImsOrgId}). Cannot be moved to '${customerOrgName}'.`;

          log.warn(`Preonboarded site ${site.getId()} is in different customer org ${currentSiteOrgId}, expected ${customerOrgId} - waitlisting`);

          onboarding.setStatus(STATUSES.WAITLISTED);
          onboarding.setWaitlistReason(waitlistReason);
          const steps = { ...(onboarding.getSteps() || {}), orgResolutionFailed: true };
          onboarding.setSteps(steps);
          if (updatedBy) {
            onboarding.setUpdatedBy(updatedBy);
          }
          await onboarding.save();
          await postPlgOnboardingNotification(onboarding, context);
          return onboarding;
        }
      }

      // Reassign site org if needed BEFORE entitlement operations.
      // This ensures ensureAsoEntitlement gets the correct customer org's entitlement.
      // The onboarding record's organizationId was already anchored above.
      if (needsOrgReassignment) {
        await reassignSiteOrganization(site, customerOrgId, log);
        log.info(`Reassigned preonboarded site ${site.getId()} from internal org to customer org ${customerOrgId}`);
      }

      const { entitlement } = await ensureAsoEntitlement(site, organization, context);
      await revokePreviousAsoEnrollmentsForOrg(site, organization, entitlement, context);
      await updateLaunchDarklyFlags(site, organization, context);

      const steps = {
        ...(onboarding.getSteps() || {}),
        entitlementCreated: true,
      };
      if (needsOrgReassignment) {
        steps.siteOrgReassigned = true;
      }
      onboarding.setStatus(STATUSES.ONBOARDED);
      onboarding.setWaitlistReason(null);
      onboarding.setBotBlocker(null);
      onboarding.setSteps(steps);
      onboarding.setCompletedAt(new Date().toISOString());
      if (updatedBy) {
        onboarding.setUpdatedBy(updatedBy);
      }
      await onboarding.save();
      await postPlgOnboardingNotification(onboarding, context);
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

    // Step 2: AEM verification — domain must be an AEM site (RUM check OR delivery type).
    // Load Site first so existing delivery type informs the check (no duplicate fetch later).
    let site = await Site.findByBaseURL(baseURL);
    const rumApiClient = RUMAPIClient.createFrom(context);
    let cachedDeliveryType = null;
    try {
      await rumApiClient.retrieveDomainkey(domain);
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
        if (updatedBy) {
          onboarding.setUpdatedBy(updatedBy);
        }
        await onboarding.save();
        await postPlgOnboardingNotification(onboarding, context);
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
          // Will reassign at Step 9, before creating entitlements
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
            const currentOrgName = organization.getName();
            waitlistReason += ` This domain has no active products in its existing org '${existingOrgName}'. It can be safely moved to '${currentOrgName}'.`;
          } else {
            const currentOrgName = organization.getName();
            waitlistReason += ` This domain cannot be moved to '${currentOrgName}' — it is already set up with active products in its existing org ('${existingOrgName}').`;
          }
          onboarding.setStatus(STATUSES.WAITLISTED);
          onboarding.setWaitlistReason(waitlistReason);
          onboarding.setSiteId(site.getId());
          onboarding.setSteps(steps);
          if (updatedBy) {
            onboarding.setUpdatedBy(updatedBy);
          }
          await onboarding.save();
          await postPlgOnboardingNotification(onboarding, context);
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
        ipsToAllowlist: botBlockerResult.ipsToAllowlist
          || botBlockerResult.ipsToWhitelist,
        userAgent: botBlockerResult.userAgent,
      };

      onboarding.setStatus(STATUSES.WAITING_FOR_IP_ALLOWLISTING);
      onboarding.setBotBlocker(botBlockerInfo);
      onboarding.setSiteId(site?.getId() || null);
      onboarding.setSteps(steps);
      if (updatedBy) {
        onboarding.setUpdatedBy(updatedBy);
      }
      await onboarding.save();
      await postPlgOnboardingNotification(onboarding, context);

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

    // Step 5c: Set delivery type and author URL
    let rumHost = null;
    if (presetDeliveryType) {
      // AEM_SITE_CHECK bypass: ESE provided delivery type and optional author URL
      /* c8 ignore next */
      const existingDeliveryConfig = site.getDeliveryConfig() || {};
      site.setDeliveryType(presetDeliveryType);

      if (presetDeliveryType === SiteModel.DELIVERY_TYPES.AEM_CS && presetAuthorUrl) {
        // Derive programId and environmentId from AEM CS author URL
        const csMatch = presetAuthorUrl.match(AEM_CS_AUTHOR_URL_PATTERN);
        /* c8 ignore next */
        const [, programId, environmentId] = csMatch || [];
        site.setDeliveryConfig({
          ...existingDeliveryConfig,
          authorURL: presetAuthorUrl,
          ...(programId && {
            programId, environmentId, preferContentApi: true, enableDAMAltTextUpdate: true,
          }),
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
        // Other delivery types: set author URL as-is
        site.setDeliveryConfig({ ...existingDeliveryConfig, authorURL: presetAuthorUrl, imsOrgId });
        log.info(`Set author URL from preset: ${presetAuthorUrl}`);
        steps.authorUrlResolved = true;
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
            enableDAMAltTextUpdate: true,
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

    // Step 9: Reassign site org if it was previously in an internal/demo org
    // This must happen BEFORE entitlement operations to ensure we get the correct org's entitlement
    if (needsOrgReassignment) {
      log.info(`Reassigning site ${site.getId()} to org ${organizationId} (was in internal/demo org)`);
      await reassignSiteOrganization(site, organizationId, log);
      // Update PlgOnboarding's organizationId to match the site's new org
      onboarding.setOrganizationId(organizationId);
      steps.siteOrgReassigned = true;
    }

    // Step 10: Add ASO entitlement, revoke any previous ASO enrollments for this org, update FF.
    // Revocation is guarded by entitlement.organizationId === organization.getId() and an
    // internal-org check, so cross-org mass-revokes are blocked on any resolution drift.
    const { entitlement } = await ensureAsoEntitlement(site, organization, context);
    await revokePreviousAsoEnrollmentsForOrg(site, organization, entitlement, context);
    await updateLaunchDarklyFlags(site, organization, context);

    steps.entitlementCreated = true;

    // Step 11: Trigger audit runs
    await triggerAudits(auditTypes, context, site);

    // Step 12: Trigger brand profile (non-blocking)
    try {
      await triggerBrandProfileAgent({
        context, site, reason: 'plg-onboarding',
      });
    } catch (error) {
      log.warn(`Failed to trigger brand-profile for site ${site.getId()}: ${error.message}`);
    }

    // Mark as completed
    onboarding.setStatus(STATUSES.ONBOARDED);
    onboarding.setWaitlistReason(null);
    onboarding.setBotBlocker(null);
    onboarding.setSteps(steps);
    onboarding.setCompletedAt(new Date().toISOString());
    if (updatedBy) {
      onboarding.setUpdatedBy(updatedBy);
    }
    await onboarding.save();
    await postPlgOnboardingNotification(onboarding, context);

    return onboarding;
  } catch (error) {
    // Persist the error in the onboarding record
    onboarding.setStatus(STATUSES.ERROR);
    onboarding.setSteps(steps);
    onboarding.setError({
      message: (error.clientError || error.conflict)
        ? error.message : 'An internal error occurred',
    });
    if (updatedBy) {
      onboarding.setUpdatedBy(updatedBy);
    }
    try {
      await onboarding.save();
      await postPlgOnboardingNotification(onboarding, context);
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

    const isInternalCall = data.fromBackoffice === true || isAdmin;

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

    const updatedBy = isInternalCall ? null : (authInfo?.getProfile()?.email || 'system');

    try {
      const onboarding = await performAsoPlgOnboarding({ domain, imsOrgId, updatedBy }, context);
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

      // Resolve updatedBy IMS IDs to emails for the response
      // eslint-disable-next-line no-warning-comments
      // TODO: Create a GET /plg/onboard/:onboardingId endpoint for individual record details.
      // This would allow the backoffice UI to:
      // 1. GET /plg/sites - return basic info without IMS resolution (fast list view)
      // 2. GET /plg/onboard/:onboardingId - return full details without resolved emails
      // This would eliminate the N * IMS_CONCURRENCY API calls on every list load and
      // significantly improve performance as the PLG onboarding table grows.
      const { imsClient } = context;
      // Collect all unique IMS IDs from updatedBy and reviewedBy fields
      const imsIds = new Set();
      for (const r of records) {
        const updatedBy = r.getUpdatedBy();
        if (hasText(updatedBy) && updatedBy !== 'system') {
          imsIds.add(updatedBy);
        }
        for (const review of (r.getReviews() || [])) {
          if (hasText(review.reviewedBy) && review.reviewedBy !== 'admin') {
            imsIds.add(review.reviewedBy);
          }
        }
      }
      const emailMap = {};
      const IMS_CONCURRENCY = 10;
      const imsIdList = [...imsIds];
      for (let i = 0; i < imsIdList.length; i += IMS_CONCURRENCY) {
        const batch = imsIdList.slice(i, i + IMS_CONCURRENCY);
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(batch.map(async (imsId) => {
          try {
            const imsProfile = await imsClient.getImsAdminProfile(imsId);
            emailMap[imsId] = imsProfile.email || null;
          } catch (e) {
            log.warn(`Failed to resolve email for IMS ID ${imsId}: ${e.message}`);
            emailMap[imsId] = null;
          }
        }));
      }

      let payload;
      try {
        payload = records.map((record) => {
          const json = PlgOnboardingDto.toAdminJSON(record);
          const updatedBy = record.getUpdatedBy();
          return {
            ...json,
            updatedBy: updatedBy ? (emailMap[updatedBy] ?? updatedBy) : null,
            reviews: json.reviews.map((review) => ({
              ...review,
              reviewedBy: emailMap[review.reviewedBy] ?? review.reviewedBy,
            })),
          };
        });
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
   * Admin-only: review a waitlisted onboarding (BYPASS or UPHOLD), or record a review on an
   * ONBOARDED record and transition it to WAITLISTED (revokes ASO site enrollments when linked).
   * On BYPASS for WAITLISTED, performs scenario-specific prep and re-runs the PLG flow.
   */
  const update = async (context) => {
    const {
      dataAccess: da, params, data,
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
    if (status !== STATUSES.WAITLISTED && status !== STATUSES.ONBOARDED) {
      return badRequest('Onboarding record must be in WAITLISTED or ONBOARDED state');
    }

    /* c8 ignore next */
    const reason = onboarding.getWaitlistReason() || '';

    // Get reviewer identity from auth
    const reviewedBy = getReviewerIdentity(context);

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

    // ONBOARDED: revoke ASO enrollments, mark WAITLISTED, persist review (no bypass / re-run)
    if (status === STATUSES.ONBOARDED) {
      try {
        await revokeAsoSiteEnrollments(onboarding, context);
        onboarding.setStatus(STATUSES.WAITLISTED);
        onboarding.setWaitlistReason(justification);
        await onboarding.save();
        await postPlgOnboardingNotification(onboarding, context);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          `Failed to waitlist onboarded PLG domain ${onboarding.getDomain()}: ${msg}`,
          err,
        );
        return internalServerError('Failed to waitlist onboarding. Please try again later.');
      }
      return ok(PlgOnboardingDto.toAdminJSON(onboarding));
    }

    const checkKey = deriveCheckKey(onboarding);
    if (!checkKey) {
      return badRequest('Unable to determine the review reason from the onboarding record');
    }

    // UPHOLD: just store the review and return
    if (decision === REVIEW_DECISIONS.UPHELD) {
      await onboarding.save();
      return ok(PlgOnboardingDto.toAdminJSON(onboarding));
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
            oldOnboarded.setStatus(STATUSES.WAITLISTED);
            oldOnboarded.setWaitlistReason(`Domain ${oldOnboarded.getDomain()} was displaced by ${onboarding.getDomain()} for IMS org ${imsOrgId}.`);
            // Add offboard review to old record
            const oldReviews = oldOnboarded.getReviews() || [];
            oldOnboarded.setReviews([...oldReviews, {
              reason: `Offboarded to onboard ${onboarding.getDomain()} for same IMS org`,
              decision: REVIEW_DECISIONS.BYPASSED,
              reviewedBy,
              reviewedAt: reviewEntry.reviewedAt,
              justification: 'System action to start onboarding for new domain in the same IMS org.',
            }]);
            await oldOnboarded.save();
            await postPlgOnboardingNotification(oldOnboarded, context);
            try {
              await revokeAsoSiteEnrollments(oldOnboarded, context);
            } catch (revokeErr) {
              log.warn(`Failed to revoke enrollments for offboarded domain ${oldOnboarded.getDomain()}: ${revokeErr.message}`);
            }
            log.info(`Offboarded old domain ${oldOnboarded.getDomain()} for IMS org ${imsOrgId}`);
          }
          // Re-run PLG flow for the current domain
          await onboarding.save();
          const result = await performAsoPlgOnboarding(
            { domain: onboarding.getDomain(), imsOrgId },
            context,
          );
          return ok(PlgOnboardingDto.toAdminJSON(result));
        }

        case REVIEW_REASONS.AEM_SITE_CHECK: {
          // deliveryType is required; authorUrl is optional
          if (!siteConfig || !hasText(siteConfig.deliveryType)) {
            return badRequest('siteConfig with deliveryType is required for AEM_SITE_CHECK bypass');
          }
          const validDeliveryTypes = Object.values(SiteModel.DELIVERY_TYPES)
            .filter((t) => t !== SiteModel.DELIVERY_TYPES.OTHER);
          if (!validDeliveryTypes.includes(siteConfig.deliveryType)) {
            return badRequest(
              `deliveryType must be one of: ${validDeliveryTypes.join(', ')}`,
            );
          }
          if (hasText(siteConfig.authorUrl)) {
            if (siteConfig.deliveryType === SiteModel.DELIVERY_TYPES.AEM_CS) {
              if (!/^https?:\/\//i.test(siteConfig.authorUrl)) {
                siteConfig.authorUrl = `https://${siteConfig.authorUrl}`;
              }
              if (!AEM_CS_AUTHOR_URL_PATTERN.test(siteConfig.authorUrl)) {
                return badRequest(
                  'authorUrl for AEM_CS must match the pattern: https://author-pXXX-eYYY.adobeaemcloud.com',
                );
              }
            } else if (siteConfig.deliveryType === SiteModel.DELIVERY_TYPES.AEM_EDGE) {
              const hostname = siteConfig.authorUrl.replace(/^https?:\/\//i, '').split('/')[0];
              if (!EDS_HOST_PATTERN.test(hostname)) {
                return badRequest(
                  'authorUrl for AEM_EDGE must be a valid EDS host (ref--repo--owner.aem.live or hlx.live)',
                );
              }
              siteConfig.authorUrl = hostname;
            } else if (!/^https?:\/\//i.test(siteConfig.authorUrl)) {
              return badRequest('authorUrl must be a valid HTTP(S) URL');
            }
          }

          // Re-run PLG flow with pre-set delivery type and optional author URL
          await onboarding.save();
          const result = await performAsoPlgOnboarding(
            {
              domain: onboarding.getDomain(),
              imsOrgId: onboarding.getImsOrgId(),
              presetDeliveryType: siteConfig.deliveryType,
              /* c8 ignore next */
              presetAuthorUrl: siteConfig.authorUrl || null,
              presetProgramId: siteConfig.programId ?? null,
            },
            context,
          );
          return ok(PlgOnboardingDto.toAdminJSON(result));
        }

        case REVIEW_REASONS.DOMAIN_ALREADY_ASSIGNED: {
          const domain = onboarding.getDomain();
          const baseURL = onboarding.getBaseURL();
          const site = await Site.findByBaseURL(baseURL);

          if (!site) {
            return badRequest('Site no longer exists for this domain');
          }

          const existingOrgId = site.getOrganizationId();
          const { Organization } = da;

          // Handle alternateDomain: retire current domain, onboard a new domain under current org
          if (hasText(siteConfig?.alternateDomain)) {
            if (!isSafeDomain(siteConfig.alternateDomain)) {
              return badRequest(`Invalid alternate domain: ${siteConfig.alternateDomain}`);
            }
            onboarding.setStatus(STATUSES.WAITLISTED);
            onboarding.setWaitlistReason(`Domain ${domain} was replaced by alternate domain ${siteConfig.alternateDomain}.`);
            await onboarding.save();
            await postPlgOnboardingNotification(onboarding, context);
            log.info(`Retiring domain ${domain}, starting onboarding for alternate domain ${siteConfig.alternateDomain}`);
            const result = await performAsoPlgOnboarding(
              {
                domain: siteConfig.alternateDomain,
                imsOrgId: onboarding.getImsOrgId(),
              },
              context,
            );
            return ok(PlgOnboardingDto.toAdminJSON(result));
          }

          // Handle moveSite: transfer site from existing org to current org
          if (siteConfig?.moveSite) {
            const siteEnrollments = await site.getSiteEnrollments();
            if (siteEnrollments && siteEnrollments.length > 0) {
              const existingOrg = await Organization.findById(existingOrgId);
              /* c8 ignore next */
              return badRequest(`Cannot move domain ${domain} — it is already set up with active products in org '${existingOrg?.getName?.() || existingOrgId}'.`);
            }
            const currentOrgId = onboarding.getOrganizationId();
            if (!currentOrgId) {
              return badRequest('Onboarding record has no associated organization');
            }
            const currentImsOrgId = onboarding.getImsOrgId();
            /* c8 ignore next */
            const existingDeliveryConfig = site.getDeliveryConfig() || {};
            if (existingDeliveryConfig.imsOrgId) {
              site.setDeliveryConfig({ ...existingDeliveryConfig, imsOrgId: currentImsOrgId });
            }
            await reassignSiteOrganization(site, currentOrgId, log);
            log.info(`Moved site ${site.getId()} from org ${existingOrgId} to org ${currentOrgId}`);
            // Persist BYPASS review before performAsoPlgOnboarding; it reloads the row from DB.
            await onboarding.save();
            const result = await performAsoPlgOnboarding(
              { domain, imsOrgId: onboarding.getImsOrgId() },
              context,
            );
            return ok(PlgOnboardingDto.toAdminJSON(result));
          }

          return badRequest(
            'siteConfig.moveSite or siteConfig.alternateDomain is required for DOMAIN_ALREADY_ASSIGNED bypass',
          );
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
   * Body: { imsOrgId, domain, status?, siteId?, organizationId?, steps?,
   *         botBlocker?, completedAt? }
   */
  const createOnboarding = async (context) => {
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create PLG onboarding records');
    }

    const { data } = context;
    const {
      imsOrgId,
      domain,
      status = STATUSES.INACTIVE,
      siteId,
      organizationId,
      steps,
      botBlocker,
      completedAt,
    } = data || {};

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

    // Set optional preonboarding fields if provided
    if (siteId) {
      onboarding.setSiteId(siteId);
    }
    if (organizationId) {
      onboarding.setOrganizationId(organizationId);
    }
    if (steps && typeof steps === 'object') {
      onboarding.setSteps(steps);
    }
    if (botBlocker && typeof botBlocker === 'object') {
      onboarding.setBotBlocker(botBlocker);
    }
    if (completedAt) {
      onboarding.setCompletedAt(completedAt);
    }

    await onboarding.save();
    return created(PlgOnboardingDto.toAdminJSON(onboarding));
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
    return ok(PlgOnboardingDto.toAdminJSON(onboarding));
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
