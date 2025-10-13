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
import { isNonEmptyArray } from '@adobe/spacecat-shared-utils';
import os from 'os';
import path from 'path';
import fs from 'fs';

import {
  extractURLFromSlackInput,
  postErrorMessage,
  loadProfileConfig,
  parseCSV,
  sendFile,
} from '../../../utils/slack/base.js';

import { onboardSingleSite as sharedOnboardSingleSite } from '../../utils.js';
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
    description: 'Onboards a new site (or batch of sites from CSV) to AEM Sites Optimizer using an interactive modal interface.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]}

*Interactive Onboarding:* This command opens a modal form where you can configure:
• Site URL (required)
• Project (required)
• IMS Organization ID (optional)
• Configuration profile (demo/production)
• Delivery type (auto-detect/manual)
• Authoring type (optional)
• Language & Region (optional)
• Workflow wait time (optional)
• Preview environment URL (optional)
• Entitlement Tier (optional, defaults to FREE_TRIAL)

*Batch Processing:* Upload a CSV file with ${PHRASES[1]} using the format:
\`Site URL, IMS Org ID, [Reserved], Delivery Type, Authoring Type, Tier\`
`,
  });

  const {
    dataAccess, log, env,
  } = context;
  const { Configuration } = dataAccess;

  const csvStringifier = createObjectCsvStringifier({
    header: [
      { id: 'site', title: 'Site URL' },
      { id: 'projectId', title: 'Project ID' },
      { id: 'imsOrgId', title: 'IMS Org ID' },
      { id: 'spacecatOrgId', title: 'Spacecat Org ID' },
      { id: 'siteId', title: 'Site ID' },
      { id: 'profile', title: 'Profile' },
      { id: 'existingSite', title: 'Already existing site?' },
      { id: 'deliveryType', title: 'Delivery Type' },
      { id: 'authoringType', title: 'Authoring Type' },
      { id: 'tier', title: 'Entitlement Tier' },
      { id: 'language', title: 'Language Code' },
      { id: 'region', title: 'Country Code' },
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
   * @param {string} imsOrganizationID - The IMS Org ID.
   * @param {object} configuration - The configuration object.
   * @param {string} profileName - The profile name.
   * @param {number} workflowWaitTime - Optional wait time in seconds.
   * @param {Object} slackContext - Slack context.
   * @param {Object} additionalParams - Additional onboarding parameters.
   * @param {string} additionalParams.deliveryType - Forced delivery type.
   * @param {string} additionalParams.authoringType - Authoring type.
   * @param {string} additionalParams.tier - Entitlement tier.
   * @param {string} additionalParams.projectId - Project ID.
   * @param {string} additionalParams.language - Language code.
   * @param {string} additionalParams.region - Country code.
   * @returns {Promise<Object>} - A report line containing execution details.
   */
  const onboardSingleSite = async (
    baseURLInput,
    imsOrganizationID,
    configuration,
    profileName,
    workflowWaitTime,
    slackContext,
    additionalParams = {},
  ) => {
    // Load the profile configuration
    const profile = await loadProfileConfig(profileName);

    // Use the shared onboarding function from utils
    return sharedOnboardSingleSite(
      baseURLInput,
      imsOrganizationID,
      configuration,
      profile,
      workflowWaitTime,
      slackContext,
      context,
      additionalParams,
      {
        urlProcessor: extractURLFromSlackInput, // Pass URL processor for Slack input format
        profileName,
      },
    );
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
      say, botToken, files, channelId, threadTs,
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
          const [baseURL, imsOrgID, tier, projectId, language, region] = row;
          const reportLine = await onboardSingleSite(
            baseURL,
            imsOrgID,
            configuration,
            profileName,
            env.WORKFLOW_WAIT_TIME_IN_SECONDS, // Use environment default wait time in batch mode
            slackContext,
            context,
            {
              tier,
              projectId,
              language,
              region,
            },
          );

          // Add individual site status reporting for CSV processing
          if (reportLine.errors) {
            await say(`:warning: Site ${baseURL}: ${reportLine.errors}`);
          } else {
            await say(`:white_check_mark: Site ${baseURL}: Onboarding started`);
          }

          fileStream.write(csvStringifier.stringifyRecords([reportLine]));
        }

        fileStream.end();

        fileStream.on('finish', async () => {
          try {
            const stats = fs.statSync(tempFilePath);
            const fileWithSize = {
              ...fs.createReadStream(tempFilePath),
              size: stats.size,
            };
            await sendFile(
              slackContext,
              fileWithSize,
              'spacecat_onboarding_report.csv',
              'Spacecat Onboarding Report',
              ':spacecat: *Batch onboarding in progress!* :satellite:\nHere you can find the *execution report*. :memo:',
              channelId,
            );
          } catch (error) {
            await say(`:warning: Failed to upload the report to Slack: ${error.message}`);
          }
        });
      } else {
        // Handle backwards compatibility with command line arguments
        const [site, imsOrgId, profile, workflowWaitTime, tier, projectId, language, region] = args;

        // Show button to start onboarding with optional pre-populated values
        const initialValues = {};
        if (site) {
          const normalizedSite = extractURLFromSlackInput(site);
          if (normalizedSite) {
            initialValues.site = normalizedSite;
          }
        }
        if (imsOrgId) initialValues.imsOrgId = imsOrgId;
        if (profile) initialValues.profile = profile;
        if (workflowWaitTime) initialValues.workflowWaitTime = workflowWaitTime;
        if (tier) initialValues.tier = tier;
        if (projectId) initialValues.projectId = projectId;
        if (language) initialValues.language = language;
        if (region) initialValues.region = region;

        const buttonValue = Object.keys(initialValues).length > 0
          ? JSON.stringify(initialValues)
          : 'start_onboarding';

        const message = {
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: ':rocket: *Site Onboarding*\n\nClick the button below to start the interactive onboarding process.',
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: 'Start Onboarding',
                  },
                  value: buttonValue,
                  action_id: 'start_onboarding',
                  style: 'primary',
                },
              ],
            },
          ],
          thread_ts: threadTs,
        };

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
