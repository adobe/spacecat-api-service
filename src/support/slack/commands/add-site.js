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

import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import {
  extractURLFromSlackInput,
  postErrorMessage,
} from '../../../utils/slack/base.js';

import { findDeliveryType } from '../../utils.js';

import BaseCommand from './base.js';

const PHRASES = ['add site'];

/**
 * Factory function to create the AddSiteCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {AddSiteCommand} - The AddSiteCommand object.
 * @constructor
 */
function AddSiteCommand(context) {
  const baseCommand = BaseCommand({
    id: 'add-site',
    name: 'Add Site',
    description: 'Adds a new site to track.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} [deliveryType = aem_edge]`,
  });

  const { dataAccess, log, env } = context;
  const { Site } = dataAccess;

  /**
   * Validates input and adds the site to db
   * Shows a modal to select products for entitlement
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @param {string} slackContext.channelId - The Slack channel ID.
   * @param {string} slackContext.threadTs - The thread timestamp.
   * @param {Object} slackContext.client - The Slack client for API calls.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const {
      say, channelId, threadTs, client,
    } = slackContext;

    try {
      const [baseURLInput, deliveryTypeArg] = args;

      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!baseURL) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      const site = await Site.findByBaseURL(baseURL);

      if (site) {
        await say(`:x: '${baseURL}' was already added before. You can run _@spacecat get site ${baseURL}_`);
        return;
      }

      const deliveryType = Object.values(SiteModel.DELIVERY_TYPES).includes(deliveryTypeArg)
        ? deliveryTypeArg
        : await findDeliveryType(baseURL);
      const isLive = deliveryType === SiteModel.DELIVERY_TYPES.AEM_EDGE;

      const newSite = await Site.create({
        baseURL,
        deliveryType,
        isLive,
        organizationId: env.DEFAULT_ORGANIZATION_ID,
      });

      if (!newSite) {
        await say(':x: Problem adding the site. Please contact the admins.');
        return;
      }

      let message = `:white_check_mark: *Successfully added new site <${baseURL}|${baseURL}>*.\n`;
      message += `:delivrer: *Delivery type:* ${deliveryType}.\n`;
      if (newSite.getIsLive()) {
        message += ':rocket: Site is set to *live* by default\n';
      }

      await say(message);

      // Show button to select products for entitlement
      const buttonMessage = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Choose products for site ${baseURL}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Choose Products for Entitlement*\n\nSite: \`${baseURL}\`\n\nClick below to choose products and trigger initial audit:`,
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
                action_id: 'open_add_site_modal',
                value: JSON.stringify({
                  baseURL,
                  siteId: newSite.getId(),
                  channelId,
                  threadTs,
                  messageTs: 'placeholder',
                }),
              },
            ],
          },
        ],
      });

      // Update the button with the actual message timestamp
      await client.chat.update({
        channel: channelId,
        ts: buttonMessage.ts,
        text: `Choose products for site ${baseURL}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Choose Products for Entitlement*\n\nSite: \`${baseURL}\`\n\nClick below to choose products and trigger initial audit:`,
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
                action_id: 'open_add_site_modal',
                value: JSON.stringify({
                  baseURL,
                  siteId: newSite.getId(),
                  channelId,
                  threadTs,
                  messageTs: buttonMessage.ts,
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

export default AddSiteCommand;
