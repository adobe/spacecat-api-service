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

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { createFrom } from '@adobe/spacecat-helix-content-sdk';
import { Octokit } from '@octokit/rest';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';
import TierClient from '@adobe/spacecat-shared-tier-client';
import { composeBaseURL, tracingFetch as fetch, isNonEmptyArray } from '@adobe/spacecat-shared-utils';
import SeoClient from '@adobe/mysticat-shared-seo-client';
import DrsClient from '@adobe/spacecat-shared-drs-client';
import { parse as parseDomain } from 'tldts';
import { postSlackMessage } from '../../utils/slack/base.js';
import {
  readCustomerConfigV2FromPostgres,
  writeCustomerConfigV2ToPostgres,
} from '../../support/customer-config-v2-storage.js';
import { convertV1ToV2, generateBrandId } from '../../support/customer-config-mapper.js';
import {
  resolveLlmoOnboardingMode,
  LLMO_ONBOARDING_MODE_V1,
  LLMO_ONBOARDING_MODE_V2,
  LLMO_FEATURE_FLAG_PRODUCT,
  LLMO_BRANDALF_FLAG,
} from '../../support/llmo-onboarding-mode.js';
import { upsertFeatureFlag } from '../../support/feature-flags-storage.js';
import { detectCdnForDomain } from '../../support/cdn-detection.js';
import { upsertBrand } from '../../support/brands-storage.js';

// LLMO Constants
const LLMO_PRODUCT_CODE = EntitlementModel.PRODUCT_CODES.LLMO;
const LLMO_TIER = EntitlementModel.TIERS.FREE_TRIAL;
const SHAREPOINT_URL = 'https://adobe.sharepoint.com/:x:/r/sites/HelixProjects/Shared%20Documents/sites/elmo-ui-data';

// These audits don't depend on any additonal data being configured
export const BASIC_AUDITS = [
  'scrape-top-pages',
  'headings',
  'llm-blocked',
  'canonical',
  'hreflang',
  'summarization',
  'prerender',
];

export const ASO_DEMO_ORG = '66331367-70e6-4a49-8445-4f6d9c265af9';

export const ASO_CRITICAL_SITES = [];
const LLMO_ONBOARDING_PUBLISH_TRIGGER = 'trigger:llmo-onboarding-publish';

function resolveUpdatedBy(context) {
  return context.attributes?.authInfo?.profile?.email
    || context.attributes?.authInfo?.getProfile?.()?.email
    || 'system';
}

function buildOnboardingMetadata({
  siteId, imsOrgId, brandName, onboardingMode, extra = {},
}) {
  return {
    site_id: siteId,
    imsOrgId,
    brand: brandName,
    onboarding_mode: onboardingMode,
    ...extra,
  };
}

function buildBrandalfMetadata({
  organizationId,
  siteId,
  imsOrgId,
  brandName,
  companyWebsite,
  onboardingMode,
}) {
  const { hostname } = new URL(companyWebsite);
  return buildOnboardingMetadata({
    siteId,
    imsOrgId,
    brandName,
    onboardingMode,
    extra: {
      site: hostname,
      spaceCatId: organizationId,
      company_website: companyWebsite,
    },
  });
}

export async function triggerBrandalfOnboardingJob({
  drsClient,
  organizationId,
  siteId,
  imsOrgId,
  brandName,
  companyWebsite,
  onboardingMode,
  log,
  say = () => {},
}) {
  const metadata = buildBrandalfMetadata({
    organizationId,
    siteId,
    imsOrgId,
    brandName,
    companyWebsite,
    onboardingMode,
  });

  const drsJob = await drsClient.submitJob({
    provider_id: 'single_shot_prompt',
    priority: 'HIGH',
    source: 'onboarding',
    parameters: {
      prompt_type: 'brandalf',
      name: brandName,
      company_website: companyWebsite,
      metadata,
    },
  });

  log.info(`Started DRS Brandalf flow: job=${drsJob.job_id}`);
  say(`:label: Started DRS Brandalf job: ${drsJob.job_id}`);
  return drsJob;
}

// submitOnboardingPromptGenerationJob removed — prompt generation is now
// triggered by DRS after Brandalf completes (LLMO-4258, option b).

export function buildInitialCustomerConfigV2({
  brandName,
  imsOrgId,
  siteId,
  baseURL,
  overrideBaseURL,
  updatedBy = 'system',
}) {
  const primaryUrl = overrideBaseURL || baseURL;
  const config = convertV1ToV2({
    brands: {
      aliases: [{
        name: brandName,
        regions: ['gl'],
        status: 'active',
      }],
    },
    competitors: { competitors: [] },
    categories: {},
    topics: {},
  }, brandName, imsOrgId);

  const [brand] = config.customer.brands;
  const timestamp = new Date().toISOString();

  brand.v1SiteId = siteId;
  brand.baseUrl = primaryUrl;
  brand.updatedAt = timestamp;
  brand.updatedBy = updatedBy;
  brand.urls = [{ value: primaryUrl, type: 'base' }];
  brand.brandAliases = [{ name: brandName, regions: ['gl'] }];

  config.customer.customerName = brandName;

  return config;
}

export async function ensureInitialCustomerConfigV2({
  organizationId,
  brandName,
  imsOrgId,
  siteId,
  baseURL,
  overrideBaseURL,
  context,
}) {
  const postgrestClient = context.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    throw new Error('V2 customer config requires Postgres (DATA_SERVICE_PROVIDER=postgres)');
  }

  const existingConfig = await readCustomerConfigV2FromPostgres(organizationId, postgrestClient);
  if (existingConfig) {
    if (!existingConfig.customer) {
      existingConfig.customer = {};
    }
    if (!existingConfig.customer.brands) {
      existingConfig.customer.brands = [];
    }
    const { brands } = existingConfig.customer;
    const siteAlreadyRegistered = brands.some((b) => b.v1SiteId === siteId);

    if (siteAlreadyRegistered) {
      context.log.info(`V2 customer config already exists for organization ${organizationId} with site ${siteId}, skipping`);
      return existingConfig;
    }

    // Add the new site as a brand to the existing config
    const primaryUrl = overrideBaseURL || baseURL;
    const timestamp = new Date().toISOString();
    const trimmedName = brandName.trim();
    let brandId = generateBrandId(trimmedName);

    // Ensure brand ID is unique within the config
    const existingIds = new Set(brands.map((b) => b.id));
    if (existingIds.has(brandId)) {
      brandId = `${brandId}-${siteId.slice(0, 8)}`;
    }

    brands.push({
      id: brandId,
      v1SiteId: siteId,
      name: trimmedName,
      baseUrl: primaryUrl,
      status: 'active',
      origin: 'system',
      regions: ['gl'],
      updatedAt: timestamp,
      updatedBy: resolveUpdatedBy(context),
      urls: [{ value: primaryUrl, type: 'base' }],
      brandAliases: [{ name: trimmedName, regions: ['gl'] }],
    });

    await writeCustomerConfigV2ToPostgres(
      organizationId,
      existingConfig,
      postgrestClient,
      resolveUpdatedBy(context),
    );
    context.log.info(`Added site ${siteId} as brand "${brandName}" to existing V2 config for organization ${organizationId}`);
    return existingConfig;
  }

  const config = buildInitialCustomerConfigV2({
    brandName: brandName.trim(),
    imsOrgId,
    siteId,
    baseURL,
    overrideBaseURL,
    updatedBy: resolveUpdatedBy(context),
  });

  await writeCustomerConfigV2ToPostgres(
    organizationId,
    config,
    postgrestClient,
    resolveUpdatedBy(context),
  );
  context.log.info(`Initialized V2 customer config for organization ${organizationId} during onboarding`);

  return config;
}

