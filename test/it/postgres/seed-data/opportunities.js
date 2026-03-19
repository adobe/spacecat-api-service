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
 * Immutable baseline opportunities for IT tests.
 *
 * - OPPTY_1: SITE_1, code-suggestions, NEW — main oppty with suggestions/fixes
 * - OPPTY_2: SITE_1, broken-backlinks, RESOLVED — different status for by-status filter
 * - OPPTY_3: SITE_3 (denied), code-suggestions, NEW — for 403 tests
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const opportunities = [
  {
    id: 'aa111111-1111-4111-b111-111111111111',
    site_id: '33333333-3333-4333-b333-333333333333',
    type: 'code-suggestions',
    origin: 'AI',
    title: 'Fix CWV issues',
    description: 'Improve Core Web Vitals scores',
    status: 'NEW',
    data: { cwvMetric: 'lcp', currentScore: 3200, targetScore: 2500 },
    runbook: 'https://wiki.example.com/runbooks/cwv-optimization',
    guidance: { steps: ['Review affected pages', 'Optimize LCP resources', 'Re-audit'] },
    tags: ['performance', 'cwv'],
  },
  {
    id: 'aa222222-2222-4222-a222-222222222222',
    site_id: '33333333-3333-4333-b333-333333333333',
    type: 'broken-backlinks',
    origin: 'AUTOMATION',
    title: 'Fix broken links',
    description: 'Resolve broken backlinks detected by audit',
    status: 'RESOLVED',
    data: { brokenLinks: 5 },
    runbook: 'https://wiki.example.com/runbooks/broken-backlinks',
    tags: ['seo', 'backlinks'],
  },
  {
    id: 'aa333333-3333-4333-b333-333333333333',
    site_id: '55555555-5555-4555-9555-555555555555',
    type: 'code-suggestions',
    origin: 'AI',
    title: 'Denied site oppty',
    description: 'Opportunity on denied site',
    status: 'NEW',
    data: { cwvMetric: 'cls', currentScore: 0.25 },
  },
];
