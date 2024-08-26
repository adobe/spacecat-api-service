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

// todo: prototype - untested
/* c8 ignore start */

import { hasText, isObject } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { triggerImportRun } from '../../utils.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['run scrape'];

function isValidDateInterval(startDate, endDate) {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate)) {
    return false;
  }
  if (!dateRegex.test(endDate)) {
    return false;
  }
  const parsedStartDate = new Date(startDate);
  if (Number.isNaN(parsedStartDate.getTime())) {
    return false;
  }
  const parsedEndDate = new Date(endDate);
  if (Number.isNaN(parsedEndDate.getTime())) {
    return false;
  }

  return parsedStartDate < parsedEndDate
        && (parsedEndDate - parsedStartDate) <= 1000 * 60 * 60 * 24 * 365 * 2; // 2 years
}

/**
 * Factory function to create the RunScrapeCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunImportCommand} The RunImportCommand object.
 * @constructor
 */
function RunScrapeCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-scrape',
    name: 'Run Scrape',
    description: 'Runs the specified scrape type for the site identified with its id, and optionally for a date range.'
            + '\nOnly selected SpaceCat fluid team members can run scraper.'
            + '\nCurrently this will run the scraper for all sources and all destinations configured for the site, hence be aware of costs'
            + ' (source: ahrefs) when choosing the date range.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {importType} {baseURL} {startDate} {endDate}`,
  });

  const { dataAccess, log } = context;

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

    const admins = JSON.parse(context?.env?.SLACK_IDS_RUN_IMPORT || '[]');

    if (!admins.includes(user)) {
      await say(':error: Only selected SpaceCat fluid team members can run imports.');
      return;
    }

    try {
      const [scrapeType, baseURLInput, startDate, endDate] = args;
      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!hasText(scrapeType) || !hasText(baseURL)) {
        await say(baseCommand.usage());
        return;
      }

      if ((startDate || endDate) && !isValidDateInterval(startDate, endDate)) {
        await say(':error: Invalid date interval. '
                    + 'Please provide valid dates in the format YYYY-MM-DD. '
                    + 'The end date must be after the start date and within a two-year range.');
        return;
      }

      const config = await dataAccess.getConfiguration();
      const jobConfig = config.getJobs().filter((job) => job.group === 'imports' && job.type === scrapeType);

      if (!Array.isArray(jobConfig) || jobConfig.length === 0) {
        const validScrapeTypes = config.getJobs().filter((job) => job.group === 'imports').map((job) => job.type);
        await say(`:warning: Import type ${scrapeType} does not exist. Valid import types are: ${validScrapeTypes.join(', ')}`);
        return;
      }

      const site = await dataAccess.getSiteByBaseURL(baseURL);
      if (!isObject(site)) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      await triggerImportRun(
        config,
        scrapeType,
        site.getId(),
        startDate,
        endDate,
        slackContext,
        context,
      );

      const message = `:adobe-run: Triggered scrape run of type ${scrapeType} for site \`${baseURL}\` and interval ${startDate}-${endDate}\n`;

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
