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
import { composeBaseURL, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';

// LLMO Constants
const LLMO_PRODUCT_CODE = EntitlementModel.PRODUCT_CODES.LLMO;
const LLMO_TIER = EntitlementModel.TIERS.FREE_TRIAL;
const SHAREPOINT_URL = 'https://adobe.sharepoint.com/:x:/r/sites/HelixProjects/Shared%20Documents/sites/elmo-ui-data';

// These audits don't depend on any additonal data being configured
export const BASIC_AUDITS = [
  'headings',
  'llm-blocked',
  'canonical',
  'hreflang',
  'summarization',
  'prerender',
];

export const ASO_DEMO_ORG = '66331367-70e6-4a49-8445-4f6d9c265af9';

export const ASO_CRITICAL_SITES = [
  'bed9197a-bd50-442d-93d4-ce7b39f6b8ad',
  'd9bd3ce3-8266-40bd-9ba7-00ee1ec0e5a3',
  '99f358de-fed1-47ea-a3a8-eb64c3ed9b0e',
  '5a3449d9-94ed-4c0f-9249-c1f592c13a28',
  '8836462f-3819-4f31-afc0-aa57fd326f67',
  'c61a0556-8c4a-42a1-be43-7d9297138cbb',
  '014af735-2399-460a-8d0a-2d99a62c8d31',
  '536d9335-0389-41f1-9f1e-19f533f1b7a5',
  'd9c82ee0-1c3f-492f-b9c6-2b66c2314da6',
  '635c5051-1491-49ca-ae22-02ea2c3929db',
  '3c4e9f11-59e9-4b1a-ab84-42442eef4624',
  '32424aff-0084-42a5-9b5d-1bd46e75224c',
  '3d020e61-ce89-48ad-b539-ae052bac3aee',
  'd30cce24-5222-49aa-ba1f-97304f5400b1',
  '256c9e72-692d-4234-bf0e-c5d144fb6616',
  '430343e7-ddda-48f2-a5ee-74f05446c8e0',
  'ae3db999-a749-4fbd-a21b-2318094808b5',
];

/**
 * Generates the data folder name from a domain.
 * @param {string} domain - The domain name
 * @param {string} env - The environment (prod, dev, etc.)
 * @returns {string} The data folder name
 */
export function generateDataFolder(baseURL, env = 'dev') {
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
export async function validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context) {
  const { log, dataAccess, env } = context;
  const { Site, Organization } = dataAccess;

  try {
    // Check if SharePoint folder already exists
    const sharepointClient = await createSharePointClient(env);
    const folder = sharepointClient.getDocument(`/sites/elmo-ui-data/${dataFolder}/`);
    const folderExists = await folder.exists();

    if (folderExists) {
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
        return {
          isValid: false,
          error: `Site ${baseURL} has already been assigned to a different organization.`,
        };
      }
    } else if (existingSite.getOrganizationId() !== env.DEFAULT_ORGANIZATION_ID
        && existingSite.getOrganizationId() !== ASO_DEMO_ORG) {
      // if the organization doesn't exist, but the site does, check that the site isn't claimed yet
      // by another organization
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
 * Publishes a file to admin.hlx.page.
 * @param {string} filename - The filename to publish
 * @param {string} outputLocation - The output location
 * @param {object} log - Logger instance
 */
async function publishToAdminHlx(filename, outputLocation, log) {
  try {
    const org = 'adobe';
    const site = 'project-elmo-ui-data';
    const ref = 'main';
    const jsonFilename = `${filename.replace(/\.[^/.]+$/, '')}.json`;
    const path = `${outputLocation}/${jsonFilename}`;
    const headers = { Cookie: `auth_token=${process.env.HLX_ADMIN_TOKEN}` };

    if (!process.env.HLX_ADMIN_TOKEN) {
      log.warn('LLMO onboarding: HLX_ADMIN_TOKEN is not set');
    }

    const baseUrl = 'https://admin.hlx.page';
    const endpoints = [
      { name: 'preview', url: `${baseUrl}/preview/${org}/${site}/${ref}/${path}` },
      { name: 'live', url: `${baseUrl}/live/${org}/${site}/${ref}/${path}` },
    ];

    for (const [index, endpoint] of endpoints.entries()) {
      log.debug(`Publishing Excel report via admin API (${endpoint.name}): ${endpoint.url}`);

      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(endpoint.url, { method: 'POST', headers });

      if (!response.ok) {
        throw new Error(`${endpoint.name} failed: ${response.status} ${response.statusText}`);
      }

      log.debug(`Excel report successfully published to ${endpoint.name}`);

      if (index === 0) {
        // eslint-disable-next-line no-await-in-loop,max-statements-per-line
        await new Promise((resolve) => { setTimeout(resolve, 2000); });
      }
    }
  } catch (publishError) {
    log.error(`Failed to publish via admin.hlx.page: ${publishError.message}`);
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
    Cookie: `auth_token=${env.HLX_ADMIN_TOKEN}`,
    'Content-Type': 'application/json',
  };

  if (!env.HLX_ADMIN_TOKEN) {
    log.warn('LLMO offboarding: HLX_ADMIN_TOKEN is not set');
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
  const headers = { Cookie: `auth_token=${env.HLX_ADMIN_TOKEN}` };

  if (!env.HLX_ADMIN_TOKEN) {
    log.warn('LLMO offboarding: HLX_ADMIN_TOKEN is not set');
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
    Cookie: `auth_token=${env.HLX_ADMIN_TOKEN}`,
    'Content-Type': 'application/json',
  };

  if (!env.HLX_ADMIN_TOKEN) {
    log.warn('LLMO offboarding: HLX_ADMIN_TOKEN is not set');
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

  log.debug('Publishing query-index to admin.hlx.page');
  await publishToAdminHlx('query-index', dataFolder, log);
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
 * @param {object} slackContext - Slack context (optional, for Slack operations)
 * @returns {Promise<object>} The organization object
 */
export async function createOrFindOrganization(imsOrgId, context, say = () => {}) {
  const { dataAccess, log } = context;
  const { Organization } = dataAccess;

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
 * Creates or finds a site based on baseURL.
 * @param {string} baseURL - The base URL of the site
 * @param {string} organizationId - The organization ID if we create a new site
 * @param {object} context - The request context
 * @returns {Promise<object>} The site object
 */
export async function createOrFindSite(baseURL, organizationId, context) {
  const { dataAccess } = context;
  const { Site } = dataAccess;

  const site = await Site.findByBaseURL(baseURL);
  if (site) {
    if (site.getOrganizationId() !== organizationId) {
      site.setOrganizationId(organizationId);
    }

    return site;
  }

  const newSite = await Site.create({
    baseURL,
    organizationId,
  });
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
    'geo-brand-presence',
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

export async function enableAudits(site, context, audits = []) {
  const { dataAccess } = context;
  const { Configuration } = dataAccess;

  const configuration = await Configuration.findLatest();
  audits.forEach((audit) => {
    configuration.enableHandlerForSite(audit, site);
  });
  await configuration.save();
}

export async function enableImports(siteConfig, imports = []) {
  const existingImports = siteConfig.getImports();

  imports.forEach(({ type, options }) => {
    // Check if import is already enabled
    const isEnabled = existingImports?.find(
      (imp) => imp.type === type && imp.enabled,
    );

    if (!isEnabled) {
      siteConfig.enableImport(type, options);
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
  const { env, log } = context;

  // Construct base URL and data folder name
  const baseURL = composeBaseURL(domain);
  const dataFolder = generateDataFolder(baseURL, env.ENV);

  let site;
  try {
    log.info(`Starting LLMO onboarding for IMS org ${imsOrgId}, domain ${domain}, brand ${brandName}`);

    // Create or find organization
    const organization = await createOrFindOrganization(imsOrgId, context);

    // Create site
    site = await createOrFindSite(baseURL, organization.getId(), context);

    log.info(`Created site ${site.getId()} for ${baseURL}`);

    // Create entitlement and enrollment
    await createEntitlementAndEnrollment(site, context);

    // Copy files to SharePoint
    await copyFilesToSharepoint(dataFolder, context);

    // Update index config
    await updateIndexConfig(dataFolder, context);

    // Enable audits
    await enableAudits(site, context, [...BASIC_AUDITS, 'llm-error-pages', 'llmo-customer-analysis']);

    // Get current site config
    const siteConfig = site.getConfig();

    // Enable imports
    await enableImports(siteConfig, [
      { type: 'top-pages' },
    ]);

    // Update brand and data directory
    siteConfig.updateLlmoBrand(brandName.trim());
    siteConfig.updateLlmoDataFolder(dataFolder.trim());

    // update the site config object
    site.setConfig(Config.toDynamoItem(siteConfig));
    await site.save();

    // Trigger audits
    await triggerAudits([...BASIC_AUDITS, 'llmo-customer-analysis'], context, site);

    return {
      siteId: site.getId(),
      organizationId: organization.getId(),
      baseURL,
      dataFolder,
      message: 'LLMO onboarding completed successfully',
    };
  } catch (error) {
    log.error(`Error during LLMO onboarding: ${error.message}. Attempting cleanup.`);

    // Attempt cleanup
    await deleteSharePointFolder(dataFolder, context);
    if (site) {
      await revokeEnrollment(site, context);
    }
    // Rolling back llmo config is not required, as it's the last step and won't have been saved
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