/**
 * Generates the data folder name from a baseURL.
 *
 * The hostname and (if present) each URL path segment are percent-decoded,
 * individually sanitized (non-alphanumeric replaced with `-`, lowercased —
 * paths are case-folded deliberately so /Kings and /kings map to the same folder),
 * and joined with `--` as a path-segment delimiter. The double-hyphen delimiter
 * cannot appear in a sanitized segment, so distinct paths cannot collide.
 *
 * Examples:
 *   https://nba.com           -> nba-com
 *   https://nba.com/kings     -> nba-com--kings
 *   https://nba.com/us/kings  -> nba-com--us--kings
 *
 * @param {string} baseURL - The site's base URL (must be a fully-qualified URL).
 * @param {string} env - The environment ('prod' or anything else, treated as dev).
 * @returns {string} The data folder name (prefixed with 'dev/' for non-prod).
 */
export function generateDataFolder(baseURL, env = 'dev') {
  const url = new URL(baseURL);
  const host = url.hostname.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean)
    .map((seg) => {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch { /* keep raw on malformed percent-encoding */ }
      return decoded.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().replace(/-+/g, '-');
    });
  const dataFolderName = segments.length > 0 ? `${host}--${segments.join('--')}` : host;
  return env === 'prod' ? dataFolderName : `dev/${dataFolderName}`;
}

/**
 * Posts an alert to the LLMO alerts Slack channel.
 * Fails gracefully if channel/token not configured or if posting fails.
 * @param {string} message - The message to post
 * @param {object} context - The request context containing env and log
 * @returns {Promise<void>}
 */
export async function postLlmoAlert(message, context) {
  const { env, log } = context;
  const slackChannel = env.SLACK_LLMO_ALERTS_CHANNEL_ID;
  const slackToken = env.SLACK_BOT_TOKEN;

  if (slackChannel && slackToken) {
    try {
      await postSlackMessage(slackChannel, message, slackToken);
    } catch (slackError) {
      log.error(`Failed to post LLMO alert to Slack: ${slackError.message}`);
    }
  }
}

/**
 * Gets the IMS Org ID for a given organization ID.
 * Used for enriching notification messages. Never throws - returns 'Unknown' on error.
 * @param {string} organizationId - The SpaceCat organization ID
 * @param {object} context - The request context containing dataAccess and log
 * @returns {Promise<string>} The IMS Org ID or 'Unknown'
 */
async function getCurrentImsOrgIdForNotification(organizationId, context) {
  const { dataAccess, log } = context;
  const { Organization } = dataAccess;

  try {
    const organization = await Organization.findById(organizationId);
    return organization ? organization.getImsOrgId() : 'Unknown';
  } catch (error) {
    log.warn(`Could not fetch IMS Org ID for notification: ${error.message}`);
    return 'Unknown';
  }
}

/**
 * Gets the current IMS Org ID for a site by baseURL.
 * Never throws - returns 'Unknown' on error.
 * @param {string} baseURL - The site's base URL
 * @param {object} context - The request context containing dataAccess and log
 * @returns {Promise<string>} The IMS Org ID or 'Unknown'
 */
async function getCurrentImsOrgIdForSite(baseURL, context) {
  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  try {
    const site = await Site.findByBaseURL(baseURL);
    if (site) {
      return await getCurrentImsOrgIdForNotification(
        site.getOrganizationId(),
        context,
      );
    }
    return 'Unknown';
  } catch (error) {
    log.warn(`Could not fetch IMS Org ID for site: ${error.message}`);
    return 'Unknown';
  }
}

/**
 * Creates a SharePoint client for LLMO operations.
 * @param {object} env - Environment variables
 * @returns {Promise<object>} SharePoint client
 */
export async function createSharePointClient(env) {
  return createFrom({
    clientId: env.SHAREPOINT_CLIENT_ID,
    clientSecret: env.SHAREPOINT_CLIENT_SECRET,
    authority: env.SHAREPOINT_AUTHORITY,
    domainId: env.SHAREPOINT_DOMAIN_ID,
  }, { url: SHAREPOINT_URL, type: 'onedrive' });
}

/**
 * Validates that the site has not been onboarded yet by checking:
 * 1. Site does not exist in SpaceCat API
 * 2. SharePoint folder does not exist
 * @param {string} baseURL - The base URL of the site
 * @param {string} dataFolder - The data folder name
 * @param {object} context - The request context
 * @returns {Promise<{isValid: boolean, error?: string}>} Validation result
 */
