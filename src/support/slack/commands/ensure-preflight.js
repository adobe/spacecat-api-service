/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { isValidUrl } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';
import {
  enablePreflightAuditForSite,
  ERROR_MESSAGE_PREFIX,
  isPreflightSiteConfigReady,
  PREFLIGHT_AUDIT_TYPE,
  promptPreflightConfig,
  SUCCESS_MESSAGE_PREFIX,
} from '../preflight/preflight-config.js';

const PHRASES = ['ensure preflight'];

export default (context) => {
  const baseCommand = BaseCommand({
    id: 'ensure-preflight',
    name: 'Ensure Preflight for Site',
    description: 'Validates site preflight configuration and enables the preflight audit for a site.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site}`,
  });

  const { log, dataAccess } = context;
  const { Configuration, Site } = dataAccess;

  /**
   * Executes the command to ensure preflight configuration for a site.
   *
   * @param {Array<string>} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    let baseURL;

    try {
      const [baseURLInput] = args;
      baseURL = extractURLFromSlackInput(baseURLInput);

      if (!isValidUrl(baseURL)) {
        await say(`${ERROR_MESSAGE_PREFIX}Please provide a valid site baseURL.`);
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await say(`${ERROR_MESSAGE_PREFIX}Cannot update site with baseURL: "${baseURL}", site not found.`);
        return;
      }

      const configuration = await Configuration.findLatest();
      const registeredAudits = configuration.getHandlers();
      if (!registeredAudits[PREFLIGHT_AUDIT_TYPE]) {
        await say(`${ERROR_MESSAGE_PREFIX}The "${PREFLIGHT_AUDIT_TYPE}" audit is not present in the configuration.`);
        return;
      }

      const { ready, needsContentSourcePath } = await isPreflightSiteConfigReady(site, context);
      if (!ready) {
        if (needsContentSourcePath) {
          await say({
            text: `:warning: Preflight audit requires additional configuration for \`${site.getBaseURL()}\``,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `:warning: *Preflight audit requires additional configuration for:*\n\`${site.getBaseURL()}\`\n\n*Missing:*\n• Content Source Path\n\nMultiple sites in this organization share the same AEM CS program and environment. Please provide a content source path to distinguish this site.`,
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
                      auditType: PREFLIGHT_AUDIT_TYPE,
                    }),
                  },
                ],
              },
            ],
          });
          return;
        }

        await promptPreflightConfig(slackContext, site, PREFLIGHT_AUDIT_TYPE);
        return;
      }

      await enablePreflightAuditForSite(site, dataAccess);
      await say(`${SUCCESS_MESSAGE_PREFIX}Preflight audit has been enabled for "${site.getBaseURL()}".`);
    } catch (error) {
      log.error(error);
      await say(
        `${ERROR_MESSAGE_PREFIX}An error occurred while trying to ensure preflight for site "${baseURL}": ${error.message}`,
      );
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
};
