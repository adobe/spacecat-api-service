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
import TierClient from '@adobe/spacecat-shared-tier-client';
import { reassignSiteOrganization } from '../../../controllers/plg/plg-onboarding/entitlement.js';

/**
 * Binds a site enrollment to the target org's existing ASO entitlement, without
 * touching the entitlement's tier (unlike ensureAsoEntitlement, which always forces
 * PLG — not what we want here, since this flow deliberately keeps the org on
 * PRE_ONBOARD).
 */
async function bindAsoSiteEnrollment(site, targetOrg, lambdaContext) {
  const { dataAccess } = lambdaContext;
  const { SiteEnrollment } = dataAccess;

  const tierClient = TierClient.createForOrg(
    lambdaContext,
    targetOrg,
    EntitlementModel.PRODUCT_CODES.ASO,
  );
  const { entitlement } = await tierClient.checkValidEntitlement();
  if (!entitlement) {
    throw new Error(`No ASO entitlement found for org ${targetOrg.getId()}`);
  }

  const siteId = site.getId();
  const entitlementId = entitlement.getId();
  const existingEnrollments = await SiteEnrollment.allBySiteId(siteId);
  let siteEnrollment = existingEnrollments.find((se) => se.getEntitlementId() === entitlementId);
  if (!siteEnrollment) {
    siteEnrollment = await SiteEnrollment.create({ siteId, entitlementId });
  }

  return { entitlement, siteEnrollment };
}

/**
 * Handles the "Confirm Move" button click from the move-plg-site command.
 *
 * Re-validates the move (state may have changed since the button was posted), revokes
 * all of the site's existing product enrollments (any product code — not just ASO),
 * reassigns the site's organization, bumps the target org's ASO entitlement to
 * PRE_ONBOARD if it's currently FREE_TRIAL or PLG, and binds a fresh ASO site
 * enrollment to it.
 */
export function openMovePlgSiteModal(lambdaContext) {
  const { dataAccess, log } = lambdaContext;
  const { Site, Organization, Entitlement } = dataAccess;

  return async ({ ack, body, client }) => {
    await ack();

    const {
      baseURL, siteId, imsOrgId, organizationId, channelId, messageTs,
    } = JSON.parse(body.actions[0].value);

    const updateMessage = async (text) => client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
      ],
    });

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        await updateMessage(`:x: Site \`${baseURL}\` no longer exists.`);
        return;
      }

      const targetOrg = await Organization.findById(organizationId);
      if (!targetOrg) {
        await updateMessage(`:x: Target organization \`${imsOrgId}\` no longer exists.`);
        return;
      }

      const siteEnrollments = await site.getSiteEnrollments();

      const entitlements = await Entitlement.allByOrganizationId(organizationId);
      const asoEntitlement = entitlements.find(
        (e) => e.getProductCode() === EntitlementModel.PRODUCT_CODES.ASO,
      );
      const currentTier = asoEntitlement?.getTier() || null;

      if (currentTier === EntitlementModel.TIERS.PAID) {
        await updateMessage(`:x: Cannot move site \`${baseURL}\` — target org now has a PAID entitlement.`);
        return;
      }

      if (currentTier === null
        || currentTier === EntitlementModel.TIERS.FREE_TRIAL
        || currentTier === EntitlementModel.TIERS.PLG) {
        const tierClient = TierClient.createForOrg(
          lambdaContext,
          targetOrg,
          EntitlementModel.PRODUCT_CODES.ASO,
        );
        await tierClient.createEntitlement(EntitlementModel.TIERS.PRE_ONBOARD);
        log.info(`Set ASO entitlement to PRE_ONBOARD for org ${organizationId} (was ${currentTier || 'none'})`);
      }

      if (siteEnrollments && siteEnrollments.length > 0) {
        await Promise.all(siteEnrollments.map(async (enrollment) => {
          log.info(`Revoking enrollment ${enrollment.getId()} for site ${siteId} before org move`);
          return enrollment.remove();
        }));
      }

      await reassignSiteOrganization(site, organizationId);
      const { entitlement } = await bindAsoSiteEnrollment(site, targetOrg, lambdaContext);

      await updateMessage(
        `:white_check_mark: Moved site \`${baseURL}\` to org \`${imsOrgId}\`. `
        + `ASO entitlement tier: \`${entitlement.getTier()}\`.`,
      );
    } catch (error) {
      log.error(`Error moving PLG site ${baseURL} to org ${imsOrgId}:`, error);
      await updateMessage(`:x: Failed to move site \`${baseURL}\`: ${error.message}`);
    }
  };
}

export default openMovePlgSiteModal;