export async function validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context) {
  const { log, dataAccess, env } = context;
  const { Site, Organization } = dataAccess;

  try {
    // Check if SharePoint folder already exists
    const sharepointClient = await createSharePointClient(env);
    const folder = sharepointClient.getDocument(`/sites/elmo-ui-data/${dataFolder}/`);
    const folderExists = await folder.exists();

    if (folderExists) {
      // Try to get current IMS Org if site exists (best effort - don't fail validation)
      const currentImsOrgId = await getCurrentImsOrgIdForSite(baseURL, context);

      await postLlmoAlert(
        ':warning: *Site is already onboarded* - Data folder already exists\n\n'
        + `• Site: \`${baseURL}\`\n`
        + `• Requested IMS Org: \`${imsOrgId}\`\n`
        + `• Current IMS Org: \`${currentImsOrgId}\`\n`
        + `• Data Folder: \`${dataFolder}`,
        context,
      );

      return {
        isValid: false,
        error: `Data folder for site ${baseURL} already exists. The site is already onboarded.`,
      };
    }

    // Check if site already exists in SpaceCat
    const existingSite = await Site.findByBaseURL(baseURL);

    // Get the organization id from the imsOrgId
    const organization = await Organization.findByImsOrgId(imsOrgId);

    // if the site doesn't exist, it means it's not onboarded yet and we are safe to onboard
    // to either an existing or a new organization
    if (!existingSite) {
      return { isValid: true };
    }

    if (ASO_CRITICAL_SITES.includes(existingSite.getId())) {
      return {
        isValid: false,
        error: `Site ${baseURL} is mission critical for ASO.`,
      };
    }

    if (organization) {
      // if the organization exists, we need to check if the site is assigned to the same
      // organization, or the default organization (= not yet claimed)
      // or AEM Demo Org (= not yet claimed)
      if (existingSite.getOrganizationId() !== organization.getId()
        && existingSite.getOrganizationId() !== env.DEFAULT_ORGANIZATION_ID
        && existingSite.getOrganizationId() !== ASO_DEMO_ORG) {
        // Get current organization's IMS Org ID (best effort - don't fail validation)
        const currentImsOrgId = await getCurrentImsOrgIdForNotification(
          existingSite.getOrganizationId(),
          context,
        );

        await postLlmoAlert(
          ':warning: *Site is already onboarded* - Assigned to a different organization\n\n'
          + `• Site: \`${baseURL}\`\n`
          + `• Requested IMS Org: \`${imsOrgId}\`\n`
          + `• Current IMS Org: \`${currentImsOrgId}\`\n`
          + `• Requested Org ID: \`${organization.getId()}\n`
          + `• Current Org ID: \`${existingSite.getOrganizationId()}`,
          context,
        );

        return {
          isValid: false,
          error: `Site ${baseURL} has already been assigned to a different organization.`,
        };
      }
    } else if (existingSite.getOrganizationId() !== env.DEFAULT_ORGANIZATION_ID
        && existingSite.getOrganizationId() !== ASO_DEMO_ORG) {
      // if the organization doesn't exist, but the site does, check that the site isn't claimed yet
      // by another organization
      // Get current organization's IMS Org ID (best effort - don't fail validation)
      const currentImsOrgId = await getCurrentImsOrgIdForNotification(
        existingSite.getOrganizationId(),
        context,
      );

      await postLlmoAlert(
        ':warning: *Site is already onboarded* - Assigned to a different organization\n\n'
        + `• Site: \`${baseURL}\`\n`
        + `• Requested IMS Org: \`${imsOrgId}\`\n`
        + `• Current IMS Org: \`${currentImsOrgId}\`\n`
        + `• Current Org ID: \`${existingSite.getOrganizationId()}`,
        context,
      );

      return {
        isValid: false,
        error: `Site ${baseURL} has already been assigned to a different organization.`,
      };
    }

    return { isValid: true };
  } catch (error) {
    log.error(`Error validating site onboarding status: ${error.message}`);
    // If we can't validate, we should fail safely and not allow onboarding
    return {
      isValid: false,
      error: `Unable to validate onboarding status: ${error.message}`,
    };
  }
}

/**
 * Starts a bulk status job for a given path.
 * @param {string} path - The folder path to get status for
 * @param {object} env - Environment variables
 * @param {object} log - Logger instance
 * @returns {Promise<string>} The job name
 */
export async function startBulkStatusJob(path, env, log) {
  const org = 'adobe';
  const site = 'project-elmo-ui-data';
  const ref = 'main';
  const headers = {
    Cookie: `auth_token=${env.HLX_ONBOARDING_TOKEN}`,
    'Content-Type': 'application/json',
  };

  if (!env.HLX_ONBOARDING_TOKEN) {
    log.warn('LLMO offboarding: HLX_ONBOARDING_TOKEN is not set');
    return null;
  }

  const baseUrl = 'https://admin.hlx.page';
  const url = `${baseUrl}/status/${org}/${site}/${ref}/*`;

  log.debug(`Starting bulk status job for path: ${path}`);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      paths: [`/${path}/*`],
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to start bulk status job: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  log.debug(`Bulk status job started: ${result.job?.name || result.name}`);

  return result.job?.name || result.name;
}

/**
 * Polls a job until it completes.
 * @param {string} jobName - The job name to poll
 * @param {object} env - Environment variables
 * @param {object} log - Logger instance
 * @returns {Promise<object>} The completed job data
 */
