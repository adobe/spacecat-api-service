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
 * Immutable baseline site top pages for IT tests.
 *
 * - Page 1: SITE_1, ahrefs, global — filter by source
 * - Page 2: SITE_1, rum, us — filter by source + geo
 * - Page 3: SITE_3 (denied), ahrefs, global — 403 test
 *
 * Format: camelCase (v2 / DynamoDB / ElectroDB)
 */
export const siteTopPages = [
  {
    siteId: '33333333-3333-4333-b333-333333333333',
    url: 'https://site1.example.com/page1',
    traffic: 1000,
    source: 'ahrefs',
    topKeyword: 'example keyword',
    geo: 'global',
    importedAt: '2025-01-20T10:00:00.000Z',
  },
  {
    siteId: '33333333-3333-4333-b333-333333333333',
    url: 'https://site1.example.com/page2',
    traffic: 500,
    source: 'rum',
    topKeyword: 'another keyword',
    geo: 'us',
    importedAt: '2025-01-20T10:00:00.000Z',
  },
  {
    siteId: '55555555-5555-4555-9555-555555555555',
    url: 'https://site3-denied.example.com/page1',
    traffic: 200,
    source: 'ahrefs',
    geo: 'global',
    importedAt: '2025-01-20T10:00:00.000Z',
  },
];
