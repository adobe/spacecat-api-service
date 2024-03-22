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
import {
  badRequest,
  createResponse,
  internalServerError, notFound,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';

import SlackHandler from '../support/slack/slack-handler.js';
import commands from '../support/slack/commands.js';
import actions from '../support/slack/actions/index.js';

/**
 * Initializes the slack bot.
 *
 * @param {App} App - The bolt app class.
 * @param {object} lambdaContext - The lambda context.
 * @return {App} The bolt app.
 */
export function initSlackBot(lambdaContext, App) {
  const { boltApp, env, log } = lambdaContext;
  const { SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN } = env;

  if (!hasText(SLACK_SIGNING_SECRET)) {
    throw new Error('Missing SLACK_SIGNING_SECRET');
  }

  if (!hasText(SLACK_BOT_TOKEN)) {
    throw new Error('Missing SLACK_BOT_TOKEN');
  }

  if (boltApp) {
    return boltApp;
  }

  const logger = {
    getLevel: () => log.level,
    setLevel: () => true,
    debug: log.debug.bind(log),
    info: log.info.bind(log),
    warn: log.warn.bind(log),
    error: log.error.bind(log),
  };

  const app = new App({
    signingSecret: SLACK_SIGNING_SECRET,
    token: SLACK_BOT_TOKEN,
    logger,
  });

  app.use(async ({ context, next }) => {
    context.dataAccess = lambdaContext.dataAccess;
    await next();
  });

  // eslint-disable-next-line no-param-reassign
  lambdaContext.boltApp = app;

  const slackHandler = SlackHandler(commands(lambdaContext), log);

  app.event('app_mention', slackHandler.onAppMention);

  Object.entries(actions)
    .forEach(([action, fn]) => app.action(action, fn(lambdaContext)));

  return app;
}

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
      const slackBot = initSlackBot(context, SlackApp);

      await slackBot.processEvent({ body: payload, ack });
    } catch (error) {
      const errorMessage = cleanupHeaderValue(error.message);
      log.error(`Error processing event: ${errorMessage}`);
      return internalServerError(errorMessage);
    }

    return new Response('');
  };

  const inviteUserToChannel = async (context) => {
    const {
      data, dataAccess, imsClient, log,
    } = context;
    const { imsUserAccessToken, imsOrgId } = data;

    let userProfile;
    try {
      userProfile = await imsClient.getImsUserProfile(imsUserAccessToken);
    } catch (error) {
      log.error(`Error fetching user profile: ${error.message}`);
      // Return a 404 response if we fail to find the user's profile
      return notFound('Error fetching user profile with the given access token.');
    }

    // Verify that this user is a member of the given organization
    if (!userProfile.organizations.includes(imsOrgId)) {
      // The given org is not part of this user's profile - do not grant them access to Slack
      return badRequest('User is not a member of the given organization.');
    }

    let organization;
    try {
      organization = await dataAccess.getOrganizationByImsOrgID(imsOrgId);
    } catch (error) {
      log.error(`Error reading organization by IMS org ID: '${imsOrgId}'. Details: ${error.message}`);
      return notFound('Error reading organization: not found.');
    }

    log.info(`Inviting userId '${userProfile.userId}' to the Slack channel for IMS org Id '${imsOrgId}' (organizationId ${organization.id}).`);

    /*
    TODO:
      - Wire up ElevatedSlackClient with a wrapper in index.js
      - Invite user to slack
      - Update invitedUserCount in the organization's Slack config
      - Persist organization back to data store
      - Test cases, including admin_route check
    */

    return createResponse('', 202);
  };

  return {
    handleEvent,
    inviteUserToChannel,
  };
}

export default SlackController;
