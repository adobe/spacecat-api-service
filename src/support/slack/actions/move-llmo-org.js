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
 * LLMO entity graph via `wrpc_move_brandalf_org`, then runs the per-site follow-up for
 * *every* site the move covered: re-parenting each site's project so it stays visible in
 * the destination org's site picker, and provisioning LLMO entitlement/enrollment on the
 * destination org.
 *
 * The follow-up loops because the move is scoped to the transitive closure of brands and
 * sites reachable from the named site, which is frequently wider than that one site.
 * Re-parenting only the seed site would leave the other moved sites owned by a project in
 * the source org - the same class of half-move this ticket exists to fix.
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
      baseURL, siteId, sourceOrgId, destOrgId, imsOrgId, channelId, threadTs,
    } = JSON.parse(body.actions[0].value);
    const userId = body?.user?.id || 'unknown';

    // Bolt's action body is authoritative for where this button actually lives, so prefer
    // it over the channel carried in the payload. Everything that talks to Slack from here
    // on - including the say passed down to reparentSiteProject and
    // createEntitlementAndEnrollment - is bound to it, so a stale payload cannot misroute
    // part of the output to another channel.
    const targetChannel = body?.channel?.id || channelId;
    const targetTs = body?.message?.ts;
    const say = createSayFunction(client, targetChannel, threadTs);

    // Reporting progress must never decide whether the move runs. This previously threw
    // straight out of the handler - the first call sits immediately before executeOrgMove,
    // so a cosmetic Slack failure aborted the move, and the identical call in the catch
    // below rethrew into Bolt, leaving the operator with no feedback at all.
    const updateMessage = async (text) => {
      try {
        await client.chat.update({
          channel: targetChannel,
          ts: targetTs,
          text,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
        });
      } catch (updateError) {
        log.warn(
          `move llmo org: could not update message ${targetTs} in ${targetChannel}: `
          + `${updateError.message}. Falling back to a new message.`,
        );
        try {
          await say(text);
        } catch (sayError) {
          log.error(`move llmo org: could not report to Slack at all: ${sayError.message}`);
        }
      }
    };

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
      // readable message rather than a raw database exception from the write RPC. Its
      // site list is also what drives the per-site follow-up below - it has to be read
      // before the move, while the sites are still resolvable from the source org.
      const preview = await previewOrgMove(lambdaContext, siteId, destOrgId);
      const previewError = describePreviewError(preview);
      if (previewError) {
        await updateMessage(previewError);
        return;
      }
      if (preview.ok !== true) {
        await updateMessage(
          `:x: *This move is now blocked* — the data changed since the preview:\n\n${
            formatBlockingConflicts(preview.blocking_conflicts)
          }`,
        );
        return;
      }

      const movedSites = preview.sites || [];

      await updateMessage(
        `:hourglass_flowing_sand: Moving LLMO org for \`${baseURL}\` `
        + `(${movedSites.length} site${movedSites.length === 1 ? '' : 's'}, `
        + `${(preview.brands || []).length} brand${(preview.brands || []).length === 1 ? '' : 's'})…`,
      );

      const result = await executeOrgMove(
        lambdaContext,
        siteId,
        destOrgId,
        `slack:move-llmo-org:${userId}`,
      );

      // Everything below runs outside the RPC's transaction. The entity move itself is
      // already durable at this point; a failure here leaves the org move applied but the
      // project re-parent and/or entitlement provisioning incomplete for that one site.
      // That is recoverable by re-running `set imsorg`/onboarding for the affected site,
      // so a single site's failure is collected and reported rather than aborting the
      // remaining sites.
      const followUpFailures = [];
      for (const movedSiteRef of movedSites) {
        try {
          // Re-fetch: the RPC rewrote organization_id in the database, but the JS model
          // held by this handler still carries the old value.
          // eslint-disable-next-line no-await-in-loop -- sequential per site; each writes
          const movedSite = await Site.findById(movedSiteRef.id);
          if (!movedSite) {
            followUpFailures.push(`\`${movedSiteRef.base_url}\`: site no longer exists`);
          } else {
            // eslint-disable-next-line no-await-in-loop -- sequential per site
            await reparentSiteProject({
              site: movedSite,
              targetOrgId: destOrgId,
              baseURL: movedSiteRef.base_url,
              lambdaContext,
              say,
            });
            // eslint-disable-next-line no-await-in-loop -- sequential per site
            await movedSite.save();
            // eslint-disable-next-line no-await-in-loop -- sequential per site
            await createEntitlementAndEnrollment(movedSite, lambdaContext, say);
          }
        } catch (followUpError) {
          log.error(
            `move llmo org: follow-up failed for site ${movedSiteRef.id} `
            + `(${movedSiteRef.base_url}): ${followUpError.message}`,
          );
          followUpFailures.push(`\`${movedSiteRef.base_url}\`: ${followUpError.message}`);
        }
      }

      const followUpNote = followUpFailures.length > 0
        ? '\n\n:warning: *The entity move succeeded, but post-move setup failed for some '
          + `sites.* Re-run \`set imsorg\` / onboarding for these:\n${
            followUpFailures.map((f) => `• ${f}`).join('\n')}`
        : '';
      await updateMessage(`${buildResultMessage(result, baseURL, preview)}${followUpNote}`);

      log.info(
        `move llmo org: moved site ${siteId} (${baseURL}) and ${movedSites.length} site(s) / `
        + `${result.brands_moved || 0} brand(s) from org ${sourceOrgId} to `
        + `${destOrgId} (${imsOrgId}) for user ${userId}`,
      );
    } catch (error) {
      log.error(`Error moving LLMO org for ${baseURL} to ${imsOrgId}:`, error);
      await updateMessage(`:x: Failed to move LLMO org for \`${baseURL}\`: ${error.message}`);
    }
  };
}

export default openMoveLlmoOrgModal;
