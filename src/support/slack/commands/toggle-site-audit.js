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
  isString, isValidUrl, isNonEmptyArray, hasText,
} from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import { extractURLFromSlackInput, loadProfileConfig } from '../../../utils/slack/base.js';

const PHRASE = 'audit';
const SUCCESS_MESSAGE_PREFIX = ':white_check_mark: ';
const ERROR_MESSAGE_PREFIX = ':x: ';

export default (context) => {
  const baseCommand = BaseCommand({
    id: 'configurations-sites--toggle-site-audit',
    name: 'Enable/Disable the Site Audit',
    description: 'Enables or disables an audit functionality for a site.',
    phrases: [PHRASE],
    usageText: `${PHRASE} {enable/disable} {site} {auditType}`,
  });

  const { log, dataAccess } = context;
  const { Configuration, Site } = dataAccess;

  const validateInput = (enableAudit, auditType) => {
    if (isString(enableAudit) === false || ['enable', 'disable'].includes(enableAudit) === false) {
      throw new Error('The "enableAudit" parameter is required and must be set to "enable" or "disable".');
    }

    if (isString(auditType) === false || auditType.length === 0) {
      throw new Error('The audit type parameter is required.');
    }
  };

  const processCSVContent = async (fileContent) => fileContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const validateCSVFile = async (file, fileContent) => {
  // Check file extension

    // if (!file.name.toLowerCase().endsWith('.csv')) {
    //   throw new Error('Please upload a CSV file.');
    // }

    // Check if file is empty
    if (hasText(fileContent) === false) {
      throw new Error('The CSV file is empty.');
    }

    // Process and validate content
    const urls = await processCSVContent(fileContent);

    // Check if we have any URLs
    if (!isNonEmptyArray(urls)) {
      throw new Error('No valid URLs found in the CSV file.');
    }

    // Check for valid URL format in each line
    const invalidUrls = urls.filter((url) => !isValidUrl(url));

    if (isNonEmptyArray(invalidUrls)) {
      throw new Error(`Invalid URLs found in CSV:\n${invalidUrls.join('\n')}`);
    }

    return urls;
  };

  const handleExecution = async (args, slackContext) => {
    const { say, files } = slackContext;

    try {
      const [enableAuditInput, auditTypeOrProfileInput] = args;

      // #region debug start
      await say(`enableAuditInput: ${enableAuditInput}`);
      await say(`auditTypeOrProfileInput: ${auditTypeOrProfileInput}`);
      // #endregion

      const enableAudit = enableAuditInput.toLowerCase();
      const auditTypeOrProfile = auditTypeOrProfileInput
        ? auditTypeOrProfileInput.toLowerCase() : null;

      // #region debug start
      await say(`auditTypeOrProfile: ${auditTypeOrProfile}`);
      // #endregion

      // Get configuration early to validate audit types
      const configuration = await Configuration.findLatest();

      // Check if a file was uploaded

      if (isNonEmptyArray(files) === false) {
      // Fall back to original single URL behavior
        const [, baseURLInput, singleAuditType] = args;

        // #region debug start
        await say('Entering single URL behavior');
        await say(`baseURLInput: ${baseURLInput}, singleAuditType: ${singleAuditType}`);
        // #endregion

        const baseURL = extractURLFromSlackInput(baseURLInput);
        console.log(`debug1111: ${baseURL}`);

        validateInput(enableAudit, singleAuditType);

        if (isValidUrl(baseURL) === false) {
          await say(`${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL.`);
          return;
        }

        // Process single site
        try {
          const site = await Site.findByBaseURL(baseURL);
          if (!site) {
            await say(`${ERROR_MESSAGE_PREFIX}Cannot update site with baseURL: "${baseURL}", site not found.`);
            return;
          }

          const registeredAudits = configuration.getHandlers();
          if (!registeredAudits[singleAuditType]) {
            await say(`${ERROR_MESSAGE_PREFIX}The "${singleAuditType}" is not present in the configuration.\nList of allowed audits:\n${Object.keys(registeredAudits).join('\n')}.`);
            return;
          }

          if (enableAudit === 'enable') {
            configuration.enableHandlerForSite(singleAuditType, site);
          } else {
            configuration.disableHandlerForSite(singleAuditType, site);
          }

          await configuration.save();
          await say(`${SUCCESS_MESSAGE_PREFIX}The audit "${singleAuditType}" has been *${enableAudit}d* for "${site.getBaseURL()}".`);
        } catch (error) {
          log.error(error);
          await say(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: ${error.message}`);
        }
        return;
      }

      // Validate inputs and get audit types
      validateInput(enableAudit, auditTypeOrProfile);

      let auditTypes;
      let isProfile = false;
      try {
      // Check if it's a profile by attempting to load it
        try {
          const profile = loadProfileConfig(auditTypeOrProfile);

          auditTypes = Object.keys(profile.audits);
          isProfile = true;
        } catch (e) {
        // If loading profile fails, it's a single audit type
          const registeredAudits = configuration.getHandlers();
          if (!registeredAudits[auditTypeOrProfile]) {
            throw new Error(`Invalid audit type or profile: "${auditTypeOrProfile}"`);
          }

          auditTypes = [auditTypeOrProfile];

          isProfile = false;
        }

        const typeDescription = isProfile ? `profile "${auditTypeOrProfile}"` : `audit type "${auditTypeOrProfile}"`;

        await say(`:information_source: Processing ${typeDescription} with ${auditTypes.length} audit type${auditTypes.length > 1 ? 's' : ''}: ${auditTypes.join(', ')}`);
      } catch (error) {
        await say(`${ERROR_MESSAGE_PREFIX}${error.message}`);
        return;
      }

      // Process the CSV file
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
        baseURLs = await validateCSVFile(file, fileContent);
      } catch (error) {
        await say(`${ERROR_MESSAGE_PREFIX}${error.message}`);
        return;
      }

      // Process all URLs with the specified audit types
      const results = {
        successful: [],
        failed: [],
      };

      await say(`:hourglass_flowing_sand: Processing ${baseURLs.length} URLs...`);

      const processPromises = baseURLs.map(async (baseURL) => {
        try {
          const site = await Site.findByBaseURL(baseURL);
          if (!site) {
            return { baseURL, success: false, error: 'Site not found' };
          }

          auditTypes.forEach((auditType) => {
            if (enableAudit === 'enable') {
              configuration.enableHandlerForSite(auditType, site);
            } else {
              configuration.disableHandlerForSite(auditType, site);
            }
          });

          return { baseURL, success: true };
        } catch (error) {
          return { baseURL, success: false, error: error.message };
        }
      });

      const processedResults = await Promise.all(processPromises);

      results.successful = processedResults
        .filter((result) => result.success)
        .map((result) => result.baseURL);

      results.failed = processedResults
        .filter((result) => !result.success)
        .map(({ baseURL, error }) => ({ baseURL, error }));

      // Save configuration after processing all sites
      await configuration.save();

      // Format and send results message
      let message = ':clipboard: *Bulk Update Results*\n';
      if (isProfile) {
        message += `\nProfile: \`${auditTypeOrProfile}\` with ${auditTypes.length} audit types:`;
        message += `\n\`\`\`${auditTypes.join('\n')}\`\`\``;
      } else {
        message += `\nAudit Type: \`${auditTypeOrProfile}\``;
      }

      if (results.successful.length > 0) {
        message += `\n${SUCCESS_MESSAGE_PREFIX}Successfully ${enableAudit}d for ${results.successful.length} sites:`;
        message += `\n\`\`\`${results.successful.join('\n')}\`\`\``;
      }

      if (results.failed.length > 0) {
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
      await say(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: ${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
};
