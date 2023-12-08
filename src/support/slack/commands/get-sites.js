/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import BaseCommand from './base.js';

import { extractAuditScores } from '../../../utils/slack/audit.js';
import { formatScore, formatURL } from '../../../utils/slack/format.js';
import { sendMessageBlocks, postErrorMessage } from '../../../utils/slack/base.js';

const PAGE_SIZE = 10;
const PHRASES = ['get sites', 'get all sites'];
const EXPORT_FORMATS = {
  CSV: 'csv',
  XLSX: 'xlsx',
};

/**
 * Generate an overflow accessory object for a Slack message.
 *
 * @returns {Object} The overflow accessory object.
 */
function generateOverflowAccessory() {
  return {
    type: 'overflow',
    options: [
      {
        text: {
          type: 'plain_text',
          text: ':page_facing_up: Download as CSV',
          emoji: true,
        },
        value: 'csv',
      },
      {
        text: {
          type: 'plain_text',
          text: ':excel: Download as XLS',
          emoji: true,
        },
        value: 'xlsx',
      },
    ],
    action_id: 'sites_overflow_action',
  };
}

/**
 * Format a list of sites for output.
 *
 * @param {Array} [sites=[]] - The sites to format.
 * @param {number} start - The index to start slicing the array.
 * @param {number} end - The index to end slicing the array.
 * @param {string} psiStrategy - The strategy to show scores of.
 * @returns {string} The formatted sites message.
 */
// eslint-disable-next-line default-param-last
function formatSites(sites = [], start, end, psiStrategy = 'mobile') {
  return sites.slice(start, end).reduce((message, site, index) => {
    const { domain } = site;
    const domainText = domain.replace(/^main--/, '').replace(/--.*/, '');
    const rank = start + index + 1;

    let siteMessage = `${rank}. No audits found for ${domainText}`;
    const { lastAudit } = site;

    if (lastAudit) {
      const icon = site.isLive ? ':rocket:' : ':submarine:';

      if (!lastAudit.isError) {
        const scores = extractAuditScores(lastAudit, psiStrategy);
        const {
          performance = 0, accessibility = 0, bestPractices = 0, seo = 0,
        } = scores;

        siteMessage = `${rank}. ${icon} ${formatScore(performance)} - ${formatScore(seo)} - ${formatScore(accessibility)} - ${formatScore(bestPractices)}: <${formatURL(domain)}|${domainText}>`;
        siteMessage += site.gitHubURL ? ` (<${site.gitHubURL}|GH>)` : '';
      } else {
        siteMessage = `${rank}. ${icon} :warning: audit error (site has 404 or other): <${formatURL(domain)}|${domain}>`;
      }
    }

    return `${message}\n${siteMessage.trim()}`;
  }, '');
}

/**
 * Generate pagination blocks for a Slack message.
 *
 * @param {number} start - The index to start the page.
 * @param {number} end - The index to end the page.
 * @param {number} totalSites - The total number of sites.
 * @param {string} filterStatus - The status to filter sites by.
 * @param {string} psiStrategy - The strategy to show scores of.
 * @returns {Object} The pagination blocks object.
 */
function generatePaginationBlocks(start, end, totalSites, filterStatus, psiStrategy = 'mobile') {
  const blocks = [];
  const numberOfPages = Math.ceil(totalSites / PAGE_SIZE);

  // add 'Previous' button if not on first page
  if (start > 0) {
    blocks.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: 'Previous',
      },
      value: `${String(start - PAGE_SIZE)}:${filterStatus}:${psiStrategy}`,
      action_id: 'paginate_sites_prev',
    });
  }

  // add numbered page buttons
  for (let i = 0; i < numberOfPages; i += 1) {
    const pageStart = i * PAGE_SIZE;
    blocks.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: `${i + 1}`,
      },
      value: `${String(pageStart)}:${filterStatus}:${psiStrategy}`,
      action_id: `paginate_sites_page_${i + 1}`,
    });
  }

  // add 'Next' button if not on last page
  if (end < totalSites) {
    blocks.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: 'Next',
      },
      value: `${String(start + PAGE_SIZE)}:${filterStatus}:${psiStrategy}`,
      action_id: 'paginate_sites_next',
    });
  }

  return {
    type: 'actions',
    elements: blocks,
  };
}

/**
 * Handler for the overflow action, which allows for downloading the
 * list of sites in different formats.
 *
 * @param {Object} param0 - The object containing the body, acknowledgement function
 * (ack), client, and say function.
 */
