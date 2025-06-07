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
  addEllipsis,
  formatSize,
  printSiteDetails,
} from '../../../utils/slack/format.js';

const PHRASES = ['get martech impact', 'get third party impact'];

/**
 * Formats a single row of the table, padding each cell according to the column widths.
 *
 * @param {Array<string>} row - An array of strings, each representing a cell in the row.
 * @param {Array<number>} columnWidths - An array of numbers, each representing
 * the maximum width of a column.
 * @returns {string} The formatted row.
 */
export function formatRows(row, columnWidths) {
  return row.map((cell, i) => cell.padEnd(columnWidths[i] + (i === 0 ? 0 : 2))).join('  ');
}

export function formatTotalBlockingTime(totalBlockingTime) {
  const tbt = totalBlockingTime || '_unknown_';
  return `${tbt}`;
}

export function calculateColumnWidths(table, headers) {
  return table.reduce((widths, row) => {
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
}

/**
 * Formats an array of third party sumary into a stringified table format.
 * If summary array is empty, it returns a fallback message. If the formatted
 * table exceeds the character limit, it is sliced and appended
 * with an ellipsis.
 *
 * @param {Array<Object>} summary - An array of third party summary objects.
 * @returns {string} Third party summary formatted into a stringified table or a fallback message.
 */
export function formatThirdPartySummary(summary = []) {
  if (summary.length === 0) {
    return '    _No third party impact detected_';
  }

  const headers = ['Third Party', 'Main Thread', 'Blocking', 'Transfer'];
  const rows = summary.map((thirdParty) => {
    const {
      entity, blockingTime, mainThreadTime, transferSize,
    } = thirdParty;

    return [
      addEllipsis(entity),
      `${Math.round(mainThreadTime)} ms`,
      `${Math.round(blockingTime)} ms`,
      formatSize(transferSize),
    ];
  });

  const table = [headers, ...rows];
  const columnWidths = calculateColumnWidths(table);

  const formattedTable = `${BACKTICKS}\n${table.map((row) => formatRows(row, columnWidths)).join('\n')}\n${BACKTICKS}`;

  // Ensure the formattedTable string does not exceed the Slack message character limit.
  return formattedTable.length > CHARACTER_LIMIT
    ? `${formattedTable.slice(0, CHARACTER_LIMIT - 3)}...`
    : formattedTable;
}

/**
 * Analyzes network requests to identify Adobe Experience Cloud tools.
 *
 * @param {Array<Object>} networkRequests - An array of network request objects.
 * @param {Object} log - The logging object.
 * @returns {Array<Object>} An array of identified Adobe tools with their details.
 */
export function analyzeAdobeTools(networkRequests = [], log = null) {
  const adobeTools = [];
  const toolCounts = new Map();

  // Add null check before forEach
  if (!networkRequests) {
    if (log) log.debug('No network requests provided');
    return adobeTools;
  }

  networkRequests.forEach((request) => {
    const { url, statusCode, priority } = request;
    let toolName = null;

    // Debug logging
    if (log) log.debug('Checking URL:', { url });

    // Adobe Target detection
    if ((url.includes('/delivery') || url.includes('/interact'))
        && (url.startsWith('https://edge.adobedc.net/ee') || url.includes('tt.omtrdc.net'))) {
      toolName = 'Adobe Target';
      if (log) log.debug('Found Adobe Target:', { url });
    } else if (url.includes('.sc.omtrdc.net') || url.includes('2o7.net')
             || (url.includes('/collect') && (url.includes('adobe') || url.includes('analytics')))) {
      // Adobe Analytics detection
      toolName = 'Adobe Analytics';
      if (log) log.debug('Found Adobe Analytics:', { url });
    } else if (url.includes('edge.adobedc.net') || url.includes('.demdex.net')
             || url.includes('alloy.js') || url.includes('alloy.min.js')) {
      // AEP WebSDK detection
      toolName = 'AEP WebSDK';
      if (log) log.debug('Found AEP WebSDK:', { url });
    } else if (url && url.toLowerCase().includes('adobedtm.com')) {
      // Adobe Launch detection - made case insensitive and added null check
      toolName = 'Adobe Launch/Tags';
      if (log) log.debug('Found Adobe Launch:', { url });
    }

    if (toolName) {
      const key = `${toolName}-${statusCode}`;
      if (!toolCounts.has(key)) {
        toolCounts.set(key, {
          tool: toolName,
          statusCode,
          priority,
          requestCount: 0,
        });
      }
      toolCounts.get(key).requestCount += 1;
    }
  });

  // Convert map to array
  toolCounts.forEach((value) => {
    adobeTools.push(value);
  });

  return adobeTools;
}

/**
 * Formats an array of Adobe tools into a stringified table format.
 * If tools array is empty, it returns a fallback message. If the formatted
 * table exceeds the character limit, it is sliced and appended
 * with an ellipsis.
 *
 * @param {Array<Object>} tools - An array of Adobe tool objects.
 * @returns {string} Adobe tools formatted into a stringified table or a fallback message.
 */
export function formatAdobeTools(tools = []) {
  if (tools.length === 0) {
    return '    _No Adobe Experience Cloud tools detected_';
  }

  const headers = ['Tool', 'Status', 'Priority', 'Requests'];
  const rows = tools.map((tool) => {
    const {
      toolName, statusCode, priority, requestCount,
    } = tool;

    return [
      toolName,
      `${statusCode}`,
      priority || 'N/A',
      `${requestCount}`,
    ];
  });

  const table = [headers, ...rows];
  const columnWidths = calculateColumnWidths(table);

  const formattedTable = `${BACKTICKS}\n`
    + `${table.map((row) => formatRows(row, columnWidths)).join('\n')}`
    + `\n${BACKTICKS}`;

  // Ensure the formattedTable string does not exceed the Slack message character limit.
  return formattedTable.length > CHARACTER_LIMIT
    ? `${formattedTable.slice(0, CHARACTER_LIMIT - 3)}...`
    : formattedTable;
}

/**
 * A factory function that creates an instance of the MartechImpactCommand.
 *
 * @param {Object} context The context object.
 * @returns {MartechImpactCommand} An instance of the GetSiteCommand.
 * @constructor
 */
function MartechImpactCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-site-martech-impact',
    name: 'Get Martech Impact for a site',
    description: 'Retrieves tbt and third party summary for a site by a given site',
    phrases: PHRASES,
    usageText: `${PHRASES.join(' or ')} {baseURL};`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  /**
   * Executes the MartechImpactCommand. Retrieves the last tbt and third party
   * summary audit status for a site by a given base URL and communicates the status
   * back via the provided say function. If an error occurs during execution, an
   * error message is sent back.
   *
   * @param {Array<string>} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [baseURLInput] = args;
      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!baseURL) {
        await say(baseCommand.usage());
        return;
      }

      const site = await Site.findByBaseURL(baseURL);

      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const latestAudit = await site.getLatestAuditByAuditType('lhs-mobile');

      if (!latestAudit) {
        await say(`:warning: No audit found for site: ${baseURL}`);
        return;
      }

      const auditResult = latestAudit.getAuditResult();
      const { totalBlockingTime, thirdPartySummary, networkRequests } = auditResult;

      const adobeTools = analyzeAdobeTools(networkRequests, log);

      const textSections = [{
        text: `
*Martech Impact for ${site.getBaseURL()}*

${printSiteDetails(site)}

*Total Blocking Time (TBT):*\t${formatTotalBlockingTime(totalBlockingTime)}

*Third Party Summary:*\n${formatThirdPartySummary(thirdPartySummary)}

*Adobe Experience Cloud Tools:*\n${formatAdobeTools(adobeTools)}
  `,
      }];

      await sendMessageBlocks(say, textSections);
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

export default MartechImpactCommand;
