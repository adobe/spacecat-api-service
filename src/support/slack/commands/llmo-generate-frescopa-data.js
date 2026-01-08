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

import BaseCommand from './base.js';
import { postErrorMessage } from '../../../utils/slack/base.js';
import {
  createSharePointClient,
} from '../../../controllers/llmo/llmo-onboarding.js';

const PHRASES = ['llmo-generate-frescopa-data'];
const DATA_FOLDER = 'frescopa.coffee';
const TEMPLATE_FOLDER = `/sites/elmo-ui-data/${DATA_FOLDER}/template`;

// Template files and their destination folders
const FILE_CONFIGS = [
  {
    templateName: 'agentictraffic-wXX-YYYY.xlsx',
    destinationFolder: 'agentic-traffic',
    filePrefix: 'agentictraffic',
  },
  {
    templateName: 'brandpresence-all-wXX-YYYY.xlsx',
    destinationFolder: 'brand-presence',
    filePrefix: 'brandpresence-all',
  },
  {
    templateName: 'referral-traffic-wXX-YYYY.xlsx',
    destinationFolder: 'referral-traffic',
    filePrefix: 'referral-traffic',
  },
];

/**
 * Publishes a file to admin.hlx.page (preview and live).
 * @param {string} filename - The filename to publish (without extension)
 * @param {string} outputLocation - The output folder location
 * @param {object} log - Logger instance
 */
async function publishToAdminHlx(filename, outputLocation, log) {
  try {
    const org = 'adobe';
    const site = 'project-elmo-ui-data';
    const ref = 'main';
    const jsonFilename = `${filename.replace(/\.[^/.]+$/, '')}.json`;
    const path = `${outputLocation}/${jsonFilename}`;
    const headers = { Cookie: `auth_token=${process.env.HLX_ADMIN_TOKEN}` };

    if (!process.env.HLX_ADMIN_TOKEN) {
      log.warn('HLX_ADMIN_TOKEN is not set');
    }

    const baseUrl = 'https://admin.hlx.page';
    const endpoints = [
      { name: 'preview', url: `${baseUrl}/preview/${org}/${site}/${ref}/${path}` },
      { name: 'live', url: `${baseUrl}/live/${org}/${site}/${ref}/${path}` },
    ];

    for (const [index, endpoint] of endpoints.entries()) {
      log.debug(`Publishing Excel file via admin API (${endpoint.name}): ${endpoint.url}`);

      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(endpoint.url, { method: 'POST', headers });

      if (!response.ok) {
        throw new Error(`${endpoint.name} failed: ${response.status} ${response.statusText}`);
      }

      log.debug(`Excel file successfully published to ${endpoint.name}`);

      if (index === 0) {
        // eslint-disable-next-line no-await-in-loop,max-statements-per-line
        await new Promise((resolve) => { setTimeout(resolve, 2000); });
      }
    }
  } catch (publishError) {
    log.error(`Failed to publish via admin.hlx.page: ${publishError.message}`);
    throw publishError;
  }
}

/**
 * Validates week identifier format (e.g., w02-2026).
 * @param {string} weekId - The week identifier to validate
 * @returns {boolean} True if valid format
 */
function isValidWeekIdentifier(weekId) {
  // Matches format like w02-2026, w52-2025, etc.
  const weekPattern = /^w\d{2}-\d{4}$/i;
  return weekPattern.test(weekId);
}

/**
 * Factory function to create the LlmoGenerateFrescopaDataCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The LlmoGenerateFrescopaDataCommand object.
 * @constructor
 */
