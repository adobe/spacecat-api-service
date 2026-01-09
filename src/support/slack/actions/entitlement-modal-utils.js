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

export const PRODUCTS_BLOCK_ID = 'products_block';
export const ASO_ACTION_ID = 'aso_checkbox';
export const LLMO_ACTION_ID = 'llmo_checkbox';
export const ACO_ACTION_ID = 'aco_checkbox';

/**
 * Creates a product selection modal view
 * @param {string} callbackId - The modal callback ID
 * @param {object} metadata - Metadata to pass to the modal
 * @param {string} title - Modal title
 * @param {string} description - Description text for the modal
 * @returns {object} Modal view object
 */
export function createProductSelectionModal(callbackId, metadata, title, description) {
  return {
    type: 'modal',
    callback_id: callbackId,
    title: {
      type: 'plain_text',
      text: title,
    },
    submit: {
      type: 'plain_text',
      text: 'Submit',
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
    },
    private_metadata: JSON.stringify(metadata),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: description,
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
          {
            type: 'checkboxes',
            action_id: ACO_ACTION_ID,
            options: [
              {
                text: {
                  type: 'plain_text',
                  text: EntitlementModel.PRODUCT_CODES.ACO,
                },
                value: EntitlementModel.PRODUCT_CODES.ACO,
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Extracts selected products from modal state
 * @param {object} state - Modal state object
 * @returns {string[]} Array of selected product codes
 */
export function extractSelectedProducts(state) {
  const values = state.values[PRODUCTS_BLOCK_ID];
  const selectedProducts = [];

  if (values[ASO_ACTION_ID]?.selected_options?.length > 0) {
    selectedProducts.push(EntitlementModel.PRODUCT_CODES.ASO);
  }
  if (values[LLMO_ACTION_ID]?.selected_options?.length > 0) {
    selectedProducts.push(EntitlementModel.PRODUCT_CODES.LLMO);
  }

  return selectedProducts;
}

/**
 * Creates a say function for posting messages to a Slack channel
 * @param {object} client - Slack client
 * @param {string} channelId - Channel ID
 * @param {string} threadTs - Thread timestamp
 * @returns {Function} Say function
 */
export function createSayFunction(client, channelId, threadTs) {
  return async (message) => {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: message,
    });
  };
}

/**
 * Updates a message to show processing state
 * @param {object} client - Slack client
 * @param {string} channelId - Channel ID
 * @param {string} messageTs - Message timestamp
 * @param {string} baseURL - Site base URL
 * @param {string} title - Title for the processing message
 * @returns {Promise<void>}
 */
export async function updateMessageToProcessing(client, channelId, messageTs, baseURL, title) {
  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: `Processing ${baseURL}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${title}*\n\nSite: \`${baseURL}\`\n\n_Processing..._`,
        },
      },
    ],
  });
}

/**
 * Creates entitlements for selected products in parallel
 * @param {object} lambdaContext - Lambda context
 * @param {object} site - Site object
 * @param {string[]} selectedProducts - Array of product codes
 * @returns {Promise<Array>} Array of entitlement results
 */
export async function createEntitlementsForProducts(lambdaContext, site, selectedProducts) {
  const entitlementPromises = selectedProducts.map(async (product) => {
    const tierClient = await TierClient.createForSite(lambdaContext, site, product);
    const { entitlement, siteEnrollment } = await tierClient.createEntitlement(
      EntitlementModel.TIERS.FREE_TRIAL,
    );
    return {
      product,
      entitlementId: entitlement.getId(),
      enrollmentId: siteEnrollment.getId(),
    };
  });

  return Promise.all(entitlementPromises);
}

/**
 * Posts entitlement success messages to Slack
 * @param {Function} say - Say function for posting messages
 * @param {Array} entitlementResults - Array of entitlement results
 * @param {string} siteId - Site ID
 * @returns {Promise<void>}
 */
export async function postEntitlementMessages(say, entitlementResults, siteId) {
  /* eslint-disable no-await-in-loop */
  for (const result of entitlementResults) {
    const message = `:white_check_mark: Ensured ${result.product} entitlement ${result.entitlementId} `
      + `(${EntitlementModel.TIERS.FREE_TRIAL}) and enrollment ${result.enrollmentId} for site ${siteId}`;
    await say(message);
  }
  /* eslint-enable no-await-in-loop */
}
