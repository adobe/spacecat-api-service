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
  extractURLFromSlackInput,
  postErrorMessage,
} from '../../../utils/slack/base.js';

import BaseCommand from './base.js';

const PHRASES = ['onboard-llmo'];

/**
 * Factory function to create the LlmoOnboardCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {LlmoOnboardCommand} - The LlmoOnboardCommand object.
 * @constructor
 */
function LlmoOnboardCommand(context) {
  const baseCommand = BaseCommand({
    id: 'onboard-llmo',
    name: 'Onboard LLMO',
    description: 'Onboards a site or IMS org for LLMO (Large Language Model Optimizer) through a modal interface.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} [site url]`,
  });

  const { log } = context;

  /**
   * Handles LLMO onboarding for a single site.
   *
   * @param {string[]} args - The args provided to the command ([baseURL, dataFolder, brandName]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say, threadTs } = slackContext;
    const { dataAccess } = context;

    const [site] = args;

    // If no site parameter provided, trigger IMS org onboarding flow
    if (!site) {
      const message = {
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':rocket: *LLMO IMS Org Onboarding*\n\nClick the button below to start the IMS organization onboarding process.',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Start Onboarding',
                },
                value: 'org_onboarding',
                action_id: 'start_llmo_org_onboarding',
                style: 'primary',
              },
            ],
          },
        ],
        thread_ts: threadTs,
      };
      await say(message);
      return;
    }

    const normalizedSite = extractURLFromSlackInput(site);

    if (!normalizedSite) {
      await say(baseCommand.usage());
      return;
    }

    try {
      // Check if site already exists to determine which buttons to show
      const { Site } = dataAccess;
      const existingSite = await Site.findByBaseURL(normalizedSite);
      const config = await existingSite?.getConfig();
      const brand = config?.getLlmoBrand();

      let message;

      if (brand) {
        message = {
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `:information_source: *Site Already Onboarded*\n\nThe site *${normalizedSite}* is already configured for LLMO with brand *${brand}*.\n\nChoose what you'd like to do:`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: 'Add Entitlements',
                  },
                  value: JSON.stringify({
                    brandURL: normalizedSite,
                    siteId: existingSite.getId(),
                    existingBrand: brand,
                    originalChannel: 'current',
                    originalThreadTs: threadTs,
                  }),
                  action_id: 'add_entitlements_action',
                  style: 'primary',
                },
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: 'Update IMS Org',
                  },
                  value: JSON.stringify({
                    brandURL: normalizedSite,
                    siteId: existingSite.getId(),
                    existingBrand: brand,
                    currentOrgId: existingSite.getOrganizationId(),
                    originalChannel: 'current',
                    originalThreadTs: threadTs,
                  }),
                  action_id: 'update_org_action',
                },
              ],
            },
          ],
          thread_ts: threadTs,
        };
      } else {
        message = {
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: ':rocket: *LLMO Onboarding*\n\nClick the button below to start the interactive onboarding process.',
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: 'Start Onboarding',
                  },
                  value: normalizedSite,
                  action_id: 'start_llmo_onboarding',
                  style: 'primary',
                },
              ],
            },
          ],
          thread_ts: threadTs,
        };
      }

      await say(message);
    } catch (error) {
      log.error('Error in LLMO onboarding:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default LlmoOnboardCommand;
