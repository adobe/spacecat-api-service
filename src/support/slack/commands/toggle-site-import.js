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
import {
  isValidUrl, isNonEmptyArray, hasText, tracingFetch as fetch,
} from '@adobe/spacecat-shared-utils';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

import { parseCSV, extractURLFromSlackInput, loadProfileConfig } from '../../../utils/slack/base.js';
import BaseCommand from './base.js';

const PHRASE = 'import';
const SUCCESS_MESSAGE_PREFIX = ':white_check_mark: ';
const ERROR_MESSAGE_PREFIX = ':x: ';

export default (context) => {
  const baseCommand = BaseCommand({
    id: 'configurations-sites--toggle-site-import',
    name: 'Enable/Disable the Site Import',
    description: `Enables or disables an import functionality for a site. 
    Supports single URL or CSV file upload.
    CSV file must be in the format of baseURL per line(no headers).
    Profiles are defined in the config/profiles.json file.`,
    phrases: [PHRASE],
    usageText: `${PHRASE} {enable/disable} {site} {importType} for singleURL, 
    or ${PHRASE} {enable/disable} {profile/importType} with CSV file uploaded.`,
  });

  const { log, dataAccess } = context;
  const { Site } = dataAccess;

  /**
   * Validates the command input parameters for enabling/disabling imports.
   *
   * @param {string} enableImport - The action to perform, must be either 'enable' or 'disable'
   * @param {string} importType - The type of import or profile to enable/disable
   * @throws {Error} If enableImport is invalid or if importType is empty/not a string
   */
  const validateInput = (enableImport, importType) => {
    if (hasText(enableImport) === false || ['enable', 'disable'].includes(enableImport) === false) {
      throw new Error('The "enableImport" parameter is required and must be set to "enable" or "disable".');
    }

    if (hasText(importType) === false || importType.length === 0) {
      throw new Error('The import type parameter is required.');
    }
  };

  /**
   * Validates the content of a CSV file by checking for non-empty content and valid URLs.
   *
   * @param {string} fileContent - The raw CSV file content to validate
   * @returns {Promise<string[]>} A promise that resolves to an array of validated URLs
   * @throws {Error} If the file is empty or contains invalid URLs
   */
  const validateCSVFile = async (fileContent, botToken) => {
    const urls = [];
    const invalidUrls = [];
    const csvData = await parseCSV(fileContent, botToken);

    if (!isNonEmptyArray(csvData)) {
      throw new Error('The parsed CSV data is empty.');
    }

    for (const row of csvData) {
      const [baseURL] = row;
      if (!isValidUrl(baseURL)) {
        invalidUrls.push(baseURL);
      } else {
        urls.push(baseURL);
      }
    }

    if (isNonEmptyArray(invalidUrls)) {
      throw new Error(`Invalid URLs found in CSV:\n${invalidUrls.join('\n')}`);
    }
    return urls;
  };

  const handleSingleURL = async (
    baseURLInput,
    importType,
    enableImport,
    say,
    isEnableImport,
    isProfile = false,
  ) => {
    const result = {
      baseURL: baseURLInput,
      success: false,
      error: null,
    };
    const baseURL = extractURLFromSlackInput(baseURLInput);

    validateInput(enableImport, importType);

    try {
      if (!isValidUrl(baseURL)) {
        throw new Error(`Invalid URL: ${baseURL}`);
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await say(`${ERROR_MESSAGE_PREFIX}Cannot update site with baseURL: "${baseURL}", site not found.`);
        result.error = 'Site not found';
        return result;
      }

      const siteConfig = site.getConfig();
      let importTypes = [];

      if (isProfile) {
        importTypes = importType;
      } else {
        importTypes = [importType];
      }

      for (const importTypeItem of importTypes) {
        if (isEnableImport) {
          siteConfig.enableImport(importTypeItem);
        } else {
          siteConfig.disableImport(importTypeItem);
        }
      }

      site.setConfig(Config.toDynamoItem(siteConfig));
      await site.save();

      result.success = true;
      return result;
    } catch (error) {
      log.error(error);
      result.success = false;
      result.error = error.message;
      return result;
    }
  };

  const handleExecution = async (args, slackContext) => {
    const { say, files, botToken } = slackContext;

    try {
      const [enableImportInput, importTypeOrProfileInput] = args;

      const enableImport = enableImportInput.toLowerCase();
      const isEnableImport = enableImport === 'enable';
      const importTypeOrProfile = importTypeOrProfileInput
        ? importTypeOrProfileInput.toLowerCase() : null;

      // single URL behavior
      if (!isNonEmptyArray(files)) {
        const [, baseURLInput, singleImportType] = args;

        const result = await handleSingleURL(
          baseURLInput,
          singleImportType,
          enableImport,
          say,
          isEnableImport,
        );
        if (result.success) {
          await say(`${SUCCESS_MESSAGE_PREFIX}The import "${singleImportType}" has been *${enableImport}d* for "${baseURLInput}".`);
        } else {
          await say(`${ERROR_MESSAGE_PREFIX}${result.error}`);
        }
        return;
      }

      validateInput(enableImport, importTypeOrProfile);

      let importTypes;
      let isProfile = false;

      // Check if it's a profile by attempting to load it
      try {
        const profile = loadProfileConfig(importTypeOrProfile);

        importTypes = Object.keys(profile.imports);
        isProfile = true;
      } catch (e) {
        // If loading profile fails, it's a single import type
        importTypes = [importTypeOrProfile];
        isProfile = false;
      }

      const typeDescription = isProfile ? `profile "${importTypeOrProfile}"` : `import type "${importTypeOrProfile}"`;

      await say(`:information_source: Processing ${typeDescription} with ${importTypes.length} import type${importTypes.length > 1 ? 's' : ''}: ${importTypes.join(', ')}`);

      const file = files[0];

      const response = await fetch(file.url_private, {
        headers: {
          Authorization: `Bearer ${context.env.SLACK_BOT_TOKEN}`,
        },
      });

      if (!response.ok) {
        await say(`${ERROR_MESSAGE_PREFIX}Failed to download the CSV file.`);
        return;
      }

      const fileContent = await response.text();

      let baseURLs;
      try {
        baseURLs = await validateCSVFile(fileContent, botToken);
      } catch (error) {
        await say(`${ERROR_MESSAGE_PREFIX}${error.message}`);
        return;
      }

      const results = {
        successful: [],
        failed: [],
      };

      await say(`:hourglass_flowing_sand: Processing ${baseURLs.length} URLs...`);

      const processPromises = baseURLs.map(async (baseURL) => {
        const result = await handleSingleURL(
          baseURL,
          importTypeOrProfile,
          enableImport,
          say,
          isEnableImport,
          true,
        );

        if (result.success) {
          results.successful.push(result.baseURL);
        } else {
          results.failed.push({ baseURL, error: result.error });
        }
      });

      const processedResults = await Promise.all(processPromises);

      results.successful = processedResults
        .filter((result) => result.success)
        .map((result) => result.baseURL);

      results.failed = processedResults
        .filter((result) => !result.success)
        .map(({ baseURL, error }) => ({ baseURL, error }));

      let message = ':clipboard: *Bulk Update Results*\n';
      if (isProfile) {
        message += `\nProfile: \`${importTypeOrProfile}\` with ${importTypes.length} import types:`;
        message += `\n\`\`\`${importTypes.join('\n')}\`\`\``;
      } else {
        message += `\nImport Type: \`${importTypeOrProfile}\``;
      }

      if (isNonEmptyArray(results.successful)) {
        message += `\n${SUCCESS_MESSAGE_PREFIX}Successfully ${enableImport}d for ${results.successful.length} sites:`;
        message += `\n\`\`\`${results.successful.join('\n')}\`\`\``;
      }

      if (isNonEmptyArray(results.failed)) {
        message += `\n${ERROR_MESSAGE_PREFIX}Failed to process ${results.failed.length} sites:`;
        message += '\n```';
        results.failed.forEach(({ baseURL, error }) => {
          message += `${baseURL}: ${error}\n`;
        });
        message += '```';
      }

      await say(message);
    } catch (error) {
      log.error(error);
      await say(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable imports: ${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
};
