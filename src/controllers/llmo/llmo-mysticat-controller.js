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
  createMarketTrackingTrendsHandler, createCompetitorSummaryHandler, createTopicsHandler,
  createTopicPromptsHandler,
  createSearchHandler,
  createTopicDetailHandler,
  createPromptDetailHandler,
  createSentimentMoversHandler,
  createShareOfVoiceHandler,
  createBrandPresenceStatsHandler,
  createRegionsHandler,
} from './llmo-brand-presence.js';
import {
  createAgenticTrafficGlobalGetHandler,
  createAgenticTrafficGlobalPostHandler,
} from './llmo-agentic-traffic-global.js';
import {
  createAgenticTrafficKpisHandler,
  createAgenticTrafficKpisTrendHandler,
  createAgenticTrafficByRegionHandler,
  createAgenticTrafficByCategoryHandler,
  createAgenticTrafficByPageTypeHandler,
  createAgenticTrafficByStatusHandler,
  createAgenticTrafficByUserAgentHandler,
  createAgenticTrafficByUrlHandler,
  createAgenticTrafficFilterDimensionsHandler,
  createAgenticTrafficWeeksHandler,
  createAgenticTrafficMoversHandler,
} from './llmo-agentic-traffic.js';

/**
 * Controller for LLMO + Mysticat (mysticat-data-service / PostgreSQL) endpoints.
 * Handles Brand Presence filter-dimensions API that queries PostgREST.
 */
function LlmoMysticatController(ctx) {
  const accessControlUtil = AccessControlUtil.fromContext(ctx);
  const hasLlmoOrganizationAccess = (organization) => accessControlUtil.hasAccess(organization, '', 'LLMO');

  const getOrgAndValidateAccess = async (context) => {
    const { spaceCatId } = context.params;
    const { dataAccess } = context;
    const { Organization } = dataAccess;

    const organization = await Organization.findById(spaceCatId);
    if (!organization) {
      throw new Error(`Organization not found: ${spaceCatId}`);
    }
    if (!await hasLlmoOrganizationAccess(organization)) {
      throw new Error('Only users belonging to the organization can view brand presence data');
    }
    return { organization };
  };

  const validateGlobalAgenticTrafficReadAccess = async (context) => {
    if (accessControlUtil.hasAdminAccess() || context.s2sConsumer) {
      return;
    }

    const authInfo = context.attributes?.authInfo;
    const profile = authInfo?.getProfile?.() ?? authInfo?.profile;
    const tenantIds = authInfo?.getTenantIds?.()
      ?? profile?.tenants?.map((tenant) => tenant.id)
      ?? [];
    const imsOrgIds = [...new Set(
      tenantIds
        .filter(Boolean)
        .map((tenantId) => {
          const normalized = String(tenantId);
          return normalized.includes('@') ? normalized : `${normalized}@AdobeOrg`;
        }),
    )];
    const organizations = (await Promise.all(
      imsOrgIds.map((imsOrgId) => context.dataAccess.Organization.findByImsOrgId(imsOrgId)),
    )).filter(Boolean);
    const accessResults = await Promise.all(
      organizations.map(hasLlmoOrganizationAccess),
    );

    if (!accessResults.some(Boolean)) {
      throw new Error('Only admins or users with LLMO organization access can view global agentic traffic');
    }
  };

  const getFilterDimensions = createFilterDimensionsHandler(getOrgAndValidateAccess);
  const getBrandPresenceWeeks = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
  const getMarketTrackingTrends = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
  const getCompetitorSummary = createCompetitorSummaryHandler(getOrgAndValidateAccess);
  const getSentimentOverview = createSentimentOverviewHandler(getOrgAndValidateAccess);
  const getTopics = createTopicsHandler(getOrgAndValidateAccess);
  const getTopicPrompts = createTopicPromptsHandler(getOrgAndValidateAccess);
  const getSearch = createSearchHandler(getOrgAndValidateAccess);
  const getTopicDetail = createTopicDetailHandler(getOrgAndValidateAccess);
  const getPromptDetail = createPromptDetailHandler(getOrgAndValidateAccess);
  const getSentimentMovers = createSentimentMoversHandler(getOrgAndValidateAccess);
  const getShareOfVoice = createShareOfVoiceHandler(getOrgAndValidateAccess);
  const getBrandPresenceStats = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
  const getRegions = createRegionsHandler();
  const getAgenticTrafficGlobal = createAgenticTrafficGlobalGetHandler(
    validateGlobalAgenticTrafficReadAccess,
  );
  const postAgenticTrafficGlobal = createAgenticTrafficGlobalPostHandler(accessControlUtil);

  const getSiteAndValidateAccess = async (context) => {
    const { siteId } = context.params;
    const { dataAccess } = context;
    const { Site, Organization } = dataAccess;

    const site = await Site.findById(siteId);
    if (!site) {
      throw new Error(`Site not found: ${siteId}`);
    }
    const organization = await Organization.findById(site.getOrganizationId());
    if (!organization) {
      throw new Error(`Organization not found for site: ${siteId}`);
    }
    if (!await hasLlmoOrganizationAccess(organization)) {
      throw new Error('Only users belonging to the organization can view agentic traffic data');
    }
    return { site, organization };
  };

  const getAgenticTrafficKpis = createAgenticTrafficKpisHandler(getSiteAndValidateAccess);
  const getAgenticTrafficKpisTrend = createAgenticTrafficKpisTrendHandler(getSiteAndValidateAccess);
  const getAgenticTrafficByRegion = createAgenticTrafficByRegionHandler(getSiteAndValidateAccess);
  const getAgenticTrafficByCategory = createAgenticTrafficByCategoryHandler(
    getSiteAndValidateAccess,
  );
  const getAgenticTrafficByPageType = createAgenticTrafficByPageTypeHandler(
    getSiteAndValidateAccess,
  );
  const getAgenticTrafficByStatus = createAgenticTrafficByStatusHandler(getSiteAndValidateAccess);
  const getAgenticTrafficByUserAgent = createAgenticTrafficByUserAgentHandler(
    getSiteAndValidateAccess,
  );
  const getAgenticTrafficByUrl = createAgenticTrafficByUrlHandler(getSiteAndValidateAccess);
  const getAgenticTrafficFilterDimensions = createAgenticTrafficFilterDimensionsHandler(
    getSiteAndValidateAccess,
  );
  const getAgenticTrafficWeeks = createAgenticTrafficWeeksHandler(getSiteAndValidateAccess);
  const getAgenticTrafficMovers = createAgenticTrafficMoversHandler(getSiteAndValidateAccess);

  return {
    getFilterDimensions,
    getBrandPresenceWeeks,
    getMarketTrackingTrends,
    getCompetitorSummary,
    getSentimentOverview,
    getTopics,
    getTopicPrompts,
    getSearch,
    getTopicDetail,
    getPromptDetail,
    getSentimentMovers,
    getShareOfVoice,
    getBrandPresenceStats,
    getRegions,
    getAgenticTrafficGlobal,
    postAgenticTrafficGlobal,
    getAgenticTrafficKpis,
    getAgenticTrafficKpisTrend,
    getAgenticTrafficByRegion,
    getAgenticTrafficByCategory,
    getAgenticTrafficByPageType,
    getAgenticTrafficByStatus,
    getAgenticTrafficByUserAgent,
    getAgenticTrafficByUrl,
    getAgenticTrafficFilterDimensions,
    getAgenticTrafficWeeks,
    getAgenticTrafficMovers,
  };
}

export default LlmoMysticatController;
