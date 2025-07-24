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
  'organic-keywords',
  'organic-keywords-nonbranded',
  'organic-keywords-ai-overview',
  'organic-keywords-feature-snippets',
  'organic-keywords-questions',
  'top-forms',
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

    log.info('[RUN-IMPORT] runImportForSite called with params:', {
      importType,
      baseURL,
      startDate,
      endDate,
      pageURL,
      data,
      hasConfig: !!config,
      hasSlackContext: !!slackContext,
    });

    const site = await Site.findByBaseURL(baseURL);
    log.info('[RUN-IMPORT] Site lookup result:', {
      baseURL,
      siteFound: !!site,
      siteId: site?.getId(),
      siteData: site ? Object.keys(site) : null,
    });

    if (!isNonEmptyObject(site)) {
      log.warn('[RUN-IMPORT] Site not found for baseURL:', baseURL);
      await postSiteNotFoundMessage(say, baseURL);
      return;
    }

    log.info('[RUN-IMPORT] About to trigger import run with params:', {
      importType,
      siteId: site.getId(),
      startDate,
      endDate,
      pageURL,
      data,
    });

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

    log.info('[RUN-IMPORT] triggerImportRun completed for:', {
      importType,
      siteId: site.getId(),
      baseURL,
    });
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

    log.info('[RUN-IMPORT] handleExecution started with args:', {
      args,
      hasFiles: !!files,
      fileCount: files?.length,
      fileNames: files?.map((f) => f.name),
      hasBotToken: !!botToken,
    });

    const config = await Configuration.findLatest();
    log.info('[RUN-IMPORT] Configuration loaded:', {
      hasConfig: !!config,
      configKeys: config ? Object.keys(config) : null,
      jobsCount: config?.getJobs()?.length,
    });

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
      log.info('[RUN-IMPORT] Parsed arguments:', {
        importType,
        baseURLInput,
        start,
        end,
        pageURLInput,
        isTopForms: importType === 'top-forms',
      });

      const baseURL = extractURLFromSlackInput(baseURLInput);
      const hasValidBaseURL = isValidUrl(baseURL);
      const hasFiles = isNonEmptyArray(files);

      log.info('[RUN-IMPORT] URL processing results:', {
        originalBaseURLInput: baseURLInput,
        extractedBaseURL: baseURL,
        hasValidBaseURL,
        hasFiles,
        fileCount: files?.length,
      });

      const [startDate, endDate] = hasFiles
        ? [baseURLInput, start]
        : [start, end];

      log.info('[RUN-IMPORT] Date processing:', {
        hasFiles,
        startDate,
        endDate,
        originalStart: start,
        originalEnd: end,
      });

      if (!hasText(importType) || (!hasValidBaseURL && !hasFiles)) {
        log.warn('[RUN-IMPORT] Invalid input validation failed:', {
          hasImportType: !!hasText(importType),
          hasValidBaseURL,
          hasFiles,
        });
        await say(baseCommand.usage());
        return;
      }

      if (hasValidBaseURL && hasFiles) {
        log.warn('[RUN-IMPORT] Both baseURL and files provided - conflicting input');
        await say(':warning: Please provide either a baseURL or a CSV file with a list of site URLs.');
        return;
      }

      if ((startDate || endDate) && !isValidDateInterval(startDate, endDate)) {
        log.warn('[RUN-IMPORT] Invalid date interval:', { startDate, endDate });
        await say(':error: Invalid date interval. '
        + 'Please provide valid dates in the format YYYY-MM-DD. '
        + 'The end date must be after the start date and within a two-year range.');
        return;
      }

      const jobConfig = config.getJobs().filter((job) => job.group === 'imports' && job.type === importType);
      log.info('[RUN-IMPORT] Job configuration lookup:', {
        importType,
        jobConfigFound: !!jobConfig,
        jobConfigLength: jobConfig?.length,
        allImportJobs: config.getJobs().filter((job) => job.group === 'imports').map((job) => job.type),
      });

      if (!Array.isArray(jobConfig) || jobConfig.length === 0) {
        const validImportTypes = config.getJobs().filter((job) => job.group === 'imports').map((job) => job.type);
        log.warn('[RUN-IMPORT] Invalid import type:', { importType, validImportTypes });
        await say(`:warning: Import type ${importType} does not exist. Valid import types are: ${validImportTypes.join(', ')}`);
        return;
      }

      const supportsPageURLs = SUPPORTS_PAGE_URLS.includes(importType);
      log.info('[RUN-IMPORT] Page URL support check:', {
        importType,
        supportsPageURLs,
        SUPPORTS_PAGE_URLS,
      });

      if (hasFiles) {
        log.info('[RUN-IMPORT] Processing CSV file flow');

        if (files.length > 1) {
          log.warn('[RUN-IMPORT] Multiple files provided:', { fileCount: files.length });
          await say(':warning: Please provide only one CSV file.');
          return;
        }

        const file = files[0];
        log.info('[RUN-IMPORT] Processing single file:', {
          fileName: file.name,
          fileSize: file.size,
          isCSV: file.name.endsWith('.csv'),
        });

        if (!file.name.endsWith('.csv')) {
          log.warn('[RUN-IMPORT] Non-CSV file provided:', { fileName: file.name });
          await say(':warning: Please provide a CSV file.');
          return;
        }

        // For top-forms import type, we need 3 columns: baseUrl, pageUrl, formSource
        const minColumns = importType === 'top-forms' ? 3 : 2;
        log.info('[RUN-IMPORT] CSV parsing configuration:', {
          importType,
          minColumns,
          isTopForms: importType === 'top-forms',
        });

        const csvData = await parseCSV(file, botToken, minColumns);
        log.info('[RUN-IMPORT] CSV parsing result:', {
          csvDataLength: csvData?.length,
          firstRow: csvData?.[0],
          sampleRows: csvData?.slice(0, 3),
          isTopForms: importType === 'top-forms',
        });

        say(`:adobe-run: Triggering import run of type ${importType} for ${csvData.length} sites.`);

        log.info('[RUN-IMPORT] Starting batch processing for CSV data');

        await Promise.all(
          csvData.map(async (row, index) => {
            const [csvBaseURL, csvPageURL, formSource] = row;
            log.info(`[RUN-IMPORT] Processing CSV row ${index + 1}:`, {
              csvBaseURL,
              csvPageURL,
              formSource,
              isTopForms: importType === 'top-forms',
              rowIndex: index,
            });

            if (isValidUrl(csvBaseURL)) {
              // Create data object for top-forms import type
              const data = importType === 'top-forms' && formSource
                ? { formSource }
                : undefined;

              log.info(`[RUN-IMPORT] Valid URL found, creating data object for row ${index + 1}:`, {
                importType,
                csvBaseURL,
                csvPageURL,
                formSource,
                data,
                isTopForms: importType === 'top-forms',
              });

              await runImportForSite(
                importType,
                csvBaseURL,
                startDate,
                endDate,
                config,
                slackContext,
                supportsPageURLs && isValidUrl(csvPageURL) ? csvPageURL : undefined,
                data,
              );

              log.info(`[RUN-IMPORT] Completed processing for row ${index + 1}:`, {
                csvBaseURL,
                success: true,
              });
            } else {
              log.warn(`[RUN-IMPORT] Invalid URL in CSV row ${index + 1}:`, {
                csvBaseURL,
                rowIndex: index,
              });
              await say(`:warning: Invalid URL found in CSV file: ${csvBaseURL}`);
            }
          }),
        );

        log.info('[RUN-IMPORT] Batch CSV processing completed');
      } else if (hasValidBaseURL) {
        log.info('[RUN-IMPORT] Processing single URL flow');

        // if pageURLInput is enclosed in brackets, remove them.
        // Slack sends URLs enclosed in brackets if not configured differently.
        // For details, check https://api.slack.com/interactivity/slash-commands
        //
        // extractURLFromSlackInput also removes the www. subdomain; we want to avoid that here.
        const extractedPageURL = /^<(.*)>/.exec(pageURLInput ?? '')?.[1] ?? pageURLInput;
        const pageURL = extractedPageURL && supportsPageURLs && isValidUrl(extractedPageURL)
          ? extractedPageURL
          : undefined;

        log.info('[RUN-IMPORT] Page URL processing:', {
          originalPageURLInput: pageURLInput,
          extractedPageURL,
          finalPageURL: pageURL,
          supportsPageURLs,
          isValidExtractedURL: extractedPageURL ? isValidUrl(extractedPageURL) : false,
        });

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

        log.info('[RUN-IMPORT] Single URL processing completed, sending message:', { message });
        await say(message);
      }

      log.info('[RUN-IMPORT] handleExecution completed successfully');
    } catch (error) {
      log.error('[RUN-IMPORT] Error in handleExecution:', error);
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
