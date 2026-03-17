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
   * Converts a PlgOnboarding model into a JSON object.
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
    completedAt: onboarding.getCompletedAt(),
    createdAt: onboarding.getCreatedAt(),
    updatedAt: onboarding.getUpdatedAt(),
  }),
};
