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
import {
  extractSelectedProducts,
  createSayFunction,
  createEntitlementsForProducts,
  postEntitlementMessages,
  createProductSelectionModal,
} from './entitlement-modal-utils.js';

/**
 * Opens the modal for ensuring entitlement for a site (button action).
 */
export function openEnsureEntitlementSiteModal(lambdaContext) {
  const { log } = lambdaContext;

  return async ({ ack, body, client }) => {
    try {
      await ack();

      const metadata = JSON.parse(body.actions[0].value);
      const {
        siteId, baseURL, channelId, threadTs,
      } = metadata;

      const modal = createProductSelectionModal(
        'ensure_entitlement_site_modal',
        {
          siteId,
          baseURL,
          channelId,
          threadTs,
        },
        'Select Products for Entitlement',
        `Creating entitlement for site: *${baseURL}*\n\nPlease select the products you want to ensure entitlement for:`,
      );

      await client.views.open({
        trigger_id: body.trigger_id,
        view: modal,
      });
    } catch (error) {
      log.error('Error opening ensure entitlement site modal:', error);
    }
  };
}

/**
 * Opens the modal for ensuring entitlement for an IMS org (button action).
 */
export function openEnsureEntitlementImsOrgModal(lambdaContext) {
  const { log } = lambdaContext;

  return async ({ ack, body, client }) => {
    try {
      await ack();

      const metadata = JSON.parse(body.actions[0].value);
      const {
        organizationId, imsOrgId, orgName, channelId, threadTs,
      } = metadata;

      const modal = createProductSelectionModal(
        'ensure_entitlement_imsorg_modal',
        {
          organizationId,
          imsOrgId,
          orgName,
          channelId,
          threadTs,
        },
        'Select Products for Entitlement',
        `Creating entitlement for organization: *${orgName}* (${imsOrgId})\n\nPlease select the products you want to ensure entitlement for:`,
      );

      await client.views.open({
        trigger_id: body.trigger_id,
        view: modal,
      });
    } catch (error) {
      log.error('Error opening ensure entitlement imsorg modal:', error);
    }
  };
}

/**
 * Opens the modal for revoking entitlement for a site (button action).
 */
export function openRevokeEntitlementSiteModal(lambdaContext) {
  const { log } = lambdaContext;

  return async ({ ack, body, client }) => {
    try {
      await ack();

      const metadata = JSON.parse(body.actions[0].value);
      const {
        siteId, baseURL, channelId, threadTs,
      } = metadata;

      const modal = createProductSelectionModal(
        'revoke_entitlement_site_modal',
        {
          siteId,
          baseURL,
          channelId,
          threadTs,
        },
        'Select Products to Revoke',
        `Revoking enrollment for site: *${baseURL}*\n\nPlease select the products you want to revoke enrollment for:`,
      );

      await client.views.open({
        trigger_id: body.trigger_id,
        view: modal,
      });
    } catch (error) {
      log.error('Error opening revoke entitlement site modal:', error);
    }
  };
}

/**
 * Opens the modal for revoking entitlement for an IMS org (button action).
 */
export function openRevokeEntitlementImsOrgModal(lambdaContext) {
  const { log } = lambdaContext;

  return async ({ ack, body, client }) => {
    try {
      await ack();

      const metadata = JSON.parse(body.actions[0].value);
      const {
        organizationId, imsOrgId, orgName, channelId, threadTs,
      } = metadata;

      const modal = createProductSelectionModal(
        'revoke_entitlement_imsorg_modal',
        {
          organizationId,
          imsOrgId,
          orgName,
          channelId,
          threadTs,
        },
        'Select Products to Revoke',
        `Revoking entitlement for organization: *${orgName}* (${imsOrgId})\n\nPlease select the products you want to revoke entitlement for:`,
      );

      await client.views.open({
        trigger_id: body.trigger_id,
        view: modal,
      });
    } catch (error) {
      log.error('Error opening revoke entitlement imsorg modal:', error);
    }
  };
}

/**
 * Handles the modal submission for ensuring entitlement for a site.
 */
