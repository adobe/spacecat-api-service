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
  isNonEmptyObject, isNonEmptyArray, isValidUUID, hasText,
} from '@adobe/spacecat-shared-utils';
import {
  accepted, badRequest, forbidden, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { OaeValidationJobs, ROUTING_VALIDATOR_TYPE } from '@adobe/spacecat-shared-tokowaka-client';
import AccessControlUtil from '../support/access-control-util.js';

const VALID_VALIDATION_TYPES = [ROUTING_VALIDATOR_TYPE];

/**
 * Creates an OAE validation controller instance.
 * @param {Object} ctx - The context object containing dataAccess and sqs
 * @param {Object} ctx.dataAccess - The data access layer for database operations
 * @param {Object} ctx.sqs - The SQS client instance
 * @param {Object} log - The logger instance
 * @param {Object} env - The environment configuration object
 * @returns {Object} The OAE validation controller instance
 * @throws {Error} If context, dataAccess, sqs, or env is not provided
 */
function OaeValidationController(ctx, log, env) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess, sqs } = ctx;

  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  if (!isNonEmptyObject(sqs)) {
    throw new Error('SQS client required');
  }

  if (!isNonEmptyObject(env)) {
    throw new Error('Environment object required');
  }

  const oaeValidationJobs = OaeValidationJobs.createFrom({ dataAccess, sqs, log });

  /**
   * Validates the request data for job creation.
   * @param {Object} data - The request data object
   * @throws {Error} If data is invalid or missing required fields
   */
  function validateRequestData(data) {
    if (!isNonEmptyObject(data)) {
      throw new Error('Invalid request: missing application/json data');
    }
    if (!isValidUUID(data.siteId)) {
      throw new Error('Invalid request: siteId must be a valid UUID');
    }
    if (!isValidUUID(data.opportunityId)) {
      throw new Error('Invalid request: opportunityId must be a valid UUID');
    }
    if (!hasText(data.type)) {
      throw new Error('Invalid request: type is required');
    }
    if (!VALID_VALIDATION_TYPES.includes(data.type)) {
      throw new Error(`Invalid request: type must be one of ${VALID_VALIDATION_TYPES.join(', ')}`);
    }
    if (!isNonEmptyArray(data.suggestionIds)) {
      throw new Error('Invalid request: suggestionIds must be a non-empty array');
    }
    if (!data.suggestionIds.every((id) => isValidUUID(id))) {
      throw new Error('Invalid request: all suggestionIds must be valid UUIDs');
    }
  }

  /**
   * Validates a job request and dispatches it to spacecat-import-worker. Shared core used by
   * both the HTTP handler below and in-process callers (e.g. the edge-deploy flow in
   * suggestions.js) that want a job created without going through the HTTP layer. Also verifies
   * every suggestionId actually belongs to opportunityId, so a job is always resolvable back to
   * one specific opportunity.
   * @param {Object} data - { siteId, opportunityId, type, suggestionIds }
   * @returns {Promise<{jobId: string}>}
   * @throws {Error} With an 'Invalid request: ...' message if data fails validation.
   */
  const createJob = async (data) => {
    validateRequestData(data);

    const {
      siteId, opportunityId, type, suggestionIds,
    } = data;

    const { data: suggestions } = await dataAccess.Suggestion.batchGetByKeys(
      suggestionIds.map((id) => ({ suggestionId: id })),
    );
    const allBelongToOpportunity = suggestions.length === suggestionIds.length
      && suggestions.every((s) => s.getOpportunityId() === opportunityId);
    if (!allBelongToOpportunity) {
      throw new Error('Invalid request: all suggestionIds must belong to opportunityId');
    }

    return oaeValidationJobs.createJob({ siteId, type, suggestionIds });
  };

  /**
   * Creates a new OAE validation job and dispatches it to spacecat-import-worker.
   * @param {Object} context - The request context
   * @param {Object} context.params - { siteId }
   * @param {Object} context.data - { opportunityId, type, suggestionIds }
   * @returns {Promise<Object>} The HTTP response object
   */
  const createValidationJob = async (context) => {
    const { data, params } = context;
    const siteId = params?.siteId;
    let jobId;
    try {
      if (!isValidUUID(siteId)) {
        return badRequest('Invalid request: siteId must be a valid UUID');
      }
      const site = await dataAccess.Site.findById(siteId);
      const accessControlUtil = AccessControlUtil.fromContext(context);
      if (!site || !await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }
      // siteId always comes from the URL, never the body -- overriding here (rather than
      // validating the two match) means a stray/stale siteId in the body can never disagree
      // with the URL's, since the URL's is the only one that ever reaches createJob.
      ({ jobId } = await createJob({ ...data, siteId }));
    } catch (error) {
      if (error.message.startsWith('Invalid request')) {
        log.warn(`Invalid request data: ${error.message}`);
        return badRequest(error.message);
      }
      log.error(`Failed to queue OAE validation job: ${error.message}`);
      return internalServerError('Failed to create OAE validation job');
    }
    return accepted({ jobId });
  };

  /**
   * Gets the full per-suggestion data for a job.
   * @param {Object} context - The request context
   * @param {Object} context.params - { siteId, jobId }
   * @returns {Promise<Object>} The HTTP response object
   */
  const getValidationJob = async (context) => {
    const jobId = context.params?.jobId;
    const siteId = context.params?.siteId;

    if (!isValidUUID(jobId)) {
      log.warn(`Invalid jobId: ${jobId}`);
      return badRequest('Invalid jobId');
    }
    if (!isValidUUID(siteId)) {
      log.warn(`Invalid siteId: ${siteId}`);
      return badRequest('Invalid siteId');
    }

    try {
      const job = await oaeValidationJobs.getJob(jobId);

      if (!job) {
        return notFound('Job not found');
      }

      // Resource-level scoping: OaeValidation rows carry no siteId of their own, so the
      // owning site is resolved via one of the job's suggestions -> its opportunity -> its
      // site, and compared against the URL's siteId -- the URL's siteId alone is caller-
      // controlled and can't be trusted for access control by itself (a caller with access to
      // their own site could otherwise view a different site's job by naming their own siteId
      // in the URL alongside someone else's jobId). Fail closed (404, no existence disclosure)
      // if any hop can't be resolved or the sites don't match -- same philosophy as
      // loadJobScopedToCaller (support/async-job-access.js). Once resolved to a real, matching
      // site, an access-control failure is a distinct 403 -- the job's existence is no longer
      // a secret at that point, so there's nothing left to hide by returning 404 instead.
      const { Suggestion, Opportunity, Site } = dataAccess;
      const [firstResult] = job.suggestions;
      const suggestion = firstResult && await Suggestion.findById(firstResult.suggestionId);
      const opportunity = suggestion && await Opportunity.findById(suggestion.getOpportunityId());
      const site = opportunity && await Site.findById(opportunity.getSiteId());

      if (!site || site.getId() !== siteId) {
        return notFound('Job not found');
      }

      const accessControlUtil = AccessControlUtil.fromContext(context);
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }

      return ok(job);
    } catch (error) {
      log.error(`Failed to get OAE validation job: ${error.message}`);
      return internalServerError('Failed to get OAE validation job');
    }
  };

  return {
    createValidationJob,
    getValidationJob,
    createJob,
  };
}

export default OaeValidationController;