export async function pollJobStatus(jobName, env, log) {
  const org = 'adobe';
  const site = 'project-elmo-ui-data';
  const ref = 'main';
  const topic = 'status';
  const headers = { Cookie: `auth_token=${env.HLX_ONBOARDING_TOKEN}` };

  if (!env.HLX_ONBOARDING_TOKEN) {
    log.warn('LLMO offboarding: HLX_ONBOARDING_TOKEN is not set');
    return null;
  }

  const baseUrl = 'https://admin.hlx.page';
  const url = `${baseUrl}/job/${org}/${site}/${ref}/${topic}/${jobName}/details`;

  const pollInterval = 200; // 200ms as specified
  const maxAttempts = 150; // 30 seconds timeout (150 * 200ms)
  let attempts = 0;

  log.debug(`Polling job status for: ${jobName}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(url, { method: 'GET', headers });

    if (!response.ok) {
      throw new Error(`Failed to get job status: ${response.status} ${response.statusText}`);
    }

    // eslint-disable-next-line no-await-in-loop
    const jobData = await response.json();

    if (jobData.state === 'stopped' && jobData.data?.phase === 'completed') {
      log.debug(`Job ${jobName} completed successfully`);
      return jobData;
    }

    attempts += 1;
    if (attempts >= maxAttempts) {
      throw new Error(`Job polling timed out after ${maxAttempts * pollInterval}ms`);
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, pollInterval);
    });
  }
}

/**
 * Performs bulk unpublish and un-preview for a list of paths.
 * @param {Array<string>} paths - Array of paths to unpublish
 * @param {string} dataFolder - Base data folder
 * @param {object} env - Environment variables
 * @param {object} log - Logger instance
 */
export async function bulkUnpublishPaths(paths, dataFolder, env, log) {
  if (!paths || paths.length === 0) {
    log.debug('No paths to unpublish');
    return;
  }

  const org = 'adobe';
  const site = 'project-elmo-ui-data';
  const ref = 'main';
  const headers = {
    Cookie: `auth_token=${env.HLX_ONBOARDING_TOKEN}`,
    'Content-Type': 'application/json',
  };

  if (!env.HLX_ONBOARDING_TOKEN) {
    log.warn('LLMO offboarding: HLX_ONBOARDING_TOKEN is not set');
    return;
  }

  const baseUrl = 'https://admin.hlx.page';

  // Prepare paths in the format required by bulk APIs
  const pathsPayload = paths.map((path) => ({ path }));

  // Bulk unpublish (live)
  const unpublishUrl = `${baseUrl}/live/${org}/${site}/${ref}/${dataFolder}/*`;
  log.debug(`Starting bulk unpublish for ${paths.length} paths`);

  try {
    const unpublishResponse = await fetch(unpublishUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ paths: pathsPayload.map((o) => o.path), delete: true }),
    });

    if (!unpublishResponse.ok) {
      log.error(`Bulk unpublish failed: ${unpublishResponse.status} ${unpublishResponse.statusText}`);
    } else {
      const unpublishResult = await unpublishResponse.json();
      log.debug(`Bulk unpublish job started: ${unpublishResult.job?.name || unpublishResult.name}`);
    }
  } catch (error) {
    log.error(`Error during bulk unpublish: ${error.message}`);
  }

  // Bulk un-preview
  const unpreviewUrl = `${baseUrl}/preview/${org}/${site}/${ref}/${dataFolder}/*`;
  log.debug(`Starting bulk un-preview for ${paths.length} paths`);

  try {
    const unpreviewResponse = await fetch(unpreviewUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ paths: pathsPayload.map((o) => o.path), delete: true }),
    });

    if (!unpreviewResponse.ok) {
      log.error(`Bulk un-preview failed: ${unpreviewResponse.status} ${unpreviewResponse.statusText}`);
    } else {
      const unpreviewResult = await unpreviewResponse.json();
      log.debug(`Bulk un-preview job started: ${unpreviewResult.job?.name || unpreviewResult.name}`);
    }
  } catch (error) {
    log.error(`Error during bulk un-preview: ${error.message}`);
  }
}

/**
 * Unpublishes a file from admin.hlx.page.
 * @param {string} dataFolder - The data folder to unpublish
 * @param {object} env - Environment variables
 * @param {object} log - Logger instance
 */
export async function unpublishFromAdminHlx(dataFolder, env, log) {
  try {
    // First, get bulk status of all files under the folder to know what needs to be unpublished
    log.info(`Getting bulk status for folder: ${dataFolder}`);
    const jobName = await startBulkStatusJob(dataFolder, env, log);

    if (jobName) {
      // Poll the job until it completes
      const jobData = await pollJobStatus(jobName, env, log);

      // Extract all paths from the resources
      const paths = jobData?.data?.resources
        ?.filter((resource) => resource.path.startsWith(`/${dataFolder}`))
        .map((resource) => resource.path) || [];

      if (paths.length > 0) {
        log.info(`Found ${paths.length} paths to unpublish under folder ${dataFolder}`);
        // Bulk unpublish and un-preview all paths
        await bulkUnpublishPaths(paths, dataFolder, env, log);
      } else {
        log.debug(`No published paths found under folder ${dataFolder}`);
      }
    }
  } catch (error) {
    log.error(`Error during bulk unpublish for folder ${dataFolder}: ${error.message}`);
    // Don't throw - continue with folder deletion
  }
}

/**
 * Copies template files to SharePoint for a new LLMO onboarding.
 * @param {string} dataFolder - The data folder name
 * @param {object} context - The request context
 * @param {Function} say - Optional function to send messages (e.g., Slack say function)
 * @returns {Promise<void>}
 */
export async function copyFilesToSharepoint(dataFolder, context, say = () => {}) {
  const { log, env } = context;

  const sharepointClient = await createSharePointClient(env);

  log.debug(`Copying query-index to ${dataFolder}`);
  const folder = sharepointClient.getDocument(`/sites/elmo-ui-data/${dataFolder}/`);
  const templateQueryIndex = sharepointClient.getDocument('/sites/elmo-ui-data/template/query-index.xlsx');
  const newQueryIndex = sharepointClient.getDocument(`/sites/elmo-ui-data/${dataFolder}/query-index.xlsx`);

  const folderExists = await folder.exists();
  if (!folderExists) {
    const base = dataFolder.startsWith('dev/') ? '/dev' : '/';
    const folderName = dataFolder.startsWith('dev/') ? dataFolder.split('/')[1] : dataFolder;
    await folder.createFolder(folderName, base);
  } else {
    log.warn(`Warning: Folder ${dataFolder} already exists. Skipping creation.`);
    await say(`Folder ${dataFolder} already exists. Skipping creation.`);
  }

  const queryIndexExists = await newQueryIndex.exists();
  if (!queryIndexExists) {
    await templateQueryIndex.copy(`/${dataFolder}/query-index.xlsx`);
  } else {
    log.warn(`Warning: Query index at ${dataFolder} already exists. Skipping creation.`);
    await say(`Query index in ${dataFolder} already exists. Skipping creation.`);
  }
}

/**
 * Updates the helix-query.yaml configuration in GitHub.
 * @param {string} dataFolder - The data folder name
 * @param {object} context - The request context
 * @param {Function} say - Optional function to send messages (e.g., Slack say function)
 * @returns {Promise<void>}
 */
export async function updateIndexConfig(dataFolder, context, say = () => {}) {
  const { log, env } = context;

  log.debug('Starting Git modification of helix query config');
  const octokit = new Octokit({
    auth: env.LLMO_ONBOARDING_GITHUB_TOKEN,
  });

  const owner = 'adobe';
  const repo = 'project-elmo-ui-data';
  const ref = env.ENV === 'prod' ? 'main' : 'onboarding-bot-dev';
  const path = 'helix-query.yaml';

  const { data: file } = await octokit.repos.getContent({
    owner, repo, ref, path,
  });
  const content = Buffer.from(file.content, 'base64').toString('utf-8');

  if (content.includes(dataFolder)) {
    log.warn(`Helix query yaml already contains string ${dataFolder}. Skipping update.`);
    await say(`Helix query yaml already contains string ${dataFolder}. Skipping GitHub update.`);
    return;
  }

  // add new config to end of file
  const modifiedContent = `${content}${content.endsWith('\n') ? '' : '\n'}
  ${dataFolder}:
    <<: *default
    include:
      - '/${dataFolder}/**'
    target: /${dataFolder}/query-index.xlsx
`;

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    branch: ref,
    path,
    message: `Automation: Onboard ${dataFolder}`,
    content: Buffer.from(modifiedContent).toString('base64'),
    sha: file.sha,
  });
}

/**
 * Creates or finds an organization based on IMS Org ID.
 * @param {string} imsOrgId - The IMS Organization ID
 * @param {object} context - The request context
 * @param {Function} [say] - Optional callback function for sending Slack messages
 * @returns {Promise<object>} The organization object
 */
export async function createOrFindOrganization(imsOrgId, context, say = () => {}) {
  const { dataAccess, log, imsClient } = context;
  const { Organization } = dataAccess;

  // Check if organization already exists
  let organization = await Organization.findByImsOrgId(imsOrgId);

  if (organization) {
    log.debug(`Found existing organization for IMS Org ID: ${imsOrgId}`);
    return organization;
  }

  // Fetch real org name from IMS if client available
  let orgName = `Organization ${imsOrgId}`;
  if (imsClient) {
    try {
      const imsOrgDetails = await imsClient.getImsOrganizationDetails(imsOrgId);
      if (imsOrgDetails?.orgName) {
        orgName = imsOrgDetails.orgName;
      }
    } catch (error) {
      log.warn(`Could not fetch IMS org details for ${imsOrgId}: ${error.message}`);
    }
  }

  // Create new organization
  log.info(`Creating new organization for IMS Org ID: ${imsOrgId}`);
  say(`Creating organization for IMS Org ID: ${imsOrgId}`);

  organization = await Organization.create({
    name: orgName,
    imsOrgId,
  });

  log.info(`Created organization ${organization.getId()} for IMS Org ID: ${imsOrgId}`);
  return organization;
}

