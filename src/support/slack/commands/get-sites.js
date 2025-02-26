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
import { generateCSVFile, hasText } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';

import { formatLighthouseError, formatScore } from '../../../utils/slack/format.js';
import { postErrorMessage, sendFile, sendMessageBlocks } from '../../../utils/slack/base.js';

const PHRASES = ['get sites', 'get all sites'];
const IMS_ORG_ID_REGEX = /[a-z0-9]{24}@AdobeOrg/i;

/**
 * Formats a list of sites into CSV content.
 *
 * @param {Array} [sites=[]] - The sites to format.
 * @returns {Buffer} - The CSV file buffer.
 */
export function formatSitesToCSV(sites = []) {
  const sitesData = sites.map((site) => {
    const audits = site.getAudits();

    const siteData = {
      'Base URL': site.getBaseURL(),
      'Delivery Type': site.getDeliveryType(),
      'Live Status': site.getIsLive() ? 'Live' : 'Non-Live',
      'Go Live Date': (site.getIsLiveToggledAt() || site.getCreatedAt()).split('T')[0],
      'GitHub URL': site.getGitHubURL() || '',
      'Performance Score': '---',
      'SEO Score': '---',
      'Accessibility Score': '---',
      'Best Practices Score': '---',
      Error: '',
    };

    if (audits.length) {
      const lastAudit = audits[0];

      if (lastAudit.getIsError()) {
        siteData.Error = formatLighthouseError(lastAudit.getAuditResult().runtimeError);
      } else {
        const {
          performance = 0,
          accessibility = 0,
          'best-practices': bestPractices = 0,
          seo = 0,
        } = lastAudit.getScores();
        siteData['Performance Score'] = formatScore(performance);
        siteData['SEO Score'] = formatScore(seo);
        siteData['Accessibility Score'] = formatScore(accessibility);
        siteData['Best Practices Score'] = formatScore(bestPractices);
      }
    }
    return siteData;
  });

  return generateCSVFile(sitesData);
}

/**
 * GetSitesCommand constructor function. Creates an instance of the command for
 * retrieving all sites.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The command object.
 * @constructor
 */
function GetSitesCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-all-sites',
    name: 'Get All Sites',
    description: 'Retrieves all known sites and includes the latest audit scores',
    phrases: PHRASES,
    usageText: `${PHRASES.join(' or ')} [desktop|mobile|all] [live|non-live] [aem_edge|aem_cs|other] [<IMSOrgId>];`,
  });

  const { dataAccess, log } = context;
  const { Organization, Site } = dataAccess;

  async function fetchAndFormatSites(threadTs, filterStatus, psiStrategy, deliveryType, imsOrgId) {
    let sites = [];

    if (imsOrgId !== 'all') {
      const org = await Organization.findByImsOrgId(imsOrgId);
      const organizationId = org?.getId();
      if (!hasText(organizationId)) {
        return {
          textSections: [{
            text: `*No organization found in Spacecat DB with IMS Org ID: "${imsOrgId}"`,
          }],
          additionalBlocks: [],
        };
      }
      sites = await org.getSites();
    } else {
      sites = await Site.allWithLatestAudit(`lhs-${psiStrategy}`, 'asc', deliveryType);
      sites = sites.filter(
        (site) => site.getOrganizationId() !== context.env.ORGANIZATION_ID_FRIENDS_FAMILY,
      );
    }

    if (filterStatus !== 'all') {
      sites = sites.filter((site) => (filterStatus === 'live' ? site.getIsLive() : !site.getIsLive()));
    }

    const totalSites = sites.length;

    if (totalSites === 0) {
      return {
        textSections: [{
          text: `
*No sites found*:
  
PSI Strategy: *${psiStrategy}*
Delivery Type: *${deliveryType}*
IMS Org: ${imsOrgId}'}
`,
        }],
        additionalBlocks: [],
      };
    }

    const textSections = [{
      text: `
*Sites:* ${totalSites} total ${filterStatus} sites

PSI Strategy: *${psiStrategy}*
Delivery Type: *${deliveryType}*
IMS Org: ${imsOrgId}

_Sites are ordered by performance score, then all other scores, ascending._
    `,
    }];

    const csvFile = formatSitesToCSV(sites);

    return {
      textSections,
      csvFile,
    };
  }

  /**
   * Initializes the bot with the necessary action handlers.
   */
  const init = (ctx) => {
    baseCommand.init(ctx);
  };

  /**
   * Execute the command to get all sites. This includes retrieving
   * the sites, formatting the sites, generating the necessary Slack message
   * blocks, and sending the message.
   *
   * @param {Array} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise<void>} A Promise that resolves when the command is executed.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    let filterStatus = 'live';
    let psiStrategy = 'mobile';
    let deliveryType = 'all';
    let imsOrgId = 'all';

    args.forEach((arg) => {
      if (IMS_ORG_ID_REGEX.test(arg)) {
        imsOrgId = arg;
        return;
      }

      switch (arg) {
        case 'all':
          filterStatus = 'all';
          break;
        case 'live':
          filterStatus = 'live';
          break;
        case 'non-live':
          filterStatus = 'non-live';
          break;
        case 'desktop':
          psiStrategy = 'desktop';
          break;
        case 'mobile':
          psiStrategy = 'mobile';
          break;
        case 'aem_edge':
          deliveryType = 'aem_edge';
          break;
        case 'aem_cs':
          deliveryType = 'aem_cs';
          break;
        case 'aem_ams':
          deliveryType = 'aem_ams';
          break;
        case 'other':
          deliveryType = 'other';
          break;
        default:
          break;
      }
    });

    try {
      const {
        textSections,
        csvFile,
      } = await fetchAndFormatSites(
        slackContext.threadTs,
        filterStatus,
        psiStrategy,
        deliveryType,
        imsOrgId,
      );

      const fileName = `sites-${filterStatus}-${psiStrategy}-${deliveryType}-${new Date().toISOString()}.csv`;

      await sendMessageBlocks(say, textSections);
      await sendFile(slackContext, csvFile, fileName);
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  init(context);

  return {
    ...baseCommand,
    handleExecution,
    init,
  };
}

export default GetSitesCommand;
