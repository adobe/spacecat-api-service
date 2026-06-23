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
/* eslint-disable no-use-before-define */

/**
 * @import {
 *   FixEntity,
 *   FixEntityCollection,
 *   OpportunityCollection,
 *   SiteCollection,
 *   SuggestionCollection
 * } from "@adobe/spacecat-shared-data-access"
 */

import {
  badRequest,
  createResponse,
  forbidden,
  noContent,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
// eslint-disable-next-line import/no-extraneous-dependencies -- listed in package.json dependencies
import { ContentClient } from '@adobe/spacecat-shared-content-client';
import {
  hasText, isArray, isIsoDate, isNonEmptyObject, isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { FixEntity as FixEntityModel } from '@adobe/spacecat-shared-data-access';
import AccessControlUtil from '../support/access-control-util.js';
import { FixDto } from '../dto/fix.js';
import { SuggestionDto } from '../dto/suggestion.js';
import { resolveDocumentPath } from '../support/document-path-resolver.js';
import { getIMSPromiseToken, exchangePromiseToken } from '../support/utils.js';

const VALIDATION_ERROR_NAME = 'ValidationError';

// Only pass IMS-format IDs to the admin profile API. Rejects legacy or malformed
// values that could have been stored before the server-side derivation fix, closing
// the residual PII exfiltration path for pre-fix data.
const IMS_ID_RE = /^[A-Za-z0-9]+@(AdobeID|AdobeOrg|Email|AdobeServices|[0-9a-fA-F]{24})$/;
const IMS_ENRICH_BATCH_SIZE = 5;

/**
 * @typedef {Object} DataAccess
 * @property {FixEntityCollection} FixEntity
 * @property {OpportunityCollection} Opportunity
 * @property {SuggestionCollection} Suggestion
 *
 * @typedef {Object} LambdaContext
 * @property {DataAccess} dataAccess
 *
 * @typedef {Object} RequestContext
 * @property {Object.<string, undefined | null | boolean | number | string>} [params]
 * @property {any} [data]
 */

export class FixesController {
  /** @type {FixEntityCollection} */
  #FixEntity;

  /** @type {OpportunityCollection} */
  #Opportunity;

  /** @type {SiteCollection} */
  #Site;

  /** @type {SuggestionCollection} */
  #Suggestion;

  #imsClient;

  /** @type {AccessControlUtil} */
  #accessControl;

  /** @type {LambdaContext} */
  #ctx;

  /**
   * @param {LambdaContext} ctx
   * @param {AccessControlUtil} [accessControl]
   */
  constructor(ctx, accessControl = new AccessControlUtil(ctx)) {
    const { dataAccess } = ctx;
    this.#ctx = ctx;
    this.#FixEntity = dataAccess.FixEntity;
    this.#Opportunity = dataAccess.Opportunity;
    this.#Site = dataAccess.Site;
    this.#Suggestion = dataAccess.Suggestion;
    this.#imsClient = ctx.imsClient;
    this.#accessControl = accessControl;
  }

  /**
   * Gets all suggestions for a given site and opportunity.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getAllForOpportunity(context) {
    const { siteId, opportunityId } = context.params;
    const { fixCreatedDate } = context.data || {};

    let res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) {
      return res;
    }

    let fixEntities = [];
    let fixes = [];

    if (hasText(fixCreatedDate)) {
      // Fetch all fixes with suggestions then filter in-memory by
      // executedAt ?? createdAt date. The previous approach used the junction
      // table (getAllFixesWithSuggestionByCreatedAt) which stores the date at
      // fix-creation time when executedAt is still null. Once the deploy
      // completes and executedAt is updated, the junction date no longer
      // matches the UI accordion key (which uses executedAt), causing the
      // accordion to show empty even though fixes exist.
      const allFixesWithSuggestions = await this.#FixEntity
        .getAllFixesWithSuggestionsByOpportunityId(opportunityId);

      // Validate opportunity-site ownership before filtering/early return. Use the
      // unfiltered result (or Opportunity.findById fallback) so an opportunity from
      // a different site returns 404 even when no fix matches the requested date.
      res = await checkOwnership(
        allFixesWithSuggestions[0]?.fixEntity,
        opportunityId,
        siteId,
        this.#Opportunity,
      );
      if (res) {
        return res;
      }

      const fixEntitiesWithSuggestions = allFixesWithSuggestions.filter(({ fixEntity }) => {
        const ts = fixEntity.getExecutedAt() ?? fixEntity.getCreatedAt();
        const d = ts ? new Date(ts) : null;
        return d && !Number.isNaN(d.getTime()) && d.toISOString().split('T')[0] === fixCreatedDate;
      });

      if (fixEntitiesWithSuggestions.length === 0) {
        return ok([]);
      }

      // Extract fix entities and attach suggestions to each one
      fixEntities = fixEntitiesWithSuggestions.map((item) => {
        const { fixEntity } = item;
        // Attach suggestions to the fixEntity for DTO conversion
        // eslint-disable-next-line no-underscore-dangle
        fixEntity._suggestions = item.suggestions;
        return fixEntity;
      });

      await this.#enrichFixesWithUserNames(fixEntities);
      fixes = fixEntities.map((fix) => FixDto.toJSON(fix));
      return ok(fixes);
    }

    const fixEntitiesWithSuggestions = await this.#FixEntity
      .getAllFixesWithSuggestionsByOpportunityId(opportunityId);

    // Validate opportunity-site ownership before any early return. checkOwnership
    // falls back to Opportunity.findById when no fix is passed, so the empty-result
    // case still returns 404 for an opportunity belonging to a different site.
    res = await checkOwnership(
      fixEntitiesWithSuggestions[0]?.fixEntity,
      opportunityId,
      siteId,
      this.#Opportunity,
    );
    if (res) {
      return res;
    }

    if (fixEntitiesWithSuggestions.length === 0) {
      return ok([]);
    }

    fixEntities = fixEntitiesWithSuggestions.map((item) => {
      const { fixEntity } = item;
      // eslint-disable-next-line no-underscore-dangle
      fixEntity._suggestions = item.suggestions;
      return fixEntity;
    });

    await this.#enrichFixesWithUserNames(fixEntities);
    fixes = fixEntities.map((fix) => FixDto.toJSON(fix));
    return ok(fixes);
  }

  /**
   * Gets all suggestions for a given site, opportunity and status.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getByStatus(context) {
    const { siteId, opportunityId, status } = context.params;
    let res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) {
      return res;
    }

    if (!hasText(status)) {
      return badRequest('Status is required');
    }

    const fixEntities = await this.#FixEntity.allByOpportunityIdAndStatus(opportunityId, status);
    res = await checkOwnership(fixEntities[0], opportunityId, siteId, this.#Opportunity);
    if (res) {
      return res;
    }

    // executedByUser enrichment is intentionally omitted here; call getAllForOpportunity
    // when resolved user details are required.
    return ok(fixEntities.map((fix) => FixDto.toJSON(fix)));
  }

  /**
   * Get a suggestion given a site, opportunity and suggestion ID
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Suggestion response.
   */
  async getByID(context) {
    const { siteId, opportunityId, fixId } = context.params;

    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) {
      return res;
    }

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) {
      return notFound('Fix not found');
    }
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) {
      return res;
    }

    await this.#enrichFixesWithUserNames([fix]);
    return ok(FixDto.toJSON(fix));
  }

  /**
   * Gets all suggestions for a given fix.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getAllSuggestionsForFix(context) {
    const { siteId, opportunityId, fixId } = context.params;

    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) {
      return res;
    }

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) {
      return notFound('Fix not found');
    }
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) {
      return res;
    }

    const suggestions = await fix.getSuggestions();
    const results = await Promise.all(suggestions.map(async (s) => {
      const opportunity = await s.getOpportunity();
      return SuggestionDto.toJSON(s, 'full', opportunity);
    }));
    return ok(results);
  }

  /**
   * Creates one or more fixes for a given site and opportunity.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of fixes response.
   */
  async createFixes(context) {
    const { siteId, opportunityId } = context.params;

    let res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) {
      return res;
    }

    res = await checkOwnership(null, opportunityId, siteId, this.#Opportunity);
    if (res) {
      return res;
    }

    if (!Array.isArray(context.data)) {
      return context.data ? badRequest('Request body must be an array') : badRequest('No updates provided');
    }

    const log = this.#ctx.log || console;

    const callerUserId = FixesController.#resolveCallerId(context);

    const anySuppliedExecutedBy = context.data.some((d) => hasText(d.executedBy));
    if (anySuppliedExecutedBy && !hasText(callerUserId)) {
      log.warn('createFixes: executedBy intent signal present but caller identity is unresolvable; executedBy will not be set');
    }

    // Pre-fetch site and opportunity info for documentPath enrichment of manual fixes
    const enrichmentCtx = await this.#prepareDocumentPathEnrichment(
      context.data,
      siteId,
      opportunityId,
      log,
    );
    const FixEntity = this.#FixEntity;
    const fixes = await Promise.all(context.data.map(async (fixData, index) => {
      try {
        const enrichedFixData = await FixesController.#enrichWithDocumentPath(
          fixData,
          enrichmentCtx,
          log,
        );

        // Strip any client-supplied executedBy unconditionally so it cannot pass through
        // when callerUserId is unresolvable. When identity is known, callerUserId wins.
        const safeFixData = { ...enrichedFixData };
        delete safeFixData.executedBy;

        const fixEntity = await FixEntity.create({
          ...safeFixData,
          opportunityId,
          ...(hasText(callerUserId) && { executedBy: callerUserId }),
        });
        if (fixData.suggestionIds) {
          const suggestions = await Promise.all(
            fixData.suggestionIds.map((id) => this.#Suggestion.findById(id)),
          );
          await FixEntity.setSuggestionsForFixEntity(opportunityId, fixEntity, suggestions);
        }
        return {
          index,
          fix: FixDto.toJSON(fixEntity),
          statusCode: 201,
        };
      } catch (error) {
        return {
          index,
          message: error.message,
          statusCode: error?.name === VALIDATION_ERROR_NAME ? /* c8 ignore next */ 400 : 500,
        };
      }
    }));
    const succeeded = countSucceeded(fixes);
    return createResponse({
      fixes,
      metadata: {
        total: fixes.length,
        success: succeeded,
        failed: fixes.length - succeeded,
      },
    }, 207);
  }

  /**
   * Prepares context for documentPath enrichment by pre-fetching site and opportunity.
   * Only performs lookups when at least one fix in the batch is a manual fix (origin: 'aso')
   * that doesn't already have a documentPath.
   * For AEM Edge sites, also creates ContentClient when deliveryType is 'aem_edge'.
   * @returns {Promise<{site, opportunityType, bearerToken, contentClient?}|null>}
   */
  async #prepareDocumentPathEnrichment(fixDataArray, siteId, opportunityId, log) {
    const needsEnrichment = fixDataArray.some(
      (fixData) => fixData.origin === 'aso' && !fixData.changeDetails?.documentPath,
    );
    if (!needsEnrichment) {
      return null;
    }

    try {
      const [site, opportunity] = await Promise.all([
        this.#Site.findById(siteId),
        this.#Opportunity.findById(opportunityId),
      ]);

      if (!site || !opportunity) {
        return null;
      }
      const promiseTokenResponse = await getIMSPromiseToken(this.#ctx);
      const imsAccessToken = await exchangePromiseToken(
        this.#ctx,
        promiseTokenResponse.promise_token,
      );
      const bearerToken = `Bearer ${imsAccessToken}`;
      const enrichmentCtx = {
        site,
        opportunityType: opportunity.getType(),
        bearerToken,
      };

      if (site.getDeliveryType() === 'aem_edge') {
        try {
          enrichmentCtx.contentClient = await ContentClient.createFrom(this.#ctx, site);
        } catch (contentClientErr) {
          log.warn(
            `Could not create ContentClient for AEM Edge documentPath enrichment: ${contentClientErr.message}`,
          );
        }
      }

      return enrichmentCtx;
    } catch (e) {
      log.warn(`Could not prepare documentPath enrichment: ${e.message}`);
      return null;
    }
  }

  /**
   * Enriches a fix data object with documentPath when it's a manual fix without one.
   * Returns the original fixData unchanged if enrichment is not needed or fails.
   */
  static async #enrichWithDocumentPath(fixData, enrichmentCtx, log) {
    if (!enrichmentCtx) {
      return fixData;
    }
    if (fixData.origin !== 'aso') {
      return fixData;
    }
    if (fixData.changeDetails?.documentPath) {
      return fixData;
    }

    const {
      site, opportunityType, bearerToken, contentClient,
    } = enrichmentCtx;
    const documentPath = await resolveDocumentPath(
      site,
      opportunityType,
      fixData.changeDetails,
      bearerToken,
      log,
      contentClient ?? undefined, // used for AEM Edge
    );

    if (!documentPath) {
      return fixData;
    }

    return {
      ...fixData,
      changeDetails: { ...fixData.changeDetails, documentPath },
    };
  }

  /**
   * Update the status of one or multiple fixes in one transaction
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} the updated opportunity data
   */
  async patchFixesStatus(context) {
    const { siteId, opportunityId } = context.params;

    const res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) {
      return res;
    }

    if (!Array.isArray(context.data)) {
      return (
        context.data
          ? badRequest('Request body must be an array of [{ id: <fix id>, status: <fix status> },...]')
          : badRequest('No updates provided')
      );
    }

    const fixes = await Promise.all(
      context.data.map(
        (data, index) => this.#patchFixStatus(data.id, data.status, index, opportunityId, siteId),
      ),
    );
    const succeeded = countSucceeded(fixes);
    return createResponse({
      fixes,
      metadata: { total: fixes.length, success: succeeded, failed: fixes.length - succeeded },
    }, 207);
  }

  async #patchFixStatus(uuid, status, index, opportunityId, siteId) {
    if (!hasText(uuid)) {
      return {
        index,
        uuid: '',
        message: 'fix id is required',
        statusCode: 400,
      };
    }
    if (!hasText(status)) {
      return {
        index,
        uuid,
        message: 'fix status is required',
        statusCode: 400,
      };
    }

    const fix = await this.#FixEntity.findById(uuid);
    const res = fix
      ? await checkOwnership(fix, opportunityId, siteId, this.#Opportunity)
      : notFound('Fix not found');
    if (res) {
      return {
        index,
        uuid,
        message: await res.json().then(({ message }) => message),
        statusCode: res.status,
      };
    }

    try {
      if (fix.getStatus() === status) {
        return {
          index, uuid, message: 'No updates provided', statusCode: 400,
        };
      }

      fix.setStatus(status);
      return {
        index, uuid, fix: FixDto.toJSON(await fix.save()), statusCode: 200,
      };
    } catch (error) {
      const statusCode = error?.name === VALIDATION_ERROR_NAME ? /* c8 ignore next */ 400 : 500;
      return {
        index, uuid, message: error.message, statusCode,
      };
    }
  }

  /**
   * Updates data for a fix.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} the updated fix data
   */
  async patchFix(context) {
    const { siteId, opportunityId, fixId } = context.params;
    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) {
      return res;
    }

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) {
      return notFound('Fix not found');
    }
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) {
      return res;
    }

    if (!context.data) {
      return badRequest('No updates provided');
    }

    const {
      executedBy, executedAt, publishedAt, changeDetails, suggestionIds, origin,
    } = context.data;

    const Suggestion = this.#Suggestion;
    let hasUpdates = false;
    try {
      if (isArray(suggestionIds)) {
        const suggestions = await Promise.all(suggestionIds.map((id) => Suggestion.findById(id)));
        if (suggestions.some((s) => !s || s.getOpportunityId() !== opportunityId)) {
          return badRequest('Invalid suggestion IDs');
        }
        await this.#FixEntity.setSuggestionsForFixEntity(opportunityId, fix, suggestions);
        hasUpdates = true;
      }

      if (hasText(executedBy)) {
        // Client signals intent to record the executor. Always resolve the actual value
        // from the authenticated caller's identity; the client-supplied string is ignored.
        const callerUserId = FixesController.#resolveCallerId(context);
        if (!hasText(callerUserId)) {
          return badRequest('executedBy requires an authenticated session with a resolvable user identity');
        }
        if (callerUserId !== fix.getExecutedBy()) {
          fix.setExecutedBy(callerUserId);
        }
        // The intent signal itself counts as an update even if the resolved value
        // is already stored (idempotent re-assertion of the executor).
        hasUpdates = true;
      }

      if (executedAt !== fix.getExecutedAt() && isIsoDate(executedAt)) {
        fix.setExecutedAt(executedAt);
        hasUpdates = true;
      }

      if (publishedAt !== fix.getPublishedAt() && isIsoDate(publishedAt)) {
        fix.setPublishedAt(publishedAt);
        hasUpdates = true;
      }

      if (isNonEmptyObject(changeDetails)) {
        fix.setChangeDetails(changeDetails);
        hasUpdates = true;
      }

      if (origin !== fix.getOrigin() && hasText(origin)) {
        fix.setOrigin(origin);
        hasUpdates = true;
      }

      if (hasUpdates) {
        return ok(FixDto.toJSON(await fix.save()));
      } else {
        return badRequest('No updates provided');
      }
    } catch (e) {
      return e?.name === VALIDATION_ERROR_NAME
        ? /* c8 ignore next */ badRequest(e.message)
        : createResponse({ message: 'Error updating fix' }, 500);
    }
  }

  /**
   * Removes a fix
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>}
   */
  async removeFix(context) {
    const { siteId, opportunityId, fixId } = context.params;

    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) {
      return res;
    }

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) {
      return notFound('Fix not found');
    }
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) {
      return res;
    }

    try {
      await fix.remove();
      return noContent();
    } catch (e) {
      return createResponse({ message: `Error removing fix: ${e.message}` }, 500);
    }
  }

  /**
   * Rolls back a failed fix: marks the Fix as ROLLED_BACK and all linked
   * suggestions as SKIPPED. Uses two sequential updates (fix entity, then
   * bulk suggestion status); no single transaction.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} the updated fix and suggestions data
   */
  async rollbackFailedFix(context) {
    const { siteId, opportunityId, fixId } = context.params;

    // Validate request params and access
    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) {
      return res;
    }

    // Find the fix
    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) {
      return notFound('Fix not found');
    }

    // Check ownership
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) {
      return res;
    }

    // Validate fix is in FAILED status
    const currentFixStatus = fix.getStatus();
    if (currentFixStatus !== FixEntityModel.STATUSES.FAILED) {
      return badRequest(`Fix cannot be rolled back: current status is '${currentFixStatus}', expected 'FAILED'`);
    }

    try {
      fix.setStatus(FixEntityModel.STATUSES.ROLLED_BACK);
      await fix.save();

      // Step 2: Get linked suggestions and bulk update their status to SKIPPED
      const suggestions = await this.#FixEntity.getSuggestionsByFixEntityId(fixId);
      if (Array.isArray(suggestions) && suggestions.length > 0) {
        try {
          await this.#Suggestion.bulkUpdateStatus(suggestions, 'SKIPPED');
        } catch (bulkError) {
          // Revert fix status so retry can succeed (same pattern as initial update)
          try {
            fix.setStatus(currentFixStatus);
            await fix.save();
          } catch (revertError) {
            // Log but don't mask the original error
            context.log?.error?.('Failed to revert fix status after suggestion update failure', {
              fixId,
              revertError: revertError?.message,
            });
          }
          throw bulkError;
        }
      }

      // suggestions already has updated status from bulkUpdateStatus when length > 0; else []
      const updatedSuggestions = suggestions;
      const updatedFix = fix;

      return ok({
        fix: {
          index: 0,
          uuid: updatedFix.getId(),
          fix: FixDto.toJSON(updatedFix),
          statusCode: 200,
        },
        suggestions: {
          updated: updatedSuggestions.map((suggestion, index) => ({
            index,
            uuid: suggestion.getId(),
            suggestion: SuggestionDto.toJSON(suggestion),
            statusCode: 200,
          })),
        },
        message: `Fix rolled back successfully. All ${updatedSuggestions.length} suggestion(s) marked as SKIPPED.`,
      });
    } catch (e) {
      /* c8 ignore next 3 */
      if (e?.name === VALIDATION_ERROR_NAME) {
        return badRequest(e.message);
      }
      return createResponse({
        message: `Error rolling back fix: ${e.message}`,
      }, 500);
    }
  }

  /**
   * Attaches `_executedByUser` to each fix by resolving `executedBy` IMS user IDs
   * via the IMS admin profile API. Called from `getAllForOpportunity` and `getByID`.
   * `getByStatus` intentionally skips enrichment to avoid unbounded fan-out for
   * potentially large result sets.
   *
   * IMS lookups are batched in groups of {@link IMS_ENRICH_BATCH_SIZE} to cap
   * concurrency. Fails silently so callers always get a response even when IMS
   * is unavailable.
   * @param {FixEntity[]} fixes
   */
  async #enrichFixesWithUserNames(fixes) {
    if (!this.#imsClient) {
      return;
    }

    const userIds = [
      ...new Set(fixes.map((f) => f.getExecutedBy()).filter((id) => id && IMS_ID_RE.test(id))),
    ];
    if (!userIds.length) {
      return;
    }

    try {
      const userMap = new Map();
      for (let i = 0; i < userIds.length; i += IMS_ENRICH_BATCH_SIZE) {
        const batch = userIds.slice(i, i + IMS_ENRICH_BATCH_SIZE);
        // eslint-disable-next-line no-await-in-loop
        const batchResults = await Promise.allSettled(
          batch.map((id) => this.#imsClient.getImsAdminProfile(id)),
        );
        batchResults.forEach((result, j) => {
          if (result.status === 'fulfilled') {
            const { first_name: firstName, last_name: lastName, email } = result.value;
            userMap.set(batch[j], {
              firstName: firstName || null,
              lastName: lastName || null,
              email: email || null,
            });
          } else {
            this.#ctx.log?.warn?.(`Failed to resolve IMS profile for user [redacted]: ${result.reason?.message}`);
          }
        });
      }

      for (const fix of fixes) {
        const userId = fix.getExecutedBy();
        if (userId && userMap.has(userId)) {
          // eslint-disable-next-line no-underscore-dangle
          fix._executedByUser = userMap.get(userId);
        }
      }
    } catch (e) {
      this.#ctx.log?.warn?.(`Could not enrich fixes with user names: ${e.message}`);
    }
  }

  /**
   * Resolves the authenticated caller's IMS user ID from the request context.
   * Tries `user_id` first (S2S JWT), then `sub` (OIDC).
   * Returns undefined when neither claim is present.
   * @param {RequestContext} context
   * @returns {string | undefined}
   */
  static #resolveCallerId(context) {
    const profile = context.attributes?.authInfo?.getProfile?.();
    return profile?.user_id ?? profile?.sub;
  }

  /**
   * Checks if the user has admin access.
   * @param {string} siteId
   * @returns {Response | null} forbidden response or null.
   */
  async #checkAccess(siteId) {
    const site = await this.#Site.findById(siteId);
    /* c8 ignore start */
    if (!site) {
      return notFound('Site not found');
    }
    /* c8 ignore end */

    return await this.#accessControl.hasAccess(site)
      ? null
      : forbidden('Only users belonging to the organization may access fix entities.');
  }
}

