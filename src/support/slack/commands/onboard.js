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
import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import {
  isValidUrl, isObject, isNonEmptyArray, isValidIMSOrgId,
} from '@adobe/spacecat-shared-utils';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import os from 'os';
import path from 'path';
import fs from 'fs';

import {
  extractURLFromSlackInput,
  postErrorMessage,
  loadProfileConfig,
  parseCSV,
} from '../../../utils/slack/base.js';

import { findDeliveryType, triggerImportRun, triggerAuditForSite } from '../../utils.js';
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
    usageText: `${PHRASES[0]} {site} [imsOrgId] [profile] [workflowWaitTime] or ${PHRASES[1]} {site} [imsOrgId] [profile] [workflowWaitTime]`,
  });

  const {
    dataAccess, log, imsClient, env,
  } = context;
  const { Configuration, Site, Organization } = dataAccess;

  const csvStringifier = createObjectCsvStringifier({
    header: [
      { id: 'site', title: 'Site URL' },
      { id: 'imsOrgId', title: 'IMS Org ID' },
      { id: 'spacecatOrgId', title: 'Spacecat Org ID' },
      { id: 'siteId', title: 'Site ID' },
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
   * Checks if an import type is already enabled for a site.
   *
   * @param {string} importType - The import type to check.
   * @param {Array} imports - Array of import configurations.
   * @returns {boolean} - True if import is enabled, false otherwise.
   */
  const isImportEnabled = (importType, imports) => {
    const foundImport = imports.find((importConfig) => importConfig.type === importType);
    // If import is found, check if it's enabled, otherwise assume it's not enabled (false)
    return foundImport ? foundImport.enabled : false;
  };

  /**
   * Checks if an audit type is already enabled for a site.
   *
   * @param {string} type - The audit type to check.
   * @param {Object} site - The site object.
   * @returns {Promise<boolean>} - True if audit is enabled, false otherwise.
   */
  const isAuditEnabledForSite = async (type, site) => {
    const configuration = await Configuration.findLatest();
    return configuration.isHandlerEnabledForSite(type, site);
  };

  /**
   * Onboards a single site.
   *
   * @param {string} baseURLInput - The site URL.
   * @param {string} imsOrganizationID - The IMS Org ID.
   * @param {object} configuration - The configuration object.
   * @param {string} profileName - The profile name.
   * @param {number} workflowWaitTime - Optional wait time in seconds.
   * @param {Object} slackContext - Slack context.
   * @returns {Promise<Object>} - A report line containing execution details.
   */
  const onboardSingleSite = async (
    baseURLInput,
    imsOrganizationID,
    configuration,
    profileName,
    workflowWaitTime,
    slackContext,
  ) => {
    const { say } = slackContext;
    const sfnClient = new SFNClient();

    const baseURL = extractURLFromSlackInput(baseURLInput);

    // Set default IMS Org ID if not provided
    const imsOrgID = imsOrganizationID || env.DEMO_IMS_ORG;

    log.info(`Starting ${profileName} environment setup for site ${baseURL}`);
    await say(`:gear:  Starting ${profileName} environment setup for site ${baseURL}`);
    await say(':key: Please make sure you have access to the AEM Shared Production Demo environment. Request access here: https://demo.adobe.com/demos/internal/AemSharedProdEnv.html');
    const reportLine = {
      site: baseURL,
      imsOrgId: imsOrgID,
      spacecatOrgId: '',
      siteId: '',
      profile: profileName,
      deliveryType: '',
      imports: '',
      audits: '',
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

      if (!isValidIMSOrgId(imsOrgID)) {
        reportLine.errors = 'Invalid IMS Org ID';
        reportLine.status = 'Failed';
        return reportLine;
      }

      let site = await Site.findByBaseURL(baseURL);
      let organizationId;
      //  Check if site already exists
      if (site) {
        const siteOrgId = site.getOrganizationId();
        const message = `:information_source: Site ${baseURL} already exists. Organization ID: ${siteOrgId}`;
        await say(message);
        log.info(message);
      } else {
        // New site - handle organization logic
        log.info(`Site ${baseURL} doesn't exist. Processing organization...`);

        // Check if the organization with IMS Org ID already exists; create if it doesn't
        let organization = await Organization.findByImsOrgId(imsOrgID);
        const imsOrgDetails = await imsClient.getImsOrganizationDetails(imsOrgID);
        if (!organization) {
          if (!imsOrgDetails) {
            reportLine.errors = `Could not find details of IMS org with the ID *${imsOrgID}*.`;
            reportLine.status = 'Failed';
            return reportLine;
          }
          log.info(`IMS Org Details: ${imsOrgDetails}`);
          organization = await Organization.create({
            name: imsOrgDetails.orgName,
            imsOrgId: imsOrgID,
          });

          const message = `:white_check_mark: A new organization has been created. Organization ID: ${organization.getId()} Organization name: ${organization.getName()} IMS Org ID: ${imsOrgID}.`;
          await say(message);
          log.info(message);
        }

        organizationId = organization.getId(); // Set organizationId for new site
        log.info(`Organization ${organizationId} was successfully retrieved or created`);
        reportLine.spacecatOrgId = organizationId;

        // Create new site
        log.info(`Site ${baseURL} doesn't exist. Finding delivery type...`);
        const deliveryType = await findDeliveryType(baseURL);
        log.info(`Found delivery type for site ${baseURL}: ${deliveryType}`);
        reportLine.deliveryType = deliveryType;
        const isLive = deliveryType === SiteModel.DELIVERY_TYPES.AEM_EDGE;

        try {
          site = await Site.create({
            baseURL, deliveryType, isLive, organizationId,
          });
        } catch (error) {
          log.error(`Error creating site: ${error.message}`);
          reportLine.errors = error.message;
          reportLine.status = 'Failed';
          return reportLine;
        }
      }

      const siteID = site.getId();
      log.info(`Site ${baseURL} was successfully retrieved or created. Site ID: ${siteID}`);

      reportLine.siteId = siteID;

      const profile = await loadProfileConfig(profileName);
      log.info(`Profile ${profileName} was successfully loaded`);

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

      const importTypes = Object.keys(profile.imports);
      reportLine.imports = importTypes.join(', ');
      const siteConfig = site.getConfig();

      // Enabled imports only if there are not already enabled
      const imports = siteConfig.getImports();
      const importsEnabled = [];
      for (const importType of importTypes) {
        const isEnabled = isImportEnabled(importType, imports);
        if (!isEnabled) {
          log.info(`Enabling import: ${importType}`);
          siteConfig.enableImport(importType);
          importsEnabled.push(importType);
        } else {
          log.info(`Import '${importType}' is already enabled, skipping`);
        }
      }

      if (importsEnabled.length > 0) {
        log.info(`Enabled the following imports for ${siteID}: ${importsEnabled.join(', ')}`);
      } else {
        log.info(`All imports are already enabled for ${siteID}`);
      }

      site.setConfig(Config.toDynamoItem(siteConfig));
      try {
        await site.save();
      } catch (error) {
        log.error(error);
        reportLine.errors = error.message;
        reportLine.status = 'Failed';
        return reportLine;
      }

      log.info(`Site config succesfully saved for site ${siteID}`);

      for (const importType of importTypes) {
        /* eslint-disable no-await-in-loop */
        await triggerImportRun(
          configuration,
          importType,
          siteID,
          profile.imports[importType].startDate,
          profile.imports[importType].endDate,
          slackContext,
          context,
        );
      }

      log.info(`Triggered the following imports for site ${siteID}: ${reportLine.imports}`);

      const auditTypes = Object.keys(profile.audits);

      // Check which audits are not already enabled
      const auditsEnabled = [];
      for (const auditType of auditTypes) {
        /* eslint-disable no-await-in-loop */
        const isEnabled = await isAuditEnabledForSite(auditType, site, context);
        if (!isEnabled) {
          configuration.enableHandlerForSite(auditType, site);
          auditsEnabled.push(auditType);
        }
      }

      if (auditsEnabled.length > 0) {
        log.info(`Enabled the following audits for site ${siteID}: ${auditsEnabled.join(', ')}`);
      } else {
        log.info(`All audits are already enabled for site ${siteID}`);
      }

      reportLine.audits = auditTypes.join(', ');
      log.info(`Enabled the following audits for site ${siteID}: ${reportLine.audits}`);

      await say(`:white_check_mark: *For site ${baseURL}*: Enabled imports: ${reportLine.imports} and audits: ${reportLine.audits}`);
      // trigger audit runs
      log.info(`Starting audits for site ${baseURL}. Audit list: ${auditTypes}`);
      await say(`:gear: Starting audits: ${auditTypes}`);
      for (const auditType of auditTypes) {
        /* eslint-disable no-await-in-loop */
        if (!configuration.isHandlerEnabledForSite(auditType, site)) {
          await say(`:x: Will not audit site '${baseURL}' because audits of type '${auditType}' are disabled for this site.`);
        } else {
          await triggerAuditForSite(
            site,
            auditType,
            slackContext,
            context,
          );
        }
      }

      // Opportunity status job
      const opportunityStatusJob = {
        type: 'opportunity-status-processor',
        siteId: siteID,
        siteUrl: baseURL,
        imsOrgId: imsOrgID,
        organizationId,
        taskContext: {
          auditTypes,
          slackContext: {
            channelId: slackContext.channelId,
            threadTs: slackContext.threadTs,
          },
        },
      };

      // Disable imports and audits job - only disable what was enabled during onboarding
      const disableImportAndAuditJob = {
        type: 'disable-import-audit-processor',
        siteId: siteID,
        siteUrl: baseURL,
        imsOrgId: imsOrgID,
        organizationId,
        taskContext: {
          importTypes: importsEnabled || [],
          auditTypes: auditsEnabled || [],
          slackContext: {
            channelId: slackContext.channelId,
            threadTs: slackContext.threadTs,
          },
        },
      };

      // Demo URL job
      const demoURLJob = {
        type: 'demo-url-processor',
        siteId: siteID,
        siteUrl: baseURL,
        imsOrgId: imsOrgID,
        organizationId,
        taskContext: {
          experienceUrl: env.EXPERIENCE_URL || 'https://experience.adobe.com',
          slackContext: {
            channelId: slackContext.channelId,
            threadTs: slackContext.threadTs,
          },
        },
      };

      // Prepare and start step function workflow with the necessary parameters
      const workflowInput = {
        opportunityStatusJob,
        disableImportAndAuditJob,
        demoURLJob,
        workflowWaitTime: workflowWaitTime || env.WORKFLOW_WAIT_TIME_IN_SECONDS,
      };

      const workflowName = `onboard-${baseURL.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`;

      const startCommand = new StartExecutionCommand({
        stateMachineArn: env.ONBOARD_WORKFLOW_STATE_MACHINE_ARN,
        input: JSON.stringify(workflowInput),
        name: workflowName,
      });
      await sfnClient.send(startCommand);
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

        const profileName = args[0] || 'demo';

        await say(`:gear: Processing CSV file with profile *${profileName}*...`);

        // Download & parse CSV
        const csvData = await parseCSV(file, botToken);

        if (!isNonEmptyArray(csvData)) {
          await say(':x: No valid rows found in the CSV file. Please check the format.');
          return;
        }

        const tempFilePath = path.join(os.tmpdir(), `spacecat_onboard_report_${Date.now()}.csv`);
        const fileStream = fs.createWriteStream(tempFilePath);
        const configuration = await Configuration.findLatest();

        // Write headers to CSV report
        fileStream.write(csvStringifier.getHeaderString());

        // Process batch onboarding
        for (const row of csvData) {
          /* eslint-disable no-await-in-loop */
          const [baseURL, imsOrgID] = row;
          const reportLine = await onboardSingleSite(
            baseURL,
            imsOrgID,
            configuration,
            profileName,
            env.WORKFLOW_WAIT_TIME_IN_SECONDS, // Use environment default wait time in batch mode
            slackContext,
          );

          // Add individual site status reporting for CSV processing
          if (reportLine.errors) {
            await say(`:warning: Site ${baseURL}: ${reportLine.errors}`);
          } else {
            await say(`:white_check_mark: Site ${baseURL}: Onboarding started`);
          }

          fileStream.write(csvStringifier.stringifyRecords([reportLine]));
        }

        await configuration.save();

        log.info('All sites were processed and onboarded.');

        fileStream.end();

        fileStream.on('finish', async () => {
          try {
            const uploadResponse = client.files.upload({
              channels: channelId,
              file: fs.createReadStream(tempFilePath),
              filename: 'spacecat_onboarding_report.csv',
              title: 'Spacecat Onboarding Report',
              initial_comment: ':spacecat: *Batch onboarding in progress!* :satellite:\nHere you can find the *execution report*. :memo:',
              thread_ts: threadTs,
            });
            log.info(uploadResponse);
          } catch (error) {
            await say(`:warning: Failed to upload the report to Slack: ${error.message}`);
          }
        });
      } else {
        if (args.length < 1) {
          await say(':warning: Missing required argument. Please provide at least *Site URL*.');
          return;
        }

        // Parse arguments with smart detection of imsOrgId
        const [baseURLInput, secondArg, thirdArg, fourthArg] = args;

        let imsOrgID;
        let profileName;
        let workflowWaitTime;

        if (args.length >= 2) {
          // Check if second argument is a valid IMS Org ID
          if (secondArg && isValidIMSOrgId(secondArg)) {
            imsOrgID = secondArg;
            profileName = thirdArg || 'demo';
            workflowWaitTime = fourthArg;
          } else {
            await say(':warning: Invalid IMS Org ID. Please provide a valid IMS Org ID.');
            return;
          }
        } else {
          // Only siteId provided
          imsOrgID = env.DEMO_IMS_ORG;
          profileName = 'demo';
          workflowWaitTime = undefined;
        }
        const parsedWaitTime = workflowWaitTime ? Number(workflowWaitTime) : undefined;

        const configuration = await Configuration.findLatest();

        const reportLine = await onboardSingleSite(
          baseURLInput,
          imsOrgID,
          configuration,
          profileName,
          parsedWaitTime,
          slackContext,
        );

        await configuration.save();

        if (reportLine.errors) {
          await say(`:warning: ${reportLine.errors}`);
        }

        const message = `
        :ims: *IMS Org ID:* ${reportLine.imsOrgId || 'n/a'}
        :space-cat: *Spacecat Org ID:* ${reportLine.spacecatOrgId || 'n/a'}
        :identification_card: *Site ID:* ${reportLine.siteId || 'n/a'}
        :cat-egory-white: *Delivery Type:* ${reportLine.deliveryType || 'n/a'}
        :question: *Already existing:* ${reportLine.existingSite}
        :gear: *Profile:* ${reportLine.profile}
        :hourglass_flowing_sand: *Wait Time:* ${parsedWaitTime || env.WORKFLOW_WAIT_TIME_IN_SECONDS} seconds (${parsedWaitTime === env.WORKFLOW_WAIT_TIME_IN_SECONDS ? 'default' : 'custom'})
        :clipboard: *Audits:* ${reportLine.audits || 'None'}
        :inbox_tray: *Imports:* ${reportLine.imports || 'None'}
        ${reportLine.errors ? `:x: *Errors:* ${reportLine.errors}` : ':hourglass_flowing_sand: *Status:* In-Progress'}
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
