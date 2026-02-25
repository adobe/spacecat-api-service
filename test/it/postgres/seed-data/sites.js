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
 * Immutable baseline sites for IT tests.
 *
 * Site 1 & 2 belong to Org 1 (accessible).
 * Site 3 belongs to Org 2 (access-denied).
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 * Note: entity ID field maps to `id` in the database.
 */
export const sites = [
  {
    id: '33333333-3333-4333-b333-333333333333',
    base_url: 'https://site1.example.com',
    organization_id: '11111111-1111-4111-b111-111111111111',
    delivery_type: 'aem_edge',
    is_live: true,
    name: 'Site One',
    github_url: 'https://github.com/test-org/site1-repo',
    hlx_config: { cdnProdHost: 'main--site1-repo--test-org.aem.live', hlxVersion: 5 },
    delivery_config: {},
    config: {
      handlers: { cwv: { groupedURLs: [{ name: 'blog', pattern: '/blog/' }] } },
      imports: [{
        sources: ['ahrefs'], type: 'organic-traffic', enabled: true, destinations: ['default'],
      }],
      slack: { channel: 'C0FAKE0IT01', workspace: 'WORKSPACE_TEST' },
    },
    is_sandbox: false,
    authoring_type: 'documentauthoring',
    project_id: 'ff111111-1111-4111-b111-111111111111',
    is_primary_locale: true,
    region: 'US',
    language: 'en',
    page_types: [{ name: 'blog', pattern: '/blog/**' }, { name: 'product', pattern: '/products/**' }],
  },
  {
    id: '44444444-4444-4444-a444-444444444444',
    base_url: 'https://site2.example.com',
    organization_id: '11111111-1111-4111-b111-111111111111',
    delivery_type: 'aem_cs',
    is_live: false,
    name: 'Site Two',
    is_sandbox: true,
    authoring_type: 'cs',
    delivery_config: {
      programId: '50513',
      environmentId: '440257',
      authorURL: 'https://author-p50513-e440257.adobeaemcloud.com',
    },
    external_owner_id: 'p50513',
    external_site_id: 'e440257',
  },
  {
    id: '55555555-5555-4555-9555-555555555555',
    base_url: 'https://site3-denied.example.com',
    organization_id: '22222222-2222-4222-a222-222222222222',
    delivery_type: 'aem_edge',
    is_live: true,
  },
];
