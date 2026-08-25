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

/**
 * Data transfer object for a site's minimal routing identity.
 *
 * Deliberately narrow: it exposes only the fields a platform (`site:readAll`) consumer
 * needs to bootstrap a customer-scoped token for a site it knows by UUID - the
 * `siteId -> imsOrgId` join it cannot perform without already being scoped. Keeping the
 * surface frozen prevents it from accreting tenant config, LLMO data, or audits over time.
 *
 * See `docs/s2s/READALL_CAPABILITY_DESIGN.md` and GET /sites/:siteId/identity.
 */
export const SiteIdentityDto = {
  /**
   * Converts a Site (plus its server-resolved imsOrgId) into the identity JSON object.
   * @param {Readonly<Site>} site - Site object.
   * @param {string|null} imsOrgId - The IMS org id of the site's owning organization,
   *   or null when the site has no organization or the organization has no imsOrgId.
   * @returns {{
   *   siteId: string,
   *   organizationId: string|null,
   *   imsOrgId: string|null,
   *   baseURL: string,
   *   deliveryType: string
   * }}
   */
  toJSON: (site, imsOrgId) => ({
    siteId: site.getId(),
    organizationId: site.getOrganizationId() ?? null,
    imsOrgId: imsOrgId ?? null,
    baseURL: site.getBaseURL(),
    deliveryType: site.getDeliveryType(),
  }),
};
