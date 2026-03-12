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

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';
import PlgOnboardingModel from '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js';
import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';
import TierClient from '@adobe/spacecat-shared-tier-client';
import {
  badRequest, createResponse, forbidden, internalServerError, notFound, ok,
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
  ASO_DEMO_ORG,
} from '../llmo/llmo-onboarding.js';
import { findDeliveryType, deriveProjectName } from '../../support/utils.js';
import { loadProfileConfig } from '../../utils/slack/base.js';
import { triggerBrandProfileAgent } from '../../support/brand-profile-trigger.js';
import { PlgOnboardingDto } from '../../dto/plg-onboarding.js';

const { STATUSES } = PlgOnboardingModel;
const ASO_PRODUCT_CODE = EntitlementModel.PRODUCT_CODES.ASO;
const ASO_TIER = EntitlementModel.TIERS.FREE_TRIAL;
const PLG_PROFILE_KEY = 'aso_plg';

const DOMAIN_ALREADY_ASSIGNED = 'already assigned to another organization';

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

function isInternalOrg(orgId, env) {
  return orgId === env.DEFAULT_ORGANIZATION_ID || orgId === ASO_DEMO_ORG;
}

async function ensureAsoEntitlement(site, context) {
  const { log } = context;
  try {
    const tierClient = await TierClient.createForSite(context, site, ASO_PRODUCT_CODE);
    const { entitlement, siteEnrollment } = await tierClient
      .createEntitlement(ASO_TIER);
    log.info(`Created ASO entitlement ${entitlement.getId()} and enrollment ${siteEnrollment.getId()} for site ${site.getId()}`);
    return { entitlement, siteEnrollment };
  } catch (error) {
    if (error.message?.includes('already exists')
      || error.message?.includes('Already enrolled')) {
      log.info(`ASO entitlement already exists for site ${site.getId()}`);
      return null;
    }
    throw error;
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
 * @param {object} context - The request context
 * @returns {Promise<object>} PlgOnboarding record
 */
async function performAsoPlgOnboarding({ domain, imsOrgId }, context) {
  const { dataAccess, log, env } = context;
  const { Site, PlgOnboarding } = dataAccess;

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
      if (!onboarding) throw createError;
      log.info(`Concurrent create detected, resuming PlgOnboarding record ${onboarding.getId()}`);
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

    // Step 2: RUM check — gate onboarding if no RUM data
    const rumApiClient = RUMAPIClient.createFrom(context);
    try {
      await rumApiClient.retrieveDomainkey(domain);
      steps.rumVerified = true;
    } catch {
      onboarding.setStatus(STATUSES.WAITLISTED);
      onboarding.setWaitlistReason('No RUM data available for this domain');
      onboarding.setSteps(steps);
      await onboarding.save();
      return onboarding;
    }

    // Step 3: Check site ownership
    let site = await Site.findByBaseURL(baseURL);

    if (site) {
      const existingOrgId = site.getOrganizationId();

      if (existingOrgId !== organizationId
        && !isInternalOrg(existingOrgId, env)) {
        throw Object.assign(
          new Error(`Domain ${domain} is ${DOMAIN_ALREADY_ASSIGNED}`),
          { conflict: true },
        );
      }

      // Move from internal org to customer's org if needed
      if (existingOrgId !== organizationId) {
        site.setOrganizationId(organizationId);
        log.info(`Reassigning site ${site.getId()} from org ${existingOrgId} to ${organizationId}`);
      }
    }

    // Step 4: Bot blocker check
    const botBlockerResult = await detectBotBlocker({ baseUrl: baseURL });
    if (!botBlockerResult.crawlable) {
      if (site) await site.save();

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
      const deliveryType = await findDeliveryType(baseURL);
      site = await Site.create({
        baseURL,
        organizationId,
        ...(deliveryType && { deliveryType }),
      });
      log.info(`Created site ${site.getId()} for ${baseURL}`);
    }
    onboarding.setSiteId(site.getId());
    steps.siteCreated = true;
    steps.siteResolved = true;

    // Step 6: Update configs
    const siteConfig = site.getConfig();

    // Enable imports from PLG profile
    const importDefs = Object.keys(profile.imports || {})
      .map((type) => ({ type }));
    await enableImports(siteConfig, importDefs, log);

    // Resolve canonical URL for overrideBaseURL
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
        if (!site.getLanguage()) site.setLanguage('en');
        if (!site.getRegion()) site.setRegion('US');
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

    // Step 7: Enable audits from PLG profile
    const auditTypes = Object.keys(profile.audits || {});
    await enableAudits(site, context, auditTypes);
    steps.auditsEnabled = true;

    // Step 8: Add ASO entitlement
    await ensureAsoEntitlement(site, context);
    steps.entitlementCreated = true;

    // Step 9: Trigger audit runs
    await triggerAudits(auditTypes, context, site);

    // Step 10: Trigger brand profile (non-blocking)
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
 * @returns {object} Controller with onboard and getStatus methods.
 */
function PlgOnboardingController(ctx) {
  const { log } = ctx;

  const onboard = async (context) => {
    const { data, attributes } = context;

    if (!data || typeof data !== 'object') {
      return badRequest('Request body is required');
    }

    const { domain } = data;

    if (!hasText(domain)) {
      return badRequest('domain is required');
    }

    const { authInfo } = attributes;

    if (!authInfo) {
      return badRequest('Authentication information is required');
    }

    const profile = authInfo.getProfile();

    if (!profile || !profile.tenants?.[0]?.id) {
      return badRequest('User profile or organization ID not found in authentication token');
    }

    const imsOrgId = `${profile.tenants[0].id}@AdobeOrg`;

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

    const profile = authInfo.getProfile();

    if (!profile || !profile.tenants?.[0]?.id) {
      return badRequest('User profile or organization ID not found in authentication token');
    }

    const callerImsOrgId = `${profile.tenants[0].id}@AdobeOrg`;
    if (callerImsOrgId !== requestedImsOrgId) {
      return forbidden('Not authorized for this IMS org');
    }

    const { PlgOnboarding } = da;
    const records = await PlgOnboarding.allByImsOrgId(requestedImsOrgId);

    if (!records || records.length === 0) {
      return notFound(`No onboarding records found for IMS org ${requestedImsOrgId}`);
    }

    return ok(records.map(PlgOnboardingDto.toJSON));
  };

  return { onboard, getStatus };
}

export default PlgOnboardingController;
