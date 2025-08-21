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
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { ImsPromiseClient } from '@adobe/spacecat-shared-ims-client';
import URI from 'urijs';
import {
  hasText,
  tracingFetch as fetch,
  isValidUrl,
  isObject,
  resolveCanonicalUrl, isValidIMSOrgId,
} from '@adobe/spacecat-shared-utils';
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
  variation,
  { url } = {},
) => sqs.sendMessage(queueUrl, {
  opportunityId,
  siteId,
  suggestionIds,
  promiseToken,
  variation,
  url,
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
 * @returns {Promise<"aem_edge" | "aem_cs" | "others">} A Promise that resolves to the delivery type
 */
export async function findDeliveryType(url) {
  const { isHelix } = await isHelixSite(url);
  if (isHelix) {
    return SiteModel.DELIVERY_TYPES.AEM_EDGE;
  }

  const { isAEM } = await isAEMSite(url);
  if (isAEM) {
    return SiteModel.DELIVERY_TYPES.AEM_CS;
  }

  return SiteModel.DELIVERY_TYPES.OTHER;
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
export async function getCSPromiseToken(context) {
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

  // Check if site already exists
  if (site) {
    const siteOrgId = site.getOrganizationId();
    const message = `:information_source: Site ${baseURL} already exists. Organization ID: ${siteOrgId}`;
    await say(message);
    log.info(message);
  } else {
    // New site - handle organization logic
    log.info(`Site ${baseURL} doesn't exist. Processing organization...`);

    // Check if the organization with IMS Org ID already exists; create if it doesn't
    let organization = await Organization.findByImsOrgId(imsOrgID);
    if (!organization) {
      const imsOrgDetails = await imsClient.getImsOrganizationDetails(imsOrgID);
      if (!imsOrgDetails) {
        localReportLine.errors = `Could not find details of IMS org with the ID *${imsOrgID}*.`;
        localReportLine.status = 'Failed';
        throw new Error(localReportLine.errors);
      }
      log.info(`IMS Org Details: ${imsOrgDetails}`);
      organization = await Organization.create({
        name: imsOrgDetails.orgName,
        imsOrgId: imsOrgID,
      });

      const message = `:white_check_mark: A new organization has been created. Organization ID: ${organization.getId()} Organization name: ${organization.getName()} IMS Org ID: ${imsOrgID}.`;
      await say(message);
      log.info(message);
    }

    organizationId = organization.getId(); // Set organizationId for new site
    log.info(`Organization ${organizationId} was successfully retrieved or created`);
    localReportLine.spacecatOrgId = organizationId;

    // Create new site
    log.info(`Site ${baseURL} doesn't exist. Finding delivery type...`);
    const deliveryType = customDeliveryType || await findDeliveryType(baseURL);
    log.info(`Found delivery type for site ${baseURL}: ${deliveryType}`);
    localReportLine.deliveryType = deliveryType;
    const isLive = deliveryType === SiteModel.DELIVERY_TYPES.AEM_EDGE;

    try {
      site = await Site.create({
        baseURL, deliveryType, isLive, organizationId, authoringType,
      });

      if (deliveryConfig && Object.keys(deliveryConfig).length > 0) {
        site.setDeliveryConfig(deliveryConfig);
        // Also set authoring type if provided (needed when setting delivery config)
        if (authoringType) {
          site.setAuthoringType(authoringType);
        }
        await site.save();
        log.info(`Applied delivery configuration for site ${site.getId()}:`, { deliveryConfig, authoringType });
      }
    } catch (error) {
      log.error(`Error creating site: ${error.message}`);
      localReportLine.errors = error.message;
      localReportLine.status = 'Failed';
      await say(`:x: *Errors:* ${error.message}`);

      throw error;
    }
  }

  Object.assign(reportLine, localReportLine);
  return { site, organizationId };
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

  // Process URL - allow customization for different input formats
  const baseURL = options.urlProcessor ? options.urlProcessor(baseURLInput) : baseURLInput.trim();
  const imsOrgID = imsOrganizationID || env.DEMO_IMS_ORG;

  // Extract profile name for logging and reporting (assume it's passed in options)
  const profileName = options.profileName || 'unknown';

  log.info(`Starting ${profileName} environment setup for site ${baseURL}`);
  await say(`:gear: Starting ${profileName} environment setup for site ${baseURL}`);
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
  };

  try {
    if (!isValidUrl(baseURL)) {
      reportLine.errors = 'Invalid site base URL';
      reportLine.status = 'Failed';
      return reportLine;
    }

    if (!isValidIMSOrgId(imsOrgID)) {
      reportLine.errors = 'Invalid IMS Org ID';
      reportLine.status = 'Failed';
      return reportLine;
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

    const siteID = site.getId();
    log.info(`Site ${baseURL} was successfully retrieved or created. Site ID: ${siteID}`);
    reportLine.siteId = siteID;

    log.info(`Profile ${profileName} was successfully loaded`);

    if (!isObject(profile)) {
      const error = `Profile "${profileName}" not found or invalid.`;
      log.error(error);
      reportLine.errors = error;
      reportLine.status = 'Failed';
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
        log.info(`Enabling import: ${importType}`);
        siteConfig.enableImport(importType);
        importsEnabled.push(importType);
      } else {
        log.info(`Import '${importType}' is already enabled, skipping`);
      }
    }

    if (importsEnabled.length > 0) {
      log.info(`Enabled the following imports for ${siteID}: ${importsEnabled.join(', ')}`);
    } else {
      log.info(`All imports are already enabled for ${siteID}`);
    }

    log.info(`Enabled the following imports for ${siteID}: ${reportLine.imports}`);

    // Resolve canonical URL for the site from the base URL
    const resolvedUrl = await resolveCanonicalUrl(baseURL);
    const { pathname: baseUrlPathName } = new URL(baseURL);
    const { pathname: resolvedUrlPathName, origin: resolvedUrlOrigin } = new URL(resolvedUrl);

    log.info(`Base url: ${baseURL} -> Resolved url: ${resolvedUrl} for site ${siteID}`);

    // Update the fetch configuration only if the pathname is different from the resolved URL
    if (baseUrlPathName !== resolvedUrlPathName) {
      siteConfig.updateFetchConfig({
        overrideBaseURL: resolvedUrlOrigin,
      });
    }

    site.setConfig(Config.toDynamoItem(siteConfig));
    try {
      await site.save();
    } catch (error) {
      log.error(error);
      reportLine.errors = error.message;
      reportLine.status = 'Failed';
      return reportLine;
    }

    log.info(`Site config successfully saved for site ${siteID}`);

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

    log.info(`Triggered the following imports for site ${siteID}: ${reportLine.imports}`);

    const auditTypes = Object.keys(profile.audits);

    // Get current configuration for audit operations
    const auditConfiguration = await Configuration.findLatest();

    // Check which audits are not already enabled
    const auditsEnabled = [];
    for (const auditType of auditTypes) {
      /* eslint-disable no-await-in-loop */
      const isEnabled = auditConfiguration.isHandlerEnabledForSite(auditType, site);
      if (!isEnabled) {
        auditConfiguration.enableHandlerForSite(auditType, site);
        auditsEnabled.push(auditType);
      }
    }

    if (auditsEnabled.length > 0) {
      log.info(`Enabled the following audits for site ${siteID}: ${auditsEnabled.join(', ')}`);
    } else {
      log.info(`All audits are already enabled for site ${siteID}`);
    }

    reportLine.audits = auditTypes.join(', ');
    log.info(`Enabled the following audits for site ${siteID}: ${reportLine.audits}`);

    await say(`:white_check_mark: *For site ${baseURL}*: Enabled imports: ${reportLine.imports} and audits: ${reportLine.audits}`);

    // trigger audit runs
    log.info(`Starting audits for site ${baseURL}. Audit list: ${auditTypes}`);
    await say(`:gear: Starting audits: ${auditTypes}`);
    for (const auditType of auditTypes) {
      /* eslint-disable no-await-in-loop */
      if (!auditConfiguration.isHandlerEnabledForSite(auditType, site)) {
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

    log.info(`Opportunity status job: ${JSON.stringify(opportunityStatusJob)}`);
    log.info(`Disable import and audit job: ${JSON.stringify(disableImportAndAuditJob)}`);
    log.info(`Demo URL job: ${JSON.stringify(demoURLJob)}`);

    // Prepare and start step function workflow with the necessary parameters
    const workflowInput = {
      opportunityStatusJob,
      disableImportAndAuditJob,
      demoURLJob,
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
    log.error(error);
    reportLine.errors = error.message;
    reportLine.status = 'Failed';
    throw error;
  }

  return reportLine;
};
