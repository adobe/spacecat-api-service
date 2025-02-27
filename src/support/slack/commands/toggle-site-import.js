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
import { IMPORT_TYPES } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import BaseCommand from './base.js';
import { extractURLFromSlackInput } from '../../../utils/slack/base.js';
import { parseCSV } from '../../../utils/csv.js';

const PHRASE = 'import';
const SUCCESS_MESSAGE_PREFIX = ':white_check_mark: ';
const ERROR_MESSAGE_PREFIX = ':x: ';

const validateInput = (enableImport, baseURL, importType) => {
  if (!['enable', 'disable'].includes(enableImport)) {
    throw new Error('The "enableImport" parameter is required and must be set to "enable" or "disable".');
  }

  if (!isValidUrl(baseURL)) {
    throw new Error('The site URL is missing or in the wrong format.');
  }

  if (!hasText(importType)) {
    throw new Error('The import type parameter is required.');
  }

  if (!Object.values(IMPORT_TYPES).includes(importType)) {
    throw new Error(`Invalid import type. Must be one of: ${Object.values(IMPORT_TYPES).join(', ')}`);
  }
};

/**
 * Processes rows from CSV into import requests
 * @param {Array<Array<string>>} rows - Array of CSV rows
 * @param {string} enableImport Whether to enable or disable
 * @returns {Array<{baseURL: string, importType: string, importConfig: Object}>}
 */
function processImportRows(rows, enableImport) {
  return rows.map((row) => {
    const [baseURL, importType, importConfigStr] = row;
    let importConfig;

    try {
      importConfig = importConfigStr ? JSON.parse(importConfigStr) : undefined;
      validateInput(enableImport, baseURL, importType);
    } catch (error) {
      throw new Error(`Invalid JSON in import configuration for ${baseURL}: ${importConfigStr}`);
    }

    return { baseURL, importType, importConfig };
  });
}

/**
 * Process a single import request into a standardized format
 * @param {Object} params Parameters for the import request
 * @param {string} params.enableImport Whether to enable or disable
 * @param {string} params.baseURL The site's base URL
 * @param {string} params.importType The type of import
 * @param {Object} [params.importConfig] Optional import configuration
 * @returns {{baseURL: string, importType: string, importConfig: Object}} Processed import request
 */
function processSingleImportRequest({
  enableImport, baseURL, importType, importConfig,
}) {
  validateInput(enableImport, baseURL, importType);
  return { baseURL, importType, importConfig };
}

/**
 * Toggles import configuration for a site
 * @param {Object} params - Parameters for toggling import
 * @param {Site} params.site - The site to update
 * @param {string} params.importType - Type of import to toggle
 * @param {boolean} params.enable - Whether to enable or disable the import
 * @param {Object} [params.importConfig] - Optional import configuration
 * @returns {string} Success message
 * @async
 */
async function toggleSiteImport({
  site, importType, enable, importConfig,
}) {
  const config = site.getConfig();

  if (enable) {
    config.enableImport(importType, importConfig);
  } else {
    config.disableImport(importType);
  }

  site.setConfig(config.state);
  await site.save();

  return `${SUCCESS_MESSAGE_PREFIX}The import "${importType}" has been *${enable ? 'enabled' : 'disabled'}* for "${site.getBaseURL()}"`;
}

/**
 * Process multiple import requests
 * @param {Array<{baseURL: string, importType: string, importConfig: Object}>} importRequests
 * @param {boolean} enable Whether to enable or disable the imports
 * @param {Site} Site The Site collection
 * @returns {Promise<Array<string>>} Array of result messages
 */
async function processImportRequests(importRequests, enable, Site) {
  const results = [];

  for (const { baseURL, importType, importConfig } of importRequests) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const site = await Site.findByBaseURL(baseURL);

      if (!site) {
        results.push(`${ERROR_MESSAGE_PREFIX}Site not found: ${baseURL}`);
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const message = await toggleSiteImport({
        site,
        importType,
        enable,
        importConfig,
      });
      results.push(message);
    } catch (error) {
      results.push(`${ERROR_MESSAGE_PREFIX}Error processing ${baseURL}: ${error.message}`);
    }
  }

  return results;
}

export default (context) => {
  const baseCommand = BaseCommand({
    id: 'configurations-sites--toggle-site-import',
    name: 'Enable/Disable Site Import',
    description: 'Enables or disables an import functionality for a site. Can process single site or CSV file.\n'
      + `Valid import types: ${Object.values(IMPORT_TYPES).join(', ')}`,
    phrases: [PHRASE],
    usageText: `${PHRASE} {enable/disable} {site} {importType} [importConfig]`,
  });

  const { log, dataAccess } = context;
  const { Site } = dataAccess;

  /**
   * Extract import requests from CSV file
   * @param {Object} file The uploaded file
   * @param {string} enableImport Whether to enable or disable
   * @returns {Promise<Array<{baseURL: string, importType: string, importConfig: Object}>>}
   */
  const getImportsFromCSV = async (file, enableImport) => {
    try {
      return parseCSV(file, (rows) => processImportRows(rows, enableImport));
    } catch (error) {
      throw new Error(`Failed to process CSV file: ${error.message}`);
    }
  };

  /**
   * Extract import request from command arguments
   * @param {Array<string>} args Command arguments
   * @returns {Promise<Array<{baseURL: string, importType: string, importConfig: Object}>>}
   */
  const getImportsFromArgs = async (
    [enableImportInput, baseURLInput, importType, importConfigStr],
  ) => {
    const baseURL = extractURLFromSlackInput(baseURLInput);
    let importConfig;

    try {
      if (importConfigStr) {
        importConfig = JSON.parse(importConfigStr);
      }
    } catch (error) {
      throw new Error('Invalid JSON in import configuration');
    }

    return [processSingleImportRequest({
      enableImport: enableImportInput.toLowerCase() === 'enable',
      baseURL,
      importType,
      importConfig,
    })];
  };

  const handleExecution = async (args, slackContext) => {
    const { say, message } = slackContext;
    const [enableImportInput] = args;
    const enableImportArg = enableImportInput.toLowerCase();
    const enableImport = enableImportArg === 'enable';

    try {
      const imports = await (isNonEmptyArray(message.files)
        ? getImportsFromCSV(message.files[0], enableImportArg)
        : getImportsFromArgs(args));

      const results = await processImportRequests(imports, enableImport, Site);

      await say(results.join('\n'));
    } catch (error) {
      log.error(error);
      await say(`${ERROR_MESSAGE_PREFIX}${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
};
