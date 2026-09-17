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

import BaseCommand from './base.js';

import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['get path-suggestions'];

/**
 * Factory function to create the GetPathSuggestionsStatusCommand object.
 * Checks whether path-level prerender suggestion generation is enabled for a site.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The GetPathSuggestionsStatusCommand object.
 */
function GetPathSuggestionsStatusCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-path-suggestions-status',
    name: 'Get Path-Level Suggestions Status',
    description: 'Checks whether path-level prerender suggestion generation is enabled for a site.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site}`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  /**
   * Fetches the site and reports the pathSuggestionsEnabled status
   * from the prerender handler config.
   *
   * @param {string[]} args - The arguments ([siteBaseURL]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [siteInput] = args;

      if (!siteInput) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      const baseURL = extractURLFromSlackInput(siteInput);

      const site = baseURL
        ? await Site.findByBaseURL(baseURL)
        : await Site.findById(siteInput);

      if (!site) {
        await postSiteNotFoundMessage(say, siteInput);
        return;
      }

      const config = site.getConfig();
      const prerenderConfig = config.getHandlerConfig('prerender') || {};
      const isEnabled = prerenderConfig.pathSuggestionsEnabled === true;

      const statusEmoji = isEnabled ? ':large_green_circle:' : ':red_circle:';
      const statusText = isEnabled ? 'enabled' : 'disabled';

      await say(`${statusEmoji} Path-level suggestions are *${statusText}* for "${site.getBaseURL()}".`);
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

export default GetPathSuggestionsStatusCommand;
