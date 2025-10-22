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

import { llmoConfig as llmo, isValidUrl } from '@adobe/spacecat-shared-utils';
import { sendFile } from '../../../utils/slack/base.js';
import { createObjectCsvStringifier } from '../../../utils/slack/csvHelper.cjs';
import BaseCommand from './base.js';

const { readConfig } = llmo;

const PHRASES = ['get-llmo-config-summary'];
const EXCLUDED_IMS_ORGS = ['9E1005A551ED61CA0A490D45@AdobeOrg'];

function GetLlmoConfigSummaryCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-llmo-config-summary',
    name: 'Get LLMO Config Summary',
    description: 'Retrieves LLMO configuration statistics for all sites or a specific site by ID/URL',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} [siteId|baseURL]`,
  });

  const { dataAccess, s3, log } = context;
  const { Site, Organization } = dataAccess;

  const getLlmoConfig = async (siteId) => {
    if (!s3 || !s3.s3Client) {
      throw new Error('LLMO config storage is not configured for this environment');
    }

    const { config, exists } = await readConfig(siteId, s3.s3Client, { s3Bucket: s3.s3Bucket });
    return exists ? config : null;
  };

  const calculateStats = (config) => {
    const categories = Object.keys(config.categories || {}).length;
    const topics = Object.keys(config.topics || {}).length;
    const prompts = Object.values(config.topics || {}).reduce(
      (total, topic) => total + (topic.prompts?.length || 0),
      0,
    );
    const brandAliases = config.brands?.aliases?.length || 0;
    const competitors = config.competitors?.competitors?.length || 0;
    const deletedPrompts = Object.keys(config.deleted?.prompts || {}).length;
    const cdnProvider = config.cdnBucketConfig?.cdnProvider || 'N/A';

    return {
      categories, topics, prompts, brandAliases, competitors, deletedPrompts, cdnProvider,
    };
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const [siteInput] = args;

    try {
      let sites = [];

      if (siteInput) {
        await say(`🔍 Fetching LLMO configuration for site: ${siteInput}...`);
        // Single site lookup
        const site = isValidUrl(siteInput)
          ? await Site.findByBaseURL(siteInput)
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
          const config = await getLlmoConfig(site.getId());
          if (!config) return null;

          const stats = calculateStats(config);
          const organization = await Organization.findById(site.getOrganizationId());
          const imsOrgId = organization?.getImsOrgId();

          // Skip excluded IMS orgs
          if (EXCLUDED_IMS_ORGS.includes(imsOrgId)) {
            log.info(`Skipping excluded IMS org: ${imsOrgId} for site: ${site.getBaseURL()}`);
            return null;
          }

          return {
            baseURL: site.getBaseURL(),
            siteId: site.getId(),
            organizationId: site.getOrganizationId(),
            imsOrgId,
            ...stats,
          };
        } catch (siteError) {
          log.warn(`Failed to process site ${site.getId()}: ${siteError.message}`);
          return null;
        }
      });

      const siteResults = await Promise.allSettled(sitePromises);
      const results = siteResults
        .map((result) => (result.status === 'fulfilled' ? result.value : null))
        .filter(Boolean);

      if (results.length === 0) {
        await say('No valid LLMO configurations found.');
        return;
      }

      // Generate and send CSV
      const csvStringifier = createObjectCsvStringifier({
        header: [
          { id: 'baseURL', title: 'Site URL' },
          { id: 'siteId', title: 'Site ID' },
          { id: 'organizationId', title: 'Organization ID' },
          { id: 'imsOrgId', title: 'IMS Org ID' },
          { id: 'categories', title: 'Categories' },
          { id: 'topics', title: 'Topics' },
          { id: 'prompts', title: 'Prompts' },
          { id: 'brandAliases', title: 'Brand Aliases' },
          { id: 'competitors', title: 'Competitors' },
          { id: 'deletedPrompts', title: 'Deleted Prompts' },
          { id: 'cdnProvider', title: 'CDN Provider' },
        ],
      });

      const csv = csvStringifier.getHeaderString() + csvStringifier.stringifyRecords(results);
      const csvBuffer = Buffer.from(csv, 'utf8');
      const filename = `llmo-config-summary-${Date.now()}.csv`;

      await sendFile(slackContext, csvBuffer, filename);
      log.info(`LLMO config summary completed: ${results.length} sites processed`);
    } catch (error) {
      log.error(`Error in LLMO config summary: ${error.message}`);
      await say(`❌ Error: ${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default GetLlmoConfigSummaryCommand;
