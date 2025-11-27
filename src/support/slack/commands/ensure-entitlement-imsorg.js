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
import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['ensure entitlement imsorg'];

/**
 * A factory function that creates an instance of the EnsureEntitlementImsOrgCommand.
 *
 * @param {object} context - The context object.
 * @returns {EnsureEntitlementImsOrgCommand} An instance of the command.
 * @constructor
 */
function EnsureEntitlementImsOrgCommand(context) {
  const baseCommand = BaseCommand({
    id: 'ensure-entitlement-imsorg',
    name: 'Ensure Entitlement for IMS Org',
    description: 'Creates entitlement for an organization by IMS Org ID',
    phrases: PHRASES,
    usageText: `${PHRASES.join(' or ')} {imsOrgId}`,
  });

  const { dataAccess, log } = context;
  const { Organization } = dataAccess;

  /**
   * Executes the command to ensure entitlement for an IMS org.
   *
   * @param {Array<string>} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @param {string} slackContext.channelId - The Slack channel ID.
   * @param {string} slackContext.threadTs - The Slack thread timestamp.
   * @param {Object} slackContext.client - The Slack client.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const {
      say, channelId, threadTs, client,
    } = slackContext;

    try {
      const [imsOrgId] = args;

      if (!imsOrgId) {
        await say(baseCommand.usage());
        return;
      }

      // Find the organization
      const organization = await Organization.findByImsOrgId(imsOrgId);

      if (!organization) {
        await say(`:x: Organization not found with IMS Org ID: ${imsOrgId}`);
        return;
      }

      const organizationId = organization.getId();
      const orgName = organization.getName() || imsOrgId;

      // Show button to open product selection modal
      const buttonMessage = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Ensure entitlement for organization ${orgName}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:white_check_mark: *Ensure Entitlement for Organization*\n\nOrganization: *${orgName}*\nIMS Org ID: ${imsOrgId}\n\nClick the button below to select products for entitlement.`,
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
                  organizationId,
                  imsOrgId,
                  orgName,
                  channelId,
                  threadTs,
                  messageTs: 'placeholder',
                }),
                action_id: 'open_ensure_entitlement_imsorg_modal',
                style: 'primary',
              },
            ],
          },
        ],
      });

      // Update the button with the actual message timestamp
      await client.chat.update({
        channel: channelId,
        ts: buttonMessage.ts,
        text: `Ensure entitlement for organization ${orgName}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:white_check_mark: *Ensure Entitlement for Organization*\n\nOrganization: *${orgName}*\nIMS Org ID: ${imsOrgId}\n\nClick the button below to select products for entitlement.`,
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
                  organizationId,
                  imsOrgId,
                  orgName,
                  channelId,
                  threadTs,
                  messageTs: buttonMessage.ts,
                }),
                action_id: 'open_ensure_entitlement_imsorg_modal',
                style: 'primary',
              },
            ],
          },
        ],
      });
    } catch (error) {
      log.error('Error in ensure entitlement imsorg command:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default EnsureEntitlementImsOrgCommand;
