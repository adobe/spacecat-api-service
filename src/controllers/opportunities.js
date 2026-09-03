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
import { Opportunity as OpportunityModel } from '@adobe/spacecat-shared-data-access';
import { OpportunityDto } from '../dto/opportunity.js';
import { isValidLocale } from '../utils/validations.js';
import { applyFieldProjection } from '../utils/field-projection.js';
import { lookupByUrl } from '../support/lookup-by-url.js';
import AccessControlUtil from '../support/access-control-util.js';
import { filterOpportunitiesByFacsComposite } from '../support/facs-composite-resolvers.js';
import {
  grantSuggestionsForOpportunity,
  revokeExistingGrants,
  revokeGrantsForOpportunity,
} from '../support/grant-suggestions-handler.js';
import { getIsSummitPlgEnabled } from '../support/utils.js';

const VALIDATION_ERROR_NAME = 'ValidationError';
const SUMMIT_PLG_ALLOWED_TYPES = ['broken-backlinks', 'cwv', 'alt-text'];

// Lightweight default projection for the by-url lookup (omits the heavy `data` blob;
// callers opt in via `fields=...,data`).
const OPPORTUNITY_BY_URL_LIGHTWEIGHT_FIELDS = ['id', 'type', 'status', 'title', 'updatedAt'];

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
    if (await getIsSummitPlgEnabled(site, ctx, requestContext, accessControlUtil)) {
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
    const summitFiltered = await filterForSummitPlg(site, allOpptys, context);
    // D4: narrow to the caller's ReBAC-permitted opportunity types (composite key).
    const opptys = filterOpportunitiesByFacsComposite(context, summitFiltered)
      .map((oppty) => OpportunityDto.toJSON(oppty, locale));

    const { list, error } = applyFieldProjection(opptys, context.data?.fields);
    if (error) {
      return badRequest(error);
    }
    return ok(list);
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
    const summitFiltered = await filterForSummitPlg(site, allOpptys, context);
    // D4: narrow to the caller's ReBAC-permitted opportunity types (composite key).
    const opptys = filterOpportunitiesByFacsComposite(context, summitFiltered)
      .map((oppty) => OpportunityDto.toJSON(oppty, locale));

    const { list, error } = applyFieldProjection(opptys, context.data?.fields);
    if (error) {
      return badRequest(error);
    }
    return ok(list);
  };

  /**
   * Looks up opportunities backed by any of the supplied source URLs, across all of the site's
   * opportunity types. POST body: `{ urls: [...], fields?, status?, limit?, cursor? }`
   * (query params are dropped for a JSON body, so all params travel in the body — mirrors the
   * agentic-traffic hits-by-urls endpoint). See lookup-service-api-design.md, Milestone 1.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Normalized results + opportunities map + pagination.
   */
  const getByUrl = async (context) => {
    const siteId = context.params?.siteId;
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

    const postgrestClient = dataAccess.services?.postgrestClient;
    if (!postgrestClient) {
      return createResponse({ message: 'URL lookup is not available' }, 500);
    }

    const { response, error } = await lookupByUrl(postgrestClient, {
      table: 'opportunity_urls',
      siteId,
      rawUrls: context.data?.urls,
      params: context.data ?? {},
      validStatuses: Object.values(OpportunityModel.STATUSES),
      defaultExcludedStatuses: [OpportunityModel.STATUSES.IGNORED],
      fetchEntities: async (ids) => {
        const { data } = await Opportunity.batchGetByKeys(ids.map((id) => ({ opportunityId: id })));
        return data ?? [];
      },
      // Narrow to what the caller may see, exactly like getAllForSite/getByStatus:
      // Summit-PLG type gating + D4 FACS composite (per-opportunity-type ReBAC).
      filterEntities: async (opptys) => filterOpportunitiesByFacsComposite(
        context,
        await filterForSummitPlg(site, opptys, context),
      ),
      getId: (oppty) => oppty.getId(),
      getStatus: (oppty) => oppty.getStatus(),
      getSortKey: (oppty) => oppty.getId(),
      toFullDto: (oppty) => OpportunityDto.toJSON(oppty),
      lightweightFields: OPPORTUNITY_BY_URL_LIGHTWEIGHT_FIELDS,
      forceFields: ['id'],
      idListKey: 'opportunityIds',
      mapKey: 'opportunities',
      includeNoMatchInResults: true,
      includeUnmatchedUrls: false,
    });
    if (error) {
      return badRequest(error);
    }
    return ok(response);
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
    if (await getIsSummitPlgEnabled(site, ctx, context, accessControlUtil)) {
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
    let isResolving = false;
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
        isResolving = status === OpportunityModel.STATUSES.RESOLVED;
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

        if (isResolving) {
          try {
            // No requestContext: revocation must apply regardless of the caller
            // (UI or backend-initiated resolve), unlike the UI-only PLG filtering above.
            if (await getIsSummitPlgEnabled(site, ctx)) {
              await revokeExistingGrants(dataAccess, updatedOppty);
            }
          /* c8 ignore next 3 */
          } catch (err) {
            ctx.log?.warn?.(`Revoke existing grants handler failed for opportunity ${opportunityId} on site ${siteId}`, err?.message ?? err);
          }
        }

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
      await revokeGrantsForOpportunity(dataAccess, opportunity);
    } catch (revokeError) {
      ctx.log?.warn?.(`Failed to revoke grants for opportunity ${opportunityId} on site ${siteId}`, revokeError?.message ?? revokeError);
    }

    try {
      await opportunity.remove(); // also removes suggestions associated with opportunity
      return noContent();
    } catch (e) {
      return handleDataAccessError(e, 'Error removing opportunity');
    }
  };

  return {
    createOpportunity,
    getAllForSite,
    getByID,
    getByStatus,
    getByUrl,
    patchOpportunity,
    removeOpportunity,
  };
}

export default OpportunitiesController;
