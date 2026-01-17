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
import BaseCommand from './base.js';
import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['get entitlement imsorg'];

/**
 * A factory function that creates an instance of the GetEntitlementImsOrgCommand.
 *
 * @param {object} context - The context object.
 * @returns {GetEntitlementImsOrgCommand} An instance of the command.
 * @constructor
 */
function GetEntitlementImsOrgCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-entitlement-imsorg',
    name: 'Get Entitlement for IMS Org',
    description: 'Retrieves entitlement information for an organization by IMS Org ID',
    phrases: PHRASES,
    usageText: `${PHRASES.join(' or ')} {imsOrgId}`,
  });

  const { dataAccess, log } = context;
  const { Organization, SiteEnrollment } = dataAccess;

  /**
   * Executes the command to get entitlement for an IMS org.
   *
   * @param {Array<string>} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [imsOrgId] = args;

      if (!imsOrgId) {
        await say(baseCommand.usage());
        return;
      }

      // Find the organization
      const organization = await Organization.findByImsOrgId(imsOrgId);

      if (!organization) {
        await say(`:x: Organization not found with IMS Org ID: ${imsOrgId}`);
        return;
      }

      const organizationId = organization.getId();
      const orgName = organization.getName() || imsOrgId;
      const productCodes = [
        EntitlementModel.PRODUCT_CODES.ASO,
        EntitlementModel.PRODUCT_CODES.LLMO,
        EntitlementModel.PRODUCT_CODES.ACO,
      ];

      await say(`:mag: Checking entitlements for organization: *${orgName}* (${imsOrgId})`);

      let hasAnyEntitlement = false;

      // Check entitlements for each product
      /* eslint-disable no-await-in-loop */
      for (const productCode of productCodes) {
        try {
          const tierClient = TierClient.createForOrg(context, organization, productCode);
          const { entitlement } = await tierClient.checkValidEntitlement();

          if (entitlement) {
            hasAnyEntitlement = true;
            const tier = entitlement.getTier();
            const entitlementId = entitlement.getId();

            // Get all site enrollments for this entitlement
            const enrollments = await SiteEnrollment.allByEntitlementId(entitlementId);
            const enrollmentCount = enrollments ? enrollments.length : 0;

            await say(
              `:white_check_mark: *${productCode}* Entitlement\n`
              + `  Entitlement ID: ${entitlementId}\n`
              + `  Tier: ${tier}\n`
              + `  Active Site Enrollments: ${enrollmentCount}`,
            );
          }
        } catch (error) {
          log.debug(`No ${productCode} entitlement found for organization ${organizationId}: ${error.message}`);
        }
      }
      /* eslint-enable no-await-in-loop */

      if (!hasAnyEntitlement) {
        await say(`:information_source: No active entitlements found for organization: ${orgName}`);
      }
    } catch (error) {
      log.error('Error in get entitlement imsorg command:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default GetEntitlementImsOrgCommand;
