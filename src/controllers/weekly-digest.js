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

import {
  ok,
  accepted,
  forbidden,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';

// Job type identifier for SQS messages
const DIGEST_JOB_TYPE = 'weekly-digest-org';

/**
 * WeeklyDigest controller. Handles triggering weekly digest emails.
 * Uses a fan-out pattern for scalability:
 * 1. triggerWeeklyDigests - Called by scheduler, enqueues per-org messages to SQS
 * 2. Processing is handled by spacecat-reporting-worker
 *
 * @param {Object} ctx - Context of the request
 * @param {Object} log - Logger instance
 * @returns {Object} WeeklyDigest controller
 */
function WeeklyDigestController(ctx, log) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Site } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Trigger weekly digest processing by enqueuing per-organization messages.
   * This is the entry point called by the scheduler/dispatcher.
   *
   * Flow:
   * 1. Query all LLMO-enabled sites
   * 2. Group sites by organization
   * 3. Send one SQS message per organization to the digest queue
   * 4. Return immediately (async processing by reporting-worker)
   *
   * @param {Object} context - Request context
   * @returns {Promise<Response>} Accepted response with queue stats
   */
  const triggerWeeklyDigests = async (context) => {
    log.info('[WeeklyDigest] triggerWeeklyDigests called');

    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can trigger weekly digests');
    }

    const { sqs, env } = context;
    const startTime = Date.now();

    log.info('Starting weekly digest trigger - queueing per-org jobs');

    const queueUrl = env.DIGEST_JOBS_QUEUE_URL;
    if (!queueUrl) {
      log.error('DIGEST_JOBS_QUEUE_URL not configured');
      return internalServerError('Digest queue not configured');
    }

    const stats = {
      totalSites: 0,
      llmoEnabledSites: 0,
      organizationsQueued: 0,
      queueErrors: 0,
    };

    try {
      // Get all sites
      const allSites = await Site.all();
      stats.totalSites = allSites.length;
      log.info(`Found ${stats.totalSites} total sites`);

      // Filter to LLMO-enabled sites (those with llmo.dataFolder config)
      const llmoSites = allSites.filter((site) => {
        const config = site.getConfig();
        const llmoConfig = config?.llmo || config?.getLlmoConfig?.();
        return llmoConfig?.dataFolder;
      });
      stats.llmoEnabledSites = llmoSites.length;
      log.info(`Found ${stats.llmoEnabledSites} LLMO-enabled sites`);

      if (llmoSites.length === 0) {
        return ok({
          message: 'No LLMO-enabled sites found',
          stats,
        });
      }

      // Group sites by organization
      const sitesByOrg = new Map();
      for (const site of llmoSites) {
        const orgId = site.getOrganizationId();
        if (!sitesByOrg.has(orgId)) {
          sitesByOrg.set(orgId, []);
        }
        sitesByOrg.get(orgId).push(site);
      }

      log.info(`Sites grouped into ${sitesByOrg.size} organizations`);

      // Queue a message for each organization
      const queuePromises = [];
      for (const [orgId, sites] of sitesByOrg) {
        const message = {
          type: DIGEST_JOB_TYPE,
          organizationId: orgId,
          siteIds: sites.map((s) => s.getId()),
          triggeredAt: new Date().toISOString(),
        };

        queuePromises.push(
          sqs.sendMessage(queueUrl, message)
            .then(() => {
              stats.organizationsQueued += 1;
              log.debug(`Queued digest job for org ${orgId} with ${sites.length} sites`);
            })
            .catch((error) => {
              stats.queueErrors += 1;
              log.error(`Failed to queue digest for org ${orgId}: ${error.message}`);
            }),
        );
      }

      // Wait for all queue operations
      await Promise.all(queuePromises);

      const duration = Date.now() - startTime;
      log.info(`Weekly digest trigger complete in ${duration}ms: ${stats.organizationsQueued} orgs queued`);

      return accepted({
        message: 'Weekly digest jobs queued for processing',
        duration: `${duration}ms`,
        stats,
      });
    } catch (error) {
      log.error(`Weekly digest trigger failed: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  return {
    triggerWeeklyDigests,
  };
}

export default WeeklyDigestController;
