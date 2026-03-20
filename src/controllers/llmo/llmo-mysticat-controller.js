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

import AccessControlUtil from '../../support/access-control-util.js';
import {
  createFilterDimensionsHandler,
  createBrandPresenceWeeksHandler, createSentimentOverviewHandler,
  createMarketTrackingTrendsHandler,
  createSentimentMoversHandler,
  createShareOfVoiceHandler,
  createBrandPresenceStatsHandler,
} from './llmo-brand-presence.js';

/**
 * Controller for LLMO + Mysticat (mysticat-data-service / PostgreSQL) endpoints.
 * Handles Brand Presence filter-dimensions API that queries PostgREST.
 */
function LlmoMysticatController(ctx) {
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  const getOrgAndValidateAccess = async (context) => {
    const { spaceCatId } = context.params;
    const { dataAccess } = context;
    const { Organization } = dataAccess;

    const organization = await Organization.findById(spaceCatId);
    if (!organization) {
      throw new Error(`Organization not found: ${spaceCatId}`);
    }
    if (!await accessControlUtil.hasAccess(organization, '', 'LLMO')) {
      throw new Error('Only users belonging to the organization can view brand presence data');
    }
    return { organization };
  };

  const getFilterDimensions = createFilterDimensionsHandler(getOrgAndValidateAccess);
  const getBrandPresenceWeeks = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
  const getMarketTrackingTrends = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
  const getSentimentOverview = createSentimentOverviewHandler(getOrgAndValidateAccess);
  const getSentimentMovers = createSentimentMoversHandler(getOrgAndValidateAccess);
  const getShareOfVoice = createShareOfVoiceHandler(getOrgAndValidateAccess);
  const getBrandPresenceStats = createBrandPresenceStatsHandler(getOrgAndValidateAccess);

  return {
    getFilterDimensions,
    getBrandPresenceWeeks,
    getMarketTrackingTrends,
    getSentimentOverview,
    getSentimentMovers,
    getShareOfVoice,
    getBrandPresenceStats,
  };
}

export default LlmoMysticatController;
