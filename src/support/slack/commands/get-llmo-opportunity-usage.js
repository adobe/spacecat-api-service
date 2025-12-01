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
import { LLMO_INTERNAL_IMS_ORGS } from './get-prompt-usage.js';

const PHRASES = ['get-llmo-opportunity-usage'];
const LLMO_SHEETDATA_SOURCE_URL = 'https://main--project-elmo-ui-data--adobe.aem.live';
const FETCH_TIMEOUT_MS = 30000; // 30 seconds timeout for external API calls
const MAX_CONCURRENT_SITES = 5; // Limit concurrent site processing to prevent timeouts

/**
 * Process promises in batches with controlled concurrency
 * Pattern from llmo-query-handler.js to prevent resource contention
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function to process each item
 * @param {number} concurrency - Maximum number of concurrent operations
 * @returns {Promise<Array>} - Results array
 */
const processBatch = async (items, fn, concurrency) => {
  const results = [];
  const executing = [];

  for (const item of items) {
    const promise = fn(item).then((result) => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });

    results.push(promise);
    executing.push(promise);

    if (executing.length >= concurrency) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
};

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

    // remove the dataFolder prefix from the dataSourcePath
    // for example /a/b/c/d.json becomes c/d.json (removes leading / and first folder)
    const cleanDataSourcePath = dataSourcePath.split('/').slice(2).join('/');

    // Construct the full URL
    const sheetURL = `${dataFolder}/${cleanDataSourcePath}`;
    const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}/${sheetURL}`);

    // Fetch data from the external endpoint with extended timeout
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `token ${env.LLMO_HLX_API_KEY}`,
        'User-Agent': SPACECAT_USER_AGENT,
        'Accept-Encoding': 'br',
      },
      timeout: FETCH_TIMEOUT_MS,
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
  const llmoConfig = site.getConfig()?.getLlmoConfig();
  const dataFolder = llmoConfig?.dataFolder || '';
  // Add dummy prefix matching the dataFolder so it gets stripped correctly
  const data = await fetchLlmoSheetData(site, `/${dataFolder}/query-index.json?limit=1000`, env);
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
    description: 'Retrieves LLMO opportunity usage statistics for all llmo enabled sites, specific site by ID/URL, or by IMS Org ID(s)',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} [siteId|baseURL|imsOrgID(s)|--all] – multiple IMS Org IDs can be comma or space separated`,
  });

  const { dataAccess, log } = context;
  const { Site, Organization, Opportunity } = dataAccess;

  const countLlmoOpportunities = async (siteId) => {
    const opportunities = await Opportunity.allBySiteId(siteId);

    // Filter opportunities that have 'isElmo' tag or are prerender or llm-blocked types
    const llmoOpportunities = opportunities.filter((opportunity) => {
      const tags = [...(opportunity.getTags())];
      const type = opportunity.getType() ?? '';
      return tags.includes('isElmo') || type === 'prerender' || type === 'llm-blocked';
    });

    return llmoOpportunities.length;
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      let sites = [];

      // No arguments - process all LLMO-enabled sites
      if (args.length === 0) {
        await say('🔍 Fetching all LLMO-enabled sites...');
        const allSites = await Site.all();
        sites = allSites.filter((site) => site.getConfig()?.getLlmoConfig());
      } else {
        const [firstArg] = args;

        // Check if it's --all flag
        if (firstArg === '--all') {
          await say('🔍 Fetching all LLMO-enabled sites...');
          const allSites = await Site.all();
          sites = allSites.filter((site) => site.getConfig()?.getLlmoConfig());
        } else if (firstArg.includes('@AdobeOrg')) {
          // IMS Org ID(s) provided
          const imsOrgIds = args
            .flatMap((s) => s.trim().split(/[,\s]+/))
            .filter(Boolean);

          await say(`🔍 Fetching LLMO-enabled sites for ${imsOrgIds.length} IMS Org ID(s)...`);

          const allSitesForOrgs = [];
          for (const imsOrgId of imsOrgIds) {
            try {
              // eslint-disable-next-line no-await-in-loop
              const organization = await Organization.findByImsOrgId(imsOrgId);
              if (!organization) {
                log.warn(`Organization not found for IMS Org ID: ${imsOrgId}`);
                // eslint-disable-next-line no-await-in-loop
                await say(`:warning: Organization not found for IMS Org ID: ${imsOrgId}`);
                // eslint-disable-next-line no-continue
                continue;
              }

              // eslint-disable-next-line no-await-in-loop
              const orgSites = await Site.allByOrganizationId(organization.getId());
              const llmoEnabledSites = orgSites.filter((site) => site.getConfig()?.getLlmoConfig());
              allSitesForOrgs.push(...llmoEnabledSites);

              log.info(`Found ${llmoEnabledSites.length} LLMO-enabled sites for IMS Org ID: ${imsOrgId}`);
            } catch (error) {
              log.warn(`Error fetching sites for IMS Org ID ${imsOrgId}: ${error.message}`);
              // eslint-disable-next-line no-await-in-loop
              await say(`:warning: Error fetching sites for IMS Org ID ${imsOrgId}: ${error.message}`);
            }
          }

          sites = allSitesForOrgs;
        } else {
          // Single site by ID or URL
          const siteInput = firstArg;
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
        }
      }

      if (sites.length === 0) {
        await say('No LLMO-enabled sites found.');
        return;
      }

      await say(`📊 Processing ${sites.length} site(s) with controlled concurrency...`);

      const processSite = async (site) => {
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

          // Skip excluded/internal IMS orgs (non customer facing orgs)
          if (LLMO_INTERNAL_IMS_ORGS.includes(imsOrgId)) {
            log.info(`Skipping excluded/internal IMS org: ${imsOrgId} for site: ${site.getBaseURL()}`);
            return null;
          }
          const containsGeo403 = queryIndex?.data?.some((item) => item.path.includes('agentic-traffic/agentictraffic-errors-403')) || false;
          const containsGeo404 = queryIndex?.data?.some((item) => item.path.includes('agentic-traffic/agentictraffic-errors-404')) || false;
          const containsGeo5xx = queryIndex?.data?.some((item) => item.path.includes('agentic-traffic/agentictraffic-errors-5xx')) || false;
          const socialOpportunities = await getTotalSocialOpportunities(queryIndex, site, env);
          const thirdPartyOpportunities = await getThirdPartyOpportunities(queryIndex, site, env);

          let totalOpportunitiesCount = totalOpportunities;
          if (containsGeo403) {
            totalOpportunitiesCount += 1;
          }
          if (containsGeo404) {
            totalOpportunitiesCount += 1;
          }
          if (containsGeo5xx) {
            totalOpportunitiesCount += 1;
          }
          if (socialOpportunities) {
            totalOpportunitiesCount += socialOpportunities;
          }
          if (thirdPartyOpportunities) {
            totalOpportunitiesCount += thirdPartyOpportunities;
          }

          log.info(`Processed site ${site.getBaseURL()}: ${totalOpportunitiesCount} total opportunities`);

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
            totalOpportunitiesCount,
          };
        } catch (siteError) {
          log.warn(`Failed to process site ${site.getId()}: ${siteError.message}`);
          return null;
        }
      };

      // Process sites with controlled concurrency to prevent resource contention
      const siteResults = await processBatch(sites, processSite, MAX_CONCURRENT_SITES);
      const results = siteResults
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
          { id: 'containsGeo403', title: 'Has Tech GEO 403' },
          { id: 'containsGeo404', title: 'Has Tech GEO 404' },
          { id: 'containsGeo5xx', title: 'Has Tech GEO 5xx' },
          { id: 'totalOpportunities', title: 'Total Spacecat LLMO Opportunities' },
          { id: 'socialOpportunities', title: 'Social Opportunities' },
          { id: 'thirdPartyOpportunities', title: 'Third Party Opportunities' },
          { id: 'totalOpportunitiesCount', title: 'Total Count' },
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
