/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { hasText, isNonEmptyArray, isValidUrl } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import { extractURLFromSlackInput, parseCSV, postErrorMessage } from '../../../utils/slack/base.js';
import { triggerAuditForSite } from '../../utils.js';

const PHRASES = ['run all audits'];

/**
 * Factory function to create a new RunAllAuditsCommand instance.
 * @param {Object} context - The context object.
 * @constructor
 */
function RunAllAuditsCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-all-audits',
    name: 'Run all Audits',
    description: 'Run all configured audits for a specified baseURL or a list of baseURLs from a CSV file.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL|CSV-File}`,
  });

  const { dataAccess, log } = context;
  const { Site, Configuration } = dataAccess;

  /**
   * Runs all audits for the given site.
   * @param {string} baseURL - The base URL of the site.
   * @param {object} slackContext - The Slack context object.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const runAllAuditsForSite = async (baseURL, slackContext) => {
    const { say } = slackContext;

    try {
      const site = await Site.findByBaseURL(baseURL);
      const configuration = await Configuration.findLatest();
      const enabledAudits = configuration.getEnabledAuditsForSite(site);

      if (!isNonEmptyArray(enabledAudits)) {
        await say(`:warning: No audits configured for site \`${baseURL}\``);
        return;
      }

      await Promise.all(
        enabledAudits.map(async (auditType) => {
          try {
            await triggerAuditForSite(site, auditType, slackContext, context);
          } catch (error) {
            log.error(`Error running audit ${auditType.id} for site ${baseURL}`, error);
            await postErrorMessage(say, error);
          }
        }),
      );
    } catch (error) {
      log.error(`Error running all audits for site ${baseURL}`, error);
      await postErrorMessage(say, error);
    }
  };

  /**
   * Validates input and triggers all audits for the given site or sites.
   *
   * @param {string[]} args - The arguments provided to the command ([baseURL|CSV-File]).
   * @param {Object} slackContext - The Slack context object.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say, files, botToken } = slackContext;

    const [baseURLInput] = args;
    const baseURL = extractURLFromSlackInput(baseURLInput);

    if (!hasText(baseURL) && !isNonEmptyArray(files)) {
      await say(baseCommand.usage());
      return;
    }

    if (hasText(baseURL) && isNonEmptyArray(files)) {
      await say(':warning: Please provide either a baseURL or a CSV file with a list of site URLs.');
      return;
    }

    if (isNonEmptyArray(files)) {
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

      await Promise.all(
        csvData.map(async (row) => {
          const [csvBaseURL] = row;
          if (isValidUrl(csvBaseURL)) {
            await runAllAuditsForSite(csvBaseURL, slackContext);
          } else {
            await say(`:warning: Invalid URL found in CSV file: ${csvBaseURL}`);
          }
        }),
      );
    } else if (hasText(baseURL)) {
      await runAllAuditsForSite(baseURL, slackContext);
    }

    say(':white_check_mark: All audits triggered successfully.');
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default RunAllAuditsCommand;
