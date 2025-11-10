/*
 * Copyright 2023 Adobe. All rights reserved.
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
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { ImsPromiseClient } from '@adobe/spacecat-shared-ims-client';
import URI from 'urijs';
import {
  hasText,
  tracingFetch as fetch,
  isValidUrl,
  isObject,
  isNonEmptyObject,
  resolveCanonicalUrl, isValidIMSOrgId,
  detectAEMVersion,
  detectLocale,
} from '@adobe/spacecat-shared-utils';
import TierClient from '@adobe/spacecat-shared-tier-client';
import { iso6393 } from 'iso-639-3';
import worldCountries from 'world-countries';

import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  STATUS_BAD_REQUEST,
} from '../utils/constants.js';

/**
 * Checks if the url parameter "url" equals "ALL".
 * @param {string} url - URL parameter.
 * @returns {boolean} True if url equals "ALL", false otherwise.
 */
export const isAuditForAllUrls = (url) => url.toUpperCase() === 'ALL';

/**
 * Checks if the deliveryType parameter "deliveryType" equals "ALL".
 * @param {string} deliveryType - deliveryType parameter.
 * @returns {boolean} True if deliveryType equals "ALL", false otherwise.
 */
export const isAuditForAllDeliveryTypes = (deliveryType) => deliveryType.toUpperCase() === 'ALL';

/**
 * Sends an audit message for a single URL.
 *
 * @param {Object} sqs - The SQS service object.
 * @param {string} queueUrl - The SQS queue URL.
 * @param {string} type - The type of audit.
 * @param {Object} auditContext - The audit context object.
 * @param {string} siteId - The site ID to audit.
 * @param {string} [auditData] - Optional audit data.
 * @returns {Promise} A promise representing the message sending operation.
 */
export const sendAuditMessage = async (
  sqs,
  queueUrl,
  type,
  auditContext,
  siteId,
  auditData,
) => sqs.sendMessage(queueUrl, {
  type,
  siteId,
  auditContext,
  data: auditData,
});

// todo: prototype - untested
/* c8 ignore start */
export const sendExperimentationCandidatesMessage = async (
  sqs,
  queueUrl,
  url,
  slackContext,
) => sqs.sendMessage(queueUrl, {
  processingType: 'experimentation-candidates-desktop',
  urls: [{ url }],
  slackContext,
});
/* c8 ignore end */

export const sentRunScraperMessage = async (
  sqs,
  queueUrl,
  jobId,
  urls,
  slackContext,
  allowCache = false,
) => sqs.sendMessage(queueUrl, {
  processingType: 'default',
  allowCache,
  jobId,
  urls: [...urls],
  slackContext,
});

// todo: prototype - untested
/* c8 ignore start */
/**
 * Sends a message to run an import job to the provided SQS queue.
 *
 * @param {Object} sqs
 * @param {string} queueUrl
 * @param {string} importType
 * @param {string} siteId
 * @param {string} startDate
 * @param {string} endDate
 * @param {Object} slackContext
 * @param {string} [pageUrl] - Optional page URL for the import
 * @param {Object} [data] - Optional data object for import-specific data
 */
export const sendRunImportMessage = async (
  sqs,
  queueUrl,
  importType,
  siteId,
  startDate,
  endDate,
  slackContext,
  pageUrl = undefined,
  data = undefined,
) => sqs.sendMessage(queueUrl, {
  type: importType,
  siteId,
  startDate,
  endDate,
  slackContext,
  pageUrl,
  ...(data && { data }),
});

export const sendAutofixMessage = async (
  sqs,
  queueUrl,
  siteId,
  opportunityId,
  suggestionIds,
  promiseToken,
  variations,
  action,
  customData,
  { url } = {},
) => sqs.sendMessage(queueUrl, {
  opportunityId,
  siteId,
  suggestionIds,
  promiseToken,
  variations,
  action,
  url,
  ...(customData && { customData }),
});
/* c8 ignore end */

export const sendInternalReportRunMessage = async (
  sqs,
  queueUrl,
  ReportType,
  slackContext,
) => sqs.sendMessage(queueUrl, {
  type: ReportType,
  slackContext,
});

export const sendReportTriggerMessage = async (
  sqs,
  queueUrl,
  data,
  ReportType,
) => sqs.sendMessage(queueUrl, {
  type: ReportType,
  data,
});

