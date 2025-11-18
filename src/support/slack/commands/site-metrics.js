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

import { hasText } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import { extractURLFromSlackInput } from '../../../utils/slack/base.js';

const PHRASE = 'site-metrics';
const ERROR_MESSAGE_PREFIX = ':x: ';

/**
 * Validates if a date string is in YYYY-MM-DD format and is a valid date
 * @param {string} dateString - Date string to validate
 * @returns {boolean} True if valid date format
 */
function isValidDate(dateString) {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;

  const date = new Date(dateString);
  return date instanceof Date && !Number.isNaN(date.getTime());
}

/**
 * Filters items by date range based on a date field
 * @param {Array} items - Items to filter
 * @param {Function} dateGetter - Function to get date from item
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Array} Filtered items
 */
function filterByDateRange(items, dateGetter, startDate, endDate) {
  return items.filter((item) => {
    const itemDate = dateGetter(item);
    if (!itemDate) return false;

    // Extract date portion (YYYY-MM-DD) from ISO timestamp
    const dateOnly = itemDate.split('T')[0];
    return dateOnly >= startDate && dateOnly <= endDate;
  });
}

/**
 * Slack command to get metrics for a site including audits, opportunities, and suggestions.
 * Shows execution counts, success/failure rates, and breakdowns by type.
 *
 * Usage:
 *   @spacecat-dev site-metrics https://example.com
 *   @spacecat-dev site-metrics https://example.com 2025-01-01 2025-01-31
 *   @spacecat-dev site-metrics example.com 2025-01-15
 *
 * @param {object} context - Command context with dataAccess and log
 * @returns {object} Command configuration
 */
