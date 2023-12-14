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
export const FALLBACK_SLACK_CHANNEL = 'C060T2PPF8V';

const SLACK_URL_FORMAT_REGEX = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9.-]+)\.([a-zA-Z]{2,})([/\w.-]*\/?)/;

/**
 * Extracts a URL from a given input string. The input can be in a Slack message
 * format or a regular URL string.
 *
 * If the input string contains a URL, the function
 * extracts and processes it based on the provided flags. The function first
 * checks for the presence of a URL scheme and adds 'http://' if it is absent.
 *
 * Then, it removes the 'www.' prefix from the hostname, if present. If only the
 * domain is required (domainOnly=true), the function returns the domain name.
 *
 * Otherwise, it checks if the URL has a path. If the URL is a domain only (path
 * is just '/'), it removes trailing slashes. For URLs with a path, the path is
 * retained as is.
 *
 * Finally, the URL is reconstructed, optionally including the
 * scheme based on the includeScheme flag.
 *
 * @param {string} input - The input string to process. This can be a URL or
 * a string containing a URL in a Slack message format.
 * @param {boolean} [domainOnly=false] - Flag to indicate if only the domain
 * should be returned. If true, only the domain part of the URL is returned.
 * @param {boolean} [includeScheme=true] - Flag to determine if the URL scheme
 * (e.g., 'http://' or 'https://') should be included in the output.
 * @returns {string|null} The processed URL based on the input and flags,
 * or null if no valid URL is found. The URL is adjusted to include or exclude
 * the scheme and to remove or retain the trailing slash based on the input flags
 * and the URL structure (domain only or with a path).
 */
function extractURLFromSlackInput(input, domainOnly = false, includeScheme = true) {
  if (!isString(input)) {
    return null;
  }

  const match = SLACK_URL_FORMAT_REGEX.exec(input);

  if (match) {
    const urlToken = match[0].includes('://') ? match[0] : `http://${match[0]}`;
    const url = new URL(urlToken);
    const finalHostname = url.hostname.replace(/^www\./, '');

    if (domainOnly) {
      return finalHostname;
    }

    const hasPath = url.pathname && url.pathname !== '/';
    const finalPathname = hasPath ? url.pathname : url.pathname.replace(/\/+$/, '');
    const baseURL = hasPath ? `${finalHostname}${finalPathname}` : finalHostname;

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

/**
 * Gets the query parameters for the Slack API. THe query parameters include the channel ID and
 * the message blocks.
 * @param {string} channelId - The channel ID to post the message to.
 * @param {string} message - The message to post.
 * @return {{blocks: string, channel}} The query parameters.
 */
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

/**
 * Gets the slack channelId from the list of targetChannels
 * @param {string} target - The channel to identify from the list of targetChannels.
 * @param {string} targetChannels - The list of configured slack channels.
 * @return {string} slack channelId from targetChannels or a FALLBACK_SLACK_CHANNEL value.
 */
export function getSlackChannelId(target, targetChannels = '') {
  const channel = targetChannels.split(',')
    .filter((pair) => pair.startsWith(`${target}=`))
    .find((pair) => pair.trim().length > target.length + 1);
  return channel ? channel.split('=')[1].trim() : FALLBACK_SLACK_CHANNEL;
}

/**
 * Posts a message to a Slack channel.
 * @param {string} channelId - The channel ID to post the message to.
 * @param {string} message - The message to post.
 * @param {string} token - The Slack bot token.
 * @return {Promise<{channel, ts}>} A promise that resolves to the channel and timestamp
 * of the message.
 */
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

/**
 * Determines if the event is part of a thread.
 * @param {object} event - The Slack event.
 * @return {string} The thread timestamp (thread_ts).
 */
const getThreadTimestamp = (event) => event.thread_ts || event.ts;

/**
 * Gets the message from the event. Removes the bot mention from the message.
 * @param {object} event - The Slack event.
 * @return {string | undefined} - The message without the bot mention.
 */
const getMessageFromEvent = (event) => event.text?.replace(BOT_MENTION_REGEX, '').trim();

/**
 * Wraps the Slack say function to respond in a thread. This is necessary because
 * the Slack say function does not support threads. The wrapped function will
 * send messages in a thread if the threadTs is set. Otherwise, it will send
 * messages in the channel. The wrapped function will also set the threadTs
 * for the next message. The threadTs is set as a property of the function
 * for convenience.
 *
 * @param {Function} say - The original Slack say function.
 * @param {string} threadTs - The timestamp of the thread to respond in.
 * @returns {Function} A wrapped say function that sends messages in a thread.
 */
const wrapSayForThread = (say, threadTs) => {
  const wrappedFunction = async (message) => {
    const messageOptions = typeof message === 'string' ? { text: message } : message;
    await say({
      ...messageOptions,
      thread_ts: threadTs,
    });
  };

  // Attach thread_ts as a property of the function
  wrappedFunction.threadTs = threadTs;

  return wrappedFunction;
};

export {
  extractURLFromSlackInput,
  getQueryParams,
  postErrorMessage,
  postSiteNotFoundMessage,
  postSlackMessage,
  sendMessageBlocks,
  getThreadTimestamp,
  getMessageFromEvent,
  wrapSayForThread,
};
