/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { Site } from '@adobe/spacecat-shared-data-access';
import { triggerFromData } from './common/trigger.js';
import { getSlackContext } from '../../utils/slack/base.js';

export const INITIAL_CANONICAL_SLACK_MESSAGE = '*CANONICAL URL REPORT* for the *last week* :thread:';

/**
 * Triggers canonical audit for websites based on the provided URL.
 *
 * @param {Object} context - The context object containing dataAccess, sqs, data, and env.
 * @returns {Response} The response object with the audit initiation message or an error message.
 */
export default async function trigger(context) {
  const { log } = context;
  const { type, url } = context.data;
  const {
    AUDIT_REPORT_SLACK_CHANNEL_ID: slackChannelId,
    SLACK_BOT_TOKEN: token,
  } = context.env;

  const slackContext = await getSlackContext({
    slackChannelId, url, message: INITIAL_CANONICAL_SLACK_MESSAGE, token, log,
  });

  const auditContext = {
    slackContext,
  };

  const config = {
    url,
    auditTypes: [type],
    deliveryType: Site.DELIVERY_TYPES.AEM_EDGE,
  };

  return triggerFromData(context, config, auditContext);
}
