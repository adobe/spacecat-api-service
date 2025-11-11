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

import { isValidUrl, SPACECAT_USER_AGENT, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import { sendFile, extractURLFromSlackInput } from '../../../utils/slack/base.js';
import { createObjectCsvStringifier } from '../../../utils/slack/csvHelper.cjs';
import BaseCommand from './base.js';

const PHRASES = ['get-llmo-opportunity-usage'];
const EXCLUDED_IMS_ORGS = ['9E1005A551ED61CA0A490D45@AdobeOrg'];
const LLMO_SHEETDATA_SOURCE_URL = 'https://main--project-elmo-ui-data--adobe.aem.live';

/**
 * Fetches LLMO sheet data for a given site and data source path.
 * Returns null if the site doesn't have LLMO enabled or the fetch fails.
 * @returns {Promise<Object>} The fetched sheet data
 */
async function fetchLlmoSheetData(site, dataSourcePath, env) {
  try {
    const llmoConfig = site.getConfig()?.getLlmoConfig();

    if (!llmoConfig) {
      return null;
    }

    const { dataFolder } = llmoConfig;
    if (!dataFolder) {
      return null;
    }

    // Construct the full URL
    const sheetURL = `${dataFolder}/${dataSourcePath}`;
    const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}/${sheetURL}`);

    // Fetch data from the external endpoint
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `token ${env.LLMO_HLX_API_KEY || 'hlx_api_key_missing'}`,
        'User-Agent': SPACECAT_USER_AGENT,
        'Accept-Encoding': 'br',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data;
  } catch (error) {
    return null;
  }
}

/**
 * get the query index for a given site
 * @param {Object} site - The site object to get the query index for
 * @param {Object} env - The environment object
 * @returns {Promise<Object>} The query index
 */
async function getQueryIndex(site, env) {
  const data = await fetchLlmoSheetData(site, 'query-index.json?limit=1000', env);
  if (!data) {
    return null;
  }
  return data;
}

/**
 * get the total number of social opportunities for a given site
 * @param {Object} queryIndex - The query index object
 * @param {Object} site - The site object
 * @param {Object} env - The environment
 * @returns {Promise<number>} The total number of social opportunities
 */
async function getTotalSocialOpportunities(queryIndex, site, env) {
  if (!queryIndex) {
    return 0;
  }
  const allSocialPaths = queryIndex?.data?.filter((item) => item.path.includes('brandpresence-social')) || [];
  // for each social path, fetch the data from the external endpoint
  const socialData = await Promise.all(allSocialPaths.map(async (item) => {
    const data = await fetchLlmoSheetData(site, `${item.path}?limit=1000`, env);
    return data?.data?.length ?? 0;
  }));
  return socialData.reduce((acc, curr) => acc + curr, 0);
}

async function getThirdPartyOpportunities(queryIndex, site, env) {
  if (!queryIndex) {
    return 0;
  }
  const all3rdPartyPaths = queryIndex?.data?.filter((item) => item.path.includes('brandpresence-3rdparty')) || [];
  // for each social path, fetch the data from the external endpoint
  const thirdPartyData = await Promise.all(all3rdPartyPaths.map(async (item) => {
    const data = await fetchLlmoSheetData(site, `${item.path}?limit=1000`, env);
    return data?.data?.length ?? 0;
  }));
  return thirdPartyData.reduce((acc, curr) => acc + curr, 0);
}

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
          const { env } = context;
          const totalOpportunities = await countLlmoOpportunities(site.getId());
          const queryIndex = await getQueryIndex(site, env);

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
          const containsGeo403 = queryIndex?.data?.some((item) => item.path.includes('agentic-traffic/agentictraffic-errors-403'));
          const containsGeo404 = queryIndex?.data?.some((item) => item.path.includes('agentic-traffic/agentictraffic-errors-404'));
          const containsGeo5xx = queryIndex?.data?.some((item) => item.path.includes('agentic-traffic/agentictraffic-errors-5xx'));
          const socialOpportunities = await getTotalSocialOpportunities(queryIndex, site, env);
          const thirdPartyOpportunities = await getThirdPartyOpportunities(queryIndex, site, env);

          return {
            baseURL: site.getBaseURL(),
            siteId: site.getId(),
            organizationId: site.getOrganizationId(),
            imsOrgName,
            imsOrgId,
            totalOpportunities,
            containsGeo403,
            containsGeo404,
            containsGeo5xx,
            socialOpportunities,
            thirdPartyOpportunities,
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
          { id: 'containsGeo403', title: 'Contains Technical GEO 403' },
          { id: 'containsGeo404', title: 'Contains Technical GEO 404' },
          { id: 'containsGeo5xx', title: 'Contains Technical GEO 5xx' },
          { id: 'totalOpportunities', title: 'Total Spacecat LLMO Opportunities' },
          { id: 'socialOpportunities', title: 'Social Opportunities' },
          { id: 'thirdPartyOpportunities', title: 'Third Party Opportunities' },
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

export {
  fetchLlmoSheetData,
  getQueryIndex,
  getTotalSocialOpportunities,
  getThirdPartyOpportunities,
};
export default GetLlmoOpportunityUsageCommand;
