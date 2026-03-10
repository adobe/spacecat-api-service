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
 * Format: camelCase (v2 / DynamoDB / ElectroDB)
 */
export const sites = [
  {
    siteId: '33333333-3333-4333-b333-333333333333',
    baseURL: 'https://site1.example.com',
    organizationId: '11111111-1111-4111-b111-111111111111',
    deliveryType: 'aem_edge',
    isLive: true,
    name: 'Site One',
    gitHubURL: 'https://github.com/test-org/site1-repo',
    hlxConfig: { cdnProdHost: 'main--site1-repo--test-org.aem.live', hlxVersion: 5 },
    deliveryConfig: {},
    config: {
      handlers: { cwv: { groupedURLs: [{ name: 'blog', pattern: '/blog/' }] } },
      imports: [{
        sources: ['ahrefs'], type: 'organic-traffic', enabled: true, destinations: ['default'],
      }],
      slack: { channel: 'C0FAKE0IT01', workspace: 'WORKSPACE_TEST' },
    },
    isSandbox: false,
    authoringType: 'documentauthoring',
    projectId: 'ff111111-1111-4111-b111-111111111111',
    isPrimaryLocale: true,
    region: 'US',
    language: 'en',
    pageTypes: [{ name: 'blog', pattern: '/blog/**' }, { name: 'product', pattern: '/products/**' }],
  },
  {
    siteId: '44444444-4444-4444-a444-444444444444',
    baseURL: 'https://site2.example.com',
    organizationId: '11111111-1111-4111-b111-111111111111',
    deliveryType: 'aem_cs',
    isLive: false,
    name: 'Site Two',
    isSandbox: true,
    authoringType: 'cs',
    deliveryConfig: {
      programId: '50513',
      environmentId: '440257',
      authorURL: 'https://author-p50513-e440257.adobeaemcloud.com',
    },
  },
  {
    siteId: '55555555-5555-4555-9555-555555555555',
    baseURL: 'https://site3-denied.example.com',
    organizationId: '22222222-2222-4222-a222-222222222222',
    deliveryType: 'aem_edge',
    isLive: true,
  },
];
