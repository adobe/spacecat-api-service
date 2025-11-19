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
import { getSiteMetrics, validateAndNormalizeDates } from '../../site-metrics-service.js';

const PHRASE = 'site-metrics';
const ERROR_MESSAGE_PREFIX = ':x: ';

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
- Audit execution stats (total, successful, failed)
- Opportunities generated (by type)
- Suggestions created (by status)

Supports optional date range filtering.`,
    phrases: [PHRASE],
    usageText: `${PHRASE} {siteURL|all} [startDate] [endDate]

Examples:
  ${PHRASE} https://example.com
  ${PHRASE} https://example.com 2025-01-01 2025-01-31
  ${PHRASE} example.com 2025-01-15
  ${PHRASE} all
  ${PHRASE} all 2025-01-01 2025-01-31
  
Date format: YYYY-MM-DD
If no dates provided, shows all-time metrics.
If only startDate provided, shows metrics from that date to today.
Use "all" to get aggregated metrics across all sites.`,
  });

  const { log, dataAccess } = context;
  const { Site } = dataAccess;

  return {
    ...baseCommand,
    async handleExecution(args, slackContext) {
      const { say } = slackContext;

      try {
        // Parse arguments
        const [siteURLInput, startDateInput, endDateInput] = args;

        // Validate site URL is provided
        if (!hasText(siteURLInput)) {
          await say(`${ERROR_MESSAGE_PREFIX}Please provide a site URL or "all".\n\nUsage:\n\`\`\`${baseCommand.usageText}\`\`\``);
          return;
        }

        // Check if user wants metrics for all sites
        const isAllSites = siteURLInput.toLowerCase() === 'all';

        let sites = [];
        /* c8 ignore start */
        // All sites aggregation path - difficult to test without complex multi-site setup
        if (isAllSites) {
          // Get all sites
          sites = await Site.all();
          if (sites.length === 0) {
            await say(`${ERROR_MESSAGE_PREFIX}No sites found in the system.`);
            return;
          }
        /* c8 ignore stop */
        } else {
          // Extract and normalize site URL
          const siteURL = extractURLFromSlackInput(siteURLInput);

          // Find site by URL
          const site = await Site.findByBaseURL(siteURL);
          if (!site) {
            await say(`${ERROR_MESSAGE_PREFIX}Site not found: "${siteURL}"\n\nPlease check the URL and try again.`);
            return;
          }
          sites = [site];
        }

        // Validate and normalize dates using shared service
        const dateValidation = validateAndNormalizeDates(startDateInput, endDateInput);
        if (dateValidation.error) {
          await say(`${ERROR_MESSAGE_PREFIX}${dateValidation.error}`);
          return;
        }

        const { startDate, endDate } = dateValidation;

        // Show loading indicator
        /* c8 ignore start */
        // All sites aggregation path - difficult to test without complex multi-site setup
        if (isAllSites) {
          await say(`:hourglass_flowing_sand: Fetching metrics for ${sites.length} sites...`);
        /* c8 ignore stop */
        } else {
          await say(':hourglass_flowing_sand: Fetching metrics for site...');
        }

        // Fetch and aggregate metrics
        let aggregatedMetrics;
        /* c8 ignore start */
        // All sites aggregation path - difficult to test without complex multi-site setup
        if (isAllSites) {
          // Aggregate metrics across all sites
          aggregatedMetrics = {
            siteCount: sites.length,
            startDate,
            endDate,
            audits: {
              total: 0, successful: 0, failed: 0, successRate: 0, byType: {},
            },
            opportunities: { total: 0, byType: {} },
            suggestions: { total: 0, byStatus: {} },
          };

          // Extract references before loop to avoid no-loop-func issues
          const aggAudits = aggregatedMetrics.audits;
          const aggOpportunities = aggregatedMetrics.opportunities;
          const aggSuggestions = aggregatedMetrics.suggestions;

          // eslint-disable-next-line no-restricted-syntax
          for (const site of sites) {
            // eslint-disable-next-line no-await-in-loop
            const siteMetrics = await getSiteMetrics(context, site.getId(), startDate, endDate);

            // Aggregate audits
            aggAudits.total += siteMetrics.audits.total;
            aggAudits.successful += siteMetrics.audits.successful;
            aggAudits.failed += siteMetrics.audits.failed;

            // Aggregate audit types
            const { byType } = siteMetrics.audits;
            const aggByType = aggAudits.byType;
            Object.entries(byType).forEach(([type, counts]) => {
              if (!aggByType[type]) {
                aggByType[type] = { total: 0, successful: 0, failed: 0 };
              }
              aggByType[type].total += counts.total;
              aggByType[type].successful += counts.successful;
              aggByType[type].failed += counts.failed;
            });

            // Aggregate opportunities
            aggOpportunities.total += siteMetrics.opportunities.total;
            const { byType: oppByType } = siteMetrics.opportunities;
            const aggOppByType = aggOpportunities.byType;
            Object.entries(oppByType).forEach(([type, count]) => {
              const current = aggOppByType[type] || 0;
              aggOppByType[type] = current + count;
            });

            // Aggregate suggestions
            aggSuggestions.total += siteMetrics.suggestions.total;
            const { byStatus } = siteMetrics.suggestions;
            const aggByStatus = aggSuggestions.byStatus;
            Object.entries(byStatus).forEach(([status, count]) => {
              const current = aggByStatus[status] || 0;
              aggByStatus[status] = current + count;
            });
          }

          // Calculate overall success rate
          const totalAudits = aggregatedMetrics.audits.total;
          const successfulAudits = aggregatedMetrics.audits.successful;
          aggregatedMetrics.audits.successRate = totalAudits > 0
            ? parseFloat(((successfulAudits / totalAudits) * 100).toFixed(1))
            : 0;
        /* c8 ignore stop */
        } else {
          const site = sites[0];
          aggregatedMetrics = await getSiteMetrics(context, site.getId(), startDate, endDate);
          aggregatedMetrics.baseURL = site.getBaseURL();
        }

        // Build Slack message
        const message = [];

        // Header
        /* c8 ignore start */
        // All sites aggregation path - difficult to test without complex multi-site setup
        if (isAllSites) {
          message.push(`:bar_chart: *Aggregated Metrics for ${sites.length} Sites*`);
        /* c8 ignore stop */
        } else {
          message.push(`:bar_chart: *Metrics for Site: ${aggregatedMetrics.baseURL}*`);
        }

        // Date range
        if (startDateInput) {
          message.push(`📅 *Period:* ${startDate} to ${endDate}`);
        } else {
          message.push('📅 *Period:* All time');
        }
        message.push('');

        // === AUDITS SECTION ===
        message.push('*🔍 AUDIT EXECUTION*');
        message.push(`   Total: *${aggregatedMetrics.audits.total}* audits run`);
        message.push(`   ✅ Successful: *${aggregatedMetrics.audits.successful}* (${aggregatedMetrics.audits.successRate}%)`);
        if (aggregatedMetrics.audits.failed > 0) {
          message.push(`   ❌ Failed: *${aggregatedMetrics.audits.failed}*`);
        }

        if (aggregatedMetrics.audits.total > 0) {
          message.push('');
          message.push('   _Breakdown by Audit Type:_');
          Object.entries(aggregatedMetrics.audits.byType)
            .sort((a, b) => b[1].total - a[1].total)
            .forEach(([type, counts]) => {
              const failedStr = counts.failed > 0 ? ` | ❌ ${counts.failed}` : '';
              message.push(`      • \`${type}\`: (✅ ${counts.successful}${failedStr})`);
            });
        } else {
          message.push('');
          message.push('   _No audits found for this period_');
        }

        // === OPPORTUNITIES SECTION ===
        message.push('');
        message.push('');
        message.push('*💡 OPPORTUNITIES GENERATED*');
        message.push(`   Total: *${aggregatedMetrics.opportunities.total}* opportunities`);

        if (aggregatedMetrics.opportunities.total > 0) {
          message.push('');
          message.push('   _Breakdown by Opportunity Type:_');
          Object.entries(aggregatedMetrics.opportunities.byType)
            .sort((a, b) => b[1] - a[1])
            .forEach(([type, count]) => {
              message.push(`      • \`${type}\`: (✅ ${count})`);
            });
        } else {
          message.push('');
          message.push('   _No opportunities found for this period_');
        }

        // === SUGGESTIONS SECTION ===
        message.push('');
        message.push('');
        message.push('*📝 SUGGESTIONS CREATED*');
        message.push(`   Total: *${aggregatedMetrics.suggestions.total}* suggestions`);

        if (aggregatedMetrics.suggestions.total > 0) {
          message.push('');
          message.push('   _Breakdown by Suggestion Status:_');
          Object.entries(aggregatedMetrics.suggestions.byStatus)
            .sort((a, b) => b[1] - a[1])
            .forEach(([status, count]) => {
              message.push(`      • \`${status}\`: (✅ ${count})`);
            });
        } else {
          message.push('');
          message.push('   _No suggestions found for this period_');
        }

        // Check if there's no data at all
        const hasNoData = aggregatedMetrics.audits.total === 0
          && aggregatedMetrics.opportunities.total === 0
          && aggregatedMetrics.suggestions.total === 0;

        if (hasNoData) {
          message.push('');
          message.push(':information_source: No data found for this site in the specified date range.');
          message.push('');
          message.push('_This could mean:_');
          message.push('• The site was onboarded after the specified date range');
          message.push('• No audits have been run yet');
          message.push('• No opportunities or suggestions were generated');
          message.push('• The date range is too restrictive');
        }

        // Send the formatted message
        await say(message.join('\n'));
      } catch (error) {
        log.error('Error fetching site metrics:', error);
        await say(`${ERROR_MESSAGE_PREFIX}An error occurred while fetching metrics: ${error.message}`);
      }
    },
  };
};
