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
  hasText,
  isNonEmptyArray,
  isValidUrl,
  tracingFetch as fetch,
} from '@adobe/spacecat-shared-utils';
import { Readable } from 'stream';
import { parse } from 'csv';
import BaseCommand from './base.js';
import { extractURLFromSlackInput, loadProfileConfig } from '../../../utils/slack/base.js';

const PHRASE = 'audit';
const SUCCESS_MESSAGE_PREFIX = ':white_check_mark: ';
const ERROR_MESSAGE_PREFIX = ':x: ';

/**
   * Usage Examples:
   *
   * Single Site Operations:
   * - Enable a specific audit:
   *   @spacecat-dev audit enable https://site.com cwv
   *
   * - Disable a specific audit:
   *   @spacecat-dev audit disable https://site.com broken-backlinks
   *
   * - Enable all audits from default (demo) profile:
   *   @spacecat-dev audit enable https://site.com all
   *
   * - Enable all audits from a specific profile:
   *   @spacecat-dev audit enable https://site.com all paid
   *   @spacecat-dev audit enable https://site.com all plg
   *
   * - Disable all currently enabled audits:
   *   @spacecat-dev audit disable https://site.com all
   *
   * CSV Bulk Operations:
   * - Enable/disable audits for multiple sites (upload CSV with one baseURL per line):
   *   @spacecat-dev audit enable demo [attach CSV file]
   *   @spacecat-dev audit disable paid [attach CSV file]
   */

/**
 * Posts a message with a button to configure preflight audit requirements
 * @param {Object} slackContext - The Slack context object
 * @param {Object} site - The site object
 * @param {string} auditType - The audit type (should be 'preflight')
 */
