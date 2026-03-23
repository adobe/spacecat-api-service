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
import { createStatsHandler } from './llmo-url-inspector-stats.js';
import { createOwnedUrlsHandler } from './llmo-url-inspector-owned-urls.js';
import { createTrendingUrlsHandler } from './llmo-url-inspector-trending-urls.js';
import { createCitedDomainsHandler } from './llmo-url-inspector-cited-domains.js';
import { createUrlDetailsHandler } from './llmo-url-inspector-url-details.js';
import { createDomainDetailsHandler } from './llmo-url-inspector-domain-details.js';
import { createFilterOptionsHandler } from './llmo-url-inspector-filter-options.js';

/**
 * Controller for URL Inspector org-scoped endpoints.
 * Queries brand_presence citation data via PostgREST.
 *
 * Route pattern:
 *   GET /org/:spaceCatId/brands/all/url-inspector/<resource>?siteId=...
 *   GET /org/:spaceCatId/brands/:brandId/url-inspector/<resource>?siteId=...
 *
 * Each handler lives in its own file (llmo-url-inspector-<feature>.js) to allow
 * parallel implementation without merge conflicts. Shared utilities are in
 * llmo-url-inspector.js.
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
