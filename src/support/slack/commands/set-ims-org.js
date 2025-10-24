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

import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['set imsorg'];

/**
 * Factory function to create the SetSiteOrganizationCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {SetSiteOrganizationCommand} The SetSiteOrganizationCommand object.
 * @constructor
 */
function SetSiteOrganizationCommand(context) {
  const baseCommand = BaseCommand({
    id: 'set-ims-org',
    name: 'Set IMS Organization',
    description: 'Sets (or creates) a Spacecat org for a site by IMS Org ID.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} {imsOrgId}`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  /**
   * Command execution logic:
   *  1. Validate user input (base URL and IMS Org ID).
   *  2. Find the Site by the provided base URL.
   *  3. Check if the Spacecat org with the provided IMS Org ID already exists.
   *  4. If not found, retrieve IMS org details and create a new Spacecat org.
   *  5. Update the site's organizationId and save.
   *  6. Inform the Slack user about the result (either "set" or "created then set").
   *  7. If IMS org cannot be found, let the user know.
   *
   * @param {string[]} args - The arguments provided to the command ([baseURL, imsOrgId]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack 'say' function to post responses.
   */
  const handleExecution = async (args, slackContext) => {
    const {
      say, channelId, threadTs, client,
    } = slackContext;

    try {
      const [baseURLInput, userImsOrgId] = args;

      const baseURL = extractURLFromSlackInput(baseURLInput);
      if (!baseURL) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      if (!userImsOrgId) {
        await say(':warning: Please provide a valid IMS Org ID.');
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      // Show button to select products
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Ready to set IMS Org for site ${baseURL}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Set IMS Organization*\n\nSite: \`${baseURL}\`\nIMS Org ID: \`${userImsOrgId}\`\n\nClick below to choose products for entitlement:`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Choose Products & Continue',
                },
                style: 'primary',
                action_id: 'open_set_ims_org_modal',
                value: JSON.stringify({
                  baseURL, imsOrgId: userImsOrgId, channelId, threadTs,
                }),
              },
            ],
          },
        ],
      });
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

export default SetSiteOrganizationCommand;
