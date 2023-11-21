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

import { createUrl } from '@adobe/fetch';
import { fetch } from './utils.js';

export const SLACK_API = 'https://slack.com/api/chat.postMessage';

export function getQueryParams(channelId, message) {
  return {
    channel: channelId,
    blocks: JSON.stringify([
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: message,
        },
      },
    ]),
  };
}

export async function postSlackMessage(channelId, message, context) {
  const { log, env: { SLACK_BOT_TOKEN: token } } = context;
  if (!token) {
    const errMsg = 'Missing slack bot token';
    log.error(errMsg);
    throw new Error(errMsg);
  }

  const params = getQueryParams(channelId, message);
  const resp = await fetch(createUrl(SLACK_API, params), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (resp.status !== 200) {
    const errMsg = `Failed to send initial slack message. Status: ${resp.status}`;
    log.error(errMsg);
    throw new Error(errMsg);
  }

  const respJson = await resp.json();

  if (!respJson.ok) {
    const errMsg = `Slack message was not acknowledged. Error: ${respJson.error}`;
    log.error(errMsg);
    throw new Error(errMsg);
  }

  return {
    channel: respJson.channel,
    ts: respJson.ts,
  };
}
