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
import { isValidUrl, isObject, isNonEmptyArray } from '@adobe/spacecat-shared-utils';
import os from 'os';
import path from 'path';
import fs from 'fs';

import {
  extractURLFromSlackInput,
  postErrorMessage,
  loadProfileConfig,
  parseCSV,
} from '../../../utils/slack/base.js';

import { findDeliveryType, triggerImportRun } from '../../utils.js';

import BaseCommand from './base.js';

import { createObjectCsvStringifier } from '../../../utils/slack/csvHelper.cjs';

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

  const csvStringifier = createObjectCsvStringifier({
    header: [
      { id: 'site', title: 'Site URL' },
      { id: 'imsOrgId', title: 'IMS Org ID' },
      { id: 'profile', title: 'Profile' },
      { id: 'existingSite', title: 'Already existing site?' },
      { id: 'deliveryType', title: 'Delivery Type' },
      { id: 'audits', title: 'Audits' },
      { id: 'imports', title: 'Imports' },
      { id: 'errors', title: 'Errors' },
      { id: 'status', title: 'Status' },
    ],
  });

  /**
   * Onboards a single site.
   *
   * @param {string} baseURLInput - The site URL.
   * @param {string} imsOrgID - The IMS Org ID.
   * @param {string} profileName - The profile name.
   * @param {Object} slackContext - Slack context.
   * @returns {Promise<Object>} - A report line containing execution details.
   */
  const onboardSingleSite = async (baseURLInput, imsOrgID, profileName, slackContext) => {
    const { say } = slackContext;
    const { DEFAULT_ORGANIZATION_ID: defaultOrgId } = context.env;

    const baseURL = extractURLFromSlackInput(baseURLInput);

    const reportLine = {
      site: baseURL,
      imsOrgId: imsOrgID,
      profile: profileName,
      deliveryType: '',
      audits: '',
      imports: '',
      errors: '',
      status: 'Success',
      existingSite: 'No',
    };

    try {
      if (!isValidUrl(baseURL)) {
        reportLine.errors = 'Invalid site base URL';
        reportLine.status = 'Failed';
        return reportLine;
      }

      if (!OrganizationModel.IMS_ORG_ID_REGEX.test(imsOrgID)) {
        reportLine.errors = 'Invalid IMS Org ID';
        reportLine.status = 'Failed';
        return reportLine;
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
          reportLine.errors = `Error retrieving IMS org with the ID *${imsOrgID}*.`;
          reportLine.status = 'Failed';
          return reportLine;
        }

        if (!imsOrgDetails) {
          reportLine.errors = `Could not find details of IMS org with the ID *${imsOrgID}*.`;
          reportLine.status = 'Failed';
          return reportLine;
        }

        organization = await Organization.create({
          name: imsOrgDetails.orgName,
          imsOrgId: imsOrgID,
        });

        const message = `:white_check_mark: A new organization has been created. Organization ID: ${organization.getId()} Organization name: ${organization.getName()} IMS Org ID: ${imsOrgID}.`;
        await say(message);
        log.info(message);
      }

      let site = await Site.findByBaseURL(baseURL);
      if (site) {
        reportLine.existingSite = 'Yes';
        reportLine.deliveryType = site.getDeliveryType();
      } else {
        const deliveryType = await findDeliveryType(baseURL);
        reportLine.deliveryType = deliveryType;
        const isLive = deliveryType === SiteModel.DELIVERY_TYPES.AEM_EDGE;
        site = await Site.create({
          baseURL, deliveryType, isLive, organizationId: defaultOrgId,
        });
      }

      const profile = await loadProfileConfig(profileName);

      if (!isObject(profile)) {
        const error = `Profile "${profileName}" not found or invalid.`;
        log.error(error);
        reportLine.errors = error;
        reportLine.status = 'Failed';
        return reportLine;
      }

      if (!isObject(profile?.audits)) {
        const error = `Profile "${profileName}" does not have a valid audits section.`;
        log.error(error);
        reportLine.errors = error;
        reportLine.status = 'Failed';
        return reportLine;
      }

      if (!isObject(profile?.imports)) {
        const error = `Profile "${profileName}" does not have a valid imports section.`;
        log.error(error);
        reportLine.errors = error;
        reportLine.status = 'Failed';
        return reportLine;
      }

      const configuration = await Configuration.findLatest();

      const importTypes = Object.keys(profile.imports);

      for (const importType of importTypes) {
        /* eslint-disable no-await-in-loop */
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

      reportLine.imports = importTypes.join(',');

      const auditTypes = Object.keys(profile.audits);

      auditTypes.forEach((auditType) => {
        configuration.enableHandlerForSite(auditType, site);
      });

      await configuration.save();

      reportLine.audits = auditTypes.join(',');
    } catch (error) {
      log.error(error);
      reportLine.errors = error.message;
      reportLine.status = 'Failed';

      throw error; // re-throw the error to ensure that the outer function detects failure
    }
    // eslint-disable-next-line consistent-return
    return reportLine;
  };

  /**
   * Handles site onboarding (single site or batch of sites).
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const {
      say, botToken, files, channelId, client, threadTs,
    } = slackContext;

    await say(':spacecat: Mission Control, we are go for *onboarding*! :satellite:');

    try {
      if (isNonEmptyArray(files)) {
        // Ensure exactly one CSV file is uploaded
        if (files.length > 1) {
          await say(':warning: Please upload only *one* CSV file at a time.');
          return;
        }

        const file = files[0];

        // Ensure file is a CSV
        if (!file.name.endsWith('.csv')) {
          await say(':warning: Please upload a *valid* CSV file.');
          return;
        }

        const profileName = args[0] || 'default';

        await say(`:gear: Processing CSV file with profile *${profileName}*...`);

        // Download & parse CSV
        const csvData = await parseCSV(file, botToken);

        if (!isNonEmptyArray(csvData)) {
          await say(':x: No valid rows found in the CSV file. Please check the format.');
          return;
        }

        const tempFilePath = path.join(os.tmpdir(), `spacecat_onboard_report_${Date.now()}.csv`);
        const fileStream = fs.createWriteStream(tempFilePath);

        // Write headers to CSV report
        fileStream.write(csvStringifier.getHeaderString());

        // Process batch onboarding
        for (const row of csvData) {
          /* eslint-disable no-await-in-loop */
          const [baseURL, imsOrgID] = row;
          const reportLine = await onboardSingleSite(baseURL, imsOrgID, profileName, slackContext);
          await say(`Onboarding a site with base URL ${baseURL} and IMS org ID ${imsOrgID}`); // TODO: remove to reduce noise
          fileStream.write(csvStringifier.stringifyRecords([reportLine]));
        }

        fileStream.end();

        fileStream.on('finish', async () => {
          try {
            const uploadResponse = client.files.upload({
              channels: channelId,
              file: fs.createReadStream(tempFilePath),
              filename: 'spacecat_onboarding_report.csv',
              title: 'Spacecat Onboarding Report',
              initial_comment: ':spacecat: *Onboarding complete!* :satellite:\nHere you can find the *execution report*. :memo:',
              thread_ts: threadTs,
            });
            log.info(uploadResponse);
          } catch (error) {
            await say(`:warning: Failed to upload the report to Slack: ${error.message}`);
          }
        });

        await say(':white_check_mark: Batch onboarding completed successfully.');
      } else {
        if (args.length < 2) {
          await say(':warning: Missing required arguments. Please provide *Site URL* and *IMS Org ID*.');
          return;
        }

        const [baseURLInput, imsOrgID, profileName = 'default'] = args;
        const reportLine = await onboardSingleSite(
          baseURLInput,
          imsOrgID,
          profileName,
          slackContext,
        );

        if (reportLine.errors) {
          await say(`:warning: ${reportLine.errors}`);
        }

        const message = `
        *Onboarding complete for ${reportLine.site}*
        :ims: *IMS Org ID:* ${reportLine.imsOrgId}
        :gear: *Profile:* ${reportLine.profile}
        :clipboard: *Audits:* ${reportLine.audits || 'None'}
        :inbox_tray: *Imports:* ${reportLine.imports || 'None'}
        ${reportLine.errors ? `:x: *Errors:* ${reportLine.errors}` : `:check: *Status:* ${reportLine.status}`}
        `;

        await say(message);
      }
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default OnboardCommand;
