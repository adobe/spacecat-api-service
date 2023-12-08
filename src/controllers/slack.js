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

import { Response } from '@adobe/fetch';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';

import { initSlackBot } from '../support/slack.js';

/**
 * Parses the payload from the incoming data.
 *
 * @param {Object} data - The incoming data object from Slack.
 * @returns {Object} Parsed payload as a JavaScript object.
 */
function parsePayload(data) {
  return data?.payload ? JSON.parse(data.payload) : data;
}

/**
 * Slack Controller for handling incoming Slack events.
 *
 * @param {App} SlackApp - Slack bot implementation.
 * @returns {Object} An object containing the handleEvent function.
 */
function SlackController(SlackApp) {
  // Acknowledge function for Slack events (no operation)
  const ack = () => {};

  /**
   * Handles incoming events from Slack.
   *
   * @param {Object} context - Context object containing information about the incoming request.
   * @returns {Response} HTTP response object.
   */
  const handleEvent = async (context) => {
    const { log, data, pathInfo: { headers } } = context;

    // Check for URL verification request from Slack and respond
    if (data?.type === 'url_verification') {
      return new Response({ challenge: data.challenge });
    }

    const payload = parsePayload(data);

    // Suppress retry events due to HTTP timeout (usually caused by cold starts)
    if (headers['x-slack-retry-reason'] === 'http_timeout') {
      log.info(`Ignoring retry event: ${payload.event_id}`);
      return new Response('', { headers: { 'x-error': 'ignored-event' } });
    }

    // Process the incoming Slack event
    try {
      const slackBot = initSlackBot(SlackApp, context);

      await slackBot.processEvent({ body: payload, ack });
    } catch (error) {
      const errorMessage = cleanupHeaderValue(error.message);
      log.error(`Error processing event: ${errorMessage}`);
      return new Response(errorMessage, { status: 500, headers: { 'x-error': errorMessage } });
    }

    return new Response('');
  };

  return { handleEvent };
}

export default SlackController;
