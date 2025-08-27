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
    description: 'Onboards a site for LLMO (Large Language Model Optimizer) through a modal interface.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} <site url>`,
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

    const [site] = args;

    const normalizedSite = extractURLFromSlackInput(site);

    if (!normalizedSite) {
      await say(baseCommand.usage());
      return;
    }

    try {
      const message = {
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':rocket: *Site Onboarding*\n\nClick the button below to start the interactive onboarding process.',
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
