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

import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import { isValidIMSOrgId } from '@adobe/spacecat-shared-utils';
import { isInternalOrg } from '../../utils.js';
import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['move plg site'];

/**
 * Factory function to create the MovePlgSiteCommand object.
 *
 * Moves a PLG site from its current org (typically internal) to a customer IMS org.
 * Posts a confirmation button first — the actual move (org reassignment + entitlement
 * tier bump) only runs after an admin clicks confirm, handled by the
 * move_plg_site_modal action.
 *
 * @param {Object} context - The context object.
 * @returns {MovePlgSiteCommand} The MovePlgSiteCommand object.
 * @constructor
 */
function MovePlgSiteCommand(context) {
  const baseCommand = BaseCommand({
    id: 'move-plg-site',
    name: 'Move PLG Site',
    description: 'Moves a PLG site from its current org to a customer IMS org, setting the target org\'s ASO entitlement to PRE_ONBOARD.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} {imsOrgId}`,
  });

  const { dataAccess, log, env } = context;
  const { Site, Organization, Entitlement } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const {
      say, channelId, threadTs, client,
    } = slackContext;

    try {
      const [baseURLInput, imsOrgId] = args;

      const baseURL = extractURLFromSlackInput(baseURLInput);
      if (!baseURL) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      if (!imsOrgId || !isValidIMSOrgId(imsOrgId)) {
        await say(':warning: Please provide a valid target IMS Org ID.');
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const targetOrg = await Organization.findByImsOrgId(imsOrgId);
      if (!targetOrg) {
        await say(`:x: No Spacecat organization found for IMS Org ID: \`${imsOrgId}\`. Use \`set imsorg\` first to create it.`);
        return;
      }

      const targetOrgId = targetOrg.getId();

      if (isInternalOrg(targetOrgId, env)) {
        await say(':x: Cannot move a PLG site into an internal organization.');
        return;
      }

      const entitlements = await Entitlement.allByOrganizationId(targetOrgId);
      const asoEntitlement = entitlements.find(
        (e) => e.getProductCode() === EntitlementModel.PRODUCT_CODES.ASO,
      );
      const currentTier = asoEntitlement?.getTier() || null;

      if (currentTier === EntitlementModel.TIERS.PAID) {
        await say(':x: Cannot move a PLG site into an organization with a PAID entitlement.');
        return;
      }

      const siteEnrollments = await site.getSiteEnrollments();
      const enrollmentEntitlements = await Promise.all(
        (siteEnrollments || []).map((e) => e.getEntitlement()),
      );
      const enrolledProducts = [...new Set(
        enrollmentEntitlements.map((e) => e?.getProductCode()).filter(Boolean),
      )];

      const enrollmentWarning = enrolledProducts.length > 0
        ? `\n:warning: *This site also has active ${enrolledProducts.join(', ')} enrollment(s) — these will be revoked too.*`
        : '';

      const orgName = targetOrg.getName() || imsOrgId;

      const buttonMessage = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Ready to move site ${baseURL} to org ${orgName}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Move PLG Site*\n\nSite: \`${baseURL}\`\nTarget Org: *${orgName}* (\`${imsOrgId}\`)\nCurrent ASO tier on target org: \`${currentTier || 'none'}\`${enrollmentWarning}\n\nThis will revoke *all* of the site's existing product enrollments, reassign the site's organization, and set the target org's ASO entitlement to \`PRE_ONBOARD\`. Click below to confirm.`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Confirm Move',
                },
                style: 'danger',
                action_id: 'open_move_plg_site_modal',
                value: JSON.stringify({
                  baseURL,
                  siteId: site.getId(),
                  imsOrgId,
                  organizationId: targetOrgId,
                  channelId,
                  threadTs,
                  messageTs: 'placeholder',
                }),
              },
            ],
          },
        ],
      });

      await client.chat.update({
        channel: channelId,
        ts: buttonMessage.ts,
        text: `Ready to move site ${baseURL} to org ${orgName}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Move PLG Site*\n\nSite: \`${baseURL}\`\nTarget Org: *${orgName}* (\`${imsOrgId}\`)\nCurrent ASO tier on target org: \`${currentTier || 'none'}\`${enrollmentWarning}\n\nThis will revoke *all* of the site's existing product enrollments, reassign the site's organization, and set the target org's ASO entitlement to \`PRE_ONBOARD\`. Click below to confirm.`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Confirm Move',
                },
                style: 'danger',
                action_id: 'open_move_plg_site_modal',
                value: JSON.stringify({
                  baseURL,
                  siteId: site.getId(),
                  imsOrgId,
                  organizationId: targetOrgId,
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

export default MovePlgSiteCommand;
