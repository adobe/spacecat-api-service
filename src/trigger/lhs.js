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

import { isAuditForAll } from '../support/utils.js';

/**
 * Retrieves the base URLs to audit.
 *
 * @param {Object} dataAccess - The data access object for site operations.
 * @param {string} url - The URL to check for auditing.
 * @returns {Promise<Array<string>>} A promise that resolves to an array of base URLs.
 * @throws {Error} Throws an error if the site is not found.
 */
async function getBaseURLsToAudit(dataAccess, url) {
  if (isAuditForAll(url)) {
    return dataAccess.getSitesToAudit();
  }

  const site = await dataAccess.getSiteByBaseURL(url);
  if (!site) {
    throw new Error('Site not found');
  }
  return [site.getBaseURL()];
}

/**
 * Sends audit messages for each URL.
 *
 * @param {Object} sqs - The SQS service object.
 * @param {string} queueUrl - The SQS queue URL.
 * @param {string} type - The type of audit.
 * @param {Array<string>} baseURLsToAudit - An array of base URLs to audit.
 * @returns {Promise<string>} A promise that resolves to a status message.
 */
async function sendAuditMessages(sqs, queueUrl, type, baseURLsToAudit) {
  for (const baseURL of baseURLsToAudit) {
    const auditContext = {};
    // eslint-disable-next-line no-await-in-loop
    await sqs.sendMessage(queueUrl, { type, url: baseURL, auditContext });
  }
  return `Triggering ${type} audit for ${baseURLsToAudit.length > 1 ? `all ${baseURLsToAudit.length} sites` : baseURLsToAudit[0]}`;
}

/**
 * Creates a standardized response object.
 *
 * @param {Object} body - The response body object.
 * @returns {Response} The response object.
 */
function createResponse(body) {
  return new Response(JSON.stringify(body));
}

/**
 * Creates a standardized error response based on the error thrown.
 *
 * @param {Error} error - The error object.
 * @returns {Response} The error response object.
 */
function createErrorResponse(error) {
  const status = error.message === 'Site not found' ? 404 : 500;
  return new Response(JSON.stringify({ error: error.message }), {
    status,
    headers: { 'x-error': error.message },
  });
}

/**
 * Triggers audit processes for websites based on the provided URL.
 *
 * @param {Object} context - The context object containing dataAccess, sqs, data, and env.
 * @returns {Response} The response object with the audit initiation message or an error message.
 */
export default async function trigger(context) {
  try {
    const { dataAccess, sqs } = context;
    const { type, url } = context.data;
    const { AUDIT_JOBS_QUEUE_URL: queueUrl } = context.env;

    const baseURLsToAudit = await getBaseURLsToAudit(dataAccess, url);
    const message = await sendAuditMessages(sqs, queueUrl, type, baseURLsToAudit);
    return createResponse({ message });
  } catch (e) {
    return createErrorResponse(e);
  }
}
