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
  createProductSelectionModal,
  extractSelectedProducts,
  createSayFunction,
  updateMessageToProcessing,
  createEntitlementsForProducts,
  postEntitlementMessages,
} from './entitlement-modal-utils.js';
import { createProject } from '../../utils.js';

const MODAL_CALLBACK_ID = 'set_ims_org_modal';

/**
 * Re-parents a site's project so it ends up in the target Spacecat org alongside
 * the site. Re-parenting only `site.organizationId` (as this flow used to) leaves
 * the associated project in the old org, so the site shows in
 * `/organizations/{orgId}/sites` but disappears from the ASO site picker, which
 * groups sites under `/organizations/{orgId}/projects` (SITES-46200).
 *
 * Mutates `site` in place (and may set its projectId); the caller is responsible
 * for persisting the site via `site.save()`.
 *
 * - No project on the site: nothing to do.
 * - Project already in the target org: nothing to do.
 * - Site is the only member of its project: move the project to the target org
 *   (the site keeps its projectId).
 * - Other sites still share the project: split — move this site to a project in
 *   the target org (find-or-create by name) so the siblings keep their project
 *   in the source org.
 *
 * @param {object} params
 * @param {object} params.site - The site being re-parented (already has its new orgId set).
 * @param {string} params.targetOrgId - The Spacecat org id the site is moving to.
 * @param {string} params.baseURL - The site's base URL (used to derive a project name).
 * @param {object} params.lambdaContext - The Lambda context (provides dataAccess + log).
 * @param {Function} params.say - Slack say function for operator feedback.
 */
export async function reparentSiteProject({
  site, targetOrgId, baseURL, lambdaContext, say,
}) {
  const { dataAccess, log } = lambdaContext;
  const { Project, Site } = dataAccess;

  const projectId = site.getProjectId();
  if (!projectId) {
    return;
  }

  const project = await Project.findById(projectId);
  if (!project) {
    log.warn(`set imsorg: site ${site.getId()} references missing project ${projectId}; skipping project re-parent`);
    return;
  }

  if (project.getOrganizationId() === targetOrgId) {
    return;
  }

  const sitesOnProject = await Site.allByProjectId(projectId);
  if (sitesOnProject.length <= 1) {
    // Solo site on the project — move the whole project to the target org.
    project.setOrganizationId(targetOrgId);
    await project.save();
    await say(
      `:information_source: Moved project *${project.getProjectName()}* to the new org so the site stays visible in the site picker.`,
    );
  } else {
    // Project is shared with sites that are staying behind — split it so the
    // moved site gets a project in the target org and the siblings keep theirs.
    const newProject = await createProject(lambdaContext, { say }, baseURL, targetOrgId, null);
    site.setProjectId(newProject.getId());
  }
}

/**
 * Opens the product selection modal for set-ims-org command.
 * This is triggered by a button action.
 */
export function openSetImsOrgModal(lambdaContext) {
  const { log } = lambdaContext;

  return async ({ ack, body, client }) => {
    await ack();

    const { value } = body.actions[0];
    const {
      baseURL, imsOrgId, channelId, threadTs, messageTs,
    } = JSON.parse(value);

    const metadata = {
      baseURL, imsOrgId, channelId, threadTs, messageTs,
    };
    const description = `*Choose products to ensure entitlement*\n\nSite: \`${baseURL}\`\nIMS Org ID: \`${imsOrgId}\``;
    const modalView = createProductSelectionModal(
      MODAL_CALLBACK_ID,
      metadata,
      'Choose Products',
      description,
    );

    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: modalView,
      });
    } catch (error) {
      log.error('Error opening modal:', error);
    }
  };
}

/**
 * Handles the modal submission for set-ims-org.
 */
export function setImsOrgModal(lambdaContext) {
  const { dataAccess, log, imsClient } = lambdaContext;
  const { Site, Organization } = dataAccess;

  return async ({ ack, body, client }) => {
    try {
      const { view } = body;
      const { private_metadata: privateMetadata, state } = view;
      const {
        baseURL, imsOrgId: userImsOrgId, channelId, threadTs, messageTs,
      } = JSON.parse(privateMetadata);

      // Extract selected products from checkboxes
      const selectedProducts = extractSelectedProducts(state);

      // Create a say function to post back to the channel
      const say = createSayFunction(client, channelId, threadTs);

      await ack();

      // Find the site
      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        log.error(`Site not found: ${baseURL}`);
        await say(`:x: Site not found: ${baseURL}`);
        return;
      }

      let spaceCatOrg = await Organization.findByImsOrgId(userImsOrgId);

      // if not found, try retrieving from IMS, then create a new spacecat org
      if (!spaceCatOrg) {
        let imsOrgDetails;
        try {
          imsOrgDetails = await imsClient.getImsOrganizationDetails(userImsOrgId);
        } catch (error) {
          log.error(`Error retrieving IMS Org details: ${error.message}`);
          await say(`:x: Could not find an IMS org with the ID *${userImsOrgId}*.`);
          return;
        }

        if (!imsOrgDetails) {
          await say(`:x: Could not find an IMS org with the ID *${userImsOrgId}*.`);
          return;
        }

        // create a new spacecat org
        spaceCatOrg = await Organization.create({
          name: imsOrgDetails.orgName,
          imsOrgId: userImsOrgId,
        });
        await spaceCatOrg.save();

        site.setOrganizationId(spaceCatOrg.getId());
        await reparentSiteProject({
          site,
          targetOrgId: spaceCatOrg.getId(),
          baseURL,
          lambdaContext,
          say,
        });
        await site.save();

        // Remove the button by updating the message
        await updateMessageToProcessing(
          client,
          channelId,
          messageTs,
          baseURL,
          'Set IMS Organization',
        );

        // inform user that we created the org and set it
        const productsMessage = selectedProducts.length > 0
          ? `\nSelected products for entitlement: *${selectedProducts.join(', ')}*`
          : '\n:warning: *No products selected* - No entitlements were created.';
        await say(
          `:white_check_mark: Successfully *created* a new Spacecat org (Name: *${imsOrgDetails.orgName}*) `
          + `and set it for site <${baseURL}|${baseURL}>!${productsMessage}`,
        );
      } else {
        // we already have a matching spacecat org
        site.setOrganizationId(spaceCatOrg.getId());
        await reparentSiteProject({
          site,
          targetOrgId: spaceCatOrg.getId(),
          baseURL,
          lambdaContext,
          say,
        });
        await site.save();

        // Remove the button by updating the message
        await updateMessageToProcessing(
          client,
          channelId,
          messageTs,
          baseURL,
          'Set IMS Organization',
        );

        const productsMessage = selectedProducts.length > 0
          ? `\nSelected products for entitlement: *${selectedProducts.join(', ')}*`
          : '\n:warning: *No products selected* - No entitlements were created.';
        await say(
          `:white_check_mark: Successfully updated site <${baseURL}|${baseURL}> to use Spacecat org `
          + `with imsOrgId: *${userImsOrgId}*.${productsMessage}`,
        );
      }
      if (selectedProducts.length > 0) {
        // ensure entitlements and enrollments for selected products
        const entitlementResults = await createEntitlementsForProducts(
          lambdaContext,
          site,
          selectedProducts,
        );
        await postEntitlementMessages(say, entitlementResults, site.getId());
      }
    } catch (error) {
      log.error('Error handling modal submission:', error);
    }
  };
}