/**
 * Checks if a hostname has a non-www subdomain using the tldts library.
 * This properly handles all TLDs including multi-part TLDs like .co.uk, .com.au, etc.
 *
 * @param {string} hostname - The hostname to check (e.g., "blog.example.com")
 * @returns {boolean} - True if the hostname has a subdomain other than www
 *
 * @example
 * hasNonWWWSubdomain('example.com')           // false - apex domain
 * hasNonWWWSubdomain('www.example.com')       // false - only www subdomain
 * hasNonWWWSubdomain('blog.example.com')      // true - has subdomain
 * hasNonWWWSubdomain('blog.example.co.uk')    // true - has subdomain (multi-part TLD)
 * hasNonWWWSubdomain('example.co.uk')         // false - apex domain (multi-part TLD)
 */
function hasNonWWWSubdomain(hostname) {
  const parsed = parseDomain(hostname);

  // If parsing failed, be conservative and assume it's a subdomain
  /* c8 ignore next 3 */
  if (!parsed || !parsed.domain) {
    return true;
  }

  const subdomain = parsed.subdomain || '';
  return subdomain !== '' && subdomain !== 'www';
}

/**
 * Toggles the www subdomain in a given URL.
 * If the URL has www, it removes it. If it doesn't have www, it adds it.
 * Only works for URLs without other subdomains (e.g., blog.example.com).
 * For URLs with non-www subdomains, returns the original URL unchanged.
 *
 * @param {string} url - The URL to toggle (e.g., "https://example.com" or "https://www.example.com")
 * @returns {string} - The URL with www toggled, or the original URL if it has a subdomain
 */
function toggleWWW(url) {
  try {
    const urlObj = new URL(url);
    const { hostname } = urlObj;

    if (hasNonWWWSubdomain(hostname)) {
      return url;
    }

    // Safe to toggle www for apex domains
    if (hostname.startsWith('www.')) {
      urlObj.hostname = hostname.replace('www.', '');
    } else {
      urlObj.hostname = `www.${hostname}`;
    }

    // Preserve trailing slash consistency with the original URL
    const result = urlObj.toString();
    return result.endsWith('/') && !url.endsWith('/') ? result.slice(0, -1) : result;
    /* c8 ignore next 3 */
  } catch (error) {
    return url;
  }
}

/**
 * Tests a URL against the SEO top pages endpoint to see if it returns data.
 * @param {string} url - The URL to test
 * @param {object} seoClient - The SEO API client
 * @param {object} log - Logger instance
 * @returns {Promise<boolean>} - True if the URL returns top pages data, false otherwise
 */
async function testSeoTopPages(url, seoClient, log) {
  try {
    const { result } = await seoClient.getTopPages(url, { limit: 1 });
    const hasData = isNonEmptyArray(result?.pages);
    log.debug(`SEO top pages test for ${url}: ${hasData ? 'SUCCESS' : 'NO DATA'}`);
    return hasData;
  } catch (error) {
    log.debug(`SEO top pages test for ${url}: FAILED - ${error.message}`);
    return false;
  }
}

/**
 * Determines if overrideBaseURL should be set based on Ahrefs top pages data.
 * Tests both the base URL and its www-variant. If only the alternate variation succeeds,
 * returns that variation as the overrideBaseURL.
 *
 * @param {string} baseURL - The site's base URL
 * @param {object} context - The request context
 * @returns {Promise<string|null>} - The overrideBaseURL if needed, null otherwise
 */
export async function determineOverrideBaseURL(baseURL, context) {
  const { log } = context;

  try {
    log.info(`Determining overrideBaseURL for ${baseURL}`);
    const seoClient = SeoClient.createFrom(context);
    const alternateURL = toggleWWW(baseURL);

    // If toggleWWW returns the same URL, it means the URL has a subdomain
    // and we shouldn't try to toggle www (would create invalid nested subdomain)
    if (alternateURL === baseURL) {
      log.info(`Skipping overrideBaseURL detection for subdomain URL: ${baseURL}`);
      return null;
    }

    log.debug(`Testing base URL: ${baseURL} and alternate: ${alternateURL}`);

    const [baseURLSuccess, alternateURLSuccess] = await Promise.all([
      testSeoTopPages(baseURL, seoClient, log),
      testSeoTopPages(alternateURL, seoClient, log),
    ]);

    if (!baseURLSuccess && alternateURLSuccess) {
      log.info(`Setting overrideBaseURL to ${alternateURL} (base URL failed, alternate succeeded)`);
      return alternateURL;
    }

    if (baseURLSuccess && alternateURLSuccess) {
      log.debug('Both URLs succeeded, no overrideBaseURL needed');
    } else if (baseURLSuccess && !alternateURLSuccess) {
      log.debug('Base URL succeeded, no overrideBaseURL needed');
    } else {
      log.warn('Both URLs failed SEO top pages test, no overrideBaseURL set');
    }

    return null;
  } catch (error) {
    log.error(`Error determining overrideBaseURL: ${error.message}`, error);
    // Don't fail onboarding if this check fails
    return null;
  }
}

/**
 * Creates or finds a site based on baseURL.
 * @param {string} baseURL - The base URL of the site
 * @param {string} organizationId - The organization ID if we create a new site
 * @param {object} context - The request context
 * @param {string} [deliveryType] - The delivery type for the site
 * @returns {Promise<object>} The site object
 */
export async function createOrFindSite(baseURL, organizationId, context, deliveryType) {
  const { dataAccess } = context;
  const { Site } = dataAccess;

  const site = await Site.findByBaseURL(baseURL);
  if (site) {
    if (site.getOrganizationId() !== organizationId) {
      site.setOrganizationId(organizationId);
      // Persist the re-parent immediately. resolveLlmoOnboardingMode (called
      // right after this in performLlmoOnboarding) reads sites by org_id, so
      // the move must be visible to that query — otherwise a legacy site
      // re-parented into a brand-new org would be classified as v2 and create
      // an instant mixed v1/v2 state. (LLMO-4176)
      await site.save();
    }

    return site;
  }

  const siteData = { baseURL, organizationId };
  if (deliveryType) {
    siteData.deliveryType = deliveryType;
  }

  const newSite = await Site.create(siteData);
  return newSite;
}

/**
 * Deletes the SharePoint folder for a site.
 * @param {string} dataFolder - The data folder path
 * @param {object} context - The request context
 * @returns {Promise<void>}
 */
export async function deleteSharePointFolder(dataFolder, context) {
  const { log, env } = context;

  try {
    const sharepointClient = await createSharePointClient(env);
    const folder = sharepointClient.getDocument(`/sites/elmo-ui-data/${dataFolder}/`);
    const folderExists = await folder.exists();

    if (folderExists) {
      log.info(`Deleting SharePoint folder: /sites/elmo-ui-data/${dataFolder}/`);
      await folder.delete();
      log.info(`Successfully deleted SharePoint folder: ${dataFolder}`);
    } else {
      log.debug(`SharePoint folder does not exist: /sites/elmo-ui-data/${dataFolder}/`);
    }
  } catch (error) {
    log.error(`Error deleting SharePoint folder ${dataFolder}: ${error.message}`);
    // Don't throw - allow offboarding to continue
  }

  await unpublishFromAdminHlx(dataFolder, env, log);
}

