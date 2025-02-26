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

import BaseCommand from './base.js';

import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['toggle live status'];

/**
 * Factory function to create the SetLiveStatusCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {SetLiveStatusCommand} The SetLiveStatusCommand object.
 * @constructor
 */
function SetLiveStatusCommand(context) {
  const baseCommand = BaseCommand({
    id: 'set-live-status',
    name: 'Toggle Live Status',
    description: 'Toggles a site\'s "isLive" flag.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site}`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  /**
   * Validates input, fetches the site by base URL,
   * and updates the "isLive" status.
   *
   * @param {string[]} args - The arguments provided to the command ([siteBaseURL, isLive]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [baseURLInput] = args;

      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!baseURL) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      const site = await Site.findByBaseURL(baseURL);

      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      site.toggleLive();

      await site.save();

      let message = `:white_check_mark: Successfully updated the live status of the site '${baseURL}'.\n\n`;
      message += site.getIsLive()
        ? ':rocket: _Site is now set to live!_\n\n'
        : ':submarine: _Site is now set to development!_\n\n';

      await say(message);
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default SetLiveStatusCommand;
