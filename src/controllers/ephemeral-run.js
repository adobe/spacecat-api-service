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

import {
  isNonEmptyObject,
  isValidUUID,
  isArray,
} from '@adobe/spacecat-shared-utils';
import {
  accepted,
  badRequest,
  createResponse,
  notFound,
  forbidden,
  internalServerError,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import AccessControlUtil from '../support/access-control-util.js';
import {
  runEphemeralRunBatch,
  MAX_BATCH_SITES,
} from '../support/ephemeral-run-service.js';
import { readBatchStatus } from '../support/ephemeral-run-batch-store.js';

/**
 * Ephemeral run — time-boxed imports + audits via batch API; teardown via Step Functions.
 *
 * Batch body may include optional `slack: { channelId?, threadTs? }` for workflow/audit Slack
 * updates; omit `slack` to use env defaults, or set empty strings to skip posting.
 *
 * @param {Object} ctx - Application context with dataAccess, sqs, env, log.
 * @returns {Object} Controller with batchRun and batchStatus.
 */
function EphemeralRunController(ctx) {
  if (!isNonEmptyObject(ctx?.dataAccess)) {
    throw new Error('Valid data access configuration required');
  }

  const { log } = ctx;

  /**
   * POST /ephemeral-run/batch
   * Start an ephemeral run for up to MAX_BATCH_SITES sites.
   */
  const batchRun = async (context) => {
    const body = context.data || {};
    const { siteIds } = body;

    if (!isArray(siteIds) || siteIds.length === 0) {
      return badRequest('siteIds array is required and must not be empty');
    }

    if (siteIds.length > MAX_BATCH_SITES) {
      return badRequest(`Maximum ${MAX_BATCH_SITES} sites per batch request`);
    }

    const invalidIds = siteIds.filter((id) => !isValidUUID(id));
    if (invalidIds.length > 0) {
      return badRequest(`Invalid siteIds: ${invalidIds.join(', ')}`);
    }

    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Ephemeral run batch requires admin access');
    }

    const authInfo = context.attributes?.authInfo;
    const createdBy = authInfo?.getProfile()?.email || 'unknown';

    try {
      const result = await runEphemeralRunBatch(siteIds, body, ctx, createdBy);
      return accepted(result);
    } catch (error) {
      log.error('Ephemeral run batch failed', error);
      return internalServerError('Failed to run ephemeral run batch');
    }
  };

  /**
   * GET /ephemeral-run/batch/:batchId/status
   * Returns batch status from S3: jobsPlan (imports/audits for the batch), progress,
   * and per-site enqueue outcomes (jobsEnqueued / jobsSkipped). Small batches often
   * complete in one request; for many sites, re-fetch until progress.pending is 0.
   */
  const batchStatus = async (context) => {
    const { batchId } = context.params || {};
    if (!isValidUUID(batchId)) {
      return badRequest('Valid batchId path parameter is required');
    }

    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Ephemeral run batch status requires admin access');
    }

    try {
      const result = await readBatchStatus(context.s3, batchId);
      if (!result) {
        return notFound(`Batch not found: ${batchId}`);
      }
      if (result.status === 'expired') {
        return createResponse(result, 410);
      }
      return ok(result);
    } catch (error) {
      log.error(`Failed to read ephemeral run batch status for ${batchId}`, error);
      return internalServerError('Failed to read batch status');
    }
  };

  return { batchRun, batchStatus };
}

export default EphemeralRunController;
