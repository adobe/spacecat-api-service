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

const PHRASES = ['set-country-code-ignore-list'];

/**
 * Factory function to create the SetLlmoCountryCodeIgnoreListCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The SetLlmoCountryCodeIgnoreListCommand object.
 */
function SetLlmoCountryCodeIgnoreListCommand(context) {
  const baseCommand = BaseCommand({
    id: 'set-llmo-country-code-ignore-list',
    name: 'Set LLMO Country Code Ignore List',
    description: 'Sets a site\'s per-site country code ignore list for CDN logs reports.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} {PS,AD,UK}`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  /**
   * Validates input, fetches the site, and updates the country code ignore list.
   *
   * @param {string[]} args - The arguments ([siteBaseURLOrId, commaSeparatedCodes]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [siteInput, codesArg] = args;

      if (!siteInput) {
        await say(':warning: Please provide a valid site base URL or site ID.');
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

      const countryCodeIgnoreList = codesArg
        ? codesArg.split(',').map((c) => c.trim()).filter(Boolean)
        : [];

      const invalid = countryCodeIgnoreList.filter((c) => c.length !== 2);
      if (invalid.length > 0) {
        await say(`:warning: Invalid country codes (must be 2 characters): ${invalid.join(', ')}`);
        return;
      }

      const config = site.getConfig();
      config.updateLlmoCountryCodeIgnoreList(countryCodeIgnoreList);
      await site.save();

      const listDisplay = countryCodeIgnoreList.length > 0
        ? countryCodeIgnoreList.join(', ')
        : '(empty — cleared)';

      await say(`:white_check_mark: Updated country code ignore list for '${site.getBaseURL()}'.\n\n*Ignore list:* ${listDisplay}`);
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

export default SetLlmoCountryCodeIgnoreListCommand;
