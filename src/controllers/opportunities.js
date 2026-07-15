/*
 * Copyright 2023 Adobe. All rights reserved.
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
  notFound,
  ok,
  createResponse,
  noContent,
  forbidden,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isObject,
  isNonEmptyObject,
  arrayEquals,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { OpportunityDto } from '../dto/opportunity.js';
import { isValidLocale } from '../utils/validations.js';
import AccessControlUtil from '../support/access-control-util.js';
import { grantSuggestionsForOpportunity } from '../support/grant-suggestions-handler.js';
import { getIsSummitPlgEnabled } from '../support/utils.js';

const VALIDATION_ERROR_NAME = 'ValidationError';
const SUMMIT_PLG_ALLOWED_TYPES = ['broken-backlinks', 'cwv', 'alt-text'];
const PRERENDER_VALIDATION_STATUSES = [
  'in_progress',
  'completed_success',
  'completed_fail',
  'error',
];
// Internal llmo-prerender-api host — the service that actually runs the S3-vs-Lambda
// comparison. Overridable via PRERENDER_VALIDATION_RUN_BASE_URL for other environments.
const DEFAULT_PRERENDER_VALIDATION_RUN_BASE_URL = 'https://sj1010010249075.corp.adobe.com';

/**
 * Opportunities controller.
 * @param {object} ctx - Context of the request.
 * @returns {object} Opportunities controller.
 * @constructor
 */
