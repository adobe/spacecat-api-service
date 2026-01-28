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
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import { calculateOverviewMetrics } from '../support/overview-metrics-calculator.js';
import { sendWeeklyDigestEmail } from '../support/email-service.js';

// Base URL for the LLM Optimizer app
const LLMO_APP_BASE_URL = 'https://llmo.now';

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
}) => {
  const { log, env } = context;
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

    // ============================================================
    // TEMPORARY TEST MODE - Use mock metrics data
    // Remove this block before merging to production
    // ============================================================
    const USE_MOCK_METRICS = true; // Set to false to use real data
    let metrics;

    if (USE_MOCK_METRICS) {
      log.warn('TEST MODE: Using mock metrics data');
      metrics = {
        hasData: true,
        visibilityScore: 72,
        visibilityDelta: '+5%',
        mentionsCount: 1247,
        mentionsDelta: '+12%',
        citationsCount: 89,
        citationsDelta: '-3%',
        dateRange: 'Jan 13 - Jan 19, 2026',
      };
    } else {
      metrics = await calculateOverviewMetrics({
        site,
        hlxApiKey: env.LLMO_HLX_API_KEY,
        log,
      });
    }
    // ============================================================

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
          // Include template name for debugging
          result.templateUsed = emailResult.templateUsed;
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
 * Process digests for all sites in an organization.
 *
 * @param {Object} options - Options
 * @param {string} options.orgId - Organization ID
 * @param {Array} options.sites - Sites belonging to this organization
 * @param {Object} options.context - Request context
 * @param {Object} options.Organization - Organization data access
 * @param {Object} options.TrialUser - TrialUser data access
 * @param {boolean} [options.testMode=false] - Test mode flag
 * @param {string} [options.testEmail] - Override email in test mode
 * @returns {Promise<Object>} Results for this organization
 */
const processOrganizationDigests = async ({
  orgId,
  sites,
  context,
  Organization,
  TrialUser,
  testMode = false,
  testEmail = null,
}) => {
  const { log } = context;
  const result = {
    sitesProcessed: 0,
    sitesSkipped: 0,
    sitesFailed: 0,
    emailsSent: 0,
    emailsFailed: 0,
    siteResults: [],
  };

  try {
    // Get organization details
    const organization = await Organization.findById(orgId);
    if (!organization) {
      log.warn(`Organization ${orgId} not found, skipping ${sites.length} sites`);
      result.sitesSkipped = sites.length;
      return result;
    }

    let eligibleUsers;

    // TEST MODE: Create a fake user with test email
    if (testMode && testEmail) {
      log.warn(`TEST MODE: Overriding users with test email: ${testEmail}`);
      eligibleUsers = [{
        getEmailId: () => testEmail,
        getFirstName: () => 'Test',
        getLastName: () => 'User',
        getStatus: () => 'REGISTERED',
        getMetadata: () => ({}),
      }];
    } else {
      // Get trial users for this organization
      const trialUsers = await TrialUser.allByOrganizationId(orgId);

      // Filter to active users who haven't opted out
      // Status should be REGISTERED or INVITED (not BLOCKED or DELETED)
      eligibleUsers = trialUsers.filter((user) => {
        const status = user.getStatus();
        if (status === 'BLOCKED' || status === 'DELETED') {
          return false;
        }
        if (hasOptedOut(user)) {
          return false;
        }
        return true;
      });
    }

    if (eligibleUsers.length === 0) {
      log.info(`No eligible users for org ${orgId}, skipping ${sites.length} sites`);
      result.sitesSkipped = sites.length;
      return result;
    }

    log.info(`Processing ${sites.length} sites for org ${orgId} with ${eligibleUsers.length} users`);

    // Process each site in the organization
    for (const site of sites) {
      // eslint-disable-next-line no-await-in-loop
      const siteResult = await processSiteDigest({
        site,
        organization,
        eligibleUsers,
        context,
      });

      result.siteResults.push(siteResult);

      if (siteResult.skipped) {
        result.sitesSkipped += 1;
      } else if (siteResult.error && siteResult.emailsSent === 0) {
        result.sitesFailed += 1;
      } else {
        result.sitesProcessed += 1;
      }

      result.emailsSent += siteResult.emailsSent;
      result.emailsFailed += siteResult.emailsFailed;
    }
  } catch (orgError) {
    log.error(`Error processing org ${orgId}: ${orgError.message}`);
    result.sitesFailed = sites.length;
  }

  return result;
};

/**
 * WeeklyDigest controller. Handles sending weekly digest emails to users.
 *
 * @param {Object} ctx - Context of the request
 * @returns {Object} WeeklyDigest controller
 */
function WeeklyDigestController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Site, Organization, TrialUser } = dataAccess;

  // ============================================================
  // TEMPORARY TEST MODE - Remove before merging to production
  // ============================================================
  const TEST_MODE = true; // Set to false to disable test mode
  const TEST_EMAIL = 'joselopez@adobe.com';
  const TEST_SITE_DOMAIN = 'adobe.com'; // Only process sites matching this domain
  // ============================================================

  /**
   * Process weekly digests for all LLMO-enabled sites.
   * This is the main entry point for the scheduled job.
   *
   * @param {Object} context - Request context
   * @returns {Promise<Response>} Processing result
   */
  const processWeeklyDigests = async (context) => {
    const { log } = context;
    const startTime = Date.now();

    log.info('Starting weekly digest processing');

    // Log test mode status
    if (TEST_MODE) {
      log.warn(`TEST MODE ENABLED: Only processing sites matching "${TEST_SITE_DOMAIN}" and sending to "${TEST_EMAIL}"`);
    }

    const summary = {
      sitesProcessed: 0,
      sitesSkipped: 0,
      sitesFailed: 0,
      totalEmailsSent: 0,
      totalEmailsFailed: 0,
      siteResults: [],
    };

    try {
      // Get all sites
      const allSites = await Site.all();
      log.info(`Found ${allSites.length} total sites`);

      // Filter to LLMO-enabled sites (those with llmo.dataFolder config)
      let llmoSites = allSites.filter((site) => {
        const config = site.getConfig();
        const llmoConfig = config?.llmo || config?.getLlmoConfig?.();
        return llmoConfig?.dataFolder;
      });

      log.info(`Found ${llmoSites.length} LLMO-enabled sites`);

      // TEST MODE: Filter to only test site
      if (TEST_MODE) {
        llmoSites = llmoSites.filter((site) => {
          const baseURL = site.getBaseURL();
          return baseURL && baseURL.includes(TEST_SITE_DOMAIN);
        });
        log.warn(`TEST MODE: Filtered to ${llmoSites.length} sites matching "${TEST_SITE_DOMAIN}"`);

        // Only process the first matching site in test mode
        if (llmoSites.length > 1) {
          llmoSites = [llmoSites[0]];
          log.warn('TEST MODE: Limited to first matching site only');
        }
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

      // Process each organization
      for (const [orgId, sites] of sitesByOrg) {
        // eslint-disable-next-line no-await-in-loop
        const orgResult = await processOrganizationDigests({
          orgId,
          sites,
          context,
          Organization,
          TrialUser,
          testMode: TEST_MODE,
          testEmail: TEST_EMAIL,
        });

        // Aggregate results
        summary.sitesProcessed += orgResult.sitesProcessed;
        summary.sitesSkipped += orgResult.sitesSkipped;
        summary.sitesFailed += orgResult.sitesFailed;
        summary.totalEmailsSent += orgResult.emailsSent;
        summary.totalEmailsFailed += orgResult.emailsFailed;
        summary.siteResults.push(...orgResult.siteResults);
      }

      const duration = Date.now() - startTime;
      log.info(`Weekly digest processing complete in ${duration}ms: ${summary.sitesProcessed} sites processed, ${summary.totalEmailsSent} emails sent`);

      return ok({
        message: TEST_MODE ? 'Weekly digest TEST processing complete' : 'Weekly digest processing complete',
        testMode: TEST_MODE,
        duration: `${duration}ms`,
        summary: {
          sitesProcessed: summary.sitesProcessed,
          sitesSkipped: summary.sitesSkipped,
          sitesFailed: summary.sitesFailed,
          totalEmailsSent: summary.totalEmailsSent,
          totalEmailsFailed: summary.totalEmailsFailed,
        },
      });
    } catch (error) {
      log.error(`Weekly digest processing failed: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  return {
    processWeeklyDigests,
  };
}

export default WeeklyDigestController;
