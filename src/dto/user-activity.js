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
 * Data transfer object for TrialUserActivity.
 */
export const UserActivityDto = {
  /**
   * Converts a TrialUserActivity object into a JSON object.
   * @param {Readonly<TrialUserActivity>} userActivity - TrialUserActivity object.
   * @returns {{
   *   id: string,
   *   organizationId: string,
   *   trialUserId: string,
   *   siteId: string,
   *   entitlementId: string,
   *   type: string,
   *   details: any,
   *   productCode: string,
   *   createdAt: string
   * }}
   */
  toJSON: (userActivity) => ({
    id: userActivity.getId(),
    organizationId: userActivity.getOrganizationId(),
    trialUserId: userActivity.getTrialUserId(),
    siteId: userActivity.getSiteId(),
    entitlementId: userActivity.getEntitlementId(),
    type: userActivity.getType(),
    details: userActivity.getDetails(),
    productCode: userActivity.getProductCode(),
    createdAt: userActivity.getCreatedAt(),
  }),
};
