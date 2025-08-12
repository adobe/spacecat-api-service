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

const PHRASES = ['run import'];

const SUPPORTS_PAGE_URLS = [
  'llmo-prompts-ahrefs',
  'organic-keywords',
  'organic-keywords-nonbranded',
  'organic-keywords-ai-overview',
  'organic-keywords-feature-snippets',
  'organic-keywords-questions',
];

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
   * @param {string} baseURL - The base URL of the site.
   * @param {string} startDate - The start date for the import run.
   * @param {string} endDate - The end date for the import run.
   * @param {Object} config - The configuration object.`
   * @param {Object} slackContext - The Slack context object.
   * @param {string} [pageURL] - Optional full page URL to use instead of the base URL.
   * @param {Object} [data] - Optional data object for import-specific data.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const runImportForSite = async (
    importType,
    baseURL,
    startDate,
    endDate,
    config,
    slackContext,
    pageURL,
    data,
  ) => {
    const { say } = slackContext;

    const site = await Site.findByBaseURL(baseURL);
    if (!isNonEmptyObject(site)) {
      await postSiteNotFoundMessage(say, baseURL);
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
      pageURL,
      data,
    );
  };

  /**
   * Handles top-forms import with CSV file containing pageUrl and formSource columns.
   * @param {string} importType - The import type.
   * @param {string} baseURL - The base URL of the site.
   * @param {string} startDate - The start date for the import run.
   * @param {string} endDate - The end date for the import run.
   * @param {Object} config - The configuration object.
   * @param {Object} slackContext - The Slack context object.
   * @param {Array} csvData - Array of CSV rows with [pageUrl, formSource].
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleTopFormsImport = async (
    importType,
    baseURL,
    startDate,
    endDate,
    config,
    slackContext,
    csvData,
  ) => {
    // Transform CSV data into the expected format for the data parameter
    const formsData = csvData.map(([pageUrl, formSource]) => ({
      pageUrl,
      formSource,
    }));

    await runImportForSite(
      importType,
      baseURL,
      startDate,
      endDate,
      config,
      slackContext,
      undefined, // pageURL not used for forms
      { forms: formsData }, // Pass all form data in the data parameter
    );
  };

  /**
   * Handles standard CSV import with baseURL and optional pageURL columns.
   * @param {string} importType - The import type.
   * @param {string} startDate - The start date for the import run.
   * @param {string} endDate - The end date for the import run.
   * @param {Object} config - The configuration object.
   * @param {Object} slackContext - The Slack context object.
   * @param {Array} csvData - Array of CSV rows.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleStandardCSVImport = async (
    importType,
    startDate,
    endDate,
    config,
    slackContext,
    csvData,
  ) => {
    const { say } = slackContext;
    const supportsPageURLs = SUPPORTS_PAGE_URLS.includes(importType);

    await Promise.all(
      csvData.map(async (row) => {
        const [csvBaseURL, csvPageURL] = row;
        if (isValidUrl(csvBaseURL)) {
          await runImportForSite(
            importType,
            csvBaseURL,
            startDate,
            endDate,
            config,
            slackContext,
            supportsPageURLs && isValidUrl(csvPageURL) ? csvPageURL : undefined,
            undefined, // No additional data for standard imports
          );
        } else {
          await say(`:warning: Invalid URL found in CSV file: ${csvBaseURL}`);
        }
      }),
    );
  };

  /**
   * Validates input parameters based on import type requirements.
   * @param {string} importType - The import type.
   * @param {boolean} hasValidBaseURL - Whether a valid base URL is provided.
   * @param {boolean} hasFiles - Whether CSV files are provided.
   * @param {string} startDate - The start date.
   * @param {string} endDate - The end date.
   * @param {Object} config - The configuration object.
   * @param {Function} say - The Slack say function.
   * @returns {Promise<Object>} Validation result with success flag and error message.
   */
  const validateInputs = async (
    importType,
    hasValidBaseURL,
    hasFiles,
    startDate,
    endDate,
    config,
    say,
  ) => {
    // Basic import type validation
    if (!hasText(importType)) {
      await say(baseCommand.usage());
      return { success: false };
    }

    // Import type-specific validation
    if (importType === 'top-forms') {
      // For top-forms, BOTH baseURL and CSV file are required
      if (!hasValidBaseURL) {
        await say(':error: Top-forms import requires a base URL. Please provide a valid base URL.');
        return { success: false };
      }
      if (!hasFiles) {
        await say(':error: Top-forms import requires a CSV file with pageUrl and formSource(Optional) columns.');
        return { success: false };
      }
    } else {
      // For other import types, either baseURL or CSV file is required (but not both)
      if (!hasValidBaseURL && !hasFiles) {
        await say(baseCommand.usage());
        return { success: false };
      }
      if (hasValidBaseURL && hasFiles) {
        await say(':warning: Please provide either a baseURL or a CSV file with a list of site URLs.');
        return { success: false };
      }
    }

    // Date validation
    if ((startDate || endDate) && !isValidDateInterval(startDate, endDate)) {
      await say(':error: Invalid date interval. '
      + 'Please provide valid dates in the format YYYY-MM-DD. '
      + 'The end date must be after the start date and within a two-year range.');
      return { success: false };
    }

    // Job configuration validation
    const jobConfig = config.getJobs().filter((job) => job.group === 'imports' && job.type === importType);
    if (!Array.isArray(jobConfig) || jobConfig.length === 0) {
      const validImportTypes = config.getJobs().filter((job) => job.group === 'imports').map((job) => job.type);
      await say(`:warning: Import type ${importType} does not exist. Valid import types are: ${validImportTypes.join(', ')}`);
      return { success: false };
    }

    return { success: true };
  };

  /**
   * Extracts start and end dates from arguments based on import type and file presence.
   * @param {string} importType - The import type.
   * @param {string} baseURLInput - The base URL input argument.
   * @param {string} start - The start date argument.
   * @param {string} end - The end date argument.
   * @param {boolean} hasFiles - Whether CSV files are present.
   * @returns {Array} Array containing [startDate, endDate].
   */
  const extractDateRange = (importType, baseURLInput, start, end, hasFiles) => {
    // For forms import, both baseURL and files are present, so dates are in start/end positions
    if (importType === 'top-forms') {
      return [start, end];
    }

    // For other imports: if files present, dates shift to baseURLInput/start positions
    return hasFiles
      ? [baseURLInput, start]
      : [start, end];
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
      const [importType, baseURLInput, start, end, pageURLInput] = args;
      const baseURL = extractURLFromSlackInput(baseURLInput);
      const hasValidBaseURL = isValidUrl(baseURL);
      const hasFiles = isNonEmptyArray(files);

      const [startDate, endDate] = extractDateRange(importType, baseURLInput, start, end, hasFiles);

      const validationResult = await validateInputs(
        importType,
        hasValidBaseURL,
        hasFiles,
        startDate,
        endDate,
        config,
        say,
      );
      if (!validationResult.success) {
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

        const isTopForms = importType === 'top-forms';
        const csvData = await parseCSV(file, botToken, isTopForms ? 1 : 2);

        if (isTopForms) {
          say(`:adobe-run: Triggering import run of type ${importType} for ${hasValidBaseURL ? '1 site with ' : ''}${csvData.length} ${hasValidBaseURL ? 'forms' : 'sites'}.`);
          // Handle top-forms with baseURL + CSV (pageUrl, formSource)
          await handleTopFormsImport(
            importType,
            baseURL,
            startDate,
            endDate,
            config,
            slackContext,
            csvData,
          );
        } else {
          say(`:adobe-run: Triggering import run of type ${importType} for ${csvData.length} sites.`);
          // Handle standard CSV import (baseURL, pageURL)
          await handleStandardCSVImport(
            importType,
            startDate,
            endDate,
            config,
            slackContext,
            csvData,
          );
        }
      } else if (hasValidBaseURL) {
        // if pageURLInput is enclosed in brackets, remove them.
        // Slack sends URLs enclosed in brackets if not configured differently.
        // For details, check https://api.slack.com/interactivity/slash-commands
        //
        // extractURLFromSlackInput also removes the www. subdomain; we want to avoid that here.
        const extractedPageURL = /^<(.*)>/.exec(pageURLInput ?? '')?.[1] ?? pageURLInput;
        const supportsPageURLs = SUPPORTS_PAGE_URLS.includes(importType);
        const pageURL = extractedPageURL && supportsPageURLs && isValidUrl(extractedPageURL)
          ? extractedPageURL
          : undefined;
        log.info(`Import run of type ${importType} for site ${baseURL} with input: `, { pageURL, startDate, endDate });
        await runImportForSite(
          importType,
          baseURL,
          startDate,
          endDate,
          config,
          slackContext,
          pageURL,
          undefined, // data parameter - undefined for single URL case
        );

        const message = `:adobe-run: Triggered import run of type ${importType} for site \`${baseURL}\`${startDate && endDate ? ` and interval ${startDate}-${endDate}` : ''}${pageURL ? ` for page ${pageURL}` : ''}\n`;
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

export default RunImportCommand;
/* c8 ignore end */