const promptPreflightConfig = async (slackContext, site, auditType) => {
  const { say } = slackContext;

  const currentAuthoringType = site.getAuthoringType();
  const currentDeliveryConfig = site.getDeliveryConfig() || {};
  const currentHelixConfig = site.getHlxConfig() || {};

  const missingItems = [];
  if (!currentAuthoringType) {
    missingItems.push('Authoring Type');
    missingItems.push('Preview URL');
  } else if (currentAuthoringType === 'documentauthoring') {
    // Document authoring require helix config
    const hasHelixConfig = currentHelixConfig.rso;
    if (!hasHelixConfig) {
      missingItems.push('Helix Preview URL');
    }
  } else if (currentAuthoringType === 'cs' || currentAuthoringType === 'cs/crosswalk') {
    // CS authoring types require delivery config
    const hasDeliveryConfig = currentDeliveryConfig.programId
      && currentDeliveryConfig.environmentId;
    if (!hasDeliveryConfig) {
      missingItems.push('AEM CS Preview URL');
    }
  }

  return say({
    text: `:warning: Preflight audit requires additional configuration for \`${site.getBaseURL()}\``,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *Preflight audit requires additional configuration for:*\n\`${site.getBaseURL()}\`\n\n*Missing:*\n${missingItems.map((item) => `• ${item}`)
            .join('\n')}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Configure & Enable',
            },
            style: 'primary',
            action_id: 'open_preflight_config',
            value: JSON.stringify({
              siteId: site.getId(),
              auditType,
            }),
          },
        ],
      },
    ],
  });
};

export default (context) => {
  const baseCommand = BaseCommand({
    id: 'configurations-sites--toggle-site-audit',
    name: 'Enable/Disable the Site Audit',
    description: `Enables or disables an audit functionality for a site. 
    Supports single URL or CSV file upload.
    CSV file must be in the format of baseURL per line(no headers).
    Profiles are defined in the config/profiles.json file.`,
    phrases: [PHRASE],
    usageText: `${PHRASE} {enable/disable} {site} {auditType} {profileName} for singleURL, 
    or ${PHRASE} {enable/disable} {profile/auditType} with CSV file uploaded.`,
  });

  const { log, dataAccess } = context;
  const { Configuration, Site } = dataAccess;

  /**
   * Validates the command input parameters for enabling/disabling audits.
   *
   * @param {string} enableAudit - The action to perform, must be either 'enable' or 'disable'
   * @param {string} auditType - The type of audit or profile to enable/disable
   * @throws {Error} If enableAudit is invalid or if auditType is empty/not a string
   */
  const validateInput = (enableAudit, auditType) => {
    if (hasText(enableAudit) === false || ['enable', 'disable'].includes(enableAudit) === false) {
      throw new Error('The "enableAudit" parameter is required and must be set to "enable" or "disable".');
    }

    if (hasText(auditType) === false || auditType.length === 0) {
      throw new Error('The audit type parameter is required.');
    }
  };

  /**
   * Processes CSV content to extract URLs from the first column.
   *
   * @param {string} fileContent - The raw CSV file content as a string
   * @returns {Promise<string[]>} A promise that resolves to an array of trimmed URLs
   * @throws {Error} If no valid URLs are found in the CSV or if CSV processing fails
   */
  const processCSVContent = async (fileContent) => {
    const csvString = fileContent.trim();
    const csvStream = Readable.from(csvString);

    return new Promise((resolve, reject) => {
      const urls = [];

      csvStream
        .pipe(parse({ skipEmptyLines: true }))
        .on('data', (row) => {
          if (row[0]?.trim()) {
            urls.push(row[0].trim());
          }
        })
        .on('end', () => {
          if (urls.length === 0) {
            reject(new Error('No valid URLs found in the CSV file.'));
          } else {
            resolve(urls);
          }
        })
        .on('error', (error) => reject(new Error(`CSV processing failed: ${error.message}`)));
    });
  };

  /**
   * Validates the content of a CSV file by checking for non-empty content and valid URLs.
   *
   * @param {string} fileContent - The raw CSV file content to validate
   * @returns {Promise<string[]>} A promise that resolves to an array of validated URLs
   * @throws {Error} If the file is empty or contains invalid URLs
   */
  const validateCSVFile = async (fileContent) => {
    if (hasText(fileContent) === false) {
      throw new Error('The CSV file is empty.');
    }
    const urls = await processCSVContent(fileContent);

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

      const enableAudit = enableAuditInput.toLowerCase();
      const isEnableAudit = enableAudit === 'enable';
      const auditTypeOrProfile = auditTypeOrProfileInput
        ? auditTypeOrProfileInput.toLowerCase() : null;

      const configuration = await Configuration.findLatest();

      // single URL behavior
      if (isNonEmptyArray(files) === false) {
        const [, baseURLInput, singleAuditType, profileNameInput] = args;

        const baseURL = extractURLFromSlackInput(baseURLInput);

        validateInput(enableAudit, singleAuditType);

        if (isValidUrl(baseURL) === false) {
          await say(`${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL.`);
          return;
        }

        try {
          const site = await Site.findByBaseURL(baseURL);
          if (!site) {
            await say(`${ERROR_MESSAGE_PREFIX}Cannot update site with baseURL: "${baseURL}", site not found.`);
            return;
          }

          const registeredAudits = configuration.getHandlers();

          // Handle "all" keyword to enable/disable all audits
          let auditTypes;
          if (singleAuditType.toLowerCase() === 'all') {
            const enabledAudits = configuration.getEnabledAuditsForSite(site);

            if (isEnableAudit) {
              const profileName = profileNameInput ? profileNameInput.toLowerCase() : 'demo';
              /* c8 ignore start */
              // Profile loading error - difficult to test as it reads from filesystem
              try {
                const profileConfig = await loadProfileConfig(profileName);
                // Profile audits is an object with audit names as keys
                const profileAuditTypes = Object.keys(profileConfig.audits || {});
                // Delta: profile audits minus already enabled audits
                auditTypes = profileAuditTypes.filter((audit) => !enabledAudits.includes(audit));
                await say(`:information_source: Enabling ${auditTypes.length} audits from profile "${profileName}": ${auditTypes.join(', ')}`);
              } catch (error) {
                log.error(`Failed to load profile "${profileName}": ${error.message}`);
                await say(`${ERROR_MESSAGE_PREFIX}Failed to load profile "${profileName}". ${error.message}`);
                return;
              }
              /* c8 ignore stop */
            } else {
              // Disable all currently enabled audits
              auditTypes = enabledAudits;
              await say(`:information_source: Disabling ${auditTypes.length} audits: ${auditTypes.join(', ')}`);
            }
          } else {
            if (!registeredAudits[singleAuditType]) {
              await say(`${ERROR_MESSAGE_PREFIX}The "${singleAuditType}" is not present in the configuration.\nList of allowed audits:\n${Object.keys(registeredAudits).join('\n')}.`);
              return;
            }
            auditTypes = [singleAuditType];
          }

          // Process each audit type
          for (const auditType of auditTypes) {
            if (isEnableAudit) {
              if (auditType === 'preflight') {
                const authoringType = site.getAuthoringType();
                const deliveryConfig = site.getDeliveryConfig();
                const helixConfig = site.getHlxConfig();

                let configMissing = false;

                if (!authoringType) {
                  configMissing = true;
                } else if (authoringType === 'documentauthoring' || authoringType === 'ue') {
                  // Document authoring and UE require helix config
                  const hasHelixConfig = helixConfig
                    && helixConfig.rso && Object.keys(helixConfig.rso).length > 0;
                  if (!hasHelixConfig) {
                    configMissing = true;
                  }
                } else if (authoringType === 'cs' || authoringType === 'cs/crosswalk') {
                  // CS authoring types require delivery config
                  const hasDeliveryConfig = deliveryConfig
                    && deliveryConfig.programId && deliveryConfig.environmentId;
                  if (!hasDeliveryConfig) {
                    configMissing = true;
                  }
                }

                if (configMissing) {
                  // Prompt user to configure missing requirements
                  // eslint-disable-next-line no-await-in-loop
                  await promptPreflightConfig(slackContext, site, auditType);
                  return;
                }
              }

              configuration.enableHandlerForSite(auditType, site);
            } else {
              configuration.disableHandlerForSite(auditType, site);
            }
          }

          await configuration.save();

          if (auditTypes.length === 1) {
            await say(`${SUCCESS_MESSAGE_PREFIX}The audit "${auditTypes[0]}" has been *${enableAudit}d* for "${site.getBaseURL()}".`);
          } else {
            await say(`${SUCCESS_MESSAGE_PREFIX}All ${auditTypes.length} audits have been *${enableAudit}d* for "${site.getBaseURL()}".`);
          }
        } catch (error) {
          log.error(error);
          await say(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: ${error.message}`);
        }
        return;
      }

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
        baseURLs = await validateCSVFile(fileContent);
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
        try {
          const site = await Site.findByBaseURL(baseURL);
          if (!site) {
            return { baseURL, success: false, error: 'Site not found' };
          }

          auditTypes.forEach((auditType) => {
            if (isEnableAudit) {
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

      await configuration.save();

      let message = ':clipboard: *Bulk Update Results*\n';
      if (isProfile) {
        message += `\nProfile: \`${auditTypeOrProfile}\` with ${auditTypes.length} audit types:`;
        message += `\n\`\`\`${auditTypes.join('\n')}\`\`\``;
      } else {
        message += `\nAudit Type: \`${auditTypeOrProfile}\``;
      }

      if (isNonEmptyArray(results.successful)) {
        message += `\n${SUCCESS_MESSAGE_PREFIX}Successfully ${enableAudit}d for ${results.successful.length} sites:`;
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
      await say(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: ${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
};
