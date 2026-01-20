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
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['get entitlement site'];

/**
 * A factory function that creates an instance of the GetEntitlementSiteCommand.
 *
 * @param {object} context - The context object.
 * @returns {GetEntitlementSiteCommand} An instance of the command.
 * @constructor
 */
function GetEntitlementSiteCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-entitlement-site',
    name: 'Get Entitlement for Site',
    description: 'Retrieves entitlement and enrollment information for a site',
    phrases: PHRASES,
    usageText: `${PHRASES.join(' or ')} {siteURL}`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  /**
   * Executes the command to get entitlement for a site.
   *
   * @param {Array<string>} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [siteURLInput] = args;
      const siteURL = extractURLFromSlackInput(siteURLInput);

      if (!siteURL) {
        await say(baseCommand.usage());
        return;
      }

      // Find the site
      const site = await Site.findByBaseURL(siteURL);

      if (!site) {
        await say(`:x: Site not found with base URL: ${siteURL}`);
        return;
      }

      const siteId = site.getId();
      const productCodes = [
        EntitlementModel.PRODUCT_CODES.ASO,
        EntitlementModel.PRODUCT_CODES.LLMO,
        EntitlementModel.PRODUCT_CODES.ACO,
      ];

      await say(`:mag: Checking entitlements for site: *${siteURL}* (${siteId})`);

      let hasAnyEntitlement = false;

      // Check entitlements for each product
      /* eslint-disable no-await-in-loop */
      for (const productCode of productCodes) {
        try {
          const tierClient = await TierClient.createForSite(context, site, productCode);
          const { entitlement, siteEnrollment } = await tierClient.checkValidEntitlement();

          // Only show entitlements that have an active enrollment for the site
          if (entitlement && siteEnrollment) {
            hasAnyEntitlement = true;
            const tier = entitlement.getTier();
            const entitlementId = entitlement.getId();
            const enrollmentId = siteEnrollment.getId();

            await say(
              `:white_check_mark: *${productCode}* Entitlement\n`
              + `  Entitlement ID: ${entitlementId}\n`
              + `  Tier: ${tier}\n`
              + `  Enrollment ID: ${enrollmentId}`,
            );
          }
        } catch (error) {
          log.debug(`No ${productCode} entitlement found for site ${siteId}: ${error.message}`);
        }
      }
      /* eslint-enable no-await-in-loop */

      if (!hasAnyEntitlement) {
        await say(`:information_source: No active entitlements found for site: ${siteURL}`);
      }
    } catch (error) {
      log.error('Error in get entitlement site command:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default GetEntitlementSiteCommand;
