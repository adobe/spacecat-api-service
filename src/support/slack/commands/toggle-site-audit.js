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
  isValidUrl,
} from '@adobe/spacecat-shared-utils';
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
   * - Disable all audits from default (demo) profile:
   *   @spacecat-dev audit disable https://site.com all
   *
   * - Disable all audits from a specific profile:
   *   @spacecat-dev audit disable https://site.com all paid
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

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [enableAuditInput] = args;

      const enableAudit = enableAuditInput.toLowerCase();
      const isEnableAudit = enableAudit === 'enable';

      const configuration = await Configuration.findLatest();

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

        // Handle "all" keyword to disable all audits
        if (singleAuditType.toLowerCase() === 'all') {
          if (isEnableAudit) {
            await say(`${ERROR_MESSAGE_PREFIX}"enable all" is not supported.`);
            return;
          }

          // Get profile name (default to 'demo' if not provided)
          const profileName = profileNameInput ? profileNameInput.toLowerCase() : 'demo';

          try {
            const profileConfig = await loadProfileConfig(profileName);
            /* c8 ignore start */
            // Defensive fallback, all profiles have audits property
            const profileAuditTypes = Object.keys(profileConfig.audits || {});
            /* c8 ignore stop */

            // Filter to only audits that are currently enabled
            const enabledAudits = profileAuditTypes.filter(
              (auditType) => configuration.isHandlerEnabledForSite(auditType, site),
            );

            enabledAudits.forEach((auditType) => {
              configuration.disableHandlerForSite(auditType, site);
            });

            await configuration.save();
            await say(`${SUCCESS_MESSAGE_PREFIX}Disabled ${enabledAudits.length} audits from profile "${profileName}" for "${site.getBaseURL()}".`);
            return;
            /* c8 ignore start */
          } catch (error) {
            log.error(`Failed to load profile "${profileName}": ${error.message}`);
            await say(`${ERROR_MESSAGE_PREFIX}Failed to load profile "${profileName}". ${error.message}`);
            return;
          }
          /* c8 ignore stop */
        }

        // Handle single audit type
        if (!registeredAudits[singleAuditType]) {
          await say(`${ERROR_MESSAGE_PREFIX}The "${singleAuditType}" is not present in the configuration.\nList of allowed audits:\n${Object.keys(registeredAudits).join('\n')}.`);
          return;
        }

        if (isEnableAudit) {
          if (singleAuditType === 'preflight') {
            const authoringType = site.getAuthoringType();
            const deliveryConfig = site.getDeliveryConfig();
            const helixConfig = site.getHlxConfig();

            let configMissing = false;

            if (!authoringType) {
              configMissing = true;
            } else if (authoringType === 'documentauthoring' || authoringType === 'ue') {
              const hasHelixConfig = helixConfig
                  && helixConfig.rso && Object.keys(helixConfig.rso).length > 0;
              if (!hasHelixConfig) {
                configMissing = true;
              }
            } else if (authoringType === 'cs' || authoringType === 'cs/crosswalk') {
              const hasDeliveryConfig = deliveryConfig
                  && deliveryConfig.programId && deliveryConfig.environmentId;
              if (!hasDeliveryConfig) {
                configMissing = true;
              }
            }

            if (configMissing) {
              await promptPreflightConfig(slackContext, site, singleAuditType);
              return;
            }
          }

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
