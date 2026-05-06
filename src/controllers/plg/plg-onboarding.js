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

import {
  badRequest, createResponse, created, forbidden, internalServerError, noContent, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  composeBaseURL,
  detectBotBlocker,
  detectLocale,
  hasText,
  isValidIMSOrgId,
  isValidUUID,
  resolveCanonicalUrl,
} from '@adobe/spacecat-shared-utils';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';
import TierClient from '@adobe/spacecat-shared-tier-client';
import LaunchDarklyClient from '@adobe/spacecat-shared-launchdarkly-client';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';

import { PlgOnboardingDto } from '../../dto/plg-onboarding.js';
import AccessControlUtil from '../../support/access-control-util.js';
import {
  createOrFindOrganization,
  enableAudits,
  enableImports,
  triggerAudits,
} from '../llmo/llmo-onboarding.js';
import {
  autoResolveAuthorUrl,
  deriveProjectName,
  findDeliveryType,
  queueDeliveryConfigWriter,
  resolveWwwUrl,
  updateCodeConfig,
} from '../../support/utils.js';
import { loadProfileConfig, postSlackMessage } from '../../utils/slack/base.js';
import { triggerBrandProfileAgent } from '../../support/brand-profile-trigger.js';
import { ASO_PRODUCT_CODE, STATUSES, REVIEW_DECISIONS } from './plg-onboarding/constants.js';
import { isValidHostname } from './plg-onboarding/validation.js';
import { performAsoPlgOnboarding } from './plg-onboarding/onboarding-flow.js';
import { revokeAsoSiteEnrollments } from './plg-onboarding/entitlement.js';
import {
  deriveCheckKey,
  REVIEW_REASONS,
  postPlgOnboardingNotification,
} from './plg-onboarding/notifications.js';
import {
  bypassDisplaceOnboarded,
  bypassAemSiteCheck,
  bypassDomainAlreadyAssigned,
} from './plg-onboarding/bypass-handlers.js';
import { getReviewerIdentity, isInternalOrg } from './plg-onboarding/internal-org.js';

function withFlowDeps(context) {
  // Keep request-context identity while giving extracted helpers the monolith's deps.
  Object.assign(context, {
    badRequest,
    ok,
    Config,
    RUMAPIClient,
    TierClient,
    LaunchDarklyClient,
    composeBaseURL,
    detectBotBlocker,
    detectLocale,
    resolveCanonicalUrl,
    createOrFindOrganization,
    enableAudits,
    enableImports,
    triggerAudits,
    autoResolveAuthorUrl,
    deriveProjectName,
    findDeliveryType,
    resolveWwwUrl,
    updateCodeConfig,
    queueDeliveryConfigWriter,
    loadProfileConfig,
    postSlackMessage,
    triggerBrandProfileAgent,
  });
  return context;
}

// ---------- GET /plg/sites helpers ----------

/**
 * Parses + validates the optional `limit` query parameter for `getAllOnboardings`.
 * Returns either `{ options }` for the data-access layer or `{ error }` on a bad input.
 *
 * NOTE: when limit is omitted the data-access layer fetches all pages — there is no
 * server-side cap. This is OOM/timeout territory once the table grows and is flagged
 * as a known gap by the surrounding TODOs (proper pagination + per-record endpoint).
 */
function parsePlgListLimit(rawLimit) {
  if (rawLimit === undefined || rawLimit === null || rawLimit === '') {
    return { options: { fetchAllPages: true } };
  }
  const limitStr = String(rawLimit).trim();
  if (!/^\d+$/.test(limitStr)) {
    return { error: 'limit must be a positive integer' };
  }
  const n = Number.parseInt(limitStr, 10);
  if (n < 1) {
    return { error: 'limit must be a positive integer' };
  }
  return { options: { limit: n } };
}

/**
 * Coerces the BaseCollection result of `PlgOnboarding.all` into an array.
 * Data access returns a single instance when limit === 1, so we have to handle the
 * array / single-instance / null shapes explicitly. Returns null on an unexpected shape
 * (caller maps to internalServerError).
 */
function normalizePlgListResult(raw, log) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (raw === null || raw === undefined) {
    return [];
  }
  if (typeof raw === 'object' && typeof raw.getId === 'function') {
    return [raw];
  }
  log.error(
    `Unexpected PLG onboarding list result shape from data access: ${Object.prototype.toString.call(raw)}`,
  );
  return null;
}

