/*
 * Copyright 2025 Adobe. All rights reserved.
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
import { extractURLFromSlackInput, postSiteNotFoundMessage } from '../../../utils/slack/base.js';

const PHRASES = ['enrich'];
const SUPPORTED_AUDIT_TYPES = [
  'cwv',
  'accessibility',
  'broken-internal-links',
  'broken-backlinks',
  'meta-tags',
  'alt-text',
];

/**
 * Factory function to create the EnrichOpportunityCommand object.
 *
 * Command: @spacecat-dev enrich <siteUrl> <auditType>
 *
 * This command:
 * 1. Validates the site and audit type
 * 2. Sends enrichment request to Task Processor
 * 3. Returns immediately (Task Processor handles the rest)
 *
 * Supported audit types:
 * - cwv
 * - accessibility
 * - broken-internal-links
 * - broken-backlinks
 * - meta-tags
 * - alt-text
 *
 * @param {Object} context - The context object.
 * @returns {EnrichOpportunityCommand} The EnrichOpportunityCommand object.
 * @constructor
 */
/* c8 ignore start - POC code without tests */
function EnrichOpportunityCommand(context) {
  const baseCommand = BaseCommand({
    id: 'enrich-opportunity',
    name: 'Enrich Opportunity',
    description: 'AI-powered opportunity enrichment with business impact analysis, prioritized suggestions, and implementation plans.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} {auditType}`,
  });

  const { dataAccess, log, sqs } = context;
  const { Site } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      // Parse arguments
      const [siteUrlArg, auditType] = args;

      if (!siteUrlArg || !auditType) {
        await say(':x: Please provide both site URL and audit type.\n'
          + `Usage: \`${baseCommand.usageText}\`\n`
          + `Supported types: ${SUPPORTED_AUDIT_TYPES.join(', ')}`);
        return;
      }

      // Validate audit type
      if (!SUPPORTED_AUDIT_TYPES.includes(auditType)) {
        await say(`:x: Unknown audit type: \`${auditType}\`\n`
          + `Supported types: ${SUPPORTED_AUDIT_TYPES.join(', ')}`);
        return;
      }

      // Extract and validate site URL
      const siteUrl = extractURLFromSlackInput(siteUrlArg);
      const site = await Site.findByBaseURL(siteUrl);

      if (!site) {
        await postSiteNotFoundMessage(say, siteUrl);
        return;
      }

      const siteId = site.getId();

      log.info(`Queueing AI enrichment for ${auditType} on site ${siteId}`);

      // Send to Task Processor
      const message = {
        type: 'enrich-opportunity',
        siteId,
        auditType,
        taskContext: {
          slackContext: {
            channelId: slackContext.channelId,
            threadTs: slackContext.threadTs,
          },
        },
      };

      // Send to Task Processor queue using queue name (auto-resolves to URL)
      await sqs.sendMessage('spacecat-task-processor-jobs', message);

      // Immediate response to user
      await say(':robot_face: *AI Enrichment Started!*\n\n'
        + `:mag: Analyzing \`${auditType}\` opportunity for ${site.getBaseURL()}\n`
        + ':hourglass: This typically takes 30-90 seconds. I\'ll update you when complete!');

      log.info(`Queued ${auditType} enrichment for site ${siteId} to Task Processor`);
    } catch (error) {
      log.error(`Failed to queue enrichment: ${error.message}`, error);
      await say(`:x: Failed to start AI enrichment: ${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}
/* c8 ignore stop */

export default EnrichOpportunityCommand;
