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
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import TierClient from '@adobe/spacecat-shared-tier-client';

const MODAL_CALLBACK_ID = 'set_ims_org_modal';
const PRODUCTS_BLOCK_ID = 'products_block';
const ASO_ACTION_ID = 'aso_checkbox';
const LLMO_ACTION_ID = 'llmo_checkbox';

/**
 * Opens the product selection modal for set-ims-org command.
 * This is triggered by a button action.
 */
export function openSetImsOrgModal(lambdaContext) {
  const { log } = lambdaContext;

  return async ({ ack, body, client }) => {
    await ack();

    const {
      value,
    } = body.actions[0];
    const {
      baseURL, imsOrgId, channelId, threadTs, messageTs,
    } = JSON.parse(value);

    const modalView = {
      type: 'modal',
      callback_id: MODAL_CALLBACK_ID,
      title: {
        type: 'plain_text',
        text: 'Choose Products',
      },
      submit: {
        type: 'plain_text',
        text: 'Submit',
      },
      close: {
        type: 'plain_text',
        text: 'Cancel',
      },
      private_metadata: JSON.stringify({
        baseURL, imsOrgId, channelId, threadTs, messageTs,
      }),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Choose products to ensure entitlement*\n\nSite: \`${baseURL}\`\nIMS Org ID: \`${imsOrgId}\``,
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'actions',
          block_id: PRODUCTS_BLOCK_ID,
          elements: [
            {
              type: 'checkboxes',
              action_id: ASO_ACTION_ID,
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: EntitlementModel.PRODUCT_CODES.ASO,
                  },
                  value: EntitlementModel.PRODUCT_CODES.ASO,
                },
              ],
            },
            {
              type: 'checkboxes',
              action_id: LLMO_ACTION_ID,
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: EntitlementModel.PRODUCT_CODES.LLMO,
                  },
                  value: EntitlementModel.PRODUCT_CODES.LLMO,
                },
              ],
            },
          ],
        },
      ],
    };

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
      const {
        view, user,
      } = body;
      const {
        private_metadata: privateMetadata, state,
      } = view;
      const {
        baseURL, imsOrgId: userImsOrgId, channelId, threadTs, messageTs,
      } = JSON.parse(privateMetadata);

      // Extract selected products from checkboxes
      const values = state.values[PRODUCTS_BLOCK_ID];
      const selectedProducts = [];

      if (values[ASO_ACTION_ID]?.selected_options?.length > 0) {
        selectedProducts.push(EntitlementModel.PRODUCT_CODES.ASO);
      }
      if (values[LLMO_ACTION_ID]?.selected_options?.length > 0) {
        selectedProducts.push(EntitlementModel.PRODUCT_CODES.LLMO);
      }

      // Validate that at least one product is selected
      if (selectedProducts.length === 0) {
        await ack({
          response_action: 'errors',
          errors: {
            [PRODUCTS_BLOCK_ID]: 'Please select at least one product',
          },
        });
        return;
      }

      await ack();

      // Log selected products
      log.info(`User ${user.id} selected products: ${selectedProducts.join(', ')} for site ${baseURL} with IMS Org ID ${userImsOrgId}`);

      // Create a say function to post back to the channel
      const say = async (message) => {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: message,
        });
      };

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
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: `Set IMS Org for site ${baseURL}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Set IMS Organization*\n\nSite: \`${baseURL}\`\nIMS Org ID: \`${userImsOrgId}\`\n\n_Processing..._`,
              },
            },
          ],
        });

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
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: `Set IMS Org for site ${baseURL}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Set IMS Organization*\n\nSite: \`${baseURL}\`\nIMS Org ID: \`${userImsOrgId}\`\n\n_Processing..._`,
              },
            },
          ],
        });

        // Note: selectedProducts.length is always > 0 due to validation
        const productsMessage = `\nSelected products for entitlement: *${selectedProducts.join(', ')}*`;
        await say(
          `:white_check_mark: Successfully updated site <${baseURL}|${baseURL}> to use Spacecat org `
          + `with imsOrgId: *${userImsOrgId}*.${productsMessage}`,
        );
      }
      // ensure entitlements and enrollments for selected products
      /* eslint-disable no-await-in-loop */
      for (const product of selectedProducts) {
        const tierClient = await TierClient.createForSite(lambdaContext, site, product);
        const { entitlement, siteEnrollment } = await tierClient.createEntitlement(
          EntitlementModel.TIERS.FREE_TRIAL,
        );
        const message = `:white_check_mark: Ensured ${product} entitlement ${entitlement.getId()} `
          + `(${EntitlementModel.TIERS.FREE_TRIAL}) and enrollment ${siteEnrollment.getId()} for site ${site.getId()}`;
        await say(message);
      }
      /* eslint-enable no-await-in-loop */
    } catch (error) {
      log.error('Error handling modal submission:', error);
    }
  };
}
