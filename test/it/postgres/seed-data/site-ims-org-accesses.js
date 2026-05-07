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
 * Baseline SiteImsOrgAccess grants for IT tests.
 *
 * All grants: organizationId=ORG_3 (delegate), targetOrganizationId=ORG_1 (site owner).
 *
 * - ACCESS_1: active — SITE_1, LLMO, no expiry
 * - ACCESS_2: expired — SITE_2, LLMO, expires_at in the past
 * - ACCESS_3: wrong product — SITE_1, ASO
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const siteImsOrgAccesses = [
  {
    id: 'fa111111-1111-4111-b111-111111111111',
    site_id: '33333333-3333-4333-b333-333333333333',
    organization_id: '33330000-3333-4333-b333-000000000333',
    target_organization_id: '11111111-1111-4111-b111-111111111111',
    product_code: 'LLMO',
    role: 'agency',
    granted_by: 'slack:U0TESTADMIN',
    updated_by: 'slack:U0TESTADMIN',
  },
  {
    id: 'fa222222-2222-4222-a222-222222222222',
    site_id: '44444444-4444-4444-a444-444444444444',
    organization_id: '33330000-3333-4333-b333-000000000333',
    target_organization_id: '11111111-1111-4111-b111-111111111111',
    product_code: 'LLMO',
    role: 'agency',
    expires_at: '2020-01-01T00:00:00.000Z',
    granted_by: 'slack:U0TESTADMIN',
    updated_by: 'slack:U0TESTADMIN',
  },
  {
    id: 'fa333333-3333-4333-b333-333333333333',
    site_id: '33333333-3333-4333-b333-333333333333',
    organization_id: '33330000-3333-4333-b333-000000000333',
    target_organization_id: '11111111-1111-4111-b111-111111111111',
    product_code: 'ASO',
    role: 'agency',
    granted_by: 'slack:U0TESTADMIN',
    updated_by: 'slack:U0TESTADMIN',
  },
];
