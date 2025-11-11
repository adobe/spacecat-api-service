/*
 * Copyright 2024 Adobe. All rights reserved.
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
  badRequest,
  ok,
  forbidden,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { OrganizationDto } from '../dto/organization.js';
import { SiteDto } from '../dto/site.js';
import AccessControlUtil from '../support/access-control-util.js';
import { fetchSiteByOrganizationEntitlement, fetchSiteByOrganizationEntitlementBySiteId } from '../support/utils.js';

/**
 * Homepage controller. Provides methods to get homepage data for ASO UI.
 * @param {object} ctx - Context of the request.
 * @returns {object} Homepage controller.
 * @constructor
 */
function HomepageController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Organization, Site } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Gets homepage data based on query parameters.
   * Tries siteId first, then falls back to organizationId, then imsOrg.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Homepage data response.
   */
  const getHomepageData = async (context) => {
    const { organizationId, imsOrg, siteId } = context.data;
    const { pathInfo } = context;
    const productCode = pathInfo.headers['x-product'];

    if (!hasText(productCode)) {
      return badRequest('Product code required in x-product header');
    }

    let organization;
    let site;

    try {
      if (hasText(siteId) && isValidUUID(siteId)) {
        site = await Site.findById(siteId);
        if (site) {
          const orgId = site.getOrganizationId();
          if (orgId) {
            organization = await Organization.findById(orgId);
            if (organization && await accessControlUtil.hasAccess(organization)) {
              const {
                site: enrolledSite,
                enrollment,
              } = await fetchSiteByOrganizationEntitlementBySiteId(
                context,
                organization,
                siteId,
                productCode,
              );

              if (enrolledSite && enrollment) {
                const data = {
                  organization: OrganizationDto.toJSON(organization),
                  site: SiteDto.toJSON(enrolledSite),
                };

                return ok({ data });
              }
            }
          }
        }
      }

      if (hasText(organizationId) && isValidUUID(organizationId)) {
        organization = await Organization.findById(organizationId);
        if (organization && await accessControlUtil.hasAccess(organization)) {
          const { site: enrolledSite } = await fetchSiteByOrganizationEntitlement(
            context,
            organization,
            productCode,
          );

          if (enrolledSite) {
            const data = {
              organization: OrganizationDto.toJSON(organization),
              site: SiteDto.toJSON(enrolledSite),
            };

            return ok({ data });
          }
        }
      }

      if (hasText(imsOrg)) {
        organization = await Organization.findByImsOrgId(imsOrg);
        if (organization && await accessControlUtil.hasAccess(organization)) {
          const { site: enrolledSite } = await fetchSiteByOrganizationEntitlement(
            context,
            organization,
            productCode,
          );

          if (enrolledSite) {
            const data = {
              organization: OrganizationDto.toJSON(organization),
              site: SiteDto.toJSON(enrolledSite),
            };

            return ok({ data });
          }
        }
      }

      return forbidden('Access denied or resources not found for the provided parameters');
    } catch (error) {
      const { log } = ctx;
      log.error(`Error fetching homepage data: ${error.message}`);
      return badRequest('Failed to fetch homepage data');
    }
  };

  return {
    getHomepageData,
  };
}

export default HomepageController;
