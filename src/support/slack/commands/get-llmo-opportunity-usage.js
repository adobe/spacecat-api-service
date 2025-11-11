/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { isValidUrl } from '@adobe/spacecat-shared-utils';
import { sendFile, extractURLFromSlackInput } from '../../../utils/slack/base.js';
import { createObjectCsvStringifier } from '../../../utils/slack/csvHelper.cjs';
import BaseCommand from './base.js';

const PHRASES = ['get-llmo-opportunity-usage'];
const EXCLUDED_IMS_ORGS = ['9E1005A551ED61CA0A490D45@AdobeOrg'];

function GetLlmoOpportunityUsageCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-llmo-opportunity-usage',
    name: 'Get LLMO Opportunity Usage',
    description: 'Retrieves LLMO opportunity usage statistics for all llmo enabled sites or a specific site by ID/URL',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} [siteId|baseURL]`,
  });

  const { dataAccess, log } = context;
  const { Site, Organization, Opportunity } = dataAccess;

  const countLlmoOpportunities = async (siteId) => {
    const opportunities = await Opportunity.allBySiteId(siteId);

    // Filter opportunities that have 'isElmo' tag
    const llmoOpportunities = opportunities.filter((opportunity) => {
      const tags = opportunity.getTags() || [];
      return tags.includes('isElmo');
    });

    return llmoOpportunities.length;
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const [siteInput] = args;

    try {
      let sites = [];

      if (siteInput) {
        await say(`🔍 Fetching LLMO opportunity usage for site: ${siteInput}...`);
        const baseURL = extractURLFromSlackInput(siteInput);
        const site = isValidUrl(baseURL)
          ? await Site.findByBaseURL(baseURL)
          : await Site.findById(siteInput);

        if (!site) {
          await say(`❌ Site not found: ${siteInput}`);
          return;
        }
        sites = [site];
      } else {
        await say('🔍 Fetching all LLMO-enabled sites...');
        // All sites with LLMO
        const allSites = await Site.all();
        sites = allSites.filter((site) => site.getConfig()?.getLlmoConfig());
      }

      if (sites.length === 0) {
        await say('No LLMO-enabled sites found.');
        return;
      }

      const sitePromises = sites.map(async (site) => {
        try {
          const totalOpportunities = await countLlmoOpportunities(site.getId());

          const organization = await Organization.findById(site.getOrganizationId());
          const imsOrgId = organization?.getImsOrgId();
          const rawOrgName = organization?.getName() || 'N/A';
          // Sanitize org name by removing/replacing control characters and normalizing whitespace
          const imsOrgName = rawOrgName
            .replace(/[\r\n\t\v\f]/g, ' ') // Replace control characters with space
            .replace(/\s+/g, ' ') // Normalize multiple spaces to single space
            .trim();

          // Skip excluded IMS orgs
          if (EXCLUDED_IMS_ORGS.includes(imsOrgId)) {
            log.info(`Skipping excluded IMS org: ${imsOrgId} for site: ${site.getBaseURL()}`);
            return null;
          }

          return {
            baseURL: site.getBaseURL(),
            siteId: site.getId(),
            organizationId: site.getOrganizationId(),
            imsOrgName,
            imsOrgId,
            totalOpportunities,
          };
        } catch (siteError) {
          log.warn(`Failed to process site ${site.getId()}: ${siteError.message}`);
          return null;
        }
      });

      const siteResults = await Promise.allSettled(sitePromises);
      const results = siteResults
        .map((result) => (result.status === 'fulfilled' ? result.value : null))
        .filter(Boolean)
        .sort((a, b) => a.baseURL.localeCompare(b.baseURL));

      if (results.length === 0) {
        await say('No LLMO opportunities found.');
        return;
      }

      // Generate and send CSV
      const csvStringifier = createObjectCsvStringifier({
        header: [
          { id: 'baseURL', title: 'Site URL' },
          { id: 'siteId', title: 'Site ID' },
          { id: 'organizationId', title: 'Organization ID' },
          { id: 'imsOrgName', title: 'IMS Org Name' },
          { id: 'imsOrgId', title: 'IMS Org ID' },
          { id: 'totalOpportunities', title: 'Total LLMO Opportunities' },
        ],
      });

      const csv = csvStringifier.getHeaderString() + csvStringifier.stringifyRecords(results);
      const csvBuffer = Buffer.from(csv, 'utf8');
      const filename = `llmo-opportunity-usage-${Date.now()}.csv`;

      await sendFile(slackContext, csvBuffer, filename);
      log.info(`LLMO opportunity usage completed: ${results.length} sites processed`);
    } catch (error) {
      log.error(`Error in LLMO opportunity usage: ${error.message}`);
      await say(`❌ Error: ${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default GetLlmoOpportunityUsageCommand;
