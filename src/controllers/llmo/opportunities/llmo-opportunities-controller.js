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
  ok, badRequest, forbidden, notFound, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import AccessControlUtil from '../../../support/access-control-util.js';
import { OpportunityDto } from '../../../dto/opportunity.js';
import { getBrandById } from '../../../support/brands-storage.js';

const MAX_CONCURRENT_SITES = 5;
const VALID_STATUSES = new Set(['NEW', 'IN_PROGRESS']);

/**
 * Returns true if the opportunity is an LLMO opportunity.
 * Matches the filtering logic used in get-llmo-opportunity-usage.js.
 */
function isLlmoOpportunity(opportunity) {
  const tags = [...(opportunity.getTags())];
  const type = opportunity.getType() ?? '';
  return tags.includes('isElmo') || type === 'prerender' || type === 'llm-blocked';
}

/**
 * Process promises in batches with controlled concurrency.
 * Pattern from get-llmo-opportunity-usage.js.
 */
async function processBatch(items, fn, concurrency) {
  const results = [];
  const executing = [];

  for (const item of items) {
    const promise = fn(item).then((result) => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });

    results.push(promise);
    executing.push(promise);

    if (executing.length >= concurrency) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

/**
 * Controller for LLMO opportunity endpoints at the organization level.
 * Provides aggregated opportunity counts and brand-scoped opportunity listings.
 */
function LlmoOpportunitiesController(ctx) {
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
      throw new Error('Only users belonging to the organization can view opportunity data');
    }
    return { organization };
  };

  /**
   * GET /org/:spaceCatId/opportunities/count
   * Returns total LLMO opportunity count across all sites in the organization.
   * Accepts optional ?siteId query parameter to scope results to a single site.
   */
  const getOpportunityCount = async (context) => {
    const { dataAccess, log } = context;
    const { Site, Opportunity } = dataAccess;
    const filterSiteId = context.data?.siteId || context.data?.site_id;

    let organization;
    try {
      ({ organization } = await getOrgAndValidateAccess(context));
    } catch (error) {
      if (error.message?.includes('belonging to the organization')) {
        return forbidden(error.message);
      }
      if (error.message?.includes('not found')) {
        return notFound(error.message);
      }
      return badRequest(error.message);
    }

    try {
      const orgId = organization.getId();
      let sites = await Site.allByOrganizationId(orgId);

      if (filterSiteId) {
        const match = sites.find((s) => s.getId() === filterSiteId);
        if (!match) {
          return forbidden('Site does not belong to the organization');
        }
        sites = [match];
      }

      const countForSite = async (site) => {
        try {
          const opportunities = await Opportunity.allBySiteId(site.getId());
          const llmoOpps = opportunities.filter(
            (opp) => isLlmoOpportunity(opp) && VALID_STATUSES.has(opp.getStatus()),
          );
          return {
            siteId: site.getId(),
            baseURL: site.getBaseURL(),
            count: llmoOpps.length,
          };
        } catch (siteError) {
          log.warn(`Failed to count opportunities for site ${site.getId()}: ${siteError.message}`);
          return { siteId: site.getId(), baseURL: site.getBaseURL(), count: 0 };
        }
      };

      const bySite = await processBatch(sites, countForSite, MAX_CONCURRENT_SITES);
      const total = bySite.reduce((sum, s) => sum + s.count, 0);

      return ok({ total, bySite });
    } catch (error) {
      log.error(`Error counting opportunities: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  /**
   * GET /org/:spaceCatId/brands/:brandId/opportunities
   * GET /org/:spaceCatId/brands/all/opportunities
   * Returns all LLMO opportunities for sites under the given brand (or all org sites).
   * Accepts optional ?siteId query parameter to scope results to a single site.
   */
  const getBrandOpportunities = async (context) => {
    const { dataAccess, log } = context;
    const { Site, Opportunity } = dataAccess;
    const brandId = context.params.brandId || 'all';
    const filterSiteId = context.data?.siteId || context.data?.site_id;

    let organization;
    try {
      ({ organization } = await getOrgAndValidateAccess(context));
    } catch (error) {
      if (error.message?.includes('belonging to the organization')) {
        return forbidden(error.message);
      }
      if (error.message?.includes('not found')) {
        return notFound(error.message);
      }
      return badRequest(error.message);
    }

    try {
      const orgId = organization.getId();
      let siteIds;
      let brandName = 'All';

      if (brandId === 'all') {
        // Fetch all sites for the organization
        const sites = await Site.allByOrganizationId(orgId);
        siteIds = sites.map((s) => s.getId());
      } else {
        // Look up brand to get its associated site IDs
        const postgrestClient = dataAccess?.services?.postgrestClient;
        if (!postgrestClient?.from) {
          return badRequest('Brand data requires PostgreSQL data service');
        }

        const brand = await getBrandById(orgId, brandId, postgrestClient);
        if (!brand) {
          return notFound(`Brand not found: ${brandId}`);
        }

        siteIds = brand.siteIds || [];
        brandName = brand.name;
      }

      if (filterSiteId) {
        if (!siteIds.includes(filterSiteId)) {
          return forbidden('Site does not belong to the organization or brand');
        }
        siteIds = [filterSiteId];
      }

      if (siteIds.length === 0) {
        return ok({
          brandId, brandName, opportunities: [], total: 0,
        });
      }

      const fetchForSite = async (siteId) => {
        try {
          const site = await Site.findById(siteId);
          if (!site) return [];

          const opportunities = await Opportunity.allBySiteId(siteId);
          return opportunities
            .filter((opp) => isLlmoOpportunity(opp) && VALID_STATUSES.has(opp.getStatus()))
            .map((opp) => ({
              ...OpportunityDto.toJSON(opp),
              siteBaseURL: site.getBaseURL(),
            }));
        } catch (siteError) {
          log.warn(`Failed to fetch opportunities for site ${siteId}: ${siteError.message}`);
          return [];
        }
      };

      const results = await processBatch(siteIds, fetchForSite, MAX_CONCURRENT_SITES);
      const opportunities = results.flat();

      return ok({
        brandId, brandName, opportunities, total: opportunities.length,
      });
    } catch (error) {
      log.error(`Error fetching brand opportunities: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  return {
    getOpportunityCount,
    getBrandOpportunities,
  };
}

export default LlmoOpportunitiesController;
export { isLlmoOpportunity, processBatch };