/**
 * Sends audit messages for each URL.
 *
 * @param {Object} sqs - The SQS service object.
 * @param {string} queueUrl - The SQS queue URL.
 * @param {string} type - The type of audit.
 * @param {Object} auditContext - The audit context object.
 * @param {Array<string>} siteIDsToAudit - An array of site IDs to audit.
 * @returns {Promise<string>} A promise that resolves to a status message.
 */
export const sendAuditMessages = async (
  sqs,
  queueUrl,
  type,
  auditContext,
  siteIDsToAudit,
) => {
  for (const siteId of siteIDsToAudit) {
    // eslint-disable-next-line no-await-in-loop
    await sendAuditMessage(sqs, queueUrl, type, auditContext, siteId);
  }
  return `Triggered ${type} audit for ${siteIDsToAudit.length > 1 ? `all ${siteIDsToAudit.length} sites` : siteIDsToAudit[0]}`;
};

/**
 * Triggers an audit for a site.
 * @param {Site} site - The site to audit.
 * @param {string} auditType - The type of audit.
 * @param {undefined|string} auditData - Optional audit data.
 * @param {Object} slackContext - The Slack context object.
 * @param {Object} lambdaContext - The Lambda context object.
 * @return {Promise} - A promise representing the audit trigger operation.
 */
export const triggerAuditForSite = async (
  site,
  auditType,
  auditData,
  slackContext,
  lambdaContext,
) => sendAuditMessage(
  lambdaContext.sqs,
  lambdaContext.env.AUDIT_JOBS_QUEUE_URL,
  auditType,
  {
    slackContext: {
      channelId: slackContext.channelId,
      threadTs: slackContext.threadTs,
    },
  },
  site.getId(),
  auditData,
);

// todo: prototype - untested
/* c8 ignore start */
export const triggerExperimentationCandidates = async (
  url,
  slackContext,
  lambdaContext,
) => sendExperimentationCandidatesMessage(
  lambdaContext.sqs,
  lambdaContext.env.SCRAPING_JOBS_QUEUE_URL,
  url,
  {
    channelId: slackContext.channelId,
    threadTs: slackContext.threadTs,
  },
);
/* c8 ignore end */

export const triggerScraperRun = async (
  jobId,
  urls,
  slackContext,
  lambdaContext,
  allowCache = false,
) => sentRunScraperMessage(
  lambdaContext.sqs,
  lambdaContext.env.SCRAPING_JOBS_QUEUE_URL,
  jobId,
  urls,
  {
    channelId: slackContext.channelId,
    threadTs: slackContext.threadTs,
  },
  allowCache,
);
// todo: prototype - untested
/* c8 ignore start */
/**
 * Triggers an import run by sending a message to the SQS queue.
 *
 * @param {Object} config
 * @param {string} importType
 * @param {string} siteId
 * @param {string} startDate
 * @param {string} endDate
 * @param {Object} slackContext
 * @param {Object} lambdaContext
 * @param {string} [pageUrl] - Optional page URL for the import
 * @param {Object} [data] - Optional data object for import-specific data
 */
export const triggerImportRun = async (
  config,
  importType,
  siteId,
  startDate,
  endDate,
  slackContext,
  lambdaContext,
  pageUrl,
  data,
) => sendRunImportMessage(
  lambdaContext.sqs,
  config.getQueues().imports,
  importType,
  siteId,
  startDate,
  endDate,
  {
    channelId: slackContext.channelId,
    threadTs: slackContext.threadTs,
  },
  pageUrl,
  data,
);
/* c8 ignore end */

export const triggerInternalReportRun = async (
  config,
  reportType,
  slackContext,
  lambdaContext,
) => sendInternalReportRunMessage(
  lambdaContext.sqs,
  config.getQueues().reports,
  reportType,
  {
    channelId: slackContext.channelId,
    threadTs: slackContext.threadTs,
  },
);

/**
 * Checks if a given URL corresponds to a Helix site.
 * @param {string} url - The URL to check.
 * @param {Object} [edgeConfig] - The optional edge configuration object.
 * @param {string} edgeConfig.hlxVersion - The Helix version of the site
 * @param {string} edgeConfig.cdnProdHostname - The CDN production hostname of the site
 * @param {string} edgeConfig.rso - The Helix Ref/Site/Owner information
 * @param {string} edgeConfig.rso.owner - The owner of the site
 * @param {string} edgeConfig.rso.ref - The ref of the site
 * @param {string} edgeConfig.rso.site - The name of the site
 * @returns {Promise<{ isHelix: boolean, reason?: string }>} A Promise that resolves to an object
 * containing the result of the Helix site check and an optional reason if it's not a Helix site.
 */