function OpportunitiesController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }
  const { Opportunity } = dataAccess;
  if (!isObject(Opportunity)) {
    throw new Error('Opportunity Collection not available');
  }

  const { Site } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Filters opportunities to only PLG-allowed types when summit PLG is enabled for the site.
   * @param {Object} site - Site entity
   * @param {Array} opportunities - Array of opportunity entities
   * @returns {Promise<Array>} Filtered (or unfiltered) opportunities
   */
  async function filterForSummitPlg(site, opportunities, requestContext) {
    if (await getIsSummitPlgEnabled(site, ctx, requestContext)) {
      return opportunities.filter(
        (oppty) => SUMMIT_PLG_ALLOWED_TYPES.includes(oppty.getType()),
      );
    }
    return opportunities;
  }

  /**
   * returns a response for a data access error.
   * If there's a ValidationError it will return a 400 response, and the
   * validation error message coming from the data access layer.
   * If there's another kind of error, it will return a 500 response.
   * The error message in the 500 response is overriden by passing the message parameter
   * to avoid exposing internal error messages to the client.
   * @param {*} e - error
   * @param {*} message - error message to override 500 error messages
   * @returns a response
   */
  function handleDataAccessError(e, message) {
    if (e?.name === VALIDATION_ERROR_NAME) {
      return badRequest(e.message);
    }
    return createResponse({ message }, 500);
  }

  /**
   * Gets all opportunities for a given site.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of opportunities response.
   */
  const getAllForSite = async (context) => {
    const siteId = context.params?.siteId;
    const locale = context.data?.locale ?? null;

    if (!isValidLocale(locale)) {
      return badRequest('Invalid locale format');
    }

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can view its opportunities');
    }

    const allOpptys = await Opportunity.allBySiteId(siteId);
    const opptys = (await filterForSummitPlg(site, allOpptys, context))
      .map((oppty) => OpportunityDto.toJSON(oppty, locale));

    return ok(opptys);
  };

  /**
   * Gets all opportunities for a given site type filtering by status.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of opportunities response.
   */
  const getByStatus = async (context) => {
    const siteId = context.params?.siteId;
    const status = context.params?.status;
    const locale = context.data?.locale ?? null;

    if (!isValidLocale(locale)) {
      return badRequest('Invalid locale format');
    }

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!hasText(status)) {
      return badRequest('Status required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can view its opportunities');
    }

    const allOpptys = await Opportunity.allBySiteIdAndStatus(siteId, status);
    const opptys = (await filterForSummitPlg(site, allOpptys, context))
      .map((oppty) => OpportunityDto.toJSON(oppty, locale));

    return ok(opptys);
  };

  /**
   * Gets an opportunity for a given site type and opportunity ID.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Opportunity response.
   */
  const getByID = async (context) => {
    const siteId = context.params?.siteId;
    const opptyId = context.params?.opportunityId;
    const locale = context.data?.locale ?? null;

    if (!isValidLocale(locale)) {
      return badRequest('Invalid locale format');
    }

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opptyId)) {
      return badRequest('Opportunity ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can view its opportunities');
    }

    const oppty = await Opportunity.findById(opptyId);
    if (!oppty || oppty.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }
    if (await getIsSummitPlgEnabled(site, ctx, context)) {
      try {
        await grantSuggestionsForOpportunity(dataAccess, site, oppty);
      /* c8 ignore next 3 */
      } catch (err) {
        ctx.log?.warn?.('Grant suggestions handler failed', err?.message ?? err);
      }
    }
    return ok(OpportunityDto.toJSON(oppty, locale));
  };

  /**
   * Creates an opportunity
   * @param {Object} context of the request
   * @return {Promise<Response>} Opportunity response.
   */
  const createOpportunity = async (context) => {
    const siteId = context.params?.siteId;
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isNonEmptyObject(context.data)) {
      return badRequest('No data provided');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can create its opportunities');
    }

    context.data.siteId = siteId;
    try {
      const oppty = await Opportunity.create(context.data);
      return createResponse(OpportunityDto.toJSON(oppty), 201);
    } catch (e) {
      return handleDataAccessError(e, 'Error creating opportunity');
    }
  };

  /**
   * Updates data for an opportunity
   * @param {Object} context of the request
   * @returns {Promise<Response>} the updated opportunity data
   */
  const patchOpportunity = async (context) => {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;
    const { authInfo: { profile } } = context.attributes;

    // validate parameters
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can edit its opportunities');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }
    // validate request body
    if (!isNonEmptyObject(context.data)) {
      return badRequest('No updates provided');
    }

    // eslint-disable-next-line object-curly-newline
    const { auditId, runbook, data, title, description, status, guidance, tags } = context.data;
    // update opportunity with new data
    let hasUpdates = false;
    try {
      if (auditId && auditId !== opportunity.getAuditId()) {
        hasUpdates = true;
        opportunity.setAuditId(auditId);
      }
      if (runbook && runbook !== opportunity.getRunbook()) {
        hasUpdates = true;
        opportunity.setRunbook(runbook);
      }
      if (isNonEmptyObject(data)) {
        hasUpdates = true;
        opportunity.setData(data);
      }

      if (title && title !== opportunity.getTitle()) {
        hasUpdates = true;
        opportunity.setTitle(title);
      }
      if (description && description !== opportunity.getDescription()) {
        hasUpdates = true;
        opportunity.setDescription(description);
      }
      if (status && status !== opportunity.getStatus()) {
        hasUpdates = true;
        opportunity.setStatus(status);
      }
      if (isNonEmptyObject(guidance)) {
        hasUpdates = true;
        opportunity.setGuidance(guidance);
      }
      if (tags && !arrayEquals(tags, opportunity.getTags())) {
        hasUpdates = true;
        opportunity.setTags(tags);
      }
      if (hasUpdates) {
        opportunity.setUpdatedBy(profile.email || 'system');
        const updatedOppty = await opportunity.save(opportunity);
        return ok(OpportunityDto.toJSON(updatedOppty));
      }
    } catch (e) {
      return handleDataAccessError(e, 'Error updating opportunity');
    }
    return badRequest('No updates provided');
  };

  /**
   * Removes an opportunity.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Delete response.
   */
  const removeOpportunity = async (context) => {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can remove its opportunities');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    try {
      await opportunity.remove(); // also removes suggestions associated with opportunity
      return noContent();
    } catch (e) {
      return handleDataAccessError(e, 'Error removing opportunity');
    }
  };

  /**
   * Merges prerender-validation lifecycle state into an opportunity's data.
   * Only `data.prerenderValidation` is updated — all other `data` fields are
   * preserved (server-side merge), so external callers cannot clobber the data
   * written by the prerender audit.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Updated opportunity response.
   */
  const patchPrerenderValidation = async (context) => {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;
    const { authInfo: { profile } } = context.attributes;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can edit its opportunities');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    if (!isNonEmptyObject(context.data)) {
      return badRequest('No updates provided');
    }

    const {
      status, startedAt, completedAt, reason,
    } = context.data;
    if (!hasText(status) || !PRERENDER_VALIDATION_STATUSES.includes(status)) {
      return badRequest(`status must be one of: ${PRERENDER_VALIDATION_STATUSES.join(', ')}`);
    }
    // Matches full ISO 8601 date-time with a timezone designator (Z or ±HH:mm) — Date.parse
    // alone is too permissive (accepts "Tuesday", "1", etc.), so the regex gates it first.
    const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
    const isValidTimestamp = (v) => v === null
      || (typeof v === 'string' && ISO_8601_REGEX.test(v) && !Number.isNaN(Date.parse(v)));
    if (startedAt !== undefined && !isValidTimestamp(startedAt)) {
      return badRequest('startedAt must be a valid ISO 8601 date string or null');
    }
    if (completedAt !== undefined && !isValidTimestamp(completedAt)) {
      return badRequest('completedAt must be a valid ISO 8601 date string or null');
    }
    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      return badRequest('reason must be a string or null');
    }

    try {
      const currentData = opportunity.getData() || {};
      const prerenderValidation = { ...currentData.prerenderValidation, status };
      if (startedAt !== undefined) {
        prerenderValidation.startedAt = startedAt;
      }
      if (completedAt !== undefined) {
        prerenderValidation.completedAt = completedAt;
      }
      // Unlike startedAt/completedAt, reason is tied to the CURRENT status, not
      // something to carry over — always set it (to null when absent) so a stale
      // failure reason from a previous run can't leak into a later success.
      prerenderValidation.reason = reason !== undefined ? reason : null;

      opportunity.setData({ ...currentData, prerenderValidation });
      opportunity.setUpdatedBy(profile.email || 'system');
      const updatedOppty = await opportunity.save(opportunity);
      return ok(OpportunityDto.toJSON(updatedOppty));
    } catch (e) {
      return handleDataAccessError(e, 'Error updating prerender validation');
    }
  };

  /**
   * Triggers a new prerender-validation comparison run for the site by forwarding
   * to the internal llmo-prerender-api service's POST /api/compare/run. The
   * caller's own Authorization header is forwarded as-is — this endpoint does not
   * hold its own credential for the internal service.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} The upstream service's response, passed through.
   */
  const runPrerenderValidation = async (context) => {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can trigger its opportunities');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    const {
      maxPages, customUrls, checkAuditAge, enableAiAnalysis,
    } = context.data || {};
    const baseUrl = context.env?.PRERENDER_VALIDATION_RUN_BASE_URL
      || DEFAULT_PRERENDER_VALIDATION_RUN_BASE_URL;

    // No credentials are forwarded here — the upstream service authorizes this call by
    // source IP (spacecat-api-service's own outbound egress IPs are allowlisted there),
    // not by a caller-supplied token. See docs/specs/2026-07-13-prerender-validation-
    // native-comparison.md for why this replaced token-forwarding.
    let upstream;
    try {
      upstream = await fetch(`${baseUrl}/api/compare/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          siteId,
          ...(maxPages !== undefined ? { maxPages } : {}),
          ...(customUrls !== undefined ? { customUrls } : {}),
          ...(checkAuditAge !== undefined ? { checkAuditAge } : {}),
          ...(enableAiAnalysis !== undefined ? { enableAiAnalysis } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      return createResponse(
        { error: 'prerenderValidationServiceUnreachable', message: e.message },
        502,
      );
    }

    const body = await upstream.json().catch(() => ({}));
    return createResponse(body, upstream.status);
  };

  return {
    createOpportunity,
    getAllForSite,
    getByID,
    getByStatus,
    patchOpportunity,
    patchPrerenderValidation,
    runPrerenderValidation,
    removeOpportunity,
  };
}

export default OpportunitiesController;
