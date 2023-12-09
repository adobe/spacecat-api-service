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
import { hasText, isString } from '@adobe/spacecat-shared-utils';

import { URL } from 'url';

import { fetch } from '../../support/utils.js';

export const BACKTICKS = '```';
export const BOT_MENTION_REGEX = /^<@[^>]+>\s+/;
export const CHARACTER_LIMIT = 2500;
export const SLACK_API = 'https://slack.com/api/chat.postMessage';

const SLACK_URL_FORMAT_REGEX = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9.-]+)\.([a-zA-Z]{2,})([/\w.-]*\/?)/;

/**
 * Extracts the domain from the input string. If the input follows a
 * specific Slack URL format, it extracts the domain from the URL. If not,
 * it assumes the input is the domain. If no input is provided, it returns null.
 *
 * @param {string} input - The input string.
 * @param domainOnly - If true, only the domain is returned. If false, the entire input is returned.
 * @returns {string|null} The domain extracted from the input message or null.
 */
function extractBaseURLFromInput(input, domainOnly = true) {
  if (!isString(input)) {
    return null;
  }

  const tokens = input.split(' ');

  for (const token of tokens) {
    const match = SLACK_URL_FORMAT_REGEX.exec(token);

    if (match !== null) {
      // see https://api.slack.com/reference/surfaces/formatting#links-in-retrieved-messages
      const processedToken = token.charAt(0) === '<' && token.charAt(token.length - 1) === '>'
        ? token.slice(1, token.length - 1).split('|').at(0)
        : token;
      const urlToken = processedToken.includes('://') ? processedToken : `http://${processedToken}`;
      const url = new URL(urlToken);
      const { hostname, pathname } = url;
      // we do not keep the www
      const finalHostname = hostname.replace(/^www\./, '');
      // we remove trailing slashes for paths only when an extension is provided
      const parts = pathname.split('.');
      const finalPathname = parts.length > 1 && parts[parts.length - 1].endsWith('/')
        ? pathname.replace(/\/+$/, '')
        : pathname;
      return !domainOnly && finalPathname && finalPathname !== '/'
        ? `${finalHostname}${finalPathname}`
        : finalHostname;
    }
  }
  return null;
}

/**
 * Sends an error message to the user and logs the error.
 *
 * @param {Function} say - The function to send a message to the user.
 * @param {Error} error - The error to log and send a message about.
 */
const postErrorMessage = async (say, error) => {
  await say(`:nuclear-warning: Oops! Something went wrong: ${error.message}`);
  console.error(error);
};

/**
 * Sends a message with blocks to the user.
 *
 * @param {Function} say - The function to send a message to the user.
 * @param {Object[]} textSections - The sections of the message.
 * @param {Object[]} [additionalBlocks=[]] - Additional blocks to send in the message.
 */
const sendMessageBlocks = async (say, textSections, additionalBlocks = []) => {
  const blocks = textSections.map((section) => {
    const block = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: section.text,
      },
    };

    if (section.accessory) {
      block.accessory = section.accessory;
    }

    return block;
  });

  blocks.push(...additionalBlocks);

  await say({ blocks });
};

const getQueryParams = (channelId, message) => ({
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
});

const postSlackMessage = async (channelId, message, token) => {
  if (!hasText(token)) {
    throw new Error('Missing slack bot token');
  }

  const params = getQueryParams(channelId, message);
  const resp = await fetch(createUrl(SLACK_API, params), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (resp.status !== 200) {
    throw new Error(`Failed to send initial slack message. Status: ${resp.status}`);
  }

  const respJson = await resp.json();

  if (!respJson.ok) {
    throw new Error(`Slack message was not acknowledged. Error: ${respJson.error}`);
  }

  return {
    channel: respJson.channel,
    ts: respJson.ts,
  };
};

export {
  extractBaseURLFromInput,
  getQueryParams,
  postErrorMessage,
  postSlackMessage,
  sendMessageBlocks,
};
