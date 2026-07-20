/*
 * Copyright 2026 Adobe. All rights reserved.
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
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['force-optimize-at-edge-enable'];

// Must match the handler type registered in spacecat-import-worker.
const FORCE_OPTIMIZE_AT_EDGE_ENABLED_MARKING_TYPE = 'force-optimize-at-edge-enabled-marking';

/**
 * Factory function to create the ForceOptimizeAtEdgeEnableCommand object.
 *
 * Force-enables Optimize at Edge for a single site by enqueuing a
 * `force-optimize-at-edge-enabled-marking` message to the import-worker. The worker enables
 * the site based ONLY on the edge request-id (routing) check, deliberately SKIPPING the
 * prerendered-content validation that the hourly job runs. Intended for internal Adobe use
 * via Slack only.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The ForceOptimizeAtEdgeEnableCommand object.
 */
function ForceOptimizeAtEdgeEnableCommand(context) {
  const baseCommand = BaseCommand({
    id: 'force-optimize-at-edge-enable',
    name: 'Force Optimize at Edge Enable',
    description: 'Force-enables Optimize at Edge for a site based on the edge request-id check '
      + 'ALONE, skipping prerendered-content validation. Internal Adobe use via Slack only.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} <site-url-or-id>`,
  });

  const { dataAccess, log, sqs } = context;
  const { Site, Configuration } = dataAccess;

  /**
   * Resolves the site, then enqueues the force-enable message.
   *
   * @param {string[]} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   */
  const handleExecution = async (args, slackContext) => {
    const { say, user } = slackContext;
    const [siteInput] = args;

    if (!siteInput) {
      await say(baseCommand.usage());
      return;
    }

    try {
      const baseURL = extractURLFromSlackInput(siteInput);
      const site = baseURL
        ? await Site.findByBaseURL(baseURL)
        : await Site.findById(siteInput);

      if (!site) {
        await postSiteNotFoundMessage(say, siteInput);
        return;
      }

      const siteId = site.getId();
      const config = await Configuration.findLatest();

      await sqs.sendMessage(config.getQueues().imports, {
        type: FORCE_OPTIMIZE_AT_EDGE_ENABLED_MARKING_TYPE,
        siteId,
        forcedBy: user,
      });

      await say(
        `:adobe-run: Triggered *force* Optimize-at-Edge enable for *${site.getBaseURL()}* `
        + `(\`${siteId}\`) — prerender content validation will be skipped.`,
      );
      log.info(`force-optimize-at-edge-enable: queued for site ${siteId} by Slack user ${user}`);
    } catch (error) {
      log.error(`Error in force-optimize-at-edge-enable: ${error.message}`);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default ForceOptimizeAtEdgeEnableCommand;
