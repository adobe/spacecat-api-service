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
 * Data transfer object for Entitlement.
 */
export const EntitlementDto = {
  /**
   * Converts a Entitlement object into a JSON object.
   * @param {Readonly<Entitlement>} entitlement - Entitlement object.
   * @returns {{
   *   id: string,
   *   organizationId: string,
   *   productCode: string,
   *   tier: string,
   *   status: string,
   *   quotas: any,
   *   createdAt: string,
   *   updatedAt: string
   * }}
   */
  toJSON: (entitlement) => ({
    id: entitlement.getId(),
    organizationId: entitlement.getOrganizationId(),
    productCode: entitlement.getProductCode(),
    tier: entitlement.getTier(),
    status: entitlement.getStatus(),
    quotas: entitlement.getQuotas(),
    createdAt: entitlement.getCreatedAt(),
    updatedAt: entitlement.getUpdatedAt(),
  }),
};
