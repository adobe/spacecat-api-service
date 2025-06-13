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
import { ImsPromiseClient } from '@adobe/spacecat-shared-ims-client';
import URI from 'urijs';
import { hasText, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
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
 * @returns {Promise} A promise representing the message sending operation.
 */
export const sendAuditMessage = async (
  sqs,
  queueUrl,
  type,
  auditContext,
  siteId,
) => sqs.sendMessage(queueUrl, { type, siteId, auditContext });

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
) => sqs.sendMessage(queueUrl, {
  processingType: 'default',
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
) => sqs.sendMessage(queueUrl, {
  type: importType,
  siteId,
  startDate,
  endDate,
  slackContext,
  pageUrl,
});

export const sendAutofixMessage = async (
  sqs,
  queueUrl,
  siteId,
  opportunityId,
  suggestionIds,
  promiseToken,
  { url } = {},
) => sqs.sendMessage(queueUrl, {
  opportunityId,
  siteId,
  suggestionIds,
  promiseToken,
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
 * @param {Object} slackContext - The Slack context object.
 * @param {Object} lambdaContext - The Lambda context object.
 * @return {Promise} - A promise representing the audit trigger operation.
 */
export const triggerAuditForSite = async (
  site,
  auditType,
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
) => sentRunScraperMessage(
  lambdaContext.sqs,
  lambdaContext.env.SCRAPING_JOBS_QUEUE_URL,
  jobId,
  urls,
  {
    channelId: slackContext.channelId,
    threadTs: slackContext.threadTs,
  },
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
 * Extracts key:value pairs from arguments.
 * @param {string[]} args - Array of arguments that may contain key:value pairs.
 * @returns {Object} Object with lowercase keys and their values.
 */
export const extractKeyValuePairs = (args) => {
  const params = {};

  args.forEach((arg) => {
    if (typeof arg === 'string' && arg.includes(':')) {
      const [key, ...valueParts] = arg.split(':');
      const value = valueParts.join(':').trim(); // Handle URLs with colons and trim whitespace
      params[key.toLowerCase().trim()] = value;
    }
  });

  return params;
};

/**
 * Determines if an argument looks like a URL (even without protocol).
 * @param {string} arg - The argument to check.
 * @returns {boolean} True if the argument looks like a URL.
 */
export const looksLikeUrl = (arg) => {
  if (typeof arg !== 'string') return false;

  // Handle Slack's angle bracket URL format: <https://domain.com>
  const slackUrlPattern = /^<https?:\/\/[^>]+>$/;
  if (slackUrlPattern.test(arg)) {
    return true;
  }

  // Check for protocol URLs
  if (arg.startsWith('http://') || arg.startsWith('https://')) {
    return true;
  }

  // Check for domain-like patterns (domain.com, domain.com:port, subdomain.domain.com:port)
  const domainPattern = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?($|\/)/;
  return domainPattern.test(arg);
};
