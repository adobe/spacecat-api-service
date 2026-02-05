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

import {
  ok,
  accepted,
  badRequest,
  forbidden,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';
import { calculateOverviewMetrics } from '../support/overview-metrics-calculator.js';
import { sendWeeklyDigestEmail } from '../support/email-service.js';

// Base URL for the LLM Optimizer app
const LLMO_APP_BASE_URL = 'https://llmo.now';

// Job type identifier for SQS messages
const DIGEST_JOB_TYPE = 'weekly-digest-org';

// Post Office template name for weekly digest emails
const WEEKLY_DIGEST_TEMPLATE = 'expdev_llmo_overview_weekly_digest';

/**
 * Check if a user has opted out of weekly digest emails.
 * Users can opt out via the emailPreferences.weeklyDigest field in metadata.
 *
 * @param {Object} trialUser - Trial user entity
 * @returns {boolean} True if user has opted out
 */
const hasOptedOut = (trialUser) => {
  const metadata = trialUser.getMetadata() || {};
  const emailPreferences = metadata.emailPreferences || {};

  // Default is opted-in (true), so only return true if explicitly set to false
  return emailPreferences.weeklyDigest === false;
};

/**
 * Get display name for a trial user.
 *
 * @param {Object} trialUser - Trial user entity
 * @returns {string} Display name (firstName lastName or email)
 */
const getUserDisplayName = (trialUser) => {
  const firstName = trialUser.getFirstName();
  const lastName = trialUser.getLastName();

  if (firstName && lastName && firstName !== '-' && lastName !== '-') {
    return `${firstName} ${lastName}`;
  }
  if (firstName && firstName !== '-') {
    return firstName;
  }
  return trialUser.getEmailId();
};

/**
 * Get the domain from a site's base URL for constructing app links.
 *
 * @param {string} baseURL - Site's base URL
 * @returns {string} Domain (e.g., "adobe.com")
 */
const getDomainFromBaseURL = (baseURL) => {
  try {
    const url = new URL(baseURL);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return baseURL;
  }
};

/**
 * Get the brand name from site config or fall back to domain.
 *
 * @param {Object} site - Site entity
 * @returns {string} Brand name
 */
const getBrandName = (site) => {
  const config = site.getConfig();
  const llmoConfig = config?.llmo || config?.getLlmoConfig?.();

  // Try to get brand name from LLMO config
  if (llmoConfig?.brandName) {
    return llmoConfig.brandName;
  }

  // Fall back to domain
  return getDomainFromBaseURL(site.getBaseURL());
};

/**
 * Process weekly digest for a single site.
 * Calculates metrics and sends emails to all eligible users.
 *
 * @param {Object} options - Options
 * @param {Object} options.site - Site entity
 * @param {Object} options.organization - Organization entity
 * @param {Array} options.eligibleUsers - Array of trial users to notify
 * @param {Object} options.context - Request context
 * @returns {Promise<Object>} Result with success/failure counts
 */
const processSiteDigest = async ({
  site,
  organization,
  eligibleUsers,
  context,
  log,
}) => {
  const { env } = context;
  const siteId = site.getId();
  const baseURL = site.getBaseURL();
  const brandName = getBrandName(site);
  const orgName = organization.getName();
  const domain = getDomainFromBaseURL(baseURL);

  const result = {
    siteId,
    baseURL,
    brandName,
    usersProcessed: 0,
    emailsSent: 0,
    emailsFailed: 0,
    skipped: false,
    error: null,
  };

  try {
    // Calculate metrics for the site
    log.info(`Calculating metrics for site ${siteId} (${baseURL})`);

    const metrics = await calculateOverviewMetrics({
      site,
      hlxApiKey: env.LLMO_HLX_API_KEY,
      log,
    });

    if (!metrics.hasData) {
      log.info(`No data available for site ${siteId}, skipping`);
      result.skipped = true;
      result.error = 'No data available';
      return result;
    }

    // Construct URLs for email
    const overviewUrl = `${LLMO_APP_BASE_URL}/${domain}/overview`;
    const settingsUrl = `${LLMO_APP_BASE_URL}/${domain}/settings`;

    // Send emails to all eligible users
    for (const user of eligibleUsers) {
      result.usersProcessed += 1;
      const emailAddress = user.getEmailId();
      const customerName = getUserDisplayName(user);

      try {
        log.info(`Sending digest email to ${emailAddress} for site ${siteId}`);

        // eslint-disable-next-line no-await-in-loop
        const emailResult = await sendWeeklyDigestEmail({
          context,
          templateName: WEEKLY_DIGEST_TEMPLATE,
          emailAddress,
          customerName,
          brandName,
          orgName,
          dateRange: metrics.dateRange,
          visibilityScore: metrics.visibilityScore,
          visibilityDelta: metrics.visibilityDelta,
          mentionsCount: metrics.mentionsCount,
          mentionsDelta: metrics.mentionsDelta,
          citationsCount: metrics.citationsCount,
          citationsDelta: metrics.citationsDelta,
          overviewUrl,
          settingsUrl,
        });

        if (emailResult.success) {
          result.emailsSent += 1;
        } else {
          result.emailsFailed += 1;
          log.error(`Failed to send digest to ${emailAddress}: ${emailResult.error}`);
        }
      } catch (emailError) {
        result.emailsFailed += 1;
        log.error(`Error sending digest to ${emailAddress}: ${emailError.message}`);
      }
    }

    log.info(`Site ${siteId} digest complete: ${result.emailsSent} sent, ${result.emailsFailed} failed`);
  } catch (error) {
    result.error = error.message;
    log.error(`Error processing digest for site ${siteId}: ${error.message}`);
  }

  return result;
};

/**
 * WeeklyDigest controller. Handles sending weekly digest emails to users.
 * Uses a fan-out pattern for scalability:
 * 1. triggerWeeklyDigests - Called by scheduler, enqueues per-org messages
 * 2. processOrganizationDigest - Worker, processes single org from SQS
 *
 * @param {Object} ctx - Context of the request
 * @param {Object} log - Logger instance
 * @returns {Object} WeeklyDigest controller
 */
function WeeklyDigestController(ctx, log) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Site, Organization, TrialUser } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Trigger weekly digest processing by enqueuing per-organization messages.
   * This is the entry point called by the scheduler/dispatcher.
   *
   * Flow:
   * 1. Query all LLMO-enabled sites
   * 2. Group sites by organization
   * 3. Send one SQS message per organization
   * 4. Return immediately (async processing)
   *
   * @param {Object} context - Request context
   * @returns {Promise<Response>} Accepted response with queue stats
   */
  const triggerWeeklyDigests = async (context) => {
    log.info('[WeeklyDigest] triggerWeeklyDigests called');

    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can trigger weekly digests');
    }

    const { sqs, env } = context;
    const startTime = Date.now();

    log.info('Starting weekly digest trigger - queueing per-org jobs');

    const queueUrl = env.DIGEST_JOBS_QUEUE_URL;
    if (!queueUrl) {
      log.error('DIGEST_JOBS_QUEUE_URL not configured');
      return internalServerError('Digest queue not configured');
    }

    const stats = {
      totalSites: 0,
      llmoEnabledSites: 0,
      organizationsQueued: 0,
      queueErrors: 0,
    };

    try {
      // Get all sites
      const allSites = await Site.all();
      stats.totalSites = allSites.length;
      log.info(`Found ${stats.totalSites} total sites`);

      // Filter to LLMO-enabled sites (those with llmo.dataFolder config)
      const llmoSites = allSites.filter((site) => {
        const config = site.getConfig();
        const llmoConfig = config?.llmo || config?.getLlmoConfig?.();
        return llmoConfig?.dataFolder;
      });
      stats.llmoEnabledSites = llmoSites.length;
      log.info(`Found ${stats.llmoEnabledSites} LLMO-enabled sites`);

      if (llmoSites.length === 0) {
        return ok({
          message: 'No LLMO-enabled sites found',
          stats,
        });
      }

      // Group sites by organization
      const sitesByOrg = new Map();
      for (const site of llmoSites) {
        const orgId = site.getOrganizationId();
        if (!sitesByOrg.has(orgId)) {
          sitesByOrg.set(orgId, []);
        }
        sitesByOrg.get(orgId).push(site);
      }

      log.info(`Sites grouped into ${sitesByOrg.size} organizations`);

      // Queue a message for each organization
      const queuePromises = [];
      for (const [orgId, sites] of sitesByOrg) {
        const message = {
          type: DIGEST_JOB_TYPE,
          organizationId: orgId,
          siteIds: sites.map((s) => s.getId()),
          triggeredAt: new Date().toISOString(),
        };

        queuePromises.push(
          sqs.sendMessage(queueUrl, message)
            .then(() => {
              stats.organizationsQueued += 1;
              log.debug(`Queued digest job for org ${orgId} with ${sites.length} sites`);
            })
            .catch((error) => {
              stats.queueErrors += 1;
              log.error(`Failed to queue digest for org ${orgId}: ${error.message}`);
            }),
        );
      }

      // Wait for all queue operations
      await Promise.all(queuePromises);

      const duration = Date.now() - startTime;
      log.info(`Weekly digest trigger complete in ${duration}ms: ${stats.organizationsQueued} orgs queued`);

      return accepted({
        message: 'Weekly digest jobs queued for processing',
        duration: `${duration}ms`,
        stats,
      });
    } catch (error) {
      log.error(`Weekly digest trigger failed: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  /**
   * Process weekly digest for a single organization.
   * This is called by the SQS worker when processing queued messages.
   *
   * Expected request body (from SQS message):
   * {
   *   type: 'weekly-digest-org',
   *   organizationId: 'org-uuid',
   *   siteIds: ['site-uuid-1', 'site-uuid-2'],
   *   triggeredAt: 'ISO timestamp'
   * }
   *
   * @param {Object} context - Request context
   * @returns {Promise<Response>} Processing result
   */
  const processOrganizationDigest = async (context) => {
    log.info('[WeeklyDigest] processOrganizationDigest called');

    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can process organization digests');
    }

    const { data } = context;
    const startTime = Date.now();

    // Parse message from SQS (comes via request body)
    const message = data || {};
    const { type, organizationId, siteIds } = message;

    // Validate message
    if (type !== DIGEST_JOB_TYPE) {
      log.warn(`Invalid job type: ${type}, expected ${DIGEST_JOB_TYPE}`);
      return badRequest(`Invalid job type: ${type}`);
    }

    if (!organizationId) {
      log.error('Missing organizationId in message');
      return badRequest('Missing organizationId');
    }

    if (!Array.isArray(siteIds) || siteIds.length === 0) {
      log.error('Missing or empty siteIds in message');
      return badRequest('Missing siteIds');
    }

    log.info(`Processing digest for org ${organizationId} with ${siteIds.length} sites`);

    const result = {
      organizationId,
      sitesProcessed: 0,
      sitesSkipped: 0,
      sitesFailed: 0,
      totalEmailsSent: 0,
      totalEmailsFailed: 0,
      siteResults: [],
    };

    try {
      // Get organization details
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        log.warn(`Organization ${organizationId} not found`);
        return badRequest(`Organization ${organizationId} not found`);
      }

      // Get trial users for this organization
      const trialUsers = await TrialUser.allByOrganizationId(organizationId);

      // Filter to active users who haven't opted out
      const eligibleUsers = trialUsers.filter((user) => {
        const status = user.getStatus();
        if (status === 'BLOCKED' || status === 'DELETED') {
          return false;
        }
        if (hasOptedOut(user)) {
          return false;
        }
        return true;
      });

      if (eligibleUsers.length === 0) {
        log.info(`No eligible users for org ${organizationId}, skipping all sites`);
        result.sitesSkipped = siteIds.length;
        return ok({
          message: 'No eligible users for organization',
          ...result,
        });
      }

      log.info(`Found ${eligibleUsers.length} eligible users for org ${organizationId}`);

      // Fetch and process each site
      for (const siteId of siteIds) {
        // eslint-disable-next-line no-await-in-loop
        const site = await Site.findById(siteId);

        if (!site) {
          log.warn(`Site ${siteId} not found, skipping`);
          result.sitesSkipped += 1;
          result.siteResults.push({
            siteId,
            skipped: true,
            error: 'Site not found',
          });
        } else {
          // eslint-disable-next-line no-await-in-loop
          const siteResult = await processSiteDigest({
            site,
            organization,
            eligibleUsers,
            context,
            log,
          });

          result.siteResults.push(siteResult);

          if (siteResult.skipped) {
            result.sitesSkipped += 1;
          } else if (siteResult.error && siteResult.emailsSent === 0) {
            result.sitesFailed += 1;
          } else {
            result.sitesProcessed += 1;
          }

          result.totalEmailsSent += siteResult.emailsSent;
          result.totalEmailsFailed += siteResult.emailsFailed;
        }
      }

      const duration = Date.now() - startTime;
      log.info(`Org ${organizationId} digest complete in ${duration}ms: ${result.sitesProcessed} sites, ${result.totalEmailsSent} emails`);

      return ok({
        message: 'Organization digest processing complete',
        duration: `${duration}ms`,
        ...result,
      });
    } catch (error) {
      log.error(`Error processing org ${organizationId} digest: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  return {
    triggerWeeklyDigests,
    processOrganizationDigest,
  };
}

export default WeeklyDigestController;
