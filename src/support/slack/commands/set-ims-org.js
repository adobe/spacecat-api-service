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

import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['set imsorg'];

/**
 * Factory function to create the SetSiteOrganizationCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {SetSiteOrganizationCommand} The SetSiteOrganizationCommand object.
 * @constructor
 */
function SetSiteOrganizationCommand(context) {
  const baseCommand = BaseCommand({
    id: 'set-ims-org',
    name: 'Set IMS Organization',
    description: 'Sets (or creates) a Spacecat org for a site by IMS Org ID.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} {imsOrgId}`,
  });

  const { dataAccess, log, imsClient } = context;
  const { Site, Organization } = dataAccess;

  /**
   * Command execution logic:
   *  1. Validate user input (base URL and IMS Org ID).
   *  2. Find the Site by the provided base URL.
   *  3. Check if the Spacecat org with the provided IMS Org ID already exists.
   *  4. If not found, retrieve IMS org details and create a new Spacecat org.
   *  5. Update the site's organizationId and save.
   *  6. Inform the Slack user about the result (either "set" or "created then set").
   *  7. If IMS org cannot be found, let the user know.
   *
   * @param {string[]} args - The arguments provided to the command ([baseURL, imsOrgId]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack 'say' function to post responses.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [baseURLInput, userImsOrgId] = args;

      const baseURL = extractURLFromSlackInput(baseURLInput);
      if (!baseURL) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      if (!userImsOrgId) {
        await say(':warning: Please provide a valid IMS Org ID.');
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      let spaceCatOrg = await Organization.findByImsOrgId(userImsOrgId);

      // if not found, try retrieving from IMS, then create a new spacecat org
      if (!spaceCatOrg) {
        let imsOrgDetails;
        try {
          imsOrgDetails = await imsClient.getImsOrganizationDetails(userImsOrgId);
          log.info(`IMS Org Details: ${imsOrgDetails}`);
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

        // inform user that we created the org and set it
        await say(
          `:white_check_mark: Successfully *created* a new Spacecat org (Name: *${imsOrgDetails.orgName}*) `
          + `and set it for site <${baseURL}|${baseURL}>!`,
        );
      } else {
        // we already have a matching spacecat org
        site.setOrganizationId(spaceCatOrg.getId());
        await site.save();

        await say(
          `:white_check_mark: Successfully updated site <${baseURL}|${baseURL}> to use Spacecat org `
          + `with imsOrgId: *${userImsOrgId}*.`,
        );
      }
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return {
    ...baseCommand,
    handleExecution,
  };
}

export default SetSiteOrganizationCommand;
