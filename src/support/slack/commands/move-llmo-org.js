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

import { isValidIMSOrgId } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';
import {
  buildPreviewMessage,
  describePreviewError,
  formatBlockingConflicts,
  previewOrgMove,
} from '../llmo-org-move.js';

const PHRASES = ['move llmo org'];

/**
 * Builds the confirmation message blocks. Kept in one place so the initial post and the
 * follow-up update (which injects the message's own timestamp into the button payload)
 * cannot drift apart.
 *
 * @param {string} text - The rendered preview.
 * @param {object} payload - The button's JSON payload.
 * @returns {Array<object>} Slack blocks.
 */
function buildConfirmBlocks(text, payload) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Confirm Move' },
          style: 'danger',
          action_id: 'open_move_llmo_org_modal',
          value: JSON.stringify(payload),
        },
      ],
    },
  ];
}

/**
 * Factory function to create the MoveLlmoOrgCommand object.
 *
 * Relocates a customer's whole LLMO entity graph - brands, prompts, competitors, feature
 * flags and the sites themselves - from the organization the named site currently sits
 * in to another IMS org.
 *
 * The move is scoped to the transitive closure of brands and sites reachable from the
 * named site, not to the whole source organization: customers are routinely provisioned
 * into a shared or DEMO org, and moving everything in that org would relocate unrelated
 * tenants too.
 *
 * This command only ever previews. It reports what would move and what conflicts, then
 * posts a confirmation button; the write happens in the `open_move_llmo_org_modal`
 * action so the operator sees the blast radius before anything changes.
 *
 * @param {Object} context - The context object.
 * @returns {MoveLlmoOrgCommand} The MoveLlmoOrgCommand object.
 * @constructor
 */
function MoveLlmoOrgCommand(context) {
  const baseCommand = BaseCommand({
    id: 'move-llmo-org',
    name: 'Move LLMO Org',
    description: 'Moves a site and every brand transitively linked to it - along with their '
      + 'prompts, competitors and feature flags - to another IMS org. Shows a preview of the '
      + 'full blast radius and requires confirmation before writing.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} {imsOrgId}`,
  });

  const { dataAccess, log } = context;
  const { Site, Organization } = dataAccess;

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
        await say(':warning: Please provide a valid destination IMS Org ID.');
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const destOrg = await Organization.findByImsOrgId(imsOrgId);
      if (!destOrg) {
        await say(
          `:x: No Spacecat organization found for IMS Org ID \`${imsOrgId}\`. `
          + 'Use `set imsorg` to create it first, then re-run this command.',
        );
        return;
      }

      const sourceOrgId = site.getOrganizationId();
      const destOrgId = destOrg.getId();

      const preview = await previewOrgMove(context, site.getId(), destOrgId);

      const previewError = describePreviewError(preview);
      if (previewError) {
        await say(previewError);
        return;
      }

      if (preview.ok !== true) {
        await say(
          `:x: *This move is blocked.*\n\n${
            formatBlockingConflicts(preview.blocking_conflicts)
          }\n\nA name or base-site clash is resolved by renaming or removing the conflicting `
          + 'brand in the destination org. A *different org* appearing in the list means the '
          + 'brand/site graph already straddles two organizations — that is pre-existing data '
          + 'corruption and needs untangling by hand before this move can run.',
        );
        return;
      }

      const text = buildPreviewMessage(preview, baseURL);
      const basePayload = {
        baseURL,
        siteId: site.getId(),
        sourceOrgId,
        destOrgId,
        imsOrgId,
        channelId,
        threadTs,
      };

      const posted = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Ready to move LLMO org for ${baseURL}`,
        blocks: buildConfirmBlocks(text, { ...basePayload, messageTs: 'placeholder' }),
      });

      await client.chat.update({
        channel: channelId,
        ts: posted.ts,
        text: `Ready to move LLMO org for ${baseURL}`,
        blocks: buildConfirmBlocks(text, { ...basePayload, messageTs: posted.ts }),
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

export default MoveLlmoOrgCommand;
