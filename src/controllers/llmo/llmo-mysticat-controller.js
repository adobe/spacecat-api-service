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

import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import AccessControlUtil from '../../support/access-control-util.js';
import { createBrandPresenceHandlers } from './llmo-brand-presence.js';

/**
 * Controller for LLMO + Mysticat (mysticat-data-service / PostgreSQL) endpoints.
 * Handles Brand Presence APIs that query PostgREST tables.
 */
function LlmoMysticatController(ctx) {
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  const getSiteAndValidateLlmo = async (context) => {
    const { siteId } = context.params;
    const { dataAccess } = context;
    const { Site } = dataAccess;

    const site = await Site.findById(siteId);
    const config = site.getConfig();
    const llmoConfig = config.getLlmoConfig();

    if (!llmoConfig?.dataFolder) {
      throw new Error('LLM Optimizer is not enabled for this site, add llmo config to the site');
    }
    const hasAccessToElmo = await accessControlUtil.hasAccess(
      site,
      '',
      EntitlementModel.PRODUCT_CODES.LLMO,
    );
    if (!hasAccessToElmo) {
      throw new Error('Only users belonging to the organization can view its sites');
    }
    return { site, config, llmoConfig };
  };

  const brandPresence = createBrandPresenceHandlers(getSiteAndValidateLlmo);

  return {
    getFilterDimensions: brandPresence.getFilterDimensions,
    getWeeks: brandPresence.getWeeks,
    getMetadata: brandPresence.getMetadata,
    getStats: brandPresence.getStats,
    getSentimentOverview: brandPresence.getSentimentOverview,
    getWeeklyTrends: brandPresence.getWeeklyTrends,
    getTopics: brandPresence.getTopics,
    getTopicPrompts: brandPresence.getTopicPrompts,
    getSearch: brandPresence.getSearch,
    getShareOfVoice: brandPresence.getShareOfVoice,
    getCompetitorTrends: brandPresence.getCompetitorTrends,
    getPrompts: brandPresence.getPrompts,
    getSources: brandPresence.getSources,
  };
}

export default LlmoMysticatController;
