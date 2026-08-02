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
  accepted, badRequest, notFound,
} from '@adobe/spacecat-shared-http-utils';
import {
  isArray, isNonEmptyObject, isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { Audit } from '@adobe/spacecat-shared-data-access';

// Distinct from import-worker's MAX_VALIDATION_URLS (50), which governs the automatic
// selectValidationUrls path only. A caller explicitly naming suggestions to re-check is
// allowed a larger batch since they've already narrowed down exactly what they want checked,
// rather than asking the system to rank/select candidates itself.
const MAX_SUGGESTION_IDS = 200;

// The route/request contract is generic (opportunityId, not prerenderOpportunityId) so a
// future opportunity type can be added later without reshaping it. This map is the one place
// that gates which opportunity types are actually supported today, and which import-worker
// message type knows how to validate each one — adding a second type means adding an entry
// here (and building that type's own resolver/comparator on the import-worker side); no other
// abstraction exists yet, per YAGNI.
const VALIDATION_MESSAGE_TYPE_BY_OPPORTUNITY_TYPE = {
  [Audit.AUDIT_TYPES.PRERENDER]: 'optimize-at-edge-enabled-marking',
};

/**
 * Controller for on-demand opportunity validation. Lets a caller trigger the same
 * S3-vs-live-edge content validation the hourly optimize-at-edge-enabled-marking job runs,
 * scoped to a specific opportunity and an explicit list of suggestion IDs, instead of waiting
 * for the automatic per-site run or going through the Slack-only validate-only command.
 *
 * Suggestion IDs are validated for shape only here (UUID, cap); import-worker resolves each
 * to its URL (via the suggestion's own data) and does not filter by suggestion status — a
 * caller naming a specific suggestion already knows what they want re-checked regardless of
 * its current status.
 *
 * Fire-and-forget: enqueues an SQS message to import-worker's existing "imports" queue and
 * responds immediately. The result lands in opportunity.data.validation, same as every other
 * validation path — this endpoint does not wait for or return the validation outcome itself.
 */
function OpportunityValidationController() {
  /**
   * POST /sites/:siteId/opportunities/:opportunityId/validate
   * Body: { suggestionIds: string[] }
   */
  const triggerValidation = async (context) => {
    const { dataAccess, sqs, log } = context;
    const { Site, Opportunity, Configuration } = dataAccess;
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;

    if (!isValidUUID(siteId)) {
      log.warn(`[opportunity-validation-api] siteId ${siteId} is not a valid UUID`);
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      log.warn(`[opportunity-validation-api] site ${siteId} not found`);
      return notFound('Site not found');
    }

    if (!isValidUUID(opportunityId)) {
      log.warn(`[opportunity-validation-api] site ${siteId}, opportunityId ${opportunityId} is not a valid UUID`);
      return badRequest('Opportunity ID required');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      log.warn(`[opportunity-validation-api] site ${siteId}, opportunity ${opportunityId} not found for this site`);
      return notFound('Opportunity not found');
    }

    const opportunityType = opportunity.getType();
    const messageType = VALIDATION_MESSAGE_TYPE_BY_OPPORTUNITY_TYPE[opportunityType];
    if (!messageType) {
      log.warn(`[opportunity-validation-api] site ${siteId}, opportunity ${opportunityId} is type '${opportunityType}', validation not supported`);
      return badRequest(`Validation not supported for opportunity type '${opportunityType}'`);
    }

    if (!isNonEmptyObject(context.data)) {
      return badRequest('No data provided');
    }
    const { suggestionIds } = context.data;
    if (!isArray(suggestionIds) || suggestionIds.length === 0) {
      return badRequest('Request body must contain a non-empty array of suggestionIds');
    }
    if (suggestionIds.length > MAX_SUGGESTION_IDS) {
      return badRequest(`Too many suggestionIds: ${suggestionIds.length} provided, max ${MAX_SUGGESTION_IDS} per request`);
    }
    if (!suggestionIds.every((id) => typeof id === 'string' && isValidUUID(id))) {
      return badRequest('suggestionIds must be an array of valid UUIDs');
    }

    const configuration = await Configuration.findLatest();
    await sqs.sendMessage(configuration.getQueues().imports, {
      type: messageType,
      siteId,
      validateOnly: true,
      opportunityId,
      suggestionIds,
    });

    log.info(`[opportunity-validation-api] queued validation for site ${siteId}, opportunity ${opportunityId}, ${suggestionIds.length} suggestion(s)`);

    return accepted({
      siteId, opportunityId, status: 'queued', suggestionCount: suggestionIds.length,
    });
  };

  return { triggerValidation };
}

export default OpportunityValidationController;
