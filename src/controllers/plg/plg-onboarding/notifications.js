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

export const REVIEW_REASONS = {
  DOMAIN_ALREADY_ONBOARDED_IN_ORG: 'DOMAIN_ALREADY_ONBOARDED_IN_ORG',
  AEM_SITE_CHECK: 'AEM_SITE_CHECK',
  DOMAIN_ALREADY_ASSIGNED: 'DOMAIN_ALREADY_ASSIGNED',
};

export const DOMAIN_ALREADY_ASSIGNED = 'already assigned to another organization';
export const DOMAIN_ALREADY_ONBOARDED_IN_ORG = 'another domain is already onboarded for this IMS org';

/**
 * Derives the review check key from the onboarding record's current state.
 * @param {object} onboarding - The PlgOnboarding record.
 * @returns {string|null} The check key enum value, or null if unknown.
 */
export function deriveCheckKey(onboarding) {
  /* c8 ignore next */
  const waitlistReason = onboarding.getWaitlistReason() || '';
  if (waitlistReason.includes(DOMAIN_ALREADY_ONBOARDED_IN_ORG)) {
    return REVIEW_REASONS.DOMAIN_ALREADY_ONBOARDED_IN_ORG;
  }
  if (waitlistReason.includes('is not an AEM site')) {
    return REVIEW_REASONS.AEM_SITE_CHECK;
  }
  if (waitlistReason.includes(DOMAIN_ALREADY_ASSIGNED)) {
    return REVIEW_REASONS.DOMAIN_ALREADY_ASSIGNED;
  }

  return null;
}
