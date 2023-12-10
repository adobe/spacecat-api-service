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
 * Extracts a URL from a given input string. The input can be in a Slack message
 * format or a regular URL string. If the input string contains a URL, the function
 * extracts and processes it based on the provided flags.
 *
 * @param {string} input - The input string to process.
 * @param {boolean} [domainOnly=false] - Flag to indicate if only the domain should be returned.
 * @param {boolean} [includeScheme=true] - Flag to determine if the URL scheme
 * should be included in the output.
 * @returns {string|null} Extracted URL or domain based on the input and flags,
 * or null if no valid URL is found.
 */
function extractURLFromSlackInput(input, domainOnly = false, includeScheme = true) {
  if (!isString(input)) {
    return null;
  }

  const match = SLACK_URL_FORMAT_REGEX.exec(input);

  if (match) {
    // Construct the URL, adding 'http://' if no scheme is present
    const urlToken = match[0].includes('://') ? match[0] : `http://${match[0]}`;
    const url = new URL(urlToken);

    // Remove 'www.' prefix from the hostname
    const finalHostname = url.hostname.replace(/^www\./, '');

    // If only the domain is required, return it
    if (domainOnly) {
      return finalHostname;
    }

    // Remove trailing slashes from the pathname
    const finalPathname = url.pathname.replace(/\/+$/, '');
    // Construct the base URL
    const baseURL = finalPathname && finalPathname !== '/' ? `${finalHostname}${finalPathname}` : finalHostname;

    // Include scheme in the output if required
    return includeScheme ? `https://${baseURL}` : baseURL;
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
};

/**
 * Sends a message to the user indicating that the site was not found.
 * @param {Function} say - The function to send a message to the user.
 * @param {string} baseURL - The base URL of the site.
 * @return {Promise<void>} A promise that resolves when the operation is complete.
 */
const postSiteNotFoundMessage = async (say, baseURL) => {
  await say(`:x: No site found with base URL '${baseURL}'.`);
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
  extractURLFromSlackInput,
  getQueryParams,
  postErrorMessage,
  postSiteNotFoundMessage,
  postSlackMessage,
  sendMessageBlocks,
};
