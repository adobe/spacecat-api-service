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

// todo: prototype - untested
/* c8 ignore start */
import { Site as SiteModel, Organization as OrganizationModel } from '@adobe/spacecat-shared-data-access';
import { isValidUrl, isObject } from '@adobe/spacecat-shared-utils';

import {
  extractURLFromSlackInput,
  postErrorMessage,
  loadProfileConfig,
} from '../../../utils/slack/base.js';

import { findDeliveryType, triggerAuditForSite, triggerImportRun } from '../../utils.js';

import BaseCommand from './base.js';

const PHRASES = ['onboard site', 'onboard sites'];

/**
 * Factory function to create the OnboardCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {OnboardCommand} - The OnboardCommand object.
 * @constructor
 */
function OnboardCommand(context) {
  const baseCommand = BaseCommand({
    id: 'onboard-site',
    name: 'Onboard Site(s)',
    description: 'Onboards a new site (or batch of sites from CSV) to Success Studio.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} {imsOrgId} [profile]`, // todo: add usageText for batch onboarding with file
  });

  const { dataAccess, log, imsClient } = context;
  const { Configuration, Site, Organization } = dataAccess;

  /**
   * Validates input and onboards the site to ESS
   * Runs initial audits for the onboarded base URL
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const { DEFAULT_ORGANIZATION_ID: defaultOrgId } = context.env;

    try {
      const [baseURLInput, imsOrgID, profileName = 'default'] = args;
      const baseURL = extractURLFromSlackInput(baseURLInput);

      await say(`:gear: Applying ${profileName} profile.`);

      if (!isValidUrl(baseURL)) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      if (!OrganizationModel.IMS_ORG_ID_REGEX.test(imsOrgID)) {
        await say(':warning: Please provide a valid IMS Org ID.');
        return;
      }

      // check if the organization with IMS Org ID already exists; create if it doesn't
      let organization = await Organization.findByImsOrgId(imsOrgID);
      if (!organization) {
        let imsOrgDetails;
        try {
          imsOrgDetails = await imsClient.getImsOrganizationDetails(imsOrgID);
          log.info(`IMS Org Details: ${imsOrgDetails}`);
        } catch (error) {
          log.error(`Error retrieving IMS Org details: ${error.message}`);
          await say(`:x: Could not find an IMS org with the ID *${imsOrgID}*.`);
          return;
        }

        if (!imsOrgDetails) {
          await say(`:x: Could not find an IMS org with the ID *${imsOrgID}*.`);
          return;
        }

        organization = await Organization.create({
          name: imsOrgDetails.orgName,
          imsOrgId: imsOrgID,
        });

        const message = `:white_check_mark: A new organization has been created. Organization ID: ${organization.getId()} Organization name: ${organization.getName()} IMS Org ID: ${imsOrgID}.`;
        await say(message);
        log.info(message);
      }

      // check if the site already exists; create if it doesn't
      let site = await Site.findByBaseURL(baseURL);
      if (!site) {
        const deliveryType = await findDeliveryType(baseURL);
        const isLive = deliveryType === SiteModel.DELIVERY_TYPES.AEM_EDGE;

        site = await Site.create({
          baseURL, deliveryType, isLive, organizationId: defaultOrgId,
        });
      }

      const profile = await loadProfileConfig(profileName);

      if (!isObject(profile)) {
        await say(`:warning: Profile "${profileName}" not found or invalid. Please try again.`);
        log.error(`Profile "${profileName}" is missing or invalid.`);
        return;
      }

      if (!isObject(profile?.audits)) {
        await say(`:warning: Profile "${profileName}" does not have a valid audits section.`);
        log.error(`Profile "${profileName}" has invalid or missing audits.`);
        return;
      }

      if (!isObject(profile?.imports)) {
        await say(`:warning: Profile "${profileName}" does not have a valid imports section.`);
        log.error(`Profile "${profileName}" has invalid or missing imports.`);
        return;
      }

      const configuration = await Configuration.findLatest();

      const auditTypes = Object.keys(profile.audits);

      auditTypes.forEach((auditType) => {
        configuration.enableHandlerForSite(auditType, site);
      });

      await configuration.save();

      for (const auditType of auditTypes) {
        // eslint-disable-next-line no-await-in-loop
        await triggerAuditForSite(site, auditType, slackContext, context);
      }

      const importTypes = Object.keys(profile.imports);

      for (const importType of importTypes) {
        // eslint-disable-next-line no-await-in-loop
        await triggerImportRun(
          configuration,
          importType,
          site.getId(),
          profile.imports[importType].startDate,
          profile.imports[importType].endDate,
          slackContext,
          context,
        );
      }

      let message = `Success Studio onboard completed successfully for ${baseURL} :rocket:\n`;
      message += `Enabled and triggered following audits: ${auditTypes.join(', ')}`;

      await say(message);
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

export default OnboardCommand;
/* c8 ignore end */
