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
import { triggerAuditForSite } from '../../utils.js';
import {
  createProductSelectionModal,
  extractSelectedProducts,
  createSayFunction,
  updateMessageToProcessing,
  createEntitlementsForProducts,
  postEntitlementMessages,
} from './modal-utils.js';

const MODAL_CALLBACK_ID = 'add_site_modal';

/**
 * Opens the product selection modal for add-site command.
 * This is triggered by a button action.
 */
export function openAddSiteModal(lambdaContext) {
  const { log } = lambdaContext;

  return async ({ ack, body, client }) => {
    await ack();

    const { value } = body.actions[0];
    const {
      baseURL, siteId, channelId, threadTs, messageTs,
    } = JSON.parse(value);

    const metadata = {
      baseURL, siteId, channelId, threadTs, messageTs,
    };
    const description = `*Choose products for entitlement*\n\nSite: \`${baseURL}\``;
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
 * Handles the modal submission for add-site.
 */
export function addSiteModal(lambdaContext) {
  const { dataAccess, log } = lambdaContext;
  const { Site, Configuration } = dataAccess;

  return async ({ ack, body, client }) => {
    try {
      const { view } = body;
      const { private_metadata: privateMetadata, state } = view;
      const {
        baseURL, siteId, channelId, threadTs, messageTs,
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
      const site = await Site.findById(siteId);
      if (!site) {
        log.error(`Site not found: ${siteId}`);
        await say(`:x: Site not found: ${baseURL}`);
        return;
      }

      // Remove the button by updating the message
      await updateMessageToProcessing(
        client,
        channelId,
        messageTs,
        baseURL,
        'Choose Products for Entitlement',
      );

      // Note: selectedProducts.length is always > 0 due to validation
      const productsMessage = `\nSelected products for entitlement: *${selectedProducts.join(', ')}*`;
      await say(`:white_check_mark: Products selected for site <${baseURL}|${baseURL}>${productsMessage}`);

      // ensure entitlements and enrollments for selected products
      const entitlementResults = await createEntitlementsForProducts(
        lambdaContext,
        site,
        selectedProducts,
      );

      await postEntitlementMessages(say, entitlementResults, site.getId());

      // Trigger initial audit
      const auditType = 'lhs-mobile';
      const configuration = await Configuration.findLatest();

      if (configuration.isHandlerEnabledForSite(auditType, site)) {
        const slackContext = {
          say, channelId, threadTs, client,
        };
        await triggerAuditForSite(site, auditType, undefined, slackContext, lambdaContext);
        await say('First PSI check is triggered! :adobe-run:\'\n'
          + `In a minute, you can run _@spacecat get site ${baseURL}_`);
      } else {
        await say('Audits are disabled for this site.');
      }
    } catch (error) {
      log.error('Error handling modal submission:', error);
    }
  };
}
