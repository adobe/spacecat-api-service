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
 * Baseline brands for IT tests.
 *
 * BRAND_1 belongs to ORG_1 (accessible org) and is Semrush-managed
 * (`semrush_workspace_id` set), with its primary site SITE_1. This anchors the
 * PATCH /sites URL-immutability guard IT: changing SITE_1's baseURL must 403
 * because the site backs a Semrush-managed brand whose tracked domain lives on
 * its Semrush projects (no upstream domain-update path).
 *
 * Format: snake_case (PostgreSQL / PostgREST)
 */
export const brands = [
  {
    id: 'ab111111-1111-4111-b111-111111111111',
    organization_id: '11111111-1111-4111-b111-111111111111',
    name: 'Test Brand',
    site_id: '33333333-3333-4333-b333-333333333333',
    // Aligned with the Semrush vendor-mock seed (SERENITY_MOCK_WORKSPACE_ID in
    // seed-ids.js) so the brand-level serenity read endpoints resolve to a
    // workspace the mock actually seeds with a project/model/prompt/market —
    // not just an unknown workspace that 404s.
    semrush_workspace_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    status: 'active',
    origin: 'human',
    regions: ['us'],
    updated_by: 'seed',
  },
];
