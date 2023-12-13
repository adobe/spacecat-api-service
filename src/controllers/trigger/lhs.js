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

import { AUDIT_TYPE_LHS_DESKTOP, AUDIT_TYPE_LHS_MOBILE } from '@adobe/spacecat-shared-data-access/src/models/audit.js';

import { isAuditForAll, sendAuditMessages } from '../../support/utils.js';
import { createErrorResponse, createNotFoundResponse, createResponse } from '../../utils/response-utils.js';

/**
 * Constant for error message when a site is not found.
 */

/**
 * Retrieves site IDs for auditing based on the input URL. If the input URL has the value
 * 'all', then all sites will be audited. Otherwise, the input URL is assumed to be a base URL.
 *
 * @param {Object} dataAccess - The data access object for site operations.
 * @param {string} url - The URL to check for auditing.
 * @returns {Promise<Array<string>>} A promise that resolves to an array of base URLs.
 * @throws {Error} Throws an error if the site is not found.
 */
async function getSiteIDsToAudit(dataAccess, url) {
  if (isAuditForAll(url)) {
    return dataAccess.getSitesToAudit();
  }

  const site = await dataAccess.getSiteByBaseURL(url);

  return site ? [site.getId()] : [];
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
    const { type, url, auditContext } = context.data;
    const { AUDIT_JOBS_QUEUE_URL: queueUrl } = context.env;

    const siteIDsToAudit = await getSiteIDsToAudit(dataAccess, url);
    if (!siteIDsToAudit.length) {
      return createNotFoundResponse('Site not found');
    }

    const types = type === 'lhs' ? [AUDIT_TYPE_LHS_DESKTOP, AUDIT_TYPE_LHS_MOBILE] : [type];
    const message = [];

    for (const auditType of types) {
      message.push(
        // eslint-disable-next-line no-await-in-loop
        await sendAuditMessages(
          sqs,
          queueUrl,
          auditType,
          auditContext,
          siteIDsToAudit,
        ),
      );
    }

    return createResponse({ message });
  } catch (e) {
    return createErrorResponse(e);
  }
}
