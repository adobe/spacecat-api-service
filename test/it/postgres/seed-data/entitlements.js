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
 * Immutable baseline entitlements for IT tests.
 * All under ORG_1 (accessible).
 *
 * - ENT_1: LLMO, FREE_TRIAL — used by SiteEnrollment + TrialUserActivity
 * - ENT_2: ASO, PAID — different product for list count
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const entitlements = [
  {
    id: 'dd111111-1111-4111-b111-111111111111',
    organization_id: '11111111-1111-4111-b111-111111111111',
    product_code: 'LLMO',
    tier: 'FREE_TRIAL',
    quotas: { llmo_trial_prompts: 200, llmo_trial_prompts_consumed: 0 },
  },
  {
    id: 'dd222222-2222-4222-a222-222222222222',
    organization_id: '11111111-1111-4111-b111-111111111111',
    product_code: 'ASO',
    tier: 'PAID',
  },
];
