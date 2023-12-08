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

import { formatDate, formatScore, printSiteDetails } from '../../../utils/slack/format.js';
import { extractBaseURLFromInput, sendMessageBlocks, postErrorMessage } from '../../../utils/slack/base.js';

const BACKTICKS = '```';
const CHARACTER_LIMIT = 2500;
const PHRASES = ['get site', 'get domain'];

/**
 * Formats a single row of the table, padding each cell according to the column widths.
 *
 * @param {Array<string>} row - An array of strings, each representing a cell in the row.
 * @param {Array<number>} columnWidths - An array of numbers, each representing the
 * maximum width of a column.
 * @param {Array<string>} headers - An array of strings, each representing a header in the table.
 * @returns {string} The formatted row.
 */
function formatRows(row, columnWidths, headers) {
  return row.map((cell, i) => {
    const cellStr = cell || '';
    // If the row has fewer columns than headers, pad the last cell to fill the remaining space
    const padding = (row.length < headers.length && i === row.length - 1)
      ? columnWidths.slice(i).reduce((a, b) => a + b, 0) : columnWidths[i];
    return cellStr.padEnd(padding + (i === 0 ? 0 : 2));
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
function formatAudits(audits) {
  if (!audits || !audits.length) {
    return 'No audit history available';
  }

  const headers = ['Audited At (UTC)', 'Perf.', 'SEO', 'A11y', 'Best Pr.', 'Live'];
  const rows = audits.map((audit) => {
    const { auditedAt, errorMessage, isError } = audit;

    if (isError) {
      return [formatDate(auditedAt), `Error: ${errorMessage}`];
    } else {
      const {
        performance, seo, accessibility, bestPractices,
      } = audit.getScores();
      return [
        formatDate(auditedAt),
        formatScore(performance),
        formatScore(seo),
        formatScore(accessibility),
        formatScore(bestPractices),
        audit.isLive() ? 'Yes' : 'No',
      ];
    }
  });

  const table = [headers, ...rows];
  const columnWidths = table.reduce((widths, row) => {
    const rowLength = row.length;
    return row.map((cell, i) => {
      const currentWidth = widths[i] || 0;
      const isColspanCase = rowLength === 2 && i !== 0;
      const colSpan = isColspanCase ? headers.length - 1 : 1;

      if (isColspanCase && i !== 0) {
        return currentWidth;
      }

      return Math.max(currentWidth, cell.length / colSpan);
    });
  }, []);

  const formattedTable = `${BACKTICKS}\n${table.map((row) => formatRows(row, columnWidths, headers)).join('\n')}\n${BACKTICKS}`;

  // Ensure the formattedTable string does not exceed the Slack message character limit.
  return formattedTable.length > CHARACTER_LIMIT ? `${formattedTable.slice(0, CHARACTER_LIMIT)}...` : formattedTable;
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
    id: 'get-franklin-site-status',
    name: 'Get Franklin Site Status',
    description: 'Retrieves audit status for a Franklin site by a given domain',
    phrases: PHRASES,
    usageText: `${PHRASES.join(' or ')} {domain} [desktop|mobile];`,
  });

  const { dataAccess } = context;

  /**
   * Executes the GetSiteCommand. Retrieves the audit status for a site by
   * a given domain and communicates the status back via the provided say function.
   * If an error occurs during execution, an error message is sent back.
   *
   * @param {Array<string>} args - The arguments provided to the command.
   * @param {Function} say - The function provided by the bot to send messages.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, say) => {
    try {
      const baseURL = extractBaseURLFromInput(args[0], false);
      const psiStrategy = args[1] === 'desktop' ? 'desktop' : 'mobile';

      if (!baseURL) {
        await say(baseCommand.usage());
        return;
      }

      await say(`:hourglass: Retrieving status for domain: ${baseURL}, please wait...`);

      const site = await dataAccess.getSiteByBaseURL(baseURL);

      if (!site) {
        await say(`:warning: No site found with domain: ${baseURL}`);
        return;
      }

      const audits = await dataAccess.getAuditsForSite(site.getId());

      const textSections = [{
        text: `
    *Franklin Site Status* / PSI: ${psiStrategy}:

${printSiteDetails(site)}

    _Audits are sorted by date descending._\n${formatAudits(audits, psiStrategy)}
  `,
      }];

      await sendMessageBlocks(say, textSections);
    } catch (error) {
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