export function ensureEntitlementSiteModal(lambdaContext) {
  const { dataAccess, log } = lambdaContext;
  const { Site } = dataAccess;

  return async ({ ack, body, client }) => {
    try {
      const { view } = body;
      const { private_metadata: privateMetadata, state } = view;
      const {
        siteId, baseURL, channelId, threadTs,
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

      await say(`:gear: Ensuring entitlements for site: *${baseURL}*`);

      // Ensure entitlements and enrollments for selected products
      const entitlementResults = await createEntitlementsForProducts(
        lambdaContext,
        site,
        selectedProducts,
      );

      await postEntitlementMessages(say, entitlementResults, site.getId());
      await say(`:white_check_mark: Successfully ensured entitlements for site: *${baseURL}*`);
    } catch (error) {
      log.error('Error in ensure entitlement site modal:', error);
    }
  };
}

/**
 * Handles the modal submission for ensuring entitlement for an IMS org.
 */
export function ensureEntitlementImsOrgModal(lambdaContext) {
  const { dataAccess, log } = lambdaContext;
  const { Organization } = dataAccess;

  return async ({ ack, body, client }) => {
    try {
      const { view } = body;
      const { private_metadata: privateMetadata, state } = view;
      const {
        organizationId, imsOrgId, orgName, channelId, threadTs,
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

      // Find the organization
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        log.error(`Organization not found: ${organizationId}`);
        await say(`:x: Organization not found: ${imsOrgId}`);
        return;
      }

      await say(`:gear: Ensuring entitlements for organization: *${orgName}* (${imsOrgId})`);

      // Ensure entitlements for selected products
      const entitlementResults = [];
      /* eslint-disable no-await-in-loop */
      for (const product of selectedProducts) {
        try {
          const tierClient = TierClient.createForOrg(lambdaContext, organization, product);
          const { entitlement } = await tierClient.createEntitlement(
            EntitlementModel.TIERS.FREE_TRIAL,
          );
          entitlementResults.push({
            product,
            entitlementId: entitlement.getId(),
          });

          await say(
            `:white_check_mark: Ensured ${product} entitlement ${entitlement.getId()} `
            + `(${EntitlementModel.TIERS.FREE_TRIAL}) for organization ${organizationId}`,
          );
        } catch (error) {
          log.error(`Error creating ${product} entitlement for org ${organizationId}:`, error);
          await say(`:x: Failed to ensure ${product} entitlement: ${error.message}`);
        }
      }
      /* eslint-enable no-await-in-loop */

      if (entitlementResults.length > 0) {
        await say(`:white_check_mark: Successfully ensured entitlements for organization: *${orgName}*`);
      }
    } catch (error) {
      log.error('Error in ensure entitlement imsorg modal:', error);
    }
  };
}

/**
 * Handles the modal submission for revoking entitlement for a site.
 */
export function revokeEntitlementSiteModal(lambdaContext) {
  const { dataAccess, log } = lambdaContext;
  const { Site } = dataAccess;

  return async ({ ack, body, client }) => {
    try {
      const { view } = body;
      const { private_metadata: privateMetadata, state } = view;
      const {
        siteId, baseURL, channelId, threadTs,
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

      await say(`:gear: Revoking enrollments for site: *${baseURL}*`);

      // Revoke enrollments for selected products
      /* eslint-disable no-await-in-loop */
      for (const product of selectedProducts) {
        try {
          const tierClient = await TierClient.createForSite(lambdaContext, site, product);
          await tierClient.revokeSiteEnrollment();

          await say(`:white_check_mark: Successfully revoked ${product} enrollment for site ${siteId}`);
        } catch (error) {
          log.error(`Error revoking ${product} enrollment for site ${siteId}:`, error);
          await say(`:x: Failed to revoke ${product} enrollment: ${error.message}`);
        }
      }
      /* eslint-enable no-await-in-loop */

      await say(`:white_check_mark: Completed revocation for site: *${baseURL}*`);
    } catch (error) {
      log.error('Error in revoke entitlement site modal:', error);
    }
  };
}

/**
 * Handles the modal submission for revoking entitlement for an IMS org.
 */
export function revokeEntitlementImsOrgModal(lambdaContext) {
  const { dataAccess, log } = lambdaContext;
  const { Organization } = dataAccess;

  return async ({ ack, body, client }) => {
    try {
      const { view } = body;
      const { private_metadata: privateMetadata, state } = view;
      const {
        organizationId, imsOrgId, orgName, channelId, threadTs,
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

      // Find the organization
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        log.error(`Organization not found: ${organizationId}`);
        await say(`:x: Organization not found: ${imsOrgId}`);
        return;
      }

      await say(`:gear: Revoking entitlements for organization: *${orgName}* (${imsOrgId})`);

      // Revoke entitlements for selected products
      // Create tier client for each selected product and revoke entitlement
      /* eslint-disable no-await-in-loop */
      for (const product of selectedProducts) {
        const tierClient = TierClient.createForOrg(lambdaContext, organization, product);
        await tierClient.revokeEntitlement();
      }
      /* eslint-enable no-await-in-loop */

      await say(`:white_check_mark: Completed revocation for organization: *${orgName}*`);
    } catch (error) {
      log.error('Error in revoke entitlement imsorg modal:', error);
    }
  };
}
