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

// Mirrors PlgOnboardingModel.STATUSES — stable DB enum values.
export const STATUSES = {
  IN_PROGRESS: 'IN_PROGRESS',
  ONBOARDED: 'ONBOARDED',
  PRE_ONBOARDING: 'PRE_ONBOARDING',
  ERROR: 'ERROR',
  WAITING_FOR_IP_ALLOWLISTING: 'WAITING_FOR_IP_ALLOWLISTING',
  WAITLISTED: 'WAITLISTED',
  INACTIVE: 'INACTIVE',
};

// Mirrors PlgOnboardingModel.REVIEW_DECISIONS — stable DB enum values.
export const REVIEW_DECISIONS = {
  BYPASSED: 'BYPASSED',
  UPHELD: 'UPHELD',
};

// Mirrors EntitlementModel.PRODUCT_CODES.ASO and TIERS.PLG.
export const ASO_PRODUCT_CODE = 'aso_optimizer';
export const ASO_TIER = 'PLG';
