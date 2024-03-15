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
import { context as h2, h1 } from '@adobe/fetch';
import { DELIVERY_TYPES } from '@adobe/spacecat-shared-data-access/src/models/site.js';

/* c8 ignore next 3 */
export const { fetch } = process.env.HELIX_FETCH_FORCE_HTTP1
  ? h1()
  : h2();

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
) => sqs.sendMessage(queueUrl, { type, url: siteId, auditContext });

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

/**
 * Checks if a given URL corresponds to a Helix site.
 * @param {string} url - The URL to check.
 * @returns {Promise<{ isHelix: boolean, reason?: string }>} A Promise that resolves to an object
 * containing the result of the Helix site check and an optional reason if it's not a Helix site.
 */
export async function isHelixSite(url) {
  let finalUrl;
  try {
    const resp = await fetch(url);
    finalUrl = resp.url;
  } catch (e) {
    return {
      isHelix: false,
      reason: `Cannot fetch the site due to ${e.message}`,
    };
  }

  finalUrl = finalUrl.endsWith('/') ? `${finalUrl}index.plain.html` : `${finalUrl}.plain.html`;
  let finalResp;

  try {
    // redirects are disabled because .plain.html should return 200
    finalResp = await fetch(finalUrl, { redirect: 'manual' });
  } catch (e) {
    return {
      isHelix: false,
      reason: '.plain.html is unreachable',
    };
  }

  // reject if .plain.html does not return 2XX
  if (!finalResp.ok) {
    return {
      isHelix: false,
      reason: `.plain.html does not return 2XX, returns ${finalResp.status}`,
    };
  }

  const respText = await finalResp.text();

  // reject if .plain.html contains <head>
  if (respText.includes('<head>')) {
    return {
      isHelix: false,
      reason: '.plain.html should not contain <head>',
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
    return DELIVERY_TYPES.AEM_EDGE;
  }

  const { isAEM } = await isAEMSite(url);
  if (isAEM) {
    return DELIVERY_TYPES.AEM_CS;
  }

  return DELIVERY_TYPES.OTHER;
}
