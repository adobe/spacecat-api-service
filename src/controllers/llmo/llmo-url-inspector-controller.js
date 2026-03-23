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

import AccessControlUtil from '../../support/access-control-util.js';
import {
  createStatsHandler,
  createOwnedUrlsHandler,
  createTrendingUrlsHandler,
  createCitedDomainsHandler,
  createUrlDetailsHandler,
  createDomainDetailsHandler,
  createFilterOptionsHandler,
} from './llmo-url-inspector.js';

/**
 * Controller for URL Inspector org-scoped endpoints.
 * Queries brand_presence citation data via PostgREST.
 *
 * Route pattern: GET /org/:spaceCatId/url-inspector/<resource>?siteId=...
 *
 * Mirrors LlmoMysticatController: validates org membership + LLMO entitlement,
 * then delegates to per-resource handler factories in llmo-url-inspector.js.
 */
function LlmoUrlInspectorController(ctx) {
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
      throw new Error('Only users belonging to the organization can view URL Inspector data');
    }
    return { organization };
  };

  const getStats = createStatsHandler(getOrgAndValidateAccess);
  const getOwnedUrls = createOwnedUrlsHandler(getOrgAndValidateAccess);
  const getTrendingUrls = createTrendingUrlsHandler(getOrgAndValidateAccess);
  const getCitedDomains = createCitedDomainsHandler(getOrgAndValidateAccess);
  const getUrlDetails = createUrlDetailsHandler(getOrgAndValidateAccess);
  const getDomainDetails = createDomainDetailsHandler(getOrgAndValidateAccess);
  const getFilterOptions = createFilterOptionsHandler(getOrgAndValidateAccess);

  return {
    getStats,
    getOwnedUrls,
    getTrendingUrls,
    getCitedDomains,
    getUrlDetails,
    getDomainDetails,
    getFilterOptions,
  };
}

export default LlmoUrlInspectorController;