function LlmoGenerateFrescopaDataCommand(context) {
  const baseCommand = BaseCommand({
    id: 'llmo-generate-frescopa-data',
    name: 'LLMO Generate Frescopa Data',
    description: 'Creates weekly Excel files for agentic-traffic, brand-presence, and referral-traffic in the frescopa.coffee folder.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} <week-identifier> (e.g., ${PHRASES[0]} w02-2026)`,
  });

  const { log, env } = context;

  /**
   * Handles the command execution.
   *
   * @param {string[]} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const [weekIdentifier] = args;

    // Validate week identifier is provided
    if (!weekIdentifier) {
      await say(`:warning: Week identifier is required (e.g., \`w02-2026\`).\n${baseCommand.usage()}`);
      return;
    }

    // Validate week identifier format
    if (!isValidWeekIdentifier(weekIdentifier)) {
      await say(`:warning: Invalid week identifier format. Expected format: \`wXX-YYYY\` (e.g., \`w02-2026\`)\n${baseCommand.usage()}`);
      return;
    }

    const normalizedWeekId = weekIdentifier.toLowerCase();

    try {
      await say(`:gear: Starting Frescopa data generation for week \`${normalizedWeekId}\`...`);

      // Create SharePoint client
      const sharepointClient = await createSharePointClient(env);

      const results = [];
      const errors = [];

      // Process each file configuration
      for (const config of FILE_CONFIGS) {
        const { templateName, destinationFolder, filePrefix } = config;
        const newFileName = `${filePrefix}-${normalizedWeekId}.xlsx`;
        const templatePath = `${TEMPLATE_FOLDER}/${templateName}`;
        const destinationFolderPath = `${DATA_FOLDER}/${destinationFolder}`;
        const destinationFilePath = `/${destinationFolderPath}/${newFileName}`;

        try {
          // eslint-disable-next-line no-await-in-loop
          await say(`:file_folder: Processing \`${newFileName}\`...`);

          // Check if destination folder exists
          const folder = sharepointClient.getDocument(`/sites/elmo-ui-data/${destinationFolderPath}/`);
          // eslint-disable-next-line no-await-in-loop
          const folderExists = await folder.exists();

          if (!folderExists) {
            errors.push(`Folder \`${destinationFolderPath}\` does not exist`);
            // eslint-disable-next-line no-await-in-loop
            await say(`:x: Folder \`${destinationFolderPath}\` does not exist. Skipping \`${newFileName}\`.`);
            // eslint-disable-next-line no-continue
            continue;
          }

          // Check if file already exists
          const newFile = sharepointClient.getDocument(`/sites/elmo-ui-data/${destinationFolderPath}/${newFileName}`);
          // eslint-disable-next-line no-await-in-loop
          const fileExists = await newFile.exists();

          if (fileExists) {
            // eslint-disable-next-line no-await-in-loop
            await say(`:warning: File \`${newFileName}\` already exists in \`${destinationFolder}\`. Skipping.`);
            // eslint-disable-next-line no-continue
            continue;
          }

          // Copy template file to destination
          const templateFile = sharepointClient.getDocument(templatePath);
          // eslint-disable-next-line no-await-in-loop
          await templateFile.copy(destinationFilePath);

          log.info(`Created file ${newFileName} in ${destinationFolderPath}`);
          // eslint-disable-next-line no-await-in-loop
          await say(`:white_check_mark: Created \`${newFileName}\` in \`${destinationFolder}\`.`);

          // Publish the file
          // eslint-disable-next-line no-await-in-loop
          await publishToAdminHlx(newFileName, destinationFolderPath, log);

          results.push({
            fileName: newFileName,
            folder: destinationFolder,
            live: `https://main--project-elmo-ui-data--adobe.aem.live/${destinationFolderPath}/${filePrefix}-${normalizedWeekId}.json`,
          });
        } catch (fileError) {
          log.error(`Error processing ${newFileName}: ${fileError.message}`, fileError);
          errors.push(`Failed to create \`${newFileName}\`: ${fileError.message}`);
          // eslint-disable-next-line no-await-in-loop
          await say(`:x: Failed to create \`${newFileName}\`: ${fileError.message}`);
        }
      }

      // Summary message
      if (results.length > 0) {
        const linksMessage = results
          .map((r) => `:link: *${r.fileName}*\n  ${r.live}`)
          .join('\n\n');

        await say(`:rocket: *Frescopa data generation complete for week ${normalizedWeekId}!*\n\n${linksMessage}`);
      }

      if (errors.length > 0 && results.length === 0) {
        await say(':x: All file operations failed. Please check the errors above.');
      }
    } catch (error) {
      log.error(`Error in frescopa data generation: ${error.message}`, error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default LlmoGenerateFrescopaDataCommand;
