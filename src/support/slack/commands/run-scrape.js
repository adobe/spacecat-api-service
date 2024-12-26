/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { hasText, isObject } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { triggerScraperRun } from '../../utils.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['run scrape'];

/**
 * Factory function to create the RunScrapeCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunScrapeCommand} The RunScrapeCommand object.
 * @constructor
 */
function RunScrapeCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-scrape',
    name: 'Run Scrape',
    description: 'Runs the specified scrape type for the site identified with its id, and optionally for a date range.'
            + '\nOnly members of role "scrape" can run this command.'
            + '\nCurrently this will run the scraper for all sources and all destinations configured for the site, hence be aware of costs.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL}`,
  });

  const { dataAccess, log } = context;
  const { Configuration, Site } = dataAccess;

  /**
     * Validates input and triggers a new scrape run for the given site.
     *
     * @param {string[]} args - The arguments provided to the command ([site]).
     * @param {Object} slackContext - The Slack context object.
     * @param {Function} slackContext.say - The Slack say function.
     * @returns {Promise} A promise that resolves when the operation is complete.
     */
  const handleExecution = async (args, slackContext) => {
    const { say, user } = slackContext;
    const config = await Configuration.findLatest();
    const slackRoles = config.getSlackRoles() || {};
    const admins = slackRoles?.scrape || [];

    if (!admins.includes(user)) {
      await say(':error: Only members of role "scrape" can run this command.');
      return;
    }

    try {
      const [baseURLInput] = args;
      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!hasText(baseURL)) {
        await say(baseCommand.usage());
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!isObject(site)) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const result = await site.getSiteTopPagesBySourceAndGeo('ahrefs', 'global');
      const topPages = result || [];

      if (topPages.length === 0) {
        await say(`:warning: No top pages found for site \`${baseURL}\``);
        return;
      }
      const urls = topPages.map((page) => ({ url: page.getURL() }));
      await say(`:white_check_mark: Found top pages for site \`${baseURL}\`, total ${topPages.length} pages.`);

      const jobId = site.getId();
      await triggerScraperRun(
        jobId,
        urls,
        slackContext,
        context,
      );
      await say(`:adobe-run: Triggered scrape run for site \`${baseURL}\` — Total ${urls.length} URLs`);

      const message = `:white_check_mark: Completed triggering scrape runs for site \`${baseURL}\` — Total URLs: ${urls.length}`;

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

export default RunScrapeCommand;
/* c8 ignore end */