/**
 * Revokes the LLMO enrollment for a site.
 * @param {object} site - The site object
 * @param {object} context - The request context
 * @returns {Promise<void>}
 */
export async function revokeEnrollment(site, context) {
  const { log } = context;
  const siteId = site.getId();

  try {
    log.info(`Revoking LLMO enrollment for site ${siteId}`);
    const tierClient = await TierClient.createForSite(context, site, LLMO_PRODUCT_CODE);
    await tierClient.revokeSiteEnrollment();
    log.info(`Successfully revoked LLMO enrollment for site ${siteId}`);
  } catch (error) {
    log.error(`Error revoking LLMO enrollment for site ${siteId}: ${error.message}`);
    // Don't throw - allow offboarding to continue
  }
}

/**
 * Removes LLMO configuration from the site config.
 * @param {object} site - The site object
 * @param {object} config - The site config object
 * @param {object} context - The request context
 * @returns {Promise<void>}
 */
export async function removeLlmoConfig(site, config, context) {
  const { log } = context;
  const siteId = site.getId();

  log.info(`Removing LLMO configuration from site ${siteId}`);

  // LLMO-only audits we can disable safely
  const AUDITS_TO_DISABLE = [
    'llmo-customer-analysis',
    'llm-blocked',
    'llm-error-pages',
    'cdn-logs-analysis',
    'cdn-logs-report',
    'wikipedia-analysis',
  ];

  // Update configuration to disable audits
  const { dataAccess } = context;
  const { Configuration } = dataAccess;
  const configuration = await Configuration.findLatest();
  AUDITS_TO_DISABLE.forEach((audit) => {
    configuration.disableHandlerForSite(audit, site);
  });
  await configuration.save();

  // Save the updated site config
  const dynamoItem = Config.toDynamoItem(config);
  delete dynamoItem.llmo;
  site.setConfig(dynamoItem);
  await site.save();

  log.info(`Successfully removed LLMO configuration for site ${siteId}`);
}

/**
 * Creates entitlement and enrollment for LLMO.
 * @param {object} site - The site object
 * @param {object} context - The request context
 * @param {Function} say - Optional function to send messages (e.g., Slack say function)
 * @returns {Promise<object>} The entitlement and enrollment objects
 */
export async function createEntitlementAndEnrollment(site, context, say = () => {}) {
  const { log } = context;

  try {
    const tierClient = await TierClient.createForSite(context, site, LLMO_PRODUCT_CODE);
    const { entitlement, siteEnrollment } = await tierClient.createEntitlement(LLMO_TIER);
    log.info(`Successfully ensured LLMO access for site ${site.getId()} via entitlement ${entitlement.getId()} and enrollment ${siteEnrollment.getId()}`);

    return {
      entitlement,
      enrollment: siteEnrollment,
    };
  } catch (error) {
    log.info(`Ensuring LLMO entitlement and enrollment failed: ${error.message}`);
    await say('❌ Ensuring LLMO entitlement and enrollment failed');
    throw error;
  }
}

/**
 * Enables audits for a site. Continues processing if individual audits fail.
 * @param {object} site - The site object
 * @param {object} context - The request context
 * @param {Array<string>} [audits=[]] - List of audit types to enable
 * @param {Function} [say] - Optional callback for sending messages (e.g., Slack)
 */
export async function enableAudits(site, context, audits = [], say = () => {}) {
  const { dataAccess, log } = context;
  const { Configuration } = dataAccess;

  const configuration = await Configuration.findLatest();

  audits.forEach((audit) => {
    try {
      configuration.enableHandlerForSite(audit, site);
    } catch (error) {
      log.warn(`Failed to enable audit '${audit}' for site ${site.getId()}: ${error.message}`);
      say(`:warning: Failed to enable audit '${audit}': ${error.message}`);
    }
  });

  await configuration.save();
}

/**
 * Enables imports for a site config. Continues processing if individual imports fail.
 * @param {object} siteConfig - The site configuration object
 * @param {Array<{type: string, options?: object}>} imports - List of imports to enable
 * @param {object} log - Logger instance
 * @param {Function} [say] - Optional callback for sending messages (e.g., Slack)
 */
export async function enableImports(siteConfig, imports, log, say = () => {}) {
  const existingImports = siteConfig.getImports();

  imports.forEach(({ type, options }) => {
    try {
      // Check if import is already enabled
      const isEnabled = existingImports?.find(
        (imp) => imp.type === type && imp.enabled,
      );

      if (!isEnabled) {
        siteConfig.enableImport(type, options);
      }
    } catch (error) {
      log.warn(`Failed to enable import '${type}': ${error.message}`);
      say(`:warning: Failed to enable import '${type}': ${error.message}`);
    }
  });
}

export async function triggerAudits(audits, context, site) {
  const { sqs, dataAccess, log } = context;
  const { Configuration } = dataAccess;
  const configuration = await Configuration.findLatest();

  await Promise.allSettled(
    audits.map(async (audit) => {
      log.info(`Triggering ${audit} audit for site: ${site.getId()}`);
      await sqs.sendMessage(configuration.getQueues().audits, {
        type: audit,
        siteId: site.getId(),
      });
    }),
  );
}

export async function enqueueLlmoOnboardingPublish(context, site, dataFolder) {
  const { sqs, dataAccess, log } = context;
  const { Configuration } = dataAccess;
  const configuration = await Configuration.findLatest();

  await sqs.sendMessage(configuration.getQueues().audits, {
    type: LLMO_ONBOARDING_PUBLISH_TRIGGER,
    siteId: site.getId(),
    auditContext: {
      dataFolder,
    },
  });

  log.info(`Queued ${LLMO_ONBOARDING_PUBLISH_TRIGGER} for site ${site.getId()}`);
}

/**
 * Complete LLMO onboarding process.
 * @param {object} params - Onboarding parameters
 * @param {string} [params.domain] - The domain name (alternative to baseURL)
 * @param {string} [params.baseURL] - The base URL (alternative to domain)
 * @param {string} params.brandName - The brand name
 * @param {string} params.imsOrgId - The IMS Organization ID
 * @param {string} [params.deliveryType] - The delivery type for site creation
 * @param {boolean} [params.tempOnboarding] - When true, skips updating helix-query.yaml in GitHub.
 *   HTTP clients set this via the `temp-onboarding` body field.
 * @param {object} context - The request context
 * @param {Function} [say] - Optional function to send progress messages
 * @returns {Promise<object>} Onboarding result
 */
