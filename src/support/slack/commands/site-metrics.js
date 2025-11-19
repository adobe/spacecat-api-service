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

        // Validate and normalize dates using shared service
        const dateValidation = validateAndNormalizeDates(startDateInput, endDateInput);
        if (dateValidation.error) {
          await say(`${ERROR_MESSAGE_PREFIX}${dateValidation.error}`);
          return;
        }

        const { startDate, endDate } = dateValidation;

        // Show loading indicator
        await say(':hourglass_flowing_sand: Fetching metrics for site...');

        const siteId = site.getId();

        // Fetch metrics using shared service
        const metrics = await getSiteMetrics(context, siteId, startDate, endDate);

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

        // === AUDITS SECTION ===
        message.push('*🔍 AUDIT EXECUTION*');
        message.push(`   Total: *${metrics.audits.total}* audits run`);
        message.push(`   ✅ Successful: *${metrics.audits.successful}* (${metrics.audits.successRate}%)`);
        message.push(`   ❌ Failed: *${metrics.audits.failed}*`);

        if (metrics.audits.total > 0) {
          message.push('');
          message.push('   _Breakdown by Audit Type:_');
          Object.entries(metrics.audits.byType)
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
        message.push(`   Total: *${metrics.opportunities.total}* opportunities`);

        if (metrics.opportunities.total > 0) {
          message.push('');
          message.push('   _Breakdown by Opportunity Type:_');
          Object.entries(metrics.opportunities.byType)
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
        message.push(`   Total: *${metrics.suggestions.total}* suggestions`);

        if (metrics.suggestions.total > 0) {
          message.push('');
          message.push('   _Breakdown by Suggestion Status:_');
          Object.entries(metrics.suggestions.byStatus)
            .sort((a, b) => b[1] - a[1])
            .forEach(([status, count]) => {
              message.push(`      • \`${status}\`: (✅ ${count})`);
            });
        } else {
          message.push('');
          message.push('   _No suggestions found for this period_');
        }

        // Check if there's no data at all
        const hasNoData = metrics.audits.total === 0
          && metrics.opportunities.total === 0
          && metrics.suggestions.total === 0;

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
