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
 * Immutable baseline organizations for IT tests.
 *
 * Org 1 — IMS org matches the JWT tenant, so jwt-user and jwt-admin have access.
 * Org 2 — Different IMS org, used for access-denied assertions.
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 * Note: entity ID field maps to `id` in the database.
 */
export const organizations = [
  {
    id: '11111111-1111-4111-b111-111111111111',
    name: 'Test Org Accessible',
    ims_org_id: 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg',
    config: {
      handlers: {},
      slack: { channel: 'C0FAKE0ORG1', workspace: 'WORKSPACE_TEST' },
    },
    fulfillable_items: {
      aem_sites_optimizer: { items: ['dx_aem_perf_content_requests'] },
    },
  },
  {
    id: '22222222-2222-4222-a222-222222222222',
    name: 'Test Org Denied',
    ims_org_id: 'DDDDDDDDEEEEEEEEFFFFFFFF@AdobeOrg',
  },
];
