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
  notFound,
  forbidden,
  internalServerError,
  ok,
  createResponse,
} from '@adobe/spacecat-shared-http-utils';
import AccessControlUtil from '../support/access-control-util.js';
import {
  runInsightsForSite,
  runInsightsBatch,
  MAX_BATCH_SITES,
  PRESETS,
} from '../support/insights-run-service.js';
import { readBatchStatus } from '../support/insights-batch-store.js';

/**
 * Insights Controller — orchestrates one-shot imports + audits for a site or batch of sites.
 *
 * @param {Object} ctx - Application context with dataAccess, sqs, env, log.
 * @returns {Object} Controller with run and batchRun methods.
 */
function InsightsController(ctx) {
  if (!isNonEmptyObject(ctx?.dataAccess)) {
    throw new Error('Valid data access configuration required');
  }

  const { dataAccess, log } = ctx;
  const { Site } = dataAccess;

  /**
   * POST /sites/:siteId/insights/run
   * Trigger a one-shot insights run for a single site.
   */
  const run = async (context) => {
    const { siteId } = context.params || {};
    if (!isValidUUID(siteId)) {
      return badRequest('Valid siteId path parameter is required');
    }

    const site = await Site.findById(siteId);
    if (!isNonEmptyObject(site)) {
      return notFound(`Site not found: ${siteId}`);
    }

    const accessControlUtil = AccessControlUtil.fromContext(ctx);
    const hasAccess = await accessControlUtil.hasAccess(site);
    if (!hasAccess) {
      return forbidden('Insufficient access to this site');
    }

    const body = context.data || {};
    if (body.preset && !PRESETS[body.preset]) {
      return badRequest(`Unknown preset: ${body.preset}. Available: ${Object.keys(PRESETS).join(', ')}`);
    }

    try {
      const result = await runInsightsForSite(siteId, body, ctx);

      const statusCode = result.status === 'failed' ? 500 : 200;
      return createResponse(result, statusCode);
    } catch (error) {
      log.error('Insights run failed', error);
      return internalServerError('Failed to run insights');
    }
  };

  /**
   * POST /insights/run/batch
   * Trigger a one-shot insights run for up to MAX_BATCH_SITES sites.
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

    if (body.preset && !PRESETS[body.preset]) {
      return badRequest(`Unknown preset: ${body.preset}. Available: ${Object.keys(PRESETS).join(', ')}`);
    }

    const accessControlUtil = AccessControlUtil.fromContext(ctx);
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Batch insights run requires admin access');
    }

    try {
      const result = await runInsightsBatch(siteIds, body, ctx);
      return accepted(result);
    } catch (error) {
      log.error('Batch insights run failed', error);
      return internalServerError('Failed to run batch insights');
    }
  };

  /**
   * GET /insights/run/batch/:batchId/status
   * Poll batch progress and per-site results.
   */
  const batchStatus = async (context) => {
    const { batchId } = context.params || {};
    if (!isValidUUID(batchId)) {
      return badRequest('Valid batchId path parameter is required');
    }

    const accessControlUtil = AccessControlUtil.fromContext(ctx);
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Batch status requires admin access');
    }

    try {
      const result = await readBatchStatus(ctx.s3, batchId);
      if (!result) {
        return notFound(`Batch not found: ${batchId}`);
      }
      return ok(result);
    } catch (error) {
      log.error(`Failed to read batch status for ${batchId}`, error);
      return internalServerError('Failed to read batch status');
    }
  };

  return { run, batchRun, batchStatus };
}

export default InsightsController;
