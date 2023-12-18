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

import { formatLighthouseError, formatScore, formatURL } from '../../../utils/slack/format.js';
import { sendMessageBlocks, postErrorMessage, wrapSayForThread } from '../../../utils/slack/base.js';

const PAGE_SIZE = 10;
const PHRASES = ['get sites', 'get all sites'];

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
 * @returns {string} The formatted sites message.
 */
// eslint-disable-next-line default-param-last
export function formatSites(sites = [], start, end) {
  return sites.slice(start, end).reduce((message, site, index) => {
    const baseURL = site.getBaseURL();
    const baseURLText = baseURL.replace(/^main--/, '').replace(/--.*/, '');
    const rank = start + index + 1;

    let siteMessage = `${rank}. No audits found for ${baseURLText}`;
    const audits = site.getAudits();

    if (audits.length) {
      const lastAudit = audits[0];
      const icon = site.isLive() ? ':rocket:' : ':submarine:';

      const scores = lastAudit.getScores();
      const {
        performance = 0,
        accessibility = 0,
        'best-practices': bestPractices = 0,
        seo = 0,
      } = scores;

      if (lastAudit.isError()) {
        siteMessage = `${rank}. ${icon} ${formatLighthouseError(lastAudit.getAuditResult().runtimeError)}: <${formatURL(baseURL)}|${baseURLText}>`;
      } else {
        siteMessage = `${rank}. ${icon} ${formatScore(performance)} - ${formatScore(seo)} - ${formatScore(accessibility)} - ${formatScore(bestPractices)}: <${formatURL(baseURL)}|${baseURLText}>`;
      }
      siteMessage += site.getGitHubURL() ? ` (<${site.getGitHubURL()}|GH>)` : '';
    }

    return `${message}\n${siteMessage.trim()}`;
  }, '');
}

/**
 * Generate pagination blocks for a Slack message. The pagination blocks
 * include buttons for the previous page, next page, and specific pages.
 * The pagination blocks also include the thread timestamp to use for the
 * pagination actions. The pagination actions are handled by the
 * paginationHandler function.
 *
 * @param {string} threadTs - The thread timestamp to use for the pagination actions.
 * @param {number} start - The index to start the page.
 * @param {number} end - The index to end the page.
 * @param {number} totalSites - The total number of sites.
 * @param {string} filterStatus - The status to filter sites by.
 * @param {string} psiStrategy - The strategy to show scores of.
 * @returns {Object} The pagination blocks object.
 */
function generatePaginationBlocks(
  threadTs,
  start,
  end,
  totalSites,
  filterStatus,
  psiStrategy = 'mobile',
) {
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

  // Modify each block to include thread_ts in the value
  blocks.forEach((block) => {
    // eslint-disable-next-line no-param-reassign
    block.value += `:${threadTs}`;
  });

  return {
    type: 'actions',
    elements: blocks,
  };
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

  async function fetchAndFormatSites(threadTs, start, filterStatus, psiStrategy) {
    let sites = await dataAccess.getSitesWithLatestAudit(`lhs-${psiStrategy}`);

    if (filterStatus !== 'all') {
      sites = sites.filter((site) => (filterStatus === 'live' ? site.isLive() : !site.isLive()));
    }

    const end = start + PAGE_SIZE;
    const totalSites = sites.length;

    const textSections = [{
      text: `
    *Franklin Sites Status:* ${totalSites} total ${filterStatus} sites / PSI: ${psiStrategy}

    Columns: Rank: (Live-Status) Performance - SEO - Accessibility - Best Practices >> Base URL

    _Sites are ordered by performance score, then all other scores, ascending._
    ${formatSites(sites, start, end)}
    `,
      accessory: generateOverflowAccessory(),
    }];

    const additionalBlocks = [
      generatePaginationBlocks(threadTs, start, end, totalSites, filterStatus, psiStrategy),
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

    const [newStart, filterStatus, psiStrategy, threadTs] = action.value.split(':');
    const threadedSay = wrapSayForThread(say, threadTs);
    const start = parseInt(newStart, 10);

    try {
      const {
        textSections,
        additionalBlocks,
      } = await fetchAndFormatSites(threadTs, start, filterStatus, psiStrategy);
      await sendMessageBlocks(threadedSay, textSections, additionalBlocks);
    } catch (error) {
      await postErrorMessage(threadedSay, error);
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

    if (!ctx.boltApp?.action) {
      return;
    }

    ctx.boltApp.action(/^paginate_sites_(prev|next|page_\d+)$/, paginationHandler);
  };

  /**
   * Execute the command to get all Franklin sites. This includes retrieving
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
      } = await fetchAndFormatSites(slackContext.threadTs, 0, filterStatus, psiStrategy);

      await sendMessageBlocks(say, textSections, additionalBlocks);
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  init(context);

  return {
    ...baseCommand,
    handleExecution,
    paginationHandler, // for testing
    init,
  };
}

export default GetSitesCommand;