async function overflowActionHandler({
  body, ack, client, say,
}) {
  await ack();

  const selectedOption = body.actions?.[0]?.selected_option?.value;

  if (!selectedOption) {
    await say(`:nuclear-warning: Oops! No format selected. Please select either '${EXPORT_FORMATS.CSV}' or '${EXPORT_FORMATS.XLSX}'.`);
    return;
  }

  if (selectedOption !== EXPORT_FORMATS.CSV && selectedOption !== EXPORT_FORMATS.XLSX) {
    await say(`:nuclear-warning: Oops! The selected format '${selectedOption}' is not supported. Please select either '${EXPORT_FORMATS.CSV}' or '${EXPORT_FORMATS.XLSX}'.`);
    return;
  }

  await say(':hourglass: Preparing the requested export for you, please wait...');

  try {
    let fileBuffer;
    // TODO: add exporters
    if (selectedOption === EXPORT_FORMATS.CSV) {
      // fileBuffer = await exporters.exportSitesToCSV();
    } else if (selectedOption === EXPORT_FORMATS.XLSX) {
      // fileBuffer = await exporters.exportSitesToExcel();
    }

    await client.files.uploadV2({
      channels: body.channel.id,
      file: fileBuffer,
      filename: `franklin-site-status.${selectedOption}`,
      title: `Franklin Site Status Export (${selectedOption.toUpperCase()})`,
      initial_comment: ':tada: Here is an export of all sites and their audit scores.',
    });
  } catch (error) {
    await postErrorMessage(say, error);
  }
}

/**
 * GetSitesCommand constructor function. Creates an instance of the command for
 * retrieving all Franklin sites.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The command object.
 * @constructor
 */
function GetSitesCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-all-franklin-sites',
    name: 'Get All Franklin Sites',
    description: 'Retrieves all known franklin sites and includes the latest audit scores',
    phrases: PHRASES,
    usageText: `${PHRASES.join(' or ')} [desktop|mobile|all|live|non-live];`,
  });

  const { dataAccess, log } = context;

  async function fetchAndFormatSites(start, filterStatus, psiStrategy) {
    let sites = await dataAccess.getSitesWithLatestAudit(`lhs-${psiStrategy}`);

    if (filterStatus !== 'all') {
      sites = sites.filter((site) => (filterStatus === 'live' ? site.isLive() : !site.isLive()));
    }

    const end = start + PAGE_SIZE;
    const totalSites = sites.length;

    const textSections = [{
      text: `
    *Franklin Sites Status:* ${totalSites} total ${filterStatus} sites / PSI: ${psiStrategy}

    Columns: Rank: (Live-Status) Performance - SEO - Accessibility - Best Practices >> Domain

    _Sites are ordered by performance score, then all other scores, ascending._
    ${formatSites(sites, start, end, psiStrategy)}
    `,
      accessory: generateOverflowAccessory(),
    }];

    const additionalBlocks = [
      generatePaginationBlocks(start, end, totalSites, filterStatus, psiStrategy),
    ];

    return { textSections, additionalBlocks };
  }

  /**
   * Handler for the pagination actions (previous page, next page, or specific page).
   *
   * @param {Object} param0 - The object containing the acknowledgement
   * function (ack), say function, and action.
   */
  const paginationHandler = async ({ ack, say, action }) => {
    log.info(`Pagination request received for get sites. Page: ${action.value}`);

    const startTime = process.hrtime();

    await ack();

    const [newStart, filterStatus, psiStrategy] = action.value.split(':');
    const start = parseInt(newStart, 10);

    try {
      const {
        textSections,
        additionalBlocks,
      } = await fetchAndFormatSites(start, filterStatus, psiStrategy);
      await sendMessageBlocks(say, textSections, additionalBlocks);
    } catch (error) {
      await postErrorMessage(say, error);
    }

    const endTime = process.hrtime(startTime);
    const elapsedTime = (endTime[0] + endTime[1] / 1e9).toFixed(2);

    log.info(`Pagination request processed in ${elapsedTime} seconds`);
  };

  /**
   * Initializes the bot with the necessary action handlers.
   */
  const init = (ctx) => {
    baseCommand.init(ctx);

    ctx.boltApp.action('sites_overflow_action', overflowActionHandler);
    ctx.boltApp.action(/^paginate_sites_(prev|next|page_\d+)$/, paginationHandler);
    ctx.boltApp.action('reply_in_thread');
  };

  /**
   * Execute the command to get all Franklin sites. This includes retrieving
   * the sites, formatting the sites, generating the necessary Slack message
   * blocks, and sending the message.
   *
   * @param {Array} args - The arguments provided to the command.
   * @param {function} say - The function to send a message to Slack.
   * @returns {Promise<void>} A Promise that resolves when the command is executed.
   */
  const handleExecution = async (args, say) => {
    await say(':hourglass: Retrieving all sites, please wait...');

    let filterStatus = 'live';
    let psiStrategy = 'mobile';

    args.forEach((arg) => {
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
        default:
          break;
      }
    });

    try {
      const {
        textSections,
        additionalBlocks,
      } = await fetchAndFormatSites(0, filterStatus, psiStrategy);

      await sendMessageBlocks(say, textSections, additionalBlocks);
    } catch (error) {
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
