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
import { isNonEmptyObject, isValidUUID } from '@adobe/spacecat-shared-utils';
import { Audit } from '@adobe/spacecat-shared-data-access';

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
 * Controller for on-demand opportunity validation. Lets the deploy-to-edge experimentation
 * flow trigger the same S3-vs-live-edge content validation the hourly
 * optimize-at-edge-enabled-marking job runs, scoped to one GeoExperiment's own suggestions.
 *
 * Body: { geoExperimentId: string }. This controller verifies the GeoExperiment exists and
 * belongs to siteId (and, when set, opportunityId) before forwarding it — it does not resolve
 * its suggestions itself (that happens in import-worker, which already owns the
 * GeoExperiment/Suggestion collections). The result lands on GeoExperiment.metadata.validation
 * and each covered Suggestion's own data.validation, not opportunity.data.validation (a
 * geoExperimentId run only covers a scoped subset of suggestions, so writing the site-wide
 * opportunity field would corrupt the bulk job's cache).
 *
 * Fire-and-forget: enqueues an SQS message to import-worker's existing "imports" queue and
 * responds immediately — this endpoint does not wait for or return the validation outcome
 * itself.
 */
function OpportunityValidationController() {
  /**
   * POST /sites/:siteId/opportunities/:opportunityId/validate
   * Body: { geoExperimentId: string }.
   */
  const triggerValidation = async (context) => {
    const { dataAccess, sqs, log } = context;
    const {
      Site, Opportunity, Configuration, GeoExperiment,
    } = dataAccess;
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;

    if (!isValidUUID(siteId)) {
      log.warn(`[opportunity-validation-api] siteId ${siteId} is not a valid UUID`);
      return badRequest('Site ID must be a valid UUID');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      log.warn(`[opportunity-validation-api] site ${siteId} not found`);
      return notFound('Site not found');
    }

    if (!isValidUUID(opportunityId)) {
      log.warn(`[opportunity-validation-api] site ${siteId}, opportunityId ${opportunityId} is not a valid UUID`);
      return badRequest('Opportunity ID must be a valid UUID');
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
    const { geoExperimentId } = context.data;

    if (typeof geoExperimentId !== 'string' || !isValidUUID(geoExperimentId)) {
      return badRequest('geoExperimentId must be a valid UUID');
    }

    const geoExperiment = await GeoExperiment.findById(geoExperimentId);
    if (!geoExperiment || geoExperiment.getSiteId() !== siteId) {
      log.warn(`[opportunity-validation-api] site ${siteId}, geoExperiment ${geoExperimentId} not found for this site`);
      return notFound('GeoExperiment not found');
    }
    // GeoExperiment's Opportunity link is optional, so only enforce it when set — a
    // site-scoped-but-not-opportunity-scoped experiment is a legitimate combination.
    if (geoExperiment.getOpportunityId() && geoExperiment.getOpportunityId() !== opportunityId) {
      log.warn(`[opportunity-validation-api] geoExperiment ${geoExperimentId} does not belong to opportunity ${opportunityId}`);
      return notFound('GeoExperiment not found');
    }

    const configuration = await Configuration.findLatest();
    await sqs.sendMessage(configuration.getQueues().imports, {
      type: messageType,
      siteId,
      validateOnly: true,
      geoExperimentId,
    });

    log.info(`[opportunity-validation-api] queued validation for site ${siteId}, opportunity ${opportunityId}, geoExperiment ${geoExperimentId}`);

    return accepted({
      siteId, opportunityId, geoExperimentId, status: 'queued',
    });
  };

  return { triggerValidation };
}

export default OpportunityValidationController;
