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

/* c8 ignore start */

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { createFrom } from '@adobe/spacecat-helix-content-sdk';
import { Octokit } from '@octokit/rest';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';
import TierClient from '@adobe/spacecat-shared-tier-client';

// LLMO Constants
const LLMO_PRODUCT_CODE = EntitlementModel.PRODUCT_CODES.LLMO;
const LLMO_TIER = EntitlementModel.TIERS.FREE_TRIAL;
const SHAREPOINT_URL = 'https://adobe.sharepoint.com/:x:/r/sites/HelixProjects/Shared%20Documents/sites/elmo-ui-data';

/**
 * Generates the data folder name from a domain.
 * @param {string} domain - The domain name
 * @param {string} env - The environment (prod, dev, etc.)
 * @returns {string} The data folder name
 */
export function generateDataFolder(domain, env = 'prod') {
  const baseURL = domain.startsWith('http') ? domain : `https://${domain}`;
  const { hostname } = new URL(baseURL);
  const dataFolderName = hostname.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  return env === 'prod' ? dataFolderName : `dev/${dataFolderName}`;
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
export async function validateSiteNotOnboarded(baseURL, dataFolder, context) {
  const { log, dataAccess, env } = context;
  const { Site } = dataAccess;

  try {
    // Check if site already exists in SpaceCat
    const existingSite = await Site.findByBaseURL(baseURL);
    // TODO we might want to support existing sites if they are not on LLMO but on spacecat.
    if (existingSite) {
      return {
        isValid: false,
        error: `Site ${baseURL} has already been onboarded to SpaceCat. Site ID: ${existingSite.getId()}`,
      };
    }

    // Check if SharePoint folder already exists
    const sharepointClient = await createSharePointClient(env);
    const folder = sharepointClient.getDocument(`/sites/elmo-ui-data/${dataFolder}/`);
    const folderExists = await folder.exists();

    if (folderExists) {
      return {
        isValid: false,
        error: `SharePoint folder '${dataFolder}' already exists. This indicates the site may have been partially onboarded.`,
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
 * Publishes a file to admin.hlx.page.
 * @param {string} filename - The filename to publish
 * @param {string} outputLocation - The output location
 * @param {object} log - Logger instance
 */
export async function publishToAdminHlx(filename, outputLocation, log) {
  try {
    const response = await fetch(`https://admin.hlx.page/preview/adobe/project-elmo-ui-data/main/${outputLocation}/${filename}`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    log.debug(`Successfully published ${filename} to admin.hlx.page`);
  } catch (publishError) {
    log.error(`Failed to publish via admin.hlx.page: ${publishError.message}`);
  }
}

/**
 * Copies template files to SharePoint for a new LLMO onboarding.
 * @param {string} dataFolder - The data folder name
 * @param {object} context - The request context
 * @param {object} slackContext - Slack context (optional, for Slack operations)
 * @returns {Promise<void>}
 */
export async function copyFilesToSharepoint(dataFolder, context) {
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
  }

  const queryIndexExists = await newQueryIndex.exists();
  if (!queryIndexExists) {
    await templateQueryIndex.copy(`/${dataFolder}/query-index.xlsx`);
  } else {
    log.warn(`Warning: Query index at ${dataFolder} already exists. Skipping creation.`);
  }

  log.debug('Publishing query-index to admin.hlx.page');
  await publishToAdminHlx('query-index', dataFolder, log);
}

/**
 * Updates the helix-query.yaml configuration in GitHub.
 * @param {string} dataFolder - The data folder name
 * @param {object} context - The request context
 * @param {object} slackContext - Slack context (optional, for Slack operations)
 * @returns {Promise<void>}
 */
export async function updateIndexConfig(dataFolder, context) {
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
 * @param {object} slackContext - Slack context (optional, for Slack operations)
 * @returns {Promise<object>} The organization object
 */
export async function createOrFindOrganization(imsOrgId, context, slackContext = null) {
  const { dataAccess, log } = context;
  const { Organization } = dataAccess;
  const { say } = slackContext || { say: () => {} };

  // Check if organization already exists
  let organization = await Organization.findByImsOrgId(imsOrgId);

  if (organization) {
    log.debug(`Found existing organization for IMS Org ID: ${imsOrgId}`);
    return organization;
  }

  // Create new organization
  log.info(`Creating new organization for IMS Org ID: ${imsOrgId}`);
  await say(`Creating organization for IMS Org ID: ${imsOrgId}`);

  organization = await Organization.create({
    name: `Organization ${imsOrgId}`,
    imsOrgId,
  });

  log.info(`Created organization ${organization.getId()} for IMS Org ID: ${imsOrgId}`);
  return organization;
}

/**
 * Creates entitlement and enrollment for LLMO.
 * @param {object} site - The site object
 * @param {object} context - The request context
 * @returns {Promise<void>}
 */
export async function createEntitlementAndEnrollment(site, context) {
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
    throw error;
  }
}

/**
 * Complete LLMO onboarding process.
 * @param {object} params - Onboarding parameters
 * @param {string} params.domain - The domain name
 * @param {string} params.brandName - The brand name
 * @param {string} params.imsOrgId - The IMS Organization ID
 * @param {object} context - The request context
 * @param {object} slackContext - Slack context (optional, for Slack operations)
 * @returns {Promise<object>} Onboarding result
 */
export async function performLlmoOnboarding(params, context) {
  const { domain, brandName, imsOrgId } = params;
  const { dataAccess, env, log } = context;
  const { Site } = dataAccess;

  // Construct base URL and data folder name
  const baseURL = domain.startsWith('http') ? domain : `https://${domain}`;
  const dataFolder = generateDataFolder(domain, env.ENV);

  log.info(`Starting LLMO onboarding for IMS org ${imsOrgId}, domain ${domain}, brand ${brandName}`);

  // Create or find organization
  const organization = await createOrFindOrganization(imsOrgId, context);

  // Create site
  const site = await Site.create({
    baseURL,
    organizationId: organization.getId(),
    isLive: true,
  });

  log.info(`Created site ${site.getId()} for ${baseURL}`);

  // Create entitlement and enrollment
  await createEntitlementAndEnrollment(site, context);

  // Copy files to SharePoint
  await copyFilesToSharepoint(dataFolder, context);

  // Update index config
  await updateIndexConfig(dataFolder, context);

  // Get current site config
  const siteConfig = site.getConfig();

  // Update brand and data directory
  siteConfig.updateLlmoBrand(brandName.trim());
  siteConfig.updateLlmoDataFolder(dataFolder.trim());

  // update the site config object
  site.setConfig(Config.toDynamoItem(siteConfig));
  await site.save();

  return {
    siteId: site.getId(),
    organizationId: organization.getId(),
    baseURL,
    dataFolder,
    message: 'LLMO onboarding completed successfully',
  };
}
/* c8 ignore end */
