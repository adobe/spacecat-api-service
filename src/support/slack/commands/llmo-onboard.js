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

import { getLastNumberOfWeeks, isValidUrl } from '@adobe/spacecat-shared-utils';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

import {
  extractURLFromSlackInput,
  postErrorMessage,
} from '../../../utils/slack/base.js';

import BaseCommand from './base.js';

const REFERRAL_TRAFFIC_AUDIT = 'llmo-referral-traffic';
const REFERRAL_TRAFFIC_IMPORT = 'traffic-analysis';
const AGENTIC_TRAFFIC_ANALYSIS_AUDIT = 'cdn-analysis';
const AGENTIC_TRAFFIC_REPORT_AUDIT = 'cdn-logs-report';

const PHRASES = ['onboard-llmo'];

async function triggerReferralTrafficBackfill(context, configuration, siteId) {
  const { log, sqs } = context;

  const last4Weeks = getLastNumberOfWeeks(4);

  for (const last4Week of last4Weeks) {
    const { week, year } = last4Week;
    const message = {
      type: REFERRAL_TRAFFIC_IMPORT,
      siteId,
      auditContext: {
        auditType: REFERRAL_TRAFFIC_AUDIT,
        week,
        year,
      },
    };
    sqs.sendMessage(configuration.getQueues().imports, message);
    log.info(`Successfully triggered import ${REFERRAL_TRAFFIC_IMPORT} with message: ${JSON.stringify(message)}`);
  }
}

/**
 * Factory function to create the LlmoOnboardCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {LlmoOnboardCommand} - The LlmoOnboardCommand object.
 * @constructor
 */
function LlmoOnboardCommand(context) {
  const baseCommand = BaseCommand({
    id: 'onboard-llmo',
    name: 'Onboard LLMO',
    description: 'Onboards a site for LLMO (Large Language Model Optimizer) by setting dataFolder and brand.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL} {dataFolder} {brandName}`,
  });

  const {
    dataAccess, log,
  } = context;
  const { Site, Configuration } = dataAccess;

  /**
   * Handles LLMO onboarding for a single site.
   *
   * @param {string[]} args - The args provided to the command ([baseURL, dataFolder, brandName]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      if (args.length < 3) {
        await say(':warning: Missing required arguments. Please provide: `baseURL`, `dataFolder`, and `brandName`.');
        await say(`Usage: _${baseCommand.usage().replace('Usage: _', '').replace('_', '')}_`);
        return;
      }

      const [baseURLInput, dataFolder, ...brandNameParts] = args;
      const brandName = brandNameParts.join(' '); // Allow brand names with spaces

      if (!brandName.trim()) {
        await say(':warning: Brand name cannot be empty.');
        return;
      }

      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!isValidUrl(baseURL)) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      await say(`:gear: Starting LLMO onboarding for site ${baseURL}...`);

      // Find the site
      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await say(`:x: Site '${baseURL}' not found. Please add the site first using the regular onboard command.`);
        return;
      }

      const siteId = site.getId();
      log.info(`Found site ${baseURL} with ID: ${siteId}`);

      // Get current site config
      const siteConfig = site.getConfig();

      // Update brand and data directory
      siteConfig.updateLlmoBrand(brandName.trim());
      siteConfig.updateLlmoDataFolder(dataFolder.trim());

      // enable the traffic-analysis import for referral-traffic
      siteConfig.enableImport(REFERRAL_TRAFFIC_IMPORT);

      // enable the llmo-prompts-ahrefs import
      siteConfig.enableImport('llmo-prompts-ahrefs', { limit: 50 });

      // update the site config object
      site.setConfig(Config.toDynamoItem(siteConfig));

      // enable all necessary handlers
      const configuration = await Configuration.findLatest();
      configuration.enableHandlerForSite(REFERRAL_TRAFFIC_AUDIT, site);
      configuration.enableHandlerForSite('geo-brand-presence', site);

      // enable the cdn-analysis only if no other site in this organization already has it enabled
      const organizationId = site.getOrganizationId();
      const sitesInOrg = await Site.allByOrganizationId(organizationId);

      const hasAgenticTrafficEnabled = sitesInOrg.some(
        (orgSite) => configuration.isHandlerEnabledForSite(AGENTIC_TRAFFIC_ANALYSIS_AUDIT, orgSite),
      );

      if (!hasAgenticTrafficEnabled) {
        log.info(`Enabling agentic traffic audits for organization ${organizationId} (first site in org)`);
        configuration.enableHandlerForSite(AGENTIC_TRAFFIC_ANALYSIS_AUDIT, site);
      } else {
        log.info(`Agentic traffic audits already enabled for organization ${organizationId}, skipping`);
      }

      // enable the cdn-logs-report audits for agentic traffic
      configuration.enableHandlerForSite(AGENTIC_TRAFFIC_REPORT_AUDIT, site);

      try {
        await configuration.save();
        await site.save();
        log.info(`Successfully updated LLMO config for site ${siteId}`);

        await triggerReferralTrafficBackfill(context, configuration, siteId);

        const message = `:white_check_mark: *LLMO onboarding completed successfully!*
        
:link: *Site:* ${baseURL}
:identification_card: *Site ID:* ${siteId}
:file_folder: *Data Folder:* ${dataFolder}
:label: *Brand:* ${brandName}

The site is now ready for LLMO operations. You can access the configuration at the LLMO API endpoints.`;

        await say(message);
      } catch (error) {
        log.error(`Error saving LLMO config for site ${siteId}: ${error.message}`);
        await say(`:x: Failed to save LLMO configuration: ${error.message}`);
      }
    } catch (error) {
      log.error('Error in LLMO onboarding:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default LlmoOnboardCommand;
