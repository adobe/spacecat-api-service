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
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['ensure entitlement site'];

/**
 * A factory function that creates an instance of the EnsureEntitlementSiteCommand.
 *
 * @param {object} context - The context object.
 * @returns {EnsureEntitlementSiteCommand} An instance of the command.
 * @constructor
 */
function EnsureEntitlementSiteCommand(context) {
  const baseCommand = BaseCommand({
    id: 'ensure-entitlement-site',
    name: 'Ensure Entitlement for Site',
    description: 'Creates entitlement and enrollment for a site by URL',
    phrases: PHRASES,
    usageText: `${PHRASES.join(' or ')} {siteURL}`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  /**
   * Executes the command to ensure entitlement for a site.
   *
   * @param {Array<string>} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @param {string} slackContext.threadTs - The Slack thread timestamp.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say, threadTs } = slackContext;

    try {
      const [siteURLInput] = args;
      const siteURL = extractURLFromSlackInput(siteURLInput);

      if (!siteURL) {
        await say(baseCommand.usage());
        return;
      }

      // Find the site
      const site = await Site.findByBaseURL(siteURL);

      if (!site) {
        await say(`:x: Site not found with base URL: ${siteURL}`);
        return;
      }

      const siteId = site.getId();

      // Show button to open product selection modal
      const message = {
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:white_check_mark: *Ensure Entitlement for Site*\n\nSite: *${siteURL}*\n\nClick the button below to select products for entitlement.`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Select Products',
                },
                value: JSON.stringify({
                  siteId,
                  baseURL: siteURL,
                  channelId: slackContext.channelId,
                  threadTs,
                }),
                action_id: 'open_ensure_entitlement_site_modal',
                style: 'primary',
              },
            ],
          },
        ],
        thread_ts: threadTs,
      };

      await say(message);
    } catch (error) {
      log.error('Error in ensure entitlement site command:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default EnsureEntitlementSiteCommand;
