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

/* eslint-disable no-use-before-define */

// todo: prototype - untested
/* c8 ignore start */

import {
  hasText,
  isNonEmptyArray,
  isNonEmptyObject,
  isValidUrl,
} from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { triggerImportRun } from '../../utils.js';
import {
  extractURLFromSlackInput, parseCSV,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';
import { isValidDateInterval } from '../../../utils/date-utils.js';

/**
 *  @import {
 *    type Site, SiteCollection
 * } from "@adobe/spacecat-shared-data-access/src/models/site/index.js"
 */

const PHRASES = ['run import'];

const SUPPORTS_PAGE_URLS = ['organic-keywords', 'organic-keywords-nonbranded'];

/**
 * Factory function to create the RunImportCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunImportCommand} The RunImportCommand object.
 * @constructor
 */
function RunImportCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-import',
    name: 'Run Import',
    description: 'Runs the specified import type for the site identified with its id, and optionally for a date range.'
      + '\nOnly selected SpaceCat fluid team members can run imports.'
      + '\nCurrently this will run the import for all sources and all destinations configured for the site, hence be aware of costs'
      + ' (source: ahrefs) when choosing the date range.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {importType} {baseURL|CSV-file} {startDate} {endDate}`,
  });

  const { dataAccess, log } = context;
  const { Configuration, Site } = dataAccess;

  /**
   * Triggers an import run for the given site.
   * @param {string} importType - The type of import to run.
   * @param {string} pageOrBaseURL - The base URL of a site,
   *                                 or a full page URL if the import type supports it.
   * @param {string} startDate - The start date for the import run.
   * @param {string} endDate - The end date for the import run.
   * @param {Object} config - The configuration object.`
   * @param {Object} slackContext - The Slack context object.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const runImportForSite = async (
    importType,
    pageOrBaseURL,
    startDate,
    endDate,
    config,
    slackContext,
  ) => {
    const { say } = slackContext;

    // If an import type supports full page URLs, finding the site gets a bit more involved:
    // Simply searching by the protocol + top level domain might not suffice,
    // in cases where the site uses a path prefix.
    // Searching for protocol + TLD first will yield incorrect results in cases
    // where there are multiple sites per domain, e.g.
    // - https://adobe.com
    // - https://adobe.com/express
    // For these cases, we have to shorten the path segment by segment and try to find the site.
    const site = SUPPORTS_PAGE_URLS.includes(importType)
      ? await findSiteForURL(Site, pageOrBaseURL)
      : await Site.findByBaseURL(pageOrBaseURL);

    if (!isNonEmptyObject(site)) {
      await postSiteNotFoundMessage(say, pageOrBaseURL);
      return;
    }

    await triggerImportRun(
      config,
      importType,
      site.getId(),
      startDate,
      endDate,
      slackContext,
      context,
      site.getBaseURL() !== pageOrBaseURL ? pageOrBaseURL : undefined,
    );
  };

  /**
   * Validates input and triggers a new import run for the given site.
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say, files, botToken } = slackContext;

    const config = await Configuration.findLatest();
    /* todo: uncomment after summit and back-office-UI support for configuration setting (roles)
    const slackRoles = config.getSlackRoles() || {};
    const admins = slackRoles?.import || [];

    if (!admins.includes(user)) {
      await say(':error: Only members of role "import" can run this command.');
      return;
    }
    */

    try {
      const [importType, baseURLInput, start, end] = args;
      const pageOrBaseURL = extractURLFromSlackInput(baseURLInput);
      const hasValidURL = isValidUrl(pageOrBaseURL);
      const hasFiles = isNonEmptyArray(files);

      const [startDate, endDate] = hasFiles
        ? [baseURLInput, start]
        : [start, end];

      if (!hasText(importType) || (!hasValidURL && !hasFiles)) {
        await say(baseCommand.usage());
        return;
      }

      if (hasValidURL && hasFiles) {
        await say(':warning: Please provide either a baseURL or a CSV file with a list of site URLs.');
        return;
      }

      if ((startDate || endDate) && !isValidDateInterval(startDate, endDate)) {
        await say(':error: Invalid date interval. '
        + 'Please provide valid dates in the format YYYY-MM-DD. '
        + 'The end date must be after the start date and within a two-year range.');
        return;
      }

      const jobConfig = config.getJobs().filter((job) => job.group === 'imports' && job.type === importType);

      if (!Array.isArray(jobConfig) || jobConfig.length === 0) {
        const validImportTypes = config.getJobs().filter((job) => job.group === 'imports').map((job) => job.type);
        await say(`:warning: Import type ${importType} does not exist. Valid import types are: ${validImportTypes.join(', ')}`);
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

        say(`:adobe-run: Triggering import run of type ${importType} for ${csvData.length} sites.`);

        await Promise.all(
          csvData.map(async (row) => {
            const [csvURL] = row;
            if (isValidUrl(csvURL)) {
              await runImportForSite(
                importType,
                csvURL,
                startDate,
                endDate,
                config,
                slackContext,
              );
            } else {
              await say(`:warning: Invalid URL found in CSV file: ${csvURL}`);
            }
          }),
        );
      } else if (hasValidURL) {
        await runImportForSite(importType, pageOrBaseURL, startDate, endDate, config, slackContext);

        const message = `:adobe-run: Triggered import run of type ${importType} for site \`${pageOrBaseURL}\`${startDate && endDate ? ` and interval ${startDate}-${endDate}` : ''}\n`;
        // message += 'Stand by for results. I will post them here when they are ready.';

        await say(message);
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

/**
 * Finds a site for the given URL by finding a site with the longest prefix match for the URL.
 *
 * @param {SiteCollection} Site
 * @param {string} pageOrBaseURL - The URL to find the site for.
 * @returns {Promise<null | Site>} A promise that resolves to the found Site object.
 */
async function findSiteForURL(Site, pageOrBaseURL) {
  const url = new URL(pageOrBaseURL);
  url.search = url.hash = ''; // eslint-disable-line no-multi-assign
  let site = null;
  let previousPathname = null;
  while (!site && previousPathname !== url.pathname) {
    site = await Site.findByBaseURL(String(url)); // eslint-disable-line no-await-in-loop
    previousPathname = url.pathname;
    url.pathname = previousPathname.replace(/[/]$|[^/]+$/, '');
  }

  return Site.findByBaseURL(`${url.protocol}//${url.host}`);
}

export default RunImportCommand;
/* c8 ignore end */
