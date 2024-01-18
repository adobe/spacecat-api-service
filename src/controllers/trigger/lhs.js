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
import { triggerFromData } from './common/trigger.js';

/**
 * Triggers audit processes for websites based on the provided URL.
 *
 * @param {Object} context - The context object containing dataAccess, sqs, data, and env.
 * @returns {Response} The response object with the audit initiation message or an error message.
 */
export default async function trigger(context) {
  const { type, url } = context.data;

  const types = type === 'lhs' ? [AUDIT_TYPE_LHS_DESKTOP, AUDIT_TYPE_LHS_MOBILE] : [type];

  const config = {
    url,
    auditTypes: types,
    deliveryType: 'all',
  };

  return triggerFromData(context, config);
}
