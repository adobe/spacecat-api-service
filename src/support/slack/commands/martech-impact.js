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
} from '../../../utils/slack/base.js';
import {
  addEllipsis,
  formatSize,
} from '../../../utils/slack/format.js';

const PHRASES = ['get martech impact', 'get third party impact'];

/**
 * Finds a network request that matches the given URL pattern
 * @param {Array<Object>} networkRequests - Array of network requests
 * @param {string} urlPattern - URL pattern to match
 * @returns {Object|null} Matching network request or null if not found
 */
export function findNetworkRequestDetails(networkRequests = [], urlPattern = '') {
  if (!networkRequests || !urlPattern) return null;
  return networkRequests.find((request) => {
    if (!request || !request.url) return false;
    const requestUrl = request.url.toLowerCase();
    const pattern = urlPattern.toLowerCase();
    return requestUrl.includes(pattern);
  }) || null;
}

/**
 * Formats a single row of the table, padding each cell according to the column widths.
 *
 * @param {Array<string>} row - An array of strings, each representing a cell in the row.
 * @param {Array<number>} columnWidths - An array of numbers, each representing
 * the maximum width of a column.
 * @returns {string} The formatted row.
 */
export function formatRows(row, columnWidths) {
  return row.map((cell, i) => String(cell).padEnd(columnWidths[i] + (i === 0 ? 0 : 2))).join('  ');
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
 * Identifies Adobe Experience Cloud tools from network requests only
 * @param {Array<Object>} networkRequests - The network requests array
 * @returns {Object} Object containing identified Adobe tools
 */
export function identifyAdobeTools(networkRequests = []) {
  const adobeTools = {
    hasLaunch: false,
    hasTarget: false,
    hasAnalytics: false,
    hasWebSDK: false,
    details: [],
  };

  // Check for Adobe Launch/Tags
  const launchRequest = findNetworkRequestDetails(networkRequests, 'launch.adobe.com')
    || findNetworkRequestDetails(networkRequests, 'assets.adobedtm.com');
  if (launchRequest) {
    const url = launchRequest.url.toLowerCase();
    if (!url.includes('alloy.js') && !url.includes('alloy.min.js')) {
      adobeTools.hasLaunch = true;
      adobeTools.details.push({
        type: 'Adobe Launch/Tags',
        url: launchRequest.url,
        statusCode: launchRequest.statusCode,
        priority: launchRequest.priority,
      });
    }
  }

  // Check for Adobe Target
  const targetRequest = findNetworkRequestDetails(networkRequests, 'tt.omtrdc.net')
    || findNetworkRequestDetails(networkRequests, 'edge.adobedc.net/ee/');
  if (targetRequest) {
    const url = targetRequest.url.toLowerCase();
    if (!url.includes('alloy.js') && !url.includes('alloy.min.js')
        && (url.includes('/delivery') || url.includes('/interact'))) {
      adobeTools.hasTarget = true;
      adobeTools.details.push({
        type: 'Adobe Target',
        url: targetRequest.url,
        statusCode: targetRequest.statusCode,
        priority: targetRequest.priority,
      });
    }
  }

  // Check for Adobe Analytics
  const analyticsRequest = findNetworkRequestDetails(networkRequests, '.sc.omtrdc.net')
    || findNetworkRequestDetails(networkRequests, 'edge.adobedc.net/ee/collect');
  if (analyticsRequest) {
    const url = analyticsRequest.url.toLowerCase();
    if (!url.includes('alloy.js') && !url.includes('alloy.min.js')) {
      adobeTools.hasAnalytics = true;
      adobeTools.details.push({
        type: 'Adobe Analytics',
        url: analyticsRequest.url,
        statusCode: analyticsRequest.statusCode,
        priority: analyticsRequest.priority,
      });
    }
  }

  // Check for AEP Web SDK
  const webSDKRequest = findNetworkRequestDetails(networkRequests, 'alloy.js')
    || findNetworkRequestDetails(networkRequests, 'alloy.min.js')
    || findNetworkRequestDetails(networkRequests, 'edge.adobedc.net')
    || findNetworkRequestDetails(networkRequests, '.demdex.net');
  if (webSDKRequest) {
    adobeTools.hasWebSDK = true;
    adobeTools.details.push({
      type: 'Adobe Experience Platform Web SDK',
      url: webSDKRequest.url,
      statusCode: webSDKRequest.statusCode,
      priority: webSDKRequest.priority,
    });
  }

  return adobeTools;
}

/**
 * Formats Adobe tools information into a stringified table format.
 * If no Adobe tools are found, it returns an empty string.
 *
 * @param {Object} adobeTools - Object containing identified Adobe tools
 * @returns {string} Adobe tools information formatted into a stringified table or an empty string
 */
export function formatAdobeToolsInfo(adobeTools) {
  if (!adobeTools || !adobeTools.details || adobeTools.details.length === 0) {
    return '';
  }

  const headers = ['Adobe Tool', 'URL', 'Status', 'Priority'];
  const rows = adobeTools.details.map((tool) => [
    tool.type,
    tool.url,
    tool.statusCode,
    tool.priority,
  ]);

  const columnWidths = calculateColumnWidths([headers, ...rows], headers);
  const formattedRows = [
    formatRows(headers, columnWidths),
    '-'.repeat(columnWidths.reduce((sum, width) => sum + width + 2, 0)),
    ...rows.map((row) => formatRows(row, columnWidths)),
  ];

  return `*Adobe Experience Cloud Tools:*\n${BACKTICKS}\n${formattedRows.join('\n')}\n${BACKTICKS}\n`;
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
      entity,
      blockingTime,
      mainThreadTime,
      transferSize,
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

  const formattedTable = `*Third Party Summary:*\n${BACKTICKS}\n${table.map((row) => formatRows(row, columnWidths)).join('\n')}\n${BACKTICKS}`;

  // If the formatted table is too long, truncate it
  const truncatedTable = formattedTable.length > CHARACTER_LIMIT
    ? `${formattedTable.slice(0, CHARACTER_LIMIT - 3)}...`
    : formattedTable;

  return truncatedTable;
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

      const audit = await site.getLatestAuditByAuditType('lhs-mobile');

      if (!audit) {
        await say(`:warning: No audit found for site: ${baseURL}`);
        return;
      }

      const auditResult = audit.getAuditResult();
      const { thirdPartySummary = [], networkRequests = [] } = auditResult;

      // Identify and format Adobe tools as a separate section
      const adobeTools = identifyAdobeTools(networkRequests);
      const adobeToolsInfo = formatAdobeToolsInfo(adobeTools);

      // Format third party summary
      const formattedSummary = formatThirdPartySummary(thirdPartySummary);
      const formattedTBT = formatTotalBlockingTime(auditResult.totalBlockingTime);

      const message = [
        `:lighthouse: *Third Party Impact Report for ${baseURL}*`,
        '',
        `:clock1: Total Blocking Time: ${formattedTBT} ms`,
        '',
        adobeToolsInfo,
        formattedSummary,
      ].filter(Boolean).join('\n');

      await say(message);
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
