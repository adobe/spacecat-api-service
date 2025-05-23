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

import {
  badRequest,
  createResponse,
  forbidden,
  internalServerError,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { WebClient } from '@slack/web-api';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * Audit Status controller for handling audit status requests
 * @param {object} ctx - Context object containing dataAccess, log, env, etc.
 * @returns {object} Audit Status controller
 * @constructor
 */
function AuditStatusController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess, env } = ctx;

  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Site, LatestAudit } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);
  const slackClient = new WebClient(env.SLACK_BOT_TOKEN);

  /**
   * Get audit status for a site and send notification to Slack
   * @param {object} context - Request context containing params, data, etc.
   * @returns {Promise<Response>} HTTP response
   */
  const getStatus = async (context) => {
    const { params, data, log } = context;
    const { siteId } = params;
    const { slackContext } = data || {};

    // Log hello world message
    log.info('Hello World from Audit Status API!');

    if (!isValidUUID(siteId)) {
      return badRequest('Valid site ID required');
    }

    try {
      // Get site information
      const site = await Site.findById(siteId);
      if (!site) {
        return createResponse({ message: 'Site not found' }, 404);
      }

      // Check access control
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }

      // Get latest audits for the site
      const latestAudits = await LatestAudit.allBySiteId(siteId);

      // Prepare status message
      const statusMessage = {
        siteId,
        baseURL: site.getBaseURL(),
        audits: latestAudits.map((audit) => ({
          type: audit.getAuditType(),
          status: audit.getStatus(),
          auditedAt: audit.getAuditedAt(),
          score: audit.getScore(),
        })),
      };

      // If slack context is provided, send message to Slack
      if (slackContext?.channelId) {
        try {
          const slackMessage = {
            channel: slackContext.channelId,
            text: `*Audit Status for ${site.getBaseURL()}*\n${
              latestAudits.map((audit) => `• ${audit.getAuditType()}: ${audit.getStatus()} (Score: ${audit.getScore()})`).join('\n')}`,
            thread_ts: slackContext.threadTs,
          };

          await slackClient.chat.postMessage(slackMessage);
          log.info(`Sent status message to Slack channel ${slackContext.channelId}`);
        } catch (error) {
          log.error(`Failed to send Slack message: ${error.message}`);
          // Don't fail the request if Slack message fails
        }
      }

      return ok(statusMessage);
    } catch (error) {
      log.error(`Error getting audit status: ${error.message}`);
      return internalServerError('Failed to get audit status');
    }
  };

  return {
    getStatus,
  };
}

export default AuditStatusController;