// todo: leverage the edgeConfig for alternate verification (e.g. due to bot protection)
// eslint-disable-next-line no-unused-vars
export async function isHelixSite(url, edgeConfig = {}) {
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    return {
      isHelix: false,
      reason: `Cannot fetch the site due to ${e.message}`,
    };
  }

  const dom = await resp.text();
  const { status } = resp;
  const headers = resp.headers.plain();

  const containsHelixDom = /<header><\/header>\s*<main>\s*<div>/.test(dom);

  if (!containsHelixDom) {
    return {
      isHelix: false,
      // if the DOM is not in helix format, log the response status, headers and first 100 chars
      // of <body> for debugging purposes
      reason: `DOM is not in helix format. Status: ${status}. Response headers: ${JSON.stringify(headers)}. Body: ${dom.includes('<body>') ? dom.substring(dom.indexOf('<body>'), dom.indexOf('<body>') + 100) : ''}`,
    };
  }

  return {
    isHelix: true,
  };
}

/**
 * Checks if a given URL corresponds to an AEM site.
 * @param {string} url - The URL to check.
 * @returns {Promise<{ isAEM: boolean, reason: string }>} A Promise that resolves to an object
 * containing the result of the AEM site check and a reason if it's not an AEM site.
 */
export async function isAEMSite(url) {
  let pageContent;
  try {
    const response = await fetch(url);
    pageContent = await response.text();
  } catch (e) {
    return {
      isAEM: false,
      reason: `Cannot fetch the site due to ${e.message}`,
    };
  }

  const aemTokens = ['/content/dam/', '/etc.clientlibs', 'cq:template', 'sling.resourceType'];
  const isAEM = aemTokens.some((token) => pageContent.includes(token));

  return {
    isAEM,
    reason: 'Does not contain AEM paths or meta properties',
  };
}

/**
 * Finds the delivery type of the site, url of which is provided.
 * @param {string} url - url of the site to find the delivery type for.
 * @returns {Promise<"aem_edge" | "aem_cs" | "aem_ams" | "aem_headless" | "other">}
 * A Promise that resolves to the delivery type of the site
 */
export async function findDeliveryType(url) {
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    return SiteModel.DELIVERY_TYPES.OTHER;
  }
  return detectAEMVersion(await resp.text());
}

/**
 * Error class with a status code property.
 * @extends Error
 */
