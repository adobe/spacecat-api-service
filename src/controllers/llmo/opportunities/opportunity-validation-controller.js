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
  isArray, isNonEmptyObject, isValidUrl, isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { Audit } from '@adobe/spacecat-shared-data-access';

// Distinct from import-worker's MAX_VALIDATION_URLS (50), which governs the automatic
// selectValidationUrls path only. A caller explicitly naming URLs to re-check is allowed a
// larger batch since they've already narrowed down exactly what they want checked, rather
// than asking the system to rank/select candidates itself.
const MAX_VALIDATION_URLS = 200;

// The message/route contract is generic (opportunityId, not prerenderOpportunityId) so a
// future opportunity type can be added later without reshaping the request contract — this
// is the one place that gates which types are supported today. Adding a second type means
// adding it here (and building that type's own resolver/comparator on the import-worker
// side); no other abstraction exists yet, per YAGNI.
const SUPPORTED_OPPORTUNITY_TYPES = new Set([Audit.AUDIT_TYPES.PRERENDER]);

/**
 * Controller for on-demand opportunity validation. Lets a caller trigger the same
 * S3-vs-live-edge content validation the hourly optimize-at-edge-enabled-marking job runs,
 * scoped to a specific opportunity and an explicit list of URLs, instead of waiting for the
 * automatic per-site run or going through the Slack-only validate-only command.
 *
 * Fire-and-forget: enqueues an SQS message to import-worker's existing "imports" queue and
 * responds immediately. The result lands in opportunity.data.validation, same as every other
 * validation path — this endpoint does not wait for or return the validation outcome itself.
 */
function OpportunityValidationController() {
  /**
   * POST /sites/:siteId/opportunities/:opportunityId/validate
   * Body: { urls: string[] }
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
    if (!SUPPORTED_OPPORTUNITY_TYPES.has(opportunityType)) {
      log.warn(`[opportunity-validation-api] site ${siteId}, opportunity ${opportunityId} is type '${opportunityType}', validation not supported`);
      return badRequest(`Validation not supported for opportunity type '${opportunityType}'`);
    }

    if (!isNonEmptyObject(context.data)) {
      return badRequest('No data provided');
    }
    const { urls } = context.data;
    if (!isArray(urls) || urls.length === 0) {
      return badRequest('Request body must contain a non-empty array of urls');
    }
    if (urls.length > MAX_VALIDATION_URLS) {
      return badRequest(`Too many URLs: ${urls.length} provided, max ${MAX_VALIDATION_URLS} per request`);
    }
    if (!urls.every((url) => typeof url === 'string' && isValidUrl(url))) {
      return badRequest('urls must be an array of valid URL strings');
    }

    const configuration = await Configuration.findLatest();
    await sqs.sendMessage(configuration.getQueues().imports, {
      type: 'optimize-at-edge-enabled-marking',
      siteId,
      validateOnly: true,
      opportunityId,
      urls,
    });

    log.info(`[opportunity-validation-api] queued validation for site ${siteId}, opportunity ${opportunityId}, ${urls.length} url(s)`);

    return accepted({
      siteId, opportunityId, status: 'queued', urlCount: urls.length,
    });
  };

  return { triggerValidation };
}

export default OpportunityValidationController;
