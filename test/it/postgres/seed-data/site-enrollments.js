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
 * Immutable baseline site enrollments for IT tests.
 *
 * - SE_1: SITE_1 → ENTITLEMENT_1 (LLMO FREE_TRIAL)
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const siteEnrollments = [
  {
    id: 'ee111111-1111-4111-b111-111111111111',
    site_id: '33333333-3333-4333-b333-333333333333',
    entitlement_id: 'dd111111-1111-4111-b111-111111111111',
  },
  // SITE_1 enrolled under ORG_3's LLMO entitlement — enables filterSitesForProductCode to pass
  // when delegatedUser requests GET /organizations/ORG_3/sites with x-product: LLMO
  {
    id: 'ee222222-2222-4222-a222-222222222222',
    site_id: '33333333-3333-4333-b333-333333333333',
    entitlement_id: 'dd333333-3333-4333-b333-333333333333',
  },
  // SITE_4 (ORG_3's own site) enrolled under ORG_3's LLMO entitlement
  {
    id: 'ee333333-3333-4333-b333-333333333333',
    site_id: '44400000-4444-4444-b444-000000000444',
    entitlement_id: 'dd333333-3333-4333-b333-333333333333',
  },
];