/**
 * Checks whether siteId and opportunityId are valid UUIDs.
 * Supports optional fixId.
 * @param {any} siteId
 * @param {any} opportunityId
 * @param {any} [fixId]
 * @returns {Response | null} badRequest response or null
 */
function checkRequestParams(siteId, opportunityId, fixId = UNSET) {
  if (!isValidUUID(siteId)) {
    return badRequest('Site ID required');
  }

  if (!isValidUUID(opportunityId)) {
    return badRequest('Opportunity ID required');
  }

  if (fixId !== UNSET && !isValidUUID(fixId)) {
    return badRequest('Fix ID required');
  }

  return null;
}
const UNSET = Symbol('UNSET');

/**
 * Checks if the fix belongs to the opportunity and the opportunity belongs to the site.
 *
 * @param {undefined | null | FixEntity} fix
 * @param {string} opportunityId
 * @param {string} siteId
 * @param {OpportunityCollection} opportunities
 * @returns {Promise<null | Response>}
 */
async function checkOwnership(fix, opportunityId, siteId, opportunities) {
  if (fix && fix.getOpportunityId() !== opportunityId) {
    return notFound('Opportunity not found');
  }
  const opportunity = await (fix ? fix.getOpportunity() : opportunities.findById(opportunityId));
  if (!opportunity || opportunity.getSiteId() !== siteId) {
    return notFound('Opportunity not found');
  }
  return null;
}

/**
 * @param {Array<{statusCode: number}>} items
 * @returns {number} number of succeeded items
 */
function countSucceeded(items) {
  return items.reduce((succ, item) => succ + (item.statusCode < 400), 0);
}