export class ErrorWithStatusCode extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const wwwUrlResolver = (site) => {
  const baseURL = site.getBaseURL();
  const uri = new URI(baseURL);
  return hasText(uri.subdomain()) ? baseURL.replace(/https?:\/\//, '') : baseURL.replace(/https?:\/\//, 'www.');
};

/**
 * Get the IMS user token from the context.
 * @param {object} context - The context of the request.
 * @returns {string} imsUserToken - The IMS User access token.
 * @throws {ErrorWithStatusCode} - If the Authorization header is missing.
 */
export function getImsUserToken(context) {
  const authorizationHeader = context.pathInfo?.headers?.authorization;
  const BEARER_PREFIX = 'Bearer ';
  if (!hasText(authorizationHeader) || !authorizationHeader.startsWith(BEARER_PREFIX)) {
    throw new ErrorWithStatusCode('Missing Authorization header', STATUS_BAD_REQUEST);
  }
  return authorizationHeader.substring(BEARER_PREFIX.length);
}

/**
 * Get an IMS promise token from the authorization header in context.
 * @param {object} context - The context of the request.
 * @returns {Promise<{
 *   promise_token: string,
 *   expires_in: number,
 *   token_type: string,
 * }>} - The promise token response.
 * @throws {ErrorWithStatusCode} - If the Authorization header is missing.
 */
export async function getIMSPromiseToken(context) {
  // get IMS promise token and attach to queue message
  let userToken;
  try {
    userToken = await getImsUserToken(context);
  } catch (e) {
    throw new ErrorWithStatusCode('Missing Authorization header', STATUS_BAD_REQUEST);
  }
  const imsPromiseClient = ImsPromiseClient.createFrom(
    context,
    ImsPromiseClient.CLIENT_TYPE.EMITTER,
  );

  return imsPromiseClient.getPromiseToken(
    userToken,
    context.env?.AUTOFIX_CRYPT_SECRET && context.env?.AUTOFIX_CRYPT_SALT,
  );
}

/**
 * Build an S3 prefix for site content files.
 * @param {string} type - The type of content (e.g., 'scrapes', 'imports', 'accessibility').
 * @param {string} siteId - The site ID.
 * @param {string} [path] - Optional sub-path.
 * @returns {string} The S3 prefix string.
 */
export function buildS3Prefix(type, siteId, path = '') {
  const normalized = path ? `${path.replace(/^\/+/g, '').replace(/\/+$/g, '')}/` : '';
  return `${type}/${siteId}/${normalized}`;
}

/**
 * Checks if an import type is already enabled for a site.
 *
 * @param {string} importType - The import type to check.
 * @param {Array} imports - Array of import configurations.
 * @returns {boolean} - True if import is enabled, false otherwise.
 */
const isImportEnabled = (importType, imports) => {
  const foundImport = imports?.find((importConfig) => importConfig.type === importType);
  // If import is found, check if it's enabled, otherwise assume it's not enabled (false)
  return foundImport ? foundImport.enabled : false;
};

/**
 * Derives a project name from a base URL.
 *
 * @param {string} baseURL - The base URL
 * @returns {string} The derived project name.
 */
export const deriveProjectName = (baseURL) => {
  const parsedBaseURL = new URL(baseURL);
  const { hostname } = parsedBaseURL;

  // Split hostname by dots, if it has 3 or more parts, we assume it has a subdomain.
  const parts = hostname.split('.');
  if (parts.length <= 2) {
    return hostname;
  }

  // Remove parts of the subdomain which are 2 or 3 letters long, max first two elements
  for (let i = 0; i < Math.min(parts.length, 2); i += 1) {
    const part = parts[i];
    if (part.length === 2 || part.length === 3) {
      parts[i] = null;
    }
  }

  return parts.filter(Boolean).join('.');
};

/**
 * Creates a new project if it does not exist yet.
 *
 * @param {Object} context - The Lambda context object.
 * @param {Object} slackContext - The Slack context object.
 * @param {string} baseURL - The base URL of the site.
 * @param {string} projectId - The project ID.
 * @returns {Promise<Object>} - The project object.
 */
export const createProject = async (
  context,
  slackContext,
  baseURL,
  organizationId,
  projectId,
) => {
  const { dataAccess, log } = context;
  const { say } = slackContext;
  const { Project } = dataAccess;

  try {
    const projectName = deriveProjectName(baseURL);

    // Find existing project if project id is provided
    let existingProject;
    if (projectId) {
      const project = await Project.findById(projectId);
      if (project) {
        existingProject = project;
      }
    }

    // Find existing project in the same org with the same name
    if (!existingProject) {
      const foundProject = (await Project.allByOrganizationId(organizationId))
        .find((p) => p.getProjectName() === projectName);
      if (foundProject) {
        existingProject = foundProject;
      }
    }

    if (existingProject) {
      const message = `:information_source: Added site ${baseURL} to existing project ${existingProject.getProjectName()}. Project ID: ${existingProject.getId()}`;
      await say(message);
      return existingProject;
    }

    // Otherwise create new project
    const newProject = await Project.create({ projectName, organizationId });
    const message = `:information_source: Added site ${baseURL} to new project ${newProject.getProjectName()}. Project ID: ${newProject.getId()}`;
    await say(message);

    return newProject;
  } catch (error) {
    log.error(`Error creating project: ${error.message}`);
    await say(`:x: Error creating project: ${error.message}`);
    throw error;
  }
};

/**
 * Creates or retrieves a site and its associated organization.
 *
 * @param {string} baseURL - The site base URL.
 * @param {string} imsOrgID - The IMS Organization ID.
 * @param {string} authoringType - The authoring type of the site.
 * @param {string} customDeliveryType - The delivery type of the site.
 * @param {Object} slackContext - The Slack context object.
 * @param {Object} reportLine - The report line object to update.
 * @param {Object} context - The Lambda context containing dataAccess, log, etc.
 * @param {Object} deliveryConfig - Optional delivery config to set on the site.
 * @returns {Promise<Object>} - Object containing the site and organizationId.
 */
const createSiteAndOrganization = async (
  baseURL,
  imsOrgID,
  authoringType,
  customDeliveryType,
  slackContext,
  reportLine,
  context,
  deliveryConfig,
) => {
  const { imsClient, dataAccess, log } = context;
  const { Site, Organization } = dataAccess;
  const { say } = slackContext;
  // Create a local copy to avoid modifying the parameter directly
  const localReportLine = { ...reportLine };

  let site = await Site.findByBaseURL(baseURL);
  let organizationId;

  if (site) {
    const siteOrgId = site.getOrganizationId();
    organizationId = siteOrgId; // Set organizationId for existing sites
    const message = `:information_source: Site ${baseURL} already exists. Organization ID: ${siteOrgId}`;
    await say(message);
  } else {
    // Check if the organization with IMS Org ID already exists; create if it doesn't
    let organization = await Organization.findByImsOrgId(imsOrgID);
    if (!organization) {
      const imsOrgDetails = await imsClient.getImsOrganizationDetails(imsOrgID);
      if (!imsOrgDetails) {
        localReportLine.errors = `Could not find details of IMS org with the ID *${imsOrgID}*.`;
        localReportLine.status = 'Failed';
        throw new Error(localReportLine.errors);
      }
      organization = await Organization.create({
        name: imsOrgDetails.orgName,
        imsOrgId: imsOrgID,
      });

      const message = `:white_check_mark: A new organization has been created. Organization ID: ${organization.getId()} Organization name: ${organization.getName()} IMS Org ID: ${imsOrgID}.`;
      await say(message);
    }

    organizationId = organization.getId();
    localReportLine.spacecatOrgId = organizationId;

    const deliveryType = customDeliveryType || await findDeliveryType(baseURL);

    localReportLine.deliveryType = deliveryType;
    const isLive = deliveryType === SiteModel.DELIVERY_TYPES.AEM_EDGE;

    try {
      site = await Site.create({
        baseURL, deliveryType, isLive, organizationId, authoringType,
      });
    } catch (error) {
      log.error(`Error creating site: ${error.message}`);
      localReportLine.errors = error.message;
      localReportLine.status = 'Failed';
      await say(`:x: *Errors:* ${error.message}`);

      throw error;
    }
  }

  // Set deliveryConfig and authoringType if provided (will be saved later with other site data)
  if (deliveryConfig && Object.keys(deliveryConfig).length > 0) {
    site.setDeliveryConfig(deliveryConfig);
    if (authoringType) {
      site.setAuthoringType(authoringType);
    }
    await say(':white_check_mark: DeliveryConfig is added/updated to site configuration');
  }

  Object.assign(reportLine, localReportLine);
  return { site, organizationId };
};

/**
 * Creates an entitlement and enrollment for a site.
 *
 * @param {Site} site - The site to create an entitlement and enrollment for.
 * @param {Object} lambdaCtx - The Lambda context.
 * @param {Object} slackCtx - The Slack context.
 * @param {Object} reportLine - The report line object to update.
 * @param {string} productCode - The product code to create an entitlement for.
 * @param {string} tier - The tier to create an entitlement for.
 * @returns {Promise<Object>} - The entitlement and site enrollment.
 */
export const createEntitlementAndEnrollment = async (
  site,
  lambdaCtx,
  slackCtx,
  reportLine,
  productCode,
  tier,
) => {
  const { log } = lambdaCtx;
  const { say } = slackCtx;

  // Create a local copy to avoid modifying the parameter directly
  const localReportLine = { ...reportLine };

  try {
    const tierClient = await TierClient.createForSite(lambdaCtx, site, productCode);
    const { entitlement, siteEnrollment } = await tierClient.createEntitlement(tier);
    log.info(`Successfully created ${productCode} entitlement ${entitlement.getId()} (${tier}) and enrollment ${siteEnrollment.getId()} for site ${site.getId()}`);

    const message = `:white_check_mark: A new ${productCode} entitlement ${entitlement.getId()} (${tier}) and enrollment ${siteEnrollment.getId()} has been created for site ${site.getId()}`;
    await say(message);

    return {
      entitlement,
      siteEnrollment,
    };
  } catch (error) {
    log.error(`Creating ${productCode} entitlement and enrollment failed: ${error.message}`);
    await say(`❌ Creating ${productCode} entitlement and site enrollment failed`);
    localReportLine.errors = `Creating ${productCode} entitlement and site enrollment failed`;
    localReportLine.status = 'Failed';
    throw error;
  }
};

/**
 * Shared onboarding function used by both modal and command implementations.
 *
 * @param {string} baseURLInput - The site URL input
 * @param {string} imsOrganizationID - The IMS Organization ID
 * @param {Object} configuration - The configuration object
 * @param {Object} profile - The loaded profile configuration object
 * @param {number} workflowWaitTime - Workflow wait time in seconds
 * @param {Object} slackContext - Slack context object with say function
 * @param {Object} context - Lambda context containing dataAccess, log, etc.
 * @param {Object} additionalParams - Additional parameters
 * @param {string} additionalParams.tier - Entitlement tier
 * @param {Object} options - Additional options
 * @param {Function} options.urlProcessor - Function to process the URL
 *                                          (e.g., extractURLFromSlackInput)
 * @param {string} options.profileName - The profile name for logging and reporting
 * @returns {Promise<Object>} Report line object
 */
export const onboardSingleSite = async (
  baseURLInput,
  imsOrganizationID,
  configuration,
  profile,
  workflowWaitTime,
  slackContext,
  context,
  additionalParams = {},
  options = {},
) => {
  const { say } = slackContext;
  const {
    dataAccess, log, env,
  } = context;
  const { Configuration } = dataAccess;
  const sfnClient = new SFNClient();

  const baseURL = options.urlProcessor ? options.urlProcessor(baseURLInput) : baseURLInput.trim();
  const imsOrgID = imsOrganizationID || env.DEMO_IMS_ORG;
  const profileName = options.profileName || 'unknown';

  const tier = additionalParams.tier || EntitlementModel.TIERS.FREE_TRIAL;

  await say(`:gear: Starting environment setup for site ${baseURL} with imsOrgID: ${imsOrgID} and tier: ${tier} using the ${profileName} profile`);
  await say(':key: Please make sure you have access to the AEM Shared Production Demo environment. Request access here: https://demo.adobe.com/demos/internal/AemSharedProdEnv.html');

  const reportLine = {
    site: baseURL,
    imsOrgId: imsOrgID,
    spacecatOrgId: '',
    siteId: '',
    profile: profileName,
    deliveryType: additionalParams.deliveryType || '',
    authoringType: additionalParams.authoringType || '',
    imports: '',
    audits: '',
    errors: '',
    status: 'Success',
    existingSite: 'No',
    tier,
  };

  try {
    if (!isValidUrl(baseURL)) {
      reportLine.errors = 'Invalid site base URL';
      reportLine.status = 'Failed';
      log.error(`Invalid site base URL: ${baseURL}`);
      await say(`:x: Invalid site base URL: ${baseURL}`);
      return reportLine;
    }

    if (!isValidIMSOrgId(imsOrgID)) {
      reportLine.errors = 'Invalid IMS Org ID';
      reportLine.status = 'Failed';
      log.error(`Invalid IMS Org ID: ${imsOrgID}`);
      await say(`:x: Invalid IMS Org ID: ${imsOrgID}`);
      return reportLine;
    }

    let language = additionalParams.language?.toLowerCase();
    let region = additionalParams.region?.toUpperCase();

    const languageValid = language && !!iso6393.find((lang) => lang.iso6301 === language);
    const regionValid = region && !!worldCountries.find(
      (c) => c.cca2.toLowerCase() === region.toLowerCase(),
    );

    // Auto-detect locale if language and/or region is not provided
    if (!languageValid || !regionValid) {
      try {
        const locale = await detectLocale({ baseUrl: baseURL });
        if (!language && locale.language) {
          language = locale.language;
        }
        if (!region && locale.region) {
          region = locale.region;
        }
      } catch (error) {
        log.error(`Error detecting locale for site ${baseURL}: ${error.message}`);
        await say(`:x: Error detecting locale for site ${baseURL}: ${error.message}`);

        // Fallback to default language and region
        language = 'en';
        region = 'US';
      }
    }

    // Create or retrieve site and organization
    const { site, organizationId } = await createSiteAndOrganization(
      baseURL,
      imsOrgID,
      additionalParams.authoringType,
      additionalParams.deliveryType,
      slackContext,
      reportLine,
      context,
      additionalParams.deliveryConfig,
    );

    // Validate tier
    if (!Object.values(EntitlementModel.TIERS).includes(tier)) {
      reportLine.errors = `Invalid tier: ${tier}`;
      reportLine.status = 'Failed';
      log.error(`Invalid tier: ${tier}`);
      await say(`:x: Invalid tier: ${tier}`);
      return reportLine;
    }

    // Create entitlement and enrollment
    await createEntitlementAndEnrollment(
      site,
      context,
      slackContext,
      reportLine,
      EntitlementModel.PRODUCT_CODES.ASO,
      tier,
    );

    // Create new project or assign existing project
    const project = await createProject(
      context,
      slackContext,
      baseURL,
      organizationId,
      site.getProjectId() || additionalParams.projectId,
    );
    site.setProjectId(project.getId());
    reportLine.projectId = project.getId();

    // Assign language and region
    const hasLanguage = hasText(site.getLanguage());
    if (!hasLanguage) {
      site.setLanguage(language);
      reportLine.language = language;
    } else {
      reportLine.language = site.getLanguage();
    }
    const hasRegion = hasText(site.getRegion());
    if (!hasRegion) {
      site.setRegion(region);
      reportLine.region = region;
    } else {
      reportLine.region = site.getRegion();
    }

    const siteID = site.getId();
    reportLine.siteId = siteID;

    if (!isObject(profile)) {
      const error = `Profile "${profileName}" not found or invalid.`;
      log.error(error);
      reportLine.errors = error;
      reportLine.status = 'Failed';
      await say(`:x: Profile "${profileName}" not found or invalid.`);
      return reportLine;
    }

    if (!isObject(profile?.audits)) {
      const error = `Profile "${profileName}" does not have a valid audits section.`;
      log.error(error);
      reportLine.errors = error;
      reportLine.status = 'Failed';
      return reportLine;
    }

    if (!isObject(profile?.imports)) {
      const error = `Profile "${profileName}" does not have a valid imports section.`;
      log.error(error);
      reportLine.errors = error;
      reportLine.status = 'Failed';
      return reportLine;
    }

    const importTypes = Object.keys(profile.imports);
    reportLine.imports = importTypes.join(', ');
    const siteConfig = site.getConfig();

    // Enabled imports only if there are not already enabled
    const imports = siteConfig.getImports();
    const importsEnabled = [];
    for (const importType of importTypes) {
      const isEnabled = isImportEnabled(importType, imports);
      if (!isEnabled) {
        siteConfig.enableImport(importType);
        importsEnabled.push(importType);
      }
    }

    // Resolve canonical URL for the site from the base URL
    let resolvedUrl = await resolveCanonicalUrl(baseURL);
    if (resolvedUrl === null) {
      log.warn(`Unable to resolve canonical URL for site ${siteID}, using base URL: ${baseURL}`);
      resolvedUrl = baseURL;
    }
    const { pathname: baseUrlPathName, origin: baseUrlOrigin } = new URL(baseURL);
    log.info(`Base url: ${baseURL} -> Resolved url: ${resolvedUrl} for site ${siteID}`);
    const { pathname: resolvedUrlPathName, origin: resolvedUrlOrigin } = new URL(resolvedUrl);

    // Update the fetch configuration only if the pathname/origin is different from the resolved URL
    if (baseUrlPathName !== resolvedUrlPathName || baseUrlOrigin !== resolvedUrlOrigin) {
      // If the base URL has a subpath, preserve it in the override
      const overrideBaseURL = baseUrlPathName !== '/' ? `${resolvedUrlOrigin}${baseUrlPathName}` : resolvedUrlOrigin;
      log.info(`Updating fetch configuration for site ${siteID} with override base URL: ${overrideBaseURL}`);
      siteConfig.updateFetchConfig({
        overrideBaseURL,
      });
    }

    site.setConfig(Config.toDynamoItem(siteConfig));
    try {
      await site.save();
    } catch (error) {
      log.error(`Failed to save site ${siteID} with updated config:`, error);
      reportLine.errors = error.message;
      reportLine.status = 'Failed';
      await say(`:x: *Error saving site configuration:* ${error.message}`);
      return reportLine;
    }

    for (const importType of importTypes) {
      /* eslint-disable no-await-in-loop */
      await triggerImportRun(
        configuration,
        importType,
        siteID,
        profile.imports[importType].startDate,
        profile.imports[importType].endDate,
        slackContext,
        context,
      );
    }

    const auditTypes = Object.keys(profile.audits);

    const latestConfiguration = await Configuration.findLatest();

    // Check which audits are not already enabled
    const auditsEnabled = [];
    for (const auditType of auditTypes) {
      /* eslint-disable no-await-in-loop */
      const isEnabled = latestConfiguration.isHandlerEnabledForSite(auditType, site);
      if (!isEnabled) {
        latestConfiguration.enableHandlerForSite(auditType, site);
        auditsEnabled.push(auditType);
      }
    }

    if (auditsEnabled.length > 0) {
      try {
        await latestConfiguration.save();
        log.debug(`Enabled the following audits for site ${siteID}: ${auditsEnabled.join(', ')}`);
      } catch (error) {
        log.error(`Failed to save configuration for site ${siteID}:`, error);
        throw error;
      }
    } else {
      log.debug(`All audits are already enabled for site ${siteID}`);
    }

    reportLine.audits = auditTypes.join(', ');
    const auditsMessage = reportLine.audits || 'None';
    const importsMessage = reportLine.imports || 'None';
    await say(`:white_check_mark: *For site ${baseURL}*: Enabled imports: ${importsMessage} and audits: ${auditsMessage}`);

    // trigger audit runs
    if (auditTypes.length > 0) {
      await say(`:gear: Starting audits: ${auditTypes.join(', ')}`);
    }
    for (const auditType of auditTypes) {
      /* eslint-disable no-await-in-loop */
      if (!latestConfiguration.isHandlerEnabledForSite(auditType, site)) {
        await say(`:x: Will not audit site '${baseURL}' because audits of type '${auditType}' are disabled for this site.`);
      } else {
        await triggerAuditForSite(
          site,
          auditType,
          undefined,
          slackContext,
          context,
        );
      }
    }

    // Opportunity status job
    const opportunityStatusJob = {
      type: 'opportunity-status-processor',
      siteId: siteID,
      siteUrl: baseURL,
      imsOrgId: imsOrgID,
      organizationId,
      taskContext: {
        auditTypes,
        slackContext: {
          channelId: slackContext.channelId,
          threadTs: slackContext.threadTs,
        },
      },
    };

    const scheduledRun = additionalParams.scheduledRun !== undefined
      ? additionalParams.scheduledRun
      : (profile.config?.scheduledRun || false);

    await say(`:information_source: Scheduled run: ${scheduledRun}`);

    // Disable imports and audits job - only disable what was enabled during onboarding
    const disableImportAndAuditJob = {
      type: 'disable-import-audit-processor',
      siteId: siteID,
      siteUrl: baseURL,
      imsOrgId: imsOrgID,
      organizationId,
      taskContext: {
        importTypes: importsEnabled || [],
        auditTypes: auditsEnabled || [],
        scheduledRun,
        slackContext: {
          channelId: slackContext.channelId,
          threadTs: slackContext.threadTs,
        },
      },
    };

    // Demo URL job
    const demoURLJob = {
      type: 'demo-url-processor',
      siteId: siteID,
      siteUrl: baseURL,
      imsOrgId: imsOrgID,
      organizationId,
      taskContext: {
        experienceUrl: env.EXPERIENCE_URL || 'https://experience.adobe.com',
        slackContext: {
          channelId: slackContext.channelId,
          threadTs: slackContext.threadTs,
        },
      },
    };

    // CWV Demo Suggestions job - add generic CWV suggestions to opportunities
    const cwvDemoSuggestionsJob = {
      type: 'cwv-demo-suggestions-processor',
      siteId: siteID,
      siteUrl: baseURL,
      imsOrgId: imsOrgID,
      organizationId,
      taskContext: {
        profile: profileName,
        slackContext: {
          channelId: slackContext.channelId,
          threadTs: slackContext.threadTs,
        },
      },
    };

    // Prepare and start step function workflow with the necessary parameters
    const workflowInput = {
      opportunityStatusJob,
      disableImportAndAuditJob,
      demoURLJob,
      cwvDemoSuggestionsJob,
      workflowWaitTime: workflowWaitTime || env.WORKFLOW_WAIT_TIME_IN_SECONDS,
    };

    const workflowName = `onboard-${baseURL.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`;

    const startCommand = new StartExecutionCommand({
      stateMachineArn: env.ONBOARD_WORKFLOW_STATE_MACHINE_ARN,
      input: JSON.stringify(workflowInput),
      name: workflowName,
    });
    await sfnClient.send(startCommand);
  } catch (error) {
    await say(`:x: Failed to start onboarding for site ${baseURL}: ${error.message}`);
    log.error(error);
    reportLine.errors = error.message;
    reportLine.status = 'Failed';
    throw error;
  }

  return reportLine;
};

/**
 * TODO: This function should be moved to Tier Client
 * @param {Object} context - The context object.
 * @param {Object} organization - The organization object.
 * @param {Array} sites - The sites array.
 * @param {String} productCode - The product code.
 * @returns {Array} - The filtered sites array.
 */
export const filterSitesForProductCode = async (context, organization, sites, productCode) => {
  // for every site we will create tier client and will check valid entitlement and enrollment
  const { SiteEnrollment } = context.dataAccess;
  const tierClient = TierClient.createForOrg(context, organization, productCode);
  const { entitlement } = await tierClient.checkValidEntitlement();

  if (!isNonEmptyObject(entitlement)) {
    return [];
  }

  // Get all enrollments for this entitlement in one query
  const siteEnrollments = await SiteEnrollment.allByEntitlementId(entitlement.getId());

  // Create a Set of enrolled site IDs for efficient lookup
  const enrolledSiteIds = new Set(siteEnrollments.map((se) => se.getSiteId()));

  // Filter sites based on enrollment
  return sites.filter((site) => enrolledSiteIds.has(site.getId()));
};