export async function performLlmoOnboarding(params, context, say = () => {}) {
  const {
    domain, baseURL: providedBaseURL, brandName, imsOrgId, deliveryType,
    tempOnboarding,
  } = params;
  const { env, log } = context;

  // Support both domain (HTTP) and baseURL (Slack) inputs
  const baseURL = providedBaseURL || composeBaseURL(domain);
  const dataFolder = generateDataFolder(baseURL, env.ENV);

  let site;
  let detectedCdn = null;
  try {
    log.info(`Starting LLMO onboarding for IMS org ${imsOrgId}, baseURL ${baseURL}, brand ${brandName}`);

    // Create or find organization
    const organization = await createOrFindOrganization(imsOrgId, context, say);

    // Create site BEFORE resolving the onboarding mode. createOrFindSite may
    // re-parent an existing site into the destination org; resolveLlmoOnboardingMode
    // reads Site.allByOrganizationId, so the re-parent has to be persisted first
    // (createOrFindSite saves the site in that branch). Otherwise a legacy
    // pre-cutoff site moved into a brand-new org would be misclassified as v2
    // and instantly create the mixed state LLMO-4176 was filed to prevent.
    site = await createOrFindSite(baseURL, organization.getId(), context, deliveryType);

    const onboardingMode = await resolveLlmoOnboardingMode(organization.getId(), context);

    log.info(`Created site ${site.getId()} for ${baseURL} using LLMO onboarding mode ${onboardingMode}`);

    // Create entitlement and enrollment
    await createEntitlementAndEnrollment(site, context, say);

    // Copy files to SharePoint
    await copyFilesToSharepoint(dataFolder, context, say);

    try {
      await enqueueLlmoOnboardingPublish(context, site, dataFolder);
    } catch (error) {
      log.warn(`Failed to enqueue ${LLMO_ONBOARDING_PUBLISH_TRIGGER} for site ${site.getId()}: ${error.message}`);
    }

    // Update helix-query.yaml in project-elmo-ui-data (skip for temporary onboarding)
    if (tempOnboarding) {
      log.info(`Skipping helix-query.yaml update (temp-onboarding) for data folder ${dataFolder}`);
      await say(`:information_source: Skipping helix-query.yaml update (temp-onboarding) for ${dataFolder}`);
    } else {
      await updateIndexConfig(dataFolder, context, say);
    }

    // Enable audits (continues on partial failure, logs warnings)
    await enableAudits(
      site,
      context,
      [...BASIC_AUDITS, 'llm-error-pages', 'llmo-customer-analysis', 'wikipedia-analysis'],
      say,
    );

    // Get current site config
    const siteConfig = site.getConfig();

    // Enable imports (continues on partial failure, logs warnings)
    await enableImports(siteConfig, [{ type: 'top-pages' }], log, say);

    // Update brand and data directory
    siteConfig.updateLlmoBrand(brandName.trim());
    siteConfig.updateLlmoDataFolder(dataFolder.trim());

    // Determine and set overrideBaseURL if needed
    /* c8 ignore next */
    const currentFetchConfig = siteConfig.getFetchConfig() || {};

    // Only determine override if one doesn't already exist
    if (!currentFetchConfig.overrideBaseURL) {
      const overrideBaseURL = await determineOverrideBaseURL(baseURL, context);
      if (overrideBaseURL) {
        siteConfig.updateFetchConfig({
          ...currentFetchConfig,
          overrideBaseURL,
        });
        log.info(`Set overrideBaseURL to ${overrideBaseURL} for site ${site.getId()}`);
        say(`:arrows_counterclockwise: Set overrideBaseURL to ${overrideBaseURL}`);
      }
    } else {
      log.info(`Site ${site.getId()} already has overrideBaseURL: ${currentFetchConfig.overrideBaseURL}, skipping auto-detection`);
    }

    try {
      detectedCdn = await detectCdnForDomain(new URL(baseURL).hostname, log);
      if (detectedCdn) {
        siteConfig.updateLlmoDetectedCdn?.(detectedCdn);
        log.info(`Detected CDN ${detectedCdn} for site ${site.getId()}`);
        say(`:mag: Detected CDN: ${detectedCdn}`);
      } else {
        log.info(`CDN detection inconclusive for site ${site.getId()}`);
      }
    } catch (cdnError) {
      log.warn(`CDN detection failed for site ${site.getId()}: ${cdnError.message}`);
    }

    // update the site config object
    site.setConfig(Config.toDynamoItem(siteConfig));
    await site.save();

    if (onboardingMode === LLMO_ONBOARDING_MODE_V2) {
      await ensureInitialCustomerConfigV2({
        organizationId: organization.getId(),
        brandName,
        imsOrgId,
        siteId: site.getId(),
        baseURL,
        overrideBaseURL: siteConfig.getFetchConfig?.()?.overrideBaseURL,
        context,
      });

      // Enable brandalf flag so DRS scheduler uses v2 prompts for this org
      const postgrestClient = context.dataAccess?.services?.postgrestClient;
      await upsertFeatureFlag({
        organizationId: organization.getId(),
        product: LLMO_FEATURE_FLAG_PRODUCT,
        flagName: LLMO_BRANDALF_FLAG,
        value: true,
        updatedBy: 'llmo-onboarding',
        postgrestClient,
      });
      log.info(`Enabled brandalf feature flag for organization ${organization.getId()}`);

      // Write initial brand to normalized brands table so DRS prompt sync can
      // find it via GET /v2/orgs/{orgId}/brands before the Brandalf job finishes.
      // Brandalf will upsert over this with LLM-identified sub-brands later.
      // Use baseURL (matches sites.base_url) so syncBrandSites can link the brand
      // to the site. overrideBaseURL may differ (e.g., www.blick.ch vs blick.ch)
      // and would fail the exact-match lookup against the sites table.
      try {
        await upsertBrand({
          organizationId: organization.getId(),
          brand: {
            name: brandName.trim(),
            status: 'active',
            baseSiteId: site.getId(),
            urls: [{ value: baseURL, type: 'base' }],
            brandAliases: [{ name: brandName.trim(), regions: ['gl'] }],
          },
          postgrestClient,
          updatedBy: 'llmo-onboarding',
        });
        log.info(`Created initial brand "${brandName}" in normalized table for site ${site.getId()}`);
      } catch (brandError) {
        log.warn(`Failed to create initial brand in normalized table: ${brandError.message}`);
      }

      // Trigger Brandalf immediately after the v2 config exists so downstream
      // brand sync can attach results to the newly created organization.
      try {
        const drsClient = DrsClient.createFrom(context);
        if (drsClient.isConfigured()) {
          const companyWebsite = siteConfig.getFetchConfig?.()?.overrideBaseURL || baseURL;
          await triggerBrandalfOnboardingJob({
            drsClient,
            organizationId: organization.getId(),
            siteId: site.getId(),
            imsOrgId,
            brandName: brandName.trim(),
            companyWebsite,
            onboardingMode,
            log,
            say,
          });
        } else {
          log.debug('DRS client not configured, skipping Brandalf flow');
        }
      } catch (drsError) {
        log.error(`Failed to start DRS Brandalf flow: ${drsError.message}`);
        say(':warning: Failed to start DRS Brandalf flow (will need manual trigger)');
      }
    } else {
      log.info(`Skipping v2 customer config initialization and Brandalf flow for site ${site.getId()} in ${LLMO_ONBOARDING_MODE_V1} mode`);

      // V1 has no Brandalf trigger, so DRS will not submit prompt generation
      // automatically. Submit it directly here so v1 onboardings still get
      // prompts written to the legacy LLMO config (LLMO-4534).
      try {
        const drsClient = DrsClient.createFrom(context);
        if (drsClient.isConfigured()) {
          const trimmedBrand = brandName.trim();
          const brandProfile = siteConfig.getBrandProfile?.();
          // LLMO-4534: v1 fallback audience is English-only. v2 onboardings get a
          // locale-aware audience from brand_profile.main_profile.target_audience.
          const audience = brandProfile?.main_profile?.target_audience
            || `General consumers interested in ${trimmedBrand} products and services`;

          // The audit-worker `drs-prompt-generation` handler takes the legacy LLMO
          // config write path when `onboarding_mode` is absent from the DRS job
          // metadata. Do NOT pass `onboarding_mode` here — adding it would route v1
          // prompts to the v2 customer-config storage and break v1 onboardings.
          const drsJob = await drsClient.submitPromptGenerationJob({
            baseUrl: siteConfig.getFetchConfig?.()?.overrideBaseURL || baseURL,
            brandName: trimmedBrand,
            audience,
            siteId: site.getId(),
            imsOrgId,
          });
          if (!drsJob?.job_id) {
            throw new Error('DRS submitPromptGenerationJob returned no job_id');
          }
          log.info(`Started DRS prompt generation: job=${drsJob.job_id}`);
          say(`:robot_face: Started DRS prompt generation job: ${drsJob.job_id}`);
        } else {
          log.debug('DRS client not configured, skipping prompt generation');
        }
      } catch (drsError) {
        log.error(`Failed to start DRS prompt generation: ${drsError.message}`);
        say(`:warning: Failed to start DRS prompt generation for site ${site.getId()} (will need manual trigger)`);
      }
    }

    // Trigger audits (llmo-customer-analysis is NOT triggered here; it will be triggered
    // after the DRS prompt generation job completes, via SNS → audit-worker. LLMO-1819)
    await triggerAudits([...BASIC_AUDITS, 'wikipedia-analysis'], context, site);

    return {
      site,
      siteId: site.getId(),
      organizationId: organization.getId(),
      baseURL,
      dataFolder,
      detectedCdn,
      message: 'LLMO onboarding completed successfully',
    };
  } catch (error) {
    log.error(`Error during LLMO onboarding: ${error.message}. Attempting cleanup.`);

    // Attempt cleanup
    await deleteSharePointFolder(dataFolder, context);
    if (site) {
      await revokeEnrollment(site, context);
    }
    // Note: some config may already be persisted (audits, v2 customer config).
    // Full rollback is not attempted; cleanup is limited to SharePoint and enrollment.
    throw error;
  }
}

