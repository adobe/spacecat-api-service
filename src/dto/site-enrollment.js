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
 * Data transfer object for SiteEnrollment.
 */
export const SiteEnrollmentDto = {
  /**
   * Converts a SiteEnrollment object into a JSON object.
   * @param {Readonly<SiteEnrollment>} siteEnrollment - SiteEnrollment object.
   * @returns {{
   *   id: string,
   *   siteId: string,
   *   entitlementId: string,
   *   createdAt: string,
   *   updatedAt: string,
   *   updatedBy: string,
   *   config: Record<string, string>
   * }}
   */
  toJSON: (siteEnrollment) => ({
    id: siteEnrollment.getId(),
    siteId: siteEnrollment.getSiteId(),
    entitlementId: siteEnrollment.getEntitlementId(),
    createdAt: siteEnrollment.getCreatedAt(),
    updatedAt: siteEnrollment.getUpdatedAt(),
    updatedBy: siteEnrollment.getUpdatedBy(),
    config: siteEnrollment.getConfig(),
  }),
};
