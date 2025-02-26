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

import {
  BACKTICKS,
  CHARACTER_LIMIT,
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
  sendMessageBlocks,
} from '../../../utils/slack/base.js';
import {
  formatDate,
  formatLighthouseError,
  formatScore,
  printSiteDetails,
} from '../../../utils/slack/format.js';

const PHRASES = ['get site', 'get baseURL'];

/**
 * Formats a single row of the table, padding each cell according to the column widths.
 *
 * @param {Array<string>} row - An array of strings, each representing a cell in the row.
 * @returns {string} The formatted row.
 */
export function formatRows(row) {
  return row.map((cell, i) => {
    const cellStr = cell || '';
    return cellStr.padEnd(2 + (i === 0 ? 0 : 2));
  }).join('  ');
}

/**
 * Formats an array of audits into a stringified table format. If audits are
 * not provided or the array is empty, it returns a fallback message. If the
 * formatted table exceeds the character limit, it is sliced and appended with an ellipsis.
 *
 * @param {Array<Audit>} audits - An array of audit objects.
 * @returns {string} The audits formatted into a stringified table or a fallback message.
 */
export function formatAudits(audits) {
  if (!audits || !audits.length) {
    return 'No audit history available';
  }

  const headers = ['Audited At (UTC)', 'Perf', 'SEO', 'A11y', 'Best Pr.', 'Live'];
  const rows = audits.map((audit) => {
    const {
      performance, seo, accessibility, 'best-practices': bestPractices,
    } = audit.getScores();

    if (!audit.getIsError()) {
      return [
        formatDate(audit.getAuditedAt()),
        formatScore(performance),
        formatScore(seo),
        formatScore(accessibility),
        formatScore(bestPractices),
        audit.getIsLive() ? 'Yes' : 'No',
      ];
    } else {
      return [
        formatDate(audit.getAuditedAt()),
        formatLighthouseError(audit.getAuditResult().runtimeError),
      ];
    }
  });

  const table = [headers, ...rows];
  const formattedTable = `${BACKTICKS}\n${table.map((row) => formatRows(row, headers)).join('\n')}\n${BACKTICKS}`;

  // Ensure the formattedTable string does not exceed the Slack message character limit.
  return formattedTable.length > CHARACTER_LIMIT ? `${formattedTable.slice(0, CHARACTER_LIMIT - 3)}...` : formattedTable;
}

/**
 * A factory function that creates an instance of the GetSiteCommand.
 *
 * @param {object} context - The context object.
 * @returns {GetSiteCommand} An instance of the GetSiteCommand.
 * @constructor
 */
function GetSiteCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-site-status',
    name: 'Get Site Status',
    description: 'Retrieves audit status for a site by a given base URL',
    phrases: PHRASES,
    usageText: `${PHRASES.join(' or ')} {baseURL} [desktop|mobile];`,
  });

  const { dataAccess, log } = context;
  const { Configuration, Site } = dataAccess;

  /**
   * Executes the GetSiteCommand. Retrieves the audit status for a site by
   * a given base URL and communicates the status back via the provided say function.
   * If an error occurs during execution, an error message is sent back.
   *
   * @param {Array<string>} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [baseURLInput, psiStrategyInput] = args;

      const baseURL = extractURLFromSlackInput(baseURLInput);
      const psiStrategy = psiStrategyInput === 'desktop' ? 'desktop' : 'mobile';

      if (!baseURL) {
        await say(baseCommand.usage());
        return;
      }

      const site = await Site.findByBaseURL(baseURL);

      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const auditType = `lhs-${psiStrategy}`;
      const audits = await site.getAuditsByAuditType(auditType);
      const configuration = await Configuration.findLatest();
      const isAuditEnabled = configuration.isHandlerEnabledForSite(auditType, site);
      const latestAudit = audits.length > 0 ? audits[0] : null;

      const textSections = [{
        text: `
*Site Status for ${site.getBaseURL()}*
${printSiteDetails(site, isAuditEnabled, psiStrategy, latestAudit)}

_Audits of *${psiStrategy}* strategy, sorted by date descending:_
${formatAudits(audits)}
  `,
      }];

      await sendMessageBlocks(say, textSections, [], { unfurl_links: false });
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default GetSiteCommand;
