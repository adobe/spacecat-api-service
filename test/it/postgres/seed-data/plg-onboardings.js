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
 * Immutable baseline PLG onboardings for IT tests.
 *
 * - PLG_1: ORG_1, site1.example.com, ONBOARDED (used for ONBOARDED→OUTDATED transition test)
 * - PLG_2: ORG_1, waitlisted-site.example.com, WAITLISTED
 *          (UPHELD test → REJECTED, then REJECTED→OUTDATED)
 * - PLG_3: ORG_1, in-progress-plg-it.example.com, IN_PROGRESS (negative case for PATCH)
 * - PLG_4: ORG_1, waitlisted-for-transition.example.com, WAITLISTED
 *          (WAITLISTED→OUTDATED transition test)
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const plgOnboardings = [
  {
    id: 'd1111111-1111-4111-b111-111111111111',
    ims_org_id: 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg',
    domain: 'site1.example.com',
    base_url: 'https://www.site1.example.com',
    status: 'ONBOARDED',
    site_id: '33333333-3333-4333-b333-333333333333',
    organization_id: '11111111-1111-4111-b111-111111111111',
    steps: {
      orgResolved: true,
      siteResolved: true,
      configUpdated: true,
      auditsEnabled: true,
      entitlementCreated: true,
    },
    completed_at: '2026-01-20T12:00:00.000Z',
  },
  {
    id: 'd2222222-2222-4222-b222-222222222222',
    ims_org_id: 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg',
    domain: 'waitlisted-site.example.com',
    base_url: 'https://www.waitlisted-site.example.com',
    status: 'WAITLISTED',
    organization_id: '11111111-1111-4111-b111-111111111111',
    waitlist_reason: 'Domain site1.example.com is another domain is already onboarded for this IMS org',
    steps: {
      orgResolved: true,
    },
  },
  {
    id: 'd3333333-3333-4333-b333-333333333333',
    ims_org_id: 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg',
    domain: 'in-progress-plg-it.example.com',
    base_url: 'https://www.in-progress-plg-it.example.com',
    status: 'IN_PROGRESS',
    organization_id: '11111111-1111-4111-b111-111111111111',
    steps: {
      orgResolved: true,
    },
  },
  {
    id: 'd4444444-4444-4444-b444-444444444444',
    ims_org_id: 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg',
    domain: 'waitlisted-for-transition.example.com',
    base_url: 'https://www.waitlisted-for-transition.example.com',
    status: 'WAITLISTED',
    organization_id: '11111111-1111-4111-b111-111111111111',
    waitlist_reason: 'Waitlisted pending manual review',
    steps: {
      orgResolved: true,
    },
  },
];
