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
 * - PLG_1: ORG_1 IMS org, site1.example.com, ONBOARDED
 *
 * Format: camelCase (v2 / DynamoDB / ElectroDB)
 *
 * NOTE: PlgOnboarding model does not exist in v2 data access.
 * This file is included for structural parity but records are not seeded.
 */
export const plgOnboardings = [
  {
    plgOnboardingId: 'd1111111-1111-4111-b111-111111111111',
    imsOrgId: 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg',
    domain: 'site1.example.com',
    baseURL: 'https://www.site1.example.com',
    status: 'ONBOARDED',
    siteId: '33333333-3333-4333-b333-333333333333',
    organizationId: '11111111-1111-4111-b111-111111111111',
    steps: {
      orgResolved: true,
      siteResolved: true,
      configUpdated: true,
      auditsEnabled: true,
      entitlementCreated: true,
    },
    completedAt: '2026-01-20T12:00:00.000Z',
  },
];
