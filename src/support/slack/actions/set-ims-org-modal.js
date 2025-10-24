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
} from './modal-utils.js';

const MODAL_CALLBACK_ID = 'set_ims_org_modal';

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

      // Validate that at least one product is selected
      if (selectedProducts.length === 0) {
        await ack();
        await say(':warning: Please select at least one product.');
        return;
      }

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
        // Note: selectedProducts.length is always > 0 due to validation
        const productsMessage = `\nSelected products for entitlement: *${selectedProducts.join(', ')}*`;
        await say(
          `:white_check_mark: Successfully *created* a new Spacecat org (Name: *${imsOrgDetails.orgName}*) `
          + `and set it for site <${baseURL}|${baseURL}>!${productsMessage}`,
        );
      } else {
        // we already have a matching spacecat org
        site.setOrganizationId(spaceCatOrg.getId());
        await site.save();

        // Remove the button by updating the message
        await updateMessageToProcessing(
          client,
          channelId,
          messageTs,
          baseURL,
          'Set IMS Organization',
        );

        // Note: selectedProducts.length is always > 0 due to validation
        const productsMessage = `\nSelected products for entitlement: *${selectedProducts.join(', ')}*`;
        await say(
          `:white_check_mark: Successfully updated site <${baseURL}|${baseURL}> to use Spacecat org `
          + `with imsOrgId: *${userImsOrgId}*.${productsMessage}`,
        );
      }
      // ensure entitlements and enrollments for selected products
      const entitlementResults = await createEntitlementsForProducts(
        lambdaContext,
        site,
        selectedProducts,
      );

      await postEntitlementMessages(say, entitlementResults, site.getId());
    } catch (error) {
      log.error('Error handling modal submission:', error);
    }
  };
}
