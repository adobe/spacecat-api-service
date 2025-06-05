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
 * Identifies Adobe Experience Cloud tools from third party summary
 * @param {Array<Object>} summary - The third party summary array
 * @param {Array<Object>} networkRequests - The network requests array
 * @returns {Object} Object containing identified Adobe tools
 */
export function identifyAdobeTools(summary = [], networkRequests = []) {
  const adobeTools = {
    hasLaunch: false,
    hasTarget: false,
    hasAnalytics: false,
    hasWebSDK: false,
    hasDataLayer: false,
    details: [],
  };

  // Helper function to find matching network request details
  const findNetworkRequestDetails = (url) => {
    const request = networkRequests.find((req) => {
      const reqUrl = req.url.toLowerCase();
      return reqUrl.includes(url.toLowerCase());
    });
    return request ? {
      url: request.url,
      statusCode: request.statusCode,
      priority: request.priority,
    } : null;
  };

  // Check network requests first for more accurate detection
  networkRequests.forEach((request) => {
    const urlLower = request.url.toLowerCase();

    // Check for Adobe Launch/Tags
    if ((urlLower.includes('launch.adobe.com') || urlLower.includes('assets.adobedtm.com'))
        && !urlLower.includes('alloy.js')
        && !urlLower.includes('alloy.min.js')) {
      adobeTools.hasLaunch = true;
      adobeTools.details.push({
        type: 'Adobe Launch/Tags',
        url: request.url,
        statusCode: request.statusCode,
        priority: request.priority,
      });
    }

    // Check for Adobe Target
    if ((urlLower.includes('tt.omtrdc.net')
        || (urlLower.includes('edge.adobedc.net/ee/')
        && (urlLower.includes('/delivery') || urlLower.includes('/interact'))))
        && !urlLower.includes('alloy.js')
        && !urlLower.includes('alloy.min.js')) {
      adobeTools.hasTarget = true;
      adobeTools.details.push({
        type: 'Adobe Target',
        url: request.url,
        statusCode: request.statusCode,
        priority: request.priority,
      });
    }

    // Check for Adobe Analytics
    if ((urlLower.includes('.sc.omtrdc.net')
        || (urlLower.includes('edge.adobedc.net/ee/') && urlLower.includes('/collect')))
        && !urlLower.includes('alloy.js')
        && !urlLower.includes('alloy.min.js')) {
      adobeTools.hasAnalytics = true;
      adobeTools.details.push({
        type: 'Adobe Analytics',
        url: request.url,
        statusCode: request.statusCode,
        priority: request.priority,
      });
    }

    // Check for AEP Web SDK
    if (urlLower.includes('alloy.js')
        || urlLower.includes('alloy.min.js')
        || (urlLower.includes('edge.adobedc.net') && !urlLower.includes('edge.adobedc.net/ee/'))
        || urlLower.includes('.demdex.net')) {
      adobeTools.hasWebSDK = true;
      adobeTools.details.push({
        type: 'Adobe Experience Platform Web SDK',
        url: request.url,
        statusCode: request.statusCode,
        priority: request.priority,
      });
    }
  });

  // Fallback to checking script elements from third party summary for client-side detection
  summary.forEach((thirdParty) => {
    const { scriptElements = [] } = thirdParty;

    // Check for Adobe Target via window object
    if (scriptElements.some((script) => script.includes('window.adobe.target'))
        && !adobeTools.hasTarget) {
      adobeTools.hasTarget = true;
      const details = findNetworkRequestDetails('tt.omtrdc.net') || thirdParty;
      adobeTools.details.push({ type: 'Adobe Target', ...details });
    }

    // Check for AEP Web SDK via window object
    if (scriptElements.some((script) => script.includes('window.alloy'))
        && !adobeTools.hasWebSDK) {
      adobeTools.hasWebSDK = true;
      const details = findNetworkRequestDetails('edge.adobedc.net') || thirdParty;
      adobeTools.details.push({ type: 'Adobe Experience Platform Web SDK', ...details });
    }

    // Check for Adobe Client Data Layer
    if (scriptElements.some((script) => script.includes('window.adobeDataLayer'))) {
      adobeTools.hasDataLayer = true;
      adobeTools.details.push({ type: 'Adobe Client Data Layer', ...thirdParty });
    }
  });

  return adobeTools;
}

/**
 * Formats Adobe Experience Cloud tools information
 * @param {Object} adobeTools - The Adobe tools object from identifyAdobeTools
 * @returns {string} Formatted string with Adobe tools information
 */
export function formatAdobeToolsInfo(adobeTools) {
  if (!adobeTools || !adobeTools.details || !adobeTools.details.length) {
    return '';
  }

  const headers = ['Adobe Tool', 'URL', 'Status', 'Priority'];
  const rows = adobeTools.details.map(({
    type,
    url,
    statusCode,
    priority,
  }) => [
    addEllipsis(type),
    addEllipsis(url),
    statusCode || 'N/A',
    priority || 'N/A',
  ]);

  const table = [headers, ...rows];
  const columnWidths = calculateColumnWidths(table);

  return `*Adobe Experience Cloud Tools:*\n${BACKTICKS}\n${table.map((row) => formatRows(row, columnWidths)).join('\n')}\n${BACKTICKS}`;
}

/**
 * Formats an array of third party sumary into a stringified table format.
 * If summary array is empty, it returns a fallback message. If the formatted
 * table exceeds the character limit, it is sliced and appended
 * with an ellipsis.
 *
 * @param {Array<Object>} summary - An array of third party summary objects.
 * @param {Array<Object>} networkRequests - An array of network request objects.
 * @returns {string} Third party summary formatted into a stringified table or a fallback message.
 */
export function formatThirdPartySummary(summary = [], networkRequests = []) {
  if (summary.length === 0) {
    return '    _No third party impact detected_';
  }

  // First identify Adobe tools
  const adobeTools = identifyAdobeTools(summary, networkRequests);
  const adobeToolsInfo = formatAdobeToolsInfo(adobeTools);

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

  // If we have Adobe tools info, we need to account for its length plus the newlines
  const availableSpace = CHARACTER_LIMIT - (adobeToolsInfo ? adobeToolsInfo.length + 2 : 0);

  // If the formatted table is too long, truncate it
  const truncatedTable = formattedTable.length > availableSpace
    ? `${formattedTable.slice(0, availableSpace - 3)}...`
    : formattedTable;

  // Return both sections if Adobe tools are found
  return adobeToolsInfo
    ? `${adobeToolsInfo}\n\n${truncatedTable}`
    : truncatedTable;
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

      const formattedSummary = formatThirdPartySummary(thirdPartySummary, networkRequests);
      const formattedTBT = formatTotalBlockingTime(auditResult.totalBlockingTime);

      const message = [
        `:lighthouse: *Third Party Impact Report for ${baseURL}*`,
        '',
        `:clock1: Total Blocking Time: ${formattedTBT} ms`,
        '',
        formattedSummary,
      ].join('\n');

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
