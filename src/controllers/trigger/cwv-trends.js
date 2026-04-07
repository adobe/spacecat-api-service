/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { triggerFromData } from './common/trigger.js';

/**
 * Triggers cwv-trends-audit for websites based on the provided URL.
 * Accepts an optional `endDate` query parameter (YYYY-MM-DD) to process
 * historical data up to a specific date instead of today.
 *
 * @param {Object} context - The context object containing dataAccess, sqs, data, and env.
 * @returns {Response} The response object with the audit initiation message or an error message.
 */
export default async function triggerAudit(context) {
  const { type, url, endDate } = context.data;

  const auditContext = {};
  if (endDate) {
    auditContext.endDate = endDate;
  }

  const config = {
    url,
    auditTypes: [type],
  };

  return triggerFromData(context, config, auditContext);
}
