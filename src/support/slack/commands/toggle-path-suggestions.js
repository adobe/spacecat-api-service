/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import BaseCommand from './base.js';

import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['path-suggestions'];

/**
 * Factory function to create the TogglePathSuggestionsCommand object.
 * Enables or disables path-level prerender suggestion generation for a site.
 * This sets `pathSuggestionsEnabled` in the site's prerender handler config.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The TogglePathSuggestionsCommand object.
 */
function TogglePathSuggestionsCommand(context) {
  const baseCommand = BaseCommand({
    id: 'toggle-path-suggestions',
    name: 'Enable/Disable Path-Level Suggestions',
    description: 'Enables or disables path-level prerender suggestion generation for a site.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {enable/disable} {site}`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  /**
   * Validates input, fetches the site, and toggles pathSuggestionsEnabled
   * in the prerender handler config.
   *
   * @param {string[]} args - The arguments ([action, siteBaseURL]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [actionInput, siteInput] = args;

      if (!actionInput || !['enable', 'disable'].includes(actionInput.toLowerCase())) {
        await say(':warning: Please specify `enable` or `disable`.');
        return;
      }

      if (!siteInput) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      const action = actionInput.toLowerCase();
      const isEnable = action === 'enable';
      const baseURL = extractURLFromSlackInput(siteInput);

      const site = baseURL
        ? await Site.findByBaseURL(baseURL)
        : await Site.findById(siteInput);

      if (!site) {
        await postSiteNotFoundMessage(say, siteInput);
        return;
      }

      const config = site.getConfig();
      const handlers = config.getHandlers() || {};
      const prerenderConfig = handlers.prerender || {};

      const updatedHandlers = {
        ...handlers,
        prerender: {
          ...prerenderConfig,
          pathSuggestionsEnabled: isEnable,
        },
      };

      const configData = Config.toDynamoItem(config);
      configData.handlers = updatedHandlers;
      site.setConfig(configData);
      await site.save();

      const statusEmoji = isEnable ? ':white_check_mark:' : ':no_entry_sign:';
      await say(`${statusEmoji} Path-level suggestions have been *${action}d* for "${site.getBaseURL()}".`);
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

export default TogglePathSuggestionsCommand;