export default (context) => {
  const baseCommand = BaseCommand({
    id: 'sites--get-metrics',
    name: 'Get Site Metrics',
    description: `Get comprehensive metrics for a site including audits, opportunities, and suggestions.
    
Shows:
  - Audit executions (total, successful, failed) with breakdown by type
  - Opportunities created with breakdown by type  
  - Suggestions created with breakdown by status
  
Optionally filter by date range.`,
    phrases: [PHRASE],
    usageText: `${PHRASE} {siteURL} [startDate] [endDate]

Examples:
  ${PHRASE} https://example.com
  ${PHRASE} https://example.com 2025-01-01 2025-01-31
  ${PHRASE} example.com 2025-01-15
  
Date format: YYYY-MM-DD
If no dates provided, shows all-time metrics.
If only startDate provided, shows metrics from that date to today.`,
  });

  const { log, dataAccess } = context;
  const {
    Site, Audit, Opportunity, Suggestion,
  } = dataAccess;

  return {
    ...baseCommand,
    async handleExecution(args, slackContext) {
      const { say } = slackContext;

      try {
        // Parse arguments
        const [siteURLInput, startDateInput, endDateInput] = args;

        // Validate site URL is provided
        if (!hasText(siteURLInput)) {
          await say(`${ERROR_MESSAGE_PREFIX}Please provide a site URL.\n\nUsage:\n\`\`\`${baseCommand.usageText}\`\`\``);
          return;
        }

        // Extract and normalize site URL
        const siteURL = extractURLFromSlackInput(siteURLInput);

        // Find site by URL
        const site = await Site.findByBaseURL(siteURL);
        if (!site) {
          await say(`${ERROR_MESSAGE_PREFIX}Site not found: "${siteURL}"\n\nPlease check the URL and try again.`);
          return;
        }

        // Parse and validate date range
        const today = new Date().toISOString().split('T')[0];
        let startDate = '2000-01-01'; // Default: beginning of time
        let endDate = today; // Default: today

        if (startDateInput) {
          if (!isValidDate(startDateInput)) {
            await say(`${ERROR_MESSAGE_PREFIX}Invalid start date format: "${startDateInput}"\n\nPlease use YYYY-MM-DD format (e.g., 2025-01-15)`);
            return;
          }
          startDate = startDateInput;
        }

        if (endDateInput) {
          if (!isValidDate(endDateInput)) {
            await say(`${ERROR_MESSAGE_PREFIX}Invalid end date format: "${endDateInput}"\n\nPlease use YYYY-MM-DD format (e.g., 2025-01-31)`);
            return;
          }
          endDate = endDateInput;
        }

        // Validate date range
        if (startDate > endDate) {
          await say(`${ERROR_MESSAGE_PREFIX}Start date (${startDate}) cannot be after end date (${endDate})`);
          return;
        }

        // Show loading indicator
        await say(':hourglass_flowing_sand: Fetching metrics for site...');

        const siteId = site.getId();

        // Fetch audits for the site using existing API
        const auditsResult = await Audit.query.bySite({ siteId }).go();
        const allAudits = auditsResult.data || [];

        // Fetch opportunities for the site using existing API
        const opportunitiesResult = await Opportunity.query.bySite({ siteId }).go();
        const allOpportunities = opportunitiesResult.data || [];

        // Fetch suggestions for each opportunity using existing API
        const allSuggestions = [];
        // eslint-disable-next-line no-restricted-syntax
        for (const opportunity of allOpportunities) {
          // eslint-disable-next-line no-await-in-loop
          const suggestionsResult = await Suggestion.query
            .byOpportunity({ opportunityId: opportunity.getId() })
            .go();
          allSuggestions.push(...(suggestionsResult.data || []));
        }

        // Filter by date range
        const filteredAudits = filterByDateRange(
          allAudits,
          (audit) => audit.getAuditedAt(),
          startDate,
          endDate,
        );

        const filteredOpportunities = filterByDateRange(
          allOpportunities,
          (opp) => opp.getCreatedAt(),
          startDate,
          endDate,
        );

        const filteredSuggestions = filterByDateRange(
          allSuggestions,
          (sugg) => sugg.getCreatedAt(),
          startDate,
          endDate,
        );

        // Calculate audit metrics
        const totalAudits = filteredAudits.length;
        const successfulAudits = filteredAudits.filter((audit) => !audit.isError()).length;
        const failedAudits = totalAudits - successfulAudits;
        const successRate = totalAudits > 0 ? ((successfulAudits / totalAudits) * 100).toFixed(1) : '0.0';

        // Group audits by type
        const auditsByType = {};
        filteredAudits.forEach((audit) => {
          const type = audit.getAuditType();
          if (!auditsByType[type]) {
            auditsByType[type] = { total: 0, successful: 0, failed: 0 };
          }
          auditsByType[type].total += 1;
          if (audit.isError()) {
            auditsByType[type].failed += 1;
          } else {
            auditsByType[type].successful += 1;
          }
        });

        // Group opportunities by type
        const opportunitiesByType = {};
        filteredOpportunities.forEach((opp) => {
          const type = opp.getType();
          opportunitiesByType[type] = (opportunitiesByType[type] || 0) + 1;
        });

        // Group suggestions by status
        const suggestionsByStatus = {};
        filteredSuggestions.forEach((sugg) => {
          const status = sugg.getStatus();
          suggestionsByStatus[status] = (suggestionsByStatus[status] || 0) + 1;
        });

        // Build Slack message
        const message = [];

        // Header
        message.push(`:bar_chart: *Metrics for Site: ${site.getBaseURL()}*`);

        // Date range
        if (startDateInput) {
          message.push(`📅 *Period:* ${startDate} to ${endDate}`);
        } else {
          message.push('📅 *Period:* All time');
        }

        message.push('');

        // Audit Execution Section
        message.push('*🔍 Audit Execution:*');
        message.push(`• Total Audits: ${totalAudits}`);

        if (totalAudits > 0) {
          message.push(`• ✅ Successful: ${successfulAudits} (${successRate}%)`);
          message.push(`• ❌ Failed: ${failedAudits}`);
          message.push('');

          // Breakdown by audit type
          message.push('*Breakdown by Audit Type:*');
          const sortedAuditTypes = Object.entries(auditsByType)
            .sort((a, b) => b[1].total - a[1].total);

          sortedAuditTypes.forEach(([type, counts]) => {
            const typeSuccessRate = ((counts.successful / counts.total) * 100).toFixed(0);
            message.push(`• *${type}*: ${counts.total} total (✅ ${counts.successful} / ❌ ${counts.failed}) - ${typeSuccessRate}% success`);
          });
        } else {
          message.push('• _No audits found for this period_');
        }

        message.push('');

        // Opportunities Section
        message.push('*💡 Opportunities Generated:*');
        message.push(`• Total Opportunities: ${filteredOpportunities.length}`);

        if (filteredOpportunities.length > 0) {
          message.push('');
          message.push('*Breakdown by Opportunity Type:*');
          const sortedOppTypes = Object.entries(opportunitiesByType)
            .sort((a, b) => b[1] - a[1]);

          sortedOppTypes.forEach(([type, count]) => {
            message.push(`• *${type}*: ${count}`);
          });
        } else {
          message.push('• _No opportunities found for this period_');
        }

        message.push('');

        // Suggestions Section
        message.push('*💬 Suggestions Created:*');
        message.push(`• Total Suggestions: ${filteredSuggestions.length}`);

        if (filteredSuggestions.length > 0) {
          message.push('');
          message.push('*Breakdown by Status:*');
          const sortedSuggStatuses = Object.entries(suggestionsByStatus)
            .sort((a, b) => b[1] - a[1]);

          sortedSuggStatuses.forEach(([status, count]) => {
            message.push(`• *${status}*: ${count}`);
          });
        } else {
          message.push('• _No suggestions found for this period_');
        }

        // Summary for empty results
        const hasNoData = totalAudits === 0
          && filteredOpportunities.length === 0
          && filteredSuggestions.length === 0;
        if (hasNoData) {
          message.push('');
          message.push(':information_source: No data found for this site in the specified date range.');
          message.push('');
          message.push('_This could mean:_');
          message.push('• The site was onboarded after the specified date range');
          message.push('• No audits have been executed yet');
          message.push('• The date range is outside the data retention period');
        }

        await say(message.join('\n'));
      } catch (error) {
        log.error('Error fetching site metrics:', error);
        await say(`${ERROR_MESSAGE_PREFIX}An error occurred while fetching metrics: ${error.message}`);
      }
    },
  };
};
