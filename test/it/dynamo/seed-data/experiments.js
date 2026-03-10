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
 * Immutable baseline experiments for IT tests.
 * All under SITE_1 (accessible).
 *
 * - EXP_1: full, ACTIVE
 * - EXP_2: AB, INACTIVE
 *
 * Format: camelCase (v2 / DynamoDB / ElectroDB)
 */
export const experiments = [
  {
    siteId: '33333333-3333-4333-b333-333333333333',
    expId: 'exp-001',
    name: 'Hero Banner Test',
    url: 'https://site1.example.com/page1',
    type: 'full',
    status: 'ACTIVE',
    startDate: '2025-01-01T00:00:00.000Z',
    endDate: '2025-06-01T00:00:00.000Z',
    variants: [{ name: 'control', url: '/control' }, { name: 'challenger', url: '/challenger' }],
    conversionEventName: 'click',
    conversionEventValue: 'hero-cta',
  },
  {
    siteId: '33333333-3333-4333-b333-333333333333',
    expId: 'exp-002',
    name: 'Footer Layout Test',
    url: 'https://site1.example.com/page2',
    type: 'AB',
    status: 'INACTIVE',
    startDate: '2025-02-01T00:00:00.000Z',
    variants: [{ name: 'A', url: '/a' }, { name: 'B', url: '/b' }],
  },
];
