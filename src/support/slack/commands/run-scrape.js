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
import {
  isNonEmptyArray,
  isNonEmptyObject,
  isValidUrl,
} from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { triggerScraperRun } from '../../utils.js';
import {
  extractURLFromSlackInput, parseCSV,
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
    description: 'Runs the specified scrape type for the provided base URL or a list of URLs provided in a CSV file and optionally for a date range.'
            + '\nOnly members of role "scrape" can run this command.'
            + '\nCurrently this will run the scraper for all sources and all destinations configured for the site, hence be aware of costs.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL|CSV-File}`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  const scrapeSite = async (baseURL, slackContext) => {
    const { say } = slackContext;
    const site = await Site.findByBaseURL(baseURL);
    if (!isNonEmptyObject(site)) {
      await postSiteNotFoundMessage(say, baseURL);
      return null;
    }

    const result = await site.getSiteTopPagesBySourceAndGeo('ahrefs', 'global');
    const topPages = result || [];

    if (!isNonEmptyArray(topPages)) {
      await say(`:warning: No top pages found for site \`${baseURL}\``);
      return null;
    }

    const urls = topPages.map((page) => ({ url: page.getUrl() }));
    log.info(`Found top pages for site \`${baseURL}\`, total ${topPages.length} pages.`);

    const batches = [];
    for (let i = 0; i < urls.length; i += 50) {
      batches.push(urls.slice(i, i + 50));
    }

    return Promise.all(
      batches.map((urlsBatch) => triggerScraperRun(`${site.getId()}`, urlsBatch, slackContext, context)),
    );
  };

  /**
     * Validates input and triggers a new scrape run for the given site.
     *
     * @param {string[]} args - The arguments provided to the command ([site]).
     * @param {Object} slackContext - The Slack context object.
     * @param {Function} slackContext.say - The Slack say function.
     * @returns {Promise} A promise that resolves when the operation is complete.
     */
  const handleExecution = async (args, slackContext) => {
    const { say, files, botToken } = slackContext;

    /* todo: uncomment after summit and back-office-UI support for configuration setting (roles)
    const config = await Configuration.findLatest();
    const slackRoles = config.getSlackRoles() || {};
    const admins = slackRoles?.scrape || [];

    if (!admins.includes(user)) {
      await say(':error: Only members of role "scrape" can run this command.');
      return;
    }
    */
    try {
      const [baseURLInput] = args;
      const baseURL = extractURLFromSlackInput(baseURLInput);
      const isValidBaseURL = isValidUrl(baseURL);
      const hasFiles = isNonEmptyArray(files);

      if (!isValidBaseURL && !hasFiles) {
        await say(baseCommand.usage());
        return;
      }

      if (isValidBaseURL && hasFiles) {
        await say(':warning: Please provide either a baseURL or a CSV file with a list of site URLs.');
        return;
      }

      if (hasFiles) {
        if (files.length > 1) {
          await say(':warning: Please provide only one CSV file.');
          return;
        }

        const file = files[0];
        if (!file.name.endsWith('.csv')) {
          await say(':warning: Please provide a CSV file.');
          return;
        }

        const csvData = await parseCSV(file, botToken);

        say(`:adobe-run: Triggering scrape run for ${csvData.length} sites.`);
        await Promise.all(
          csvData.map(async (row) => {
            const [csvBaseURL] = row;
            try {
              await scrapeSite(csvBaseURL, slackContext);
            } catch (error) {
              say(`:warning: Failed scrape for \`${csvBaseURL}\`: ${error.message}`);
            }
          }),
        );
      } else if (isValidBaseURL) {
        say(`:adobe-run: Triggering scrape run for site \`${baseURL}\``);
        await scrapeSite(baseURL, slackContext);
        say(`:white_check_mark: Completed triggering scrape for \`${baseURL}\`.`);
      }
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