const IMS_RESOLUTION_CONCURRENCY = 10;

/**
 * Builds a `{ imsId → email | null }` map for every IMS ID referenced from `records` in
 * either `updatedBy` (excluding the literal 'system') or any review's `reviewedBy`
 * (excluding the literal 'admin'). Looks up profiles via `context.imsClient` in batches
 * of {@link IMS_RESOLUTION_CONCURRENCY}; lookup failures are logged and stored as null.
 *
 * TODO: Create a GET /plg/onboard/:onboardingId endpoint for individual record details.
 * This would allow the backoffice UI to:
 *   1. GET /plg/sites - return basic info without IMS resolution (fast list view)
 *   2. GET /plg/onboard/:onboardingId - return full details with resolved emails
 */
async function resolveImsEmailsForPlgRecords(records, context) {
  const { imsClient, log } = context;

  const imsIds = new Set();
  for (const r of records) {
    const updatedBy = r.getUpdatedBy();
    if (hasText(updatedBy) && updatedBy !== 'system') {
      imsIds.add(updatedBy);
    }
    const createdBy = r.getCreatedBy();
    if (hasText(createdBy) && createdBy !== 'system') {
      imsIds.add(createdBy);
    }
    for (const review of (r.getReviews() || [])) {
      if (hasText(review.reviewedBy) && review.reviewedBy !== 'admin') {
        imsIds.add(review.reviewedBy);
      }
    }
  }

  const emailMap = {};
  const imsIdList = [...imsIds];
  for (let i = 0; i < imsIdList.length; i += IMS_RESOLUTION_CONCURRENCY) {
    const batch = imsIdList.slice(i, i + IMS_RESOLUTION_CONCURRENCY);
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
  return emailMap;
}

// ---------- Controller ----------

const PLG_REJECTION_MESSAGES = {
  'internal-org': { emoji: ':no_entry:', label: 'Rejected — Internal Org' },
  'paid-customer': { emoji: ':no_entry:', label: 'Rejected — Paid Customer' },
};

async function postPlgRejectionNotification(domain, imsOrgId, reason, context) {
  const { env, log } = context;
  const channelId = env.SLACK_PLG_ONBOARDING_CHANNEL_ID;
  const token = env.SLACK_BOT_TOKEN;
  if (!channelId || !token) {
    return;
  }

  const config = PLG_REJECTION_MESSAGES[reason];
  /* c8 ignore next 4 */
  if (!config) {
    log.error(`Unknown PLG rejection reason: ${reason}`);
    return;
  }

  const message = `${config.emoji} *PLG Onboarding — ${config.label}*\n\n`
    + `• *Domain:* \`${domain}\`\n`
    + `• *IMS Org:* \`${imsOrgId}\``;

  try {
    await postSlackMessage(channelId, message, token);
  } catch (err) {
    log.error(`Failed to post PLG rejection notification: ${err.message}`);
  }
}

/**
 * PLG Onboarding controller.
 * @param {object} ctx - Context of the request.
 * @returns {object} Controller with onboard, getStatus, and getAllOnboardings methods.
 */
function PlgOnboardingController(ctx) {
  const { log } = ctx;

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
      if (hasText(requestedImsOrgId)) {
        const matchedTenant = profile.tenants.find((t) => `${t.id}@AdobeOrg` === requestedImsOrgId);
        if (!matchedTenant) {
          return forbidden('Requested imsOrgId does not match any tenant in authentication token');
        }
        imsOrgId = requestedImsOrgId;
      } else {
        imsOrgId = `${profile.tenants[0].id}@AdobeOrg`;
      }
    }

    const updatedBy = isInternalCall ? null : (authInfo?.getProfile()?.email || 'system');

    if (!isValidHostname(domain)) {
      return badRequest('Invalid domain: must be a valid hostname');
    }

    try {
      const { Organization, Entitlement } = context.dataAccess;
      const existingOrg = await Organization.findByImsOrgId(imsOrgId);
      if (existingOrg) {
        if (isInternalOrg(existingOrg.getId(), context.env)) {
          await postPlgRejectionNotification(domain, imsOrgId, 'internal-org', context);
          return badRequest('PLG onboarding is not available for internal organizations');
        }

        const entitlements = await Entitlement.allByOrganizationId(existingOrg.getId());
        const hasPaidEntitlement = entitlements.some(
          (e) => e.getProductCode() === ASO_PRODUCT_CODE
            && e.getTier() === EntitlementModel.TIERS.PAID,
        );
        if (hasPaidEntitlement) {
          await postPlgRejectionNotification(domain, imsOrgId, 'paid-customer', context);
          return badRequest('PLG onboarding is not available for paid customers');
        }
      }

      const onboarding = await performAsoPlgOnboarding(
        { domain, imsOrgId, updatedBy },
        withFlowDeps(context),
      );
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

    // Admin/API key holders can access any org's status. Read-only admins are NOT
    // permitted on the PLG onboarding flow - this endpoint stays on hasAdminAccess()
    // so that the PLG admin surface (status / waitlist / bypass / etc.) is gated
    // exclusively by the full-admin role.
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!accessControlUtil.hasAdminAccess()) {
      const profile = authInfo.getProfile();
      if (!profile?.tenants?.[0]?.id) {
        return badRequest('User profile or organization ID not found in authentication token');
      }
      const matchedTenant = profile.tenants.find((t) => `${t.id}@AdobeOrg` === requestedImsOrgId);
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
   * Handler for `GET /plg/sites`. Lists rows in the PLG onboardings store.
   * Cross-tenant; restricted to SpaceCat admins.
   *
   * Query `limit` (optional): caps how many rows are returned. When omitted, all pages are
   * loaded until exhaustion (unbounded; payload can be very large).
   */
  const getAllOnboardings = async (context) => {
    try {
      const accessControlUtil = AccessControlUtil.fromContext(context);
      if (!accessControlUtil.hasAdminAccess()) {
        return forbidden('Only admins can list all PLG onboarding records');
      }

      const limitParse = parsePlgListLimit(context.data?.limit);
      if (limitParse.error) {
        return badRequest(limitParse.error);
      }

      const { PlgOnboarding } = context.dataAccess;
      const raw = await PlgOnboarding.all({}, limitParse.options);
      const records = normalizePlgListResult(raw, log);
      if (records === null) {
        return internalServerError('Failed to list PLG onboarding records');
      }

      const emailMap = await resolveImsEmailsForPlgRecords(records, context);

      let payload;
      try {
        payload = records.map((record) => {
          const json = PlgOnboardingDto.toAdminJSON(record);
          const updatedBy = record.getUpdatedBy();
          const createdBy = record.getCreatedBy();
          return {
            ...json,
            updatedBy: updatedBy ? (emailMap[updatedBy] ?? updatedBy) : null,
            createdBy: createdBy ? (emailMap[createdBy] ?? createdBy) : null,
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
   * ONBOARDED record and transition it to WAITLISTED.
   */
  const update = async (context) => {
    const { dataAccess: da, params, data } = context;
    const flowContext = withFlowDeps(context);

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

    if (!hasText(decision) || !Object.values(REVIEW_DECISIONS).includes(decision)) {
      return badRequest(`decision is required and must be one of: ${Object.values(REVIEW_DECISIONS).join(', ')}`);
    }

    if (!hasText(justification)) {
      return badRequest('justification is required');
    }

    const { PlgOnboarding } = da;
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
    const reviewedBy = getReviewerIdentity(context);
    const reviewEntry = {
      reason,
      decision,
      reviewedBy,
      reviewedAt: new Date().toISOString(),
      justification,
    };

    const existingReviews = onboarding.getReviews() || [];
    onboarding.setReviews([...existingReviews, reviewEntry]);

    // ONBOARDED: revoke ASO enrollments, mark WAITLISTED, persist review (no bypass / re-run)
    if (status === STATUSES.ONBOARDED) {
      try {
        await revokeAsoSiteEnrollments(onboarding, flowContext);
        onboarding.setStatus(STATUSES.WAITLISTED);
        onboarding.setWaitlistReason(justification);
        await onboarding.save();
        await postPlgOnboardingNotification(onboarding, flowContext);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to waitlist onboarded PLG domain ${onboarding.getDomain()}: ${msg}`, err);
        return internalServerError('Failed to waitlist onboarding. Please try again later.');
      }
      return ok(PlgOnboardingDto.toAdminJSON(onboarding));
    }

    const checkKey = deriveCheckKey(onboarding);
    if (!checkKey) {
      return badRequest('Unable to determine the review reason from the onboarding record');
    }

    if (decision === REVIEW_DECISIONS.UPHELD) {
      await onboarding.save();
      return ok(PlgOnboardingDto.toAdminJSON(onboarding));
    }

    // BYPASS: scenario-specific prep, then re-run the flow
    try {
      switch (checkKey) {
        case REVIEW_REASONS.DOMAIN_ALREADY_ONBOARDED_IN_ORG:
          return await bypassDisplaceOnboarded({
            onboarding, reviewedBy, reviewedAt: reviewEntry.reviewedAt,
          }, flowContext);
        case REVIEW_REASONS.AEM_SITE_CHECK:
          return await bypassAemSiteCheck({ onboarding, siteConfig }, flowContext);
        case REVIEW_REASONS.DOMAIN_ALREADY_ASSIGNED:
          return await bypassDomainAlreadyAssigned(
            { onboarding, siteConfig },
            flowContext,
          );
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
   * Admin: update editable fields of a PLG onboarding record.
   * Body: { status, siteId, organizationId, steps, botBlocker,
   *         waitlistReason, updatedBy, createdBy }
   * For `steps`, only the provided keys are merged into the existing steps.
   */
  const updateOnboarding = async (context) => {
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can update PLG onboarding records');
    }

    const { data, params } = context;
    const { plgOnboardingId } = params;
    const {
      status,
      siteId,
      organizationId,
      steps,
      botBlocker,
      waitlistReason,
      updatedBy,
      createdBy,
    } = data || {};

    if (Object.keys(data || {}).length === 0) {
      return badRequest('No fields provided to update');
    }

    if (status !== undefined) {
      if (!hasText(status) || !Object.values(STATUSES).includes(status)) {
        return badRequest(`Invalid status. Must be one of: ${Object.values(STATUSES).join(', ')}`);
      }
    }

    if (siteId !== undefined && !isValidUUID(siteId)) {
      return badRequest('Invalid siteId. Must be a valid UUID');
    }

    if (organizationId !== undefined && !isValidUUID(organizationId)) {
      return badRequest('Invalid organizationId. Must be a valid UUID');
    }

    const { PlgOnboarding } = context.dataAccess;
    const onboarding = await PlgOnboarding.findById(plgOnboardingId);
    if (!onboarding) {
      return notFound(`PLG onboarding record ${plgOnboardingId} not found`);
    }

    if (status !== undefined) {
      onboarding.setStatus(status);
    }
    if (siteId !== undefined) {
      onboarding.setSiteId(siteId);
    }
    if (organizationId !== undefined) {
      onboarding.setOrganizationId(organizationId);
    }
    if (botBlocker !== undefined) {
      onboarding.setBotBlocker(botBlocker);
    }
    if (waitlistReason !== undefined) {
      onboarding.setWaitlistReason(waitlistReason);
    }
    if (updatedBy !== undefined) {
      onboarding.setUpdatedBy(updatedBy);
    }
    if (createdBy !== undefined) {
      onboarding.setCreatedBy(createdBy);
    }

    if (steps !== undefined) {
      const VALID_STEP_KEYS = new Set([
        'orgResolved', 'rumVerified', 'siteCreated', 'siteResolved', 'siteOrgReassigned',
        'authorUrlResolved', 'hlxConfigSet', 'codeConfigResolved', 'configUpdated',
        'auditsEnabled', 'deliveryConfigQueued', 'entitlementCreated', 'entitlementFailed',
        'orgResolutionFailed',
      ]);
      const invalidKeys = Object.keys(steps).filter((k) => !VALID_STEP_KEYS.has(k));
      if (invalidKeys.length > 0) {
        return badRequest(`Invalid step keys: ${invalidKeys.join(', ')}`);
      }
      onboarding.setSteps({ ...(onboarding.getSteps() || {}), ...steps });
    }

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
    updateOnboarding,
    deleteOnboarding,
  };
}

export default PlgOnboardingController;
