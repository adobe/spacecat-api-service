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
 * Data transfer object for PlgOnboarding.
 */
export const PlgOnboardingDto = {
  /**
   * Converts a PlgOnboarding model into a public-safe JSON object.
   * PII fields (updatedBy, reviews.reviewedBy) are excluded — safe to return to customers.
   * @param {Readonly<PlgOnboarding>} onboarding - PlgOnboarding model instance.
   * @returns {object}
   */
  toJSON: (onboarding) => ({
    id: onboarding.getId(),
    imsOrgId: onboarding.getImsOrgId(),
    domain: onboarding.getDomain(),
    baseURL: onboarding.getBaseURL(),
    status: onboarding.getStatus(),
    siteId: onboarding.getSiteId(),
    organizationId: onboarding.getOrganizationId(),
    steps: onboarding.getSteps(),
    error: onboarding.getError(),
    botBlocker: onboarding.getBotBlocker(),
    waitlistReason: onboarding.getWaitlistReason(),
    reviews: (onboarding.getReviews() || []).map(
      // eslint-disable-next-line no-unused-vars
      ({ reviewedBy: _reviewedBy, ...rest }) => rest,
    ),
    completedAt: onboarding.getCompletedAt(),
    createdAt: onboarding.getCreatedAt(),
    updatedAt: onboarding.getUpdatedAt(),
    // updatedBy intentionally omitted — PII, visible to admins only via toAdminJSON
  }),

  /**
   * Converts a PlgOnboarding model into an admin JSON object.
   * Includes PII fields (updatedBy, reviews.reviewedBy) — only use on admin-restricted endpoints.
   * @param {Readonly<PlgOnboarding>} onboarding - PlgOnboarding model instance.
   * @returns {object}
   */
  toAdminJSON: (onboarding) => ({
    ...PlgOnboardingDto.toJSON(onboarding),
    reviews: onboarding.getReviews() || [],
    updatedBy: onboarding.getUpdatedBy(),
    createdBy: onboarding.getCreatedBy(),
  }),
};