/**
 * Complete LLMO offboarding process.
 * @param {object} site - The validated site object
 * @param {object} config - The site config object
 * @param {object} context - The request context
 * @returns {Promise<object>} Offboarding result
 */
export async function performLlmoOffboarding(site, config, context) {
  const { log, env } = context;
  const siteId = site.getId();

  log.info(`Starting LLMO offboarding process for site: ${siteId}`);

  const baseURL = site.getBaseURL();
  const llmoConfig = config.getLlmoConfig();

  // Check if site has LLMO config with data folder, if not calculate it
  let dataFolder = llmoConfig?.dataFolder;
  if (!dataFolder) {
    log.debug(`Data folder not found in LLMO config, calculating from base URL: ${baseURL}`);
    dataFolder = generateDataFolder(baseURL, env.ENV);
  }

  log.info(`Offboarding site ${siteId} with domain ${baseURL} and data folder ${dataFolder}`);

  // Delete SharePoint folder
  await deleteSharePointFolder(dataFolder, context);

  // Revoke site enrollment
  await revokeEnrollment(site, context);

  // Remove LLMO configuration
  await removeLlmoConfig(site, config, context);

  log.info(`LLMO offboarding process completed for site ${siteId}`);

  return {
    siteId,
    baseURL,
    dataFolder,
    message: 'LLMO offboarding completed successfully',
  };
}

export async function appendRowsToQueryIndex(dataFolder, fileNames, env, log) {
  const sharepointClient = await createSharePointClient(env);
  const redirects = sharepointClient.getRedirects();

  const now = Math.floor(Date.now() / 1000);
  const rows = fileNames.map((fileName) => {
    const name = fileName.endsWith('.json') ? fileName : `${fileName}.json`;
    return [
      `/${dataFolder}/${name}`,
      now,
      now,
    ];
  });

  log.info(`Appending ${rows.length} rows to query-index.xlsx in ${dataFolder}`);
  await redirects.appendRowsToSheet(`/${dataFolder}/query-index.xlsx`, rows);
  log.info(`Successfully appended rows to query-index.xlsx in ${dataFolder}`);
}

export async function previewAndPublishQueryIndex(dataFolder, env, log) {
  const org = 'adobe';
  const site = 'project-elmo-ui-data';
  const ref = 'main';
  const baseUrl = 'https://admin.hlx.page';
  const filePath = `${dataFolder}/query-index.json`;

  if (!env.HLX_ONBOARDING_TOKEN) {
    throw new Error('HLX_ONBOARDING_TOKEN is not set');
  }

  const headers = {
    Cookie: `auth_token=${env.HLX_ONBOARDING_TOKEN}`,
  };

  const fetchOptions = { method: 'POST', headers, timeout: 30000 };

  const previewUrl = `${baseUrl}/preview/${org}/${site}/${ref}/${filePath}`;
  log.info(`Previewing query-index at ${previewUrl}`);
  const previewResponse = await fetch(previewUrl, fetchOptions);
  if (!previewResponse.ok) {
    const errorCode = previewResponse.headers?.get('x-error-code') || '';
    const errorMsg = previewResponse.headers?.get('x-error') || '';
    let bodyText = '';
    try {
      bodyText = await previewResponse.text();
    } catch {
      /* noop */
    }
    log.error(`Preview failed: ${previewResponse.status} ${previewResponse.statusText} | x-error-code: ${errorCode} | x-error: ${errorMsg} | body: ${bodyText}`);
    throw new Error(`Preview failed: ${previewResponse.status} ${previewResponse.statusText}`);
  }
  log.info('Preview of query-index succeeded');

  const publishUrl = `${baseUrl}/live/${org}/${site}/${ref}/${filePath}`;
  log.info(`Publishing query-index at ${publishUrl}`);
  const publishResponse = await fetch(publishUrl, fetchOptions);
  if (!publishResponse.ok) {
    const errorCode = publishResponse.headers?.get('x-error-code') || '';
    const errorMsg = publishResponse.headers?.get('x-error') || '';
    let bodyText = '';
    try {
      bodyText = await publishResponse.text();
    } catch {
      /* noop */
    }
    log.error(`Publish failed: ${publishResponse.status} ${publishResponse.statusText} | x-error-code: ${errorCode} | x-error: ${errorMsg} | body: ${bodyText}`);
    throw new Error(`Publish failed: ${publishResponse.status} ${publishResponse.statusText}`);
  }
  log.info('Publish of query-index succeeded');
}
