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

import { createEntitlementAndEnrollment } from '../../../controllers/llmo/llmo-onboarding.js';
import { reparentSiteProject } from './set-ims-org-modal.js';
import { createSayFunction } from './entitlement-modal-utils.js';
import {
  buildResultMessage,
  describePreviewError,
  executeOrgMove,
  formatBlockingConflicts,
  previewOrgMove,
} from '../llmo-org-move.js';

/**
 * Handles the "Confirm Move" button click from the `move llmo org` command.
 *
 * Re-validates the move (the preview the operator saw may be stale), relocates the whole
 * LLMO entity graph via `wrpc_move_brandalf_org`, re-parents the site's project so the
 * site stays visible in the destination org's site picker, and provisions LLMO
 * entitlement/enrollment on the destination org.
 *
 * @param {object} lambdaContext - The Lambda context.
 * @returns {Function} The Bolt action handler.
 */
export function openMoveLlmoOrgModal(lambdaContext) {
  const { dataAccess, log } = lambdaContext;
  const { Site, Organization } = dataAccess;

  return async ({ ack, body, client }) => {
    await ack();

    const {
      baseURL, siteId, sourceOrgId, destOrgId, imsOrgId, channelId, threadTs, messageTs,
    } = JSON.parse(body.actions[0].value);
    const say = createSayFunction(client, channelId, threadTs);
    const userId = body?.user?.id || 'unknown';

    const updateMessage = async (text) => client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    });

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        await updateMessage(`:x: Site \`${baseURL}\` no longer exists.`);
        return;
      }

      const destOrg = await Organization.findById(destOrgId);
      if (!destOrg) {
        await updateMessage(`:x: Destination organization \`${imsOrgId}\` no longer exists.`);
        return;
      }

      // The site may have been moved by someone else between the preview and this click.
      if (site.getOrganizationId() !== sourceOrgId) {
        await updateMessage(
          `:x: \`${baseURL}\` is no longer in the organization it was in when this preview `
          + 'was generated. Re-run `move llmo org` to get a fresh preview.',
        );
        return;
      }

      // Re-preview so a conflict introduced since the button was posted surfaces as a
      // readable message rather than a raw database exception from the write RPC.
      const preview = await previewOrgMove(lambdaContext, sourceOrgId, destOrgId);
      const previewError = describePreviewError(preview);
      if (previewError) {
        await updateMessage(previewError);
        return;
      }
      if (preview.ok !== true) {
        await updateMessage(
          `:x: *This move is now blocked* — the destination org changed since the preview:\n\n${
            formatBlockingConflicts(preview.blocking_conflicts)
          }`,
        );
        return;
      }

      await updateMessage(`:hourglass_flowing_sand: Moving LLMO org for \`${baseURL}\`…`);

      const result = await executeOrgMove(
        lambdaContext,
        sourceOrgId,
        destOrgId,
        `slack:move-llmo-org:${userId}`,
      );

      // Everything below runs outside the RPC's transaction. The entity move itself is
      // already durable at this point; a failure here leaves the org move applied but the
      // project re-parent and/or entitlement provisioning incomplete, which is recoverable
      // by re-running `set imsorg`/onboarding rather than by re-running this command.
      const movedSite = await Site.findById(siteId);
      await reparentSiteProject({
        site: movedSite,
        targetOrgId: destOrgId,
        baseURL,
        lambdaContext,
        say,
      });
      await movedSite.save();

      await createEntitlementAndEnrollment(movedSite, lambdaContext, say);

      await updateMessage(buildResultMessage(result, baseURL));

      log.info(
        `move llmo org: moved site ${siteId} (${baseURL}) from org ${sourceOrgId} to `
        + `${destOrgId} (${imsOrgId}) for user ${userId}`,
      );
    } catch (error) {
      log.error(`Error moving LLMO org for ${baseURL} to ${imsOrgId}:`, error);
      await updateMessage(`:x: Failed to move LLMO org for \`${baseURL}\`: ${error.message}`);
    }
  };
}

export default openMoveLlmoOrgModal;
