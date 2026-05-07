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

/**
 * Data transfer object for SiteImsOrgAccess.
 */
export const ImsOrgAccessDto = {
  /**
   * Converts a SiteImsOrgAccess object into a JSON object.
   * @param {Readonly<SiteImsOrgAccess>} grant - SiteImsOrgAccess model instance.
   * @returns {{
   *   id: string,
   *   siteId: string,
   *   organizationId: string,
   *   targetOrganizationId: string,
   *   productCode: string,
   *   role: string,
   *   grantedBy: string|undefined,
   *   expiresAt: string|undefined,
   *   createdAt: string,
   *   updatedAt: string
   * }}
   */
  toJSON: (grant) => ({
    id: grant.getId(),
    siteId: grant.getSiteId(),
    organizationId: grant.getOrganizationId(),
    targetOrganizationId: grant.getTargetOrganizationId(),
    productCode: grant.getProductCode(),
    role: grant.getRole(),
    grantedBy: grant.getGrantedBy(),
    expiresAt: grant.getExpiresAt(),
    createdAt: grant.getCreatedAt(),
    updatedAt: grant.getUpdatedAt(),
  }),
};
