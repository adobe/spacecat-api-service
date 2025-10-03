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
/* c8 ignore start */

/**
 * Data transfer object for LLMO onboarding.
 */
export const LlmoOnboardDto = {
  /**
   * Converts an LLMO onboarding request into a standardized format.
   * @param {object} requestData - The raw request data.
   * @returns {{
   *   domain: string,
   *   brandName: string,
   *   imsOrgId: string
   * }}
   */
  fromRequest: (requestData) => ({
    domain: requestData.domain,
    brandName: requestData.brandName,
    imsOrgId: requestData.imsOrgId,
  }),

  /**
   * Converts an LLMO onboarding response into a JSON object.
   * @param {object} onboardingResult - The onboarding result.
   * @returns {{
   *   message: string,
   *   domain: string,
   *   brandName: string,
   *   imsOrgId: string,
   *   baseURL?: string,
   *   dataFolder?: string,
   *   organizationId?: string,
   *   siteId?: string,
   *   status: string,
   *   createdAt?: string
   * }}
   */
  toJSON: (onboardingResult) => ({
    message: onboardingResult.message,
    domain: onboardingResult.domain,
    brandName: onboardingResult.brandName,
    imsOrgId: onboardingResult.imsOrgId,
    baseURL: onboardingResult.baseURL,
    dataFolder: onboardingResult.dataFolder,
    organizationId: onboardingResult.organizationId,
    siteId: onboardingResult.siteId,
    status: onboardingResult.status,
    createdAt: onboardingResult.createdAt,
  }),
};
/* c8 ignore end */
