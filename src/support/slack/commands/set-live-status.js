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

import { extractBaseURLFromInput, postErrorMessage } from '../../../utils/slack/base.js';

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

  const { dataAccess } = context;

  /**
   * Validates input, fetches the site by domain,
   * and updates the "isLive" status.
   *
   * @param {string[]} args - The arguments provided to the command ([siteDomain, isLive]).
   * @param {Function} say - The function provided by the bot to send messages.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, say) => {
    try {
      const [baseURLInput] = args;

      const baseURL = extractBaseURLFromInput(baseURLInput, false);

      if (!baseURL) {
        await say(':warning: Please provide a valid site domain.');
        return;
      }

      const site = await dataAccess.getSiteByBaseURL(baseURL);

      if (!site) {
        await say(`:x: No site found with the domain '${baseURL}'.`);
        return;
      }

      site.toggleLive();

      await dataAccess.updateSite(site);

      let message = `:white_check_mark: Successfully updated the live status of the site '${baseURL}'.\n\n`;
      message += site.isLive()
        ? ':rocket: _Site is now set to live!\'._\n\n'
        : ':submarine: _Site is now set to development!_\n\n';

      await say(message);
    } catch (error) {
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
