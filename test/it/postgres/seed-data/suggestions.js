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
 * Immutable baseline suggestions for IT tests.
 * All under OPPTY_1 (SITE_1, accessible).
 *
 * - SUGG_1: CODE_CHANGE, NEW — base suggestion, linked to FIX_1
 * - SUGG_2: REDIRECT_UPDATE, APPROVED — different status for by-status filter
 * - SUGG_3: CODE_CHANGE, NEW — extra for list count assertions
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const suggestions = [
  {
    id: 'bb111111-1111-4111-b111-111111111111',
    opportunity_id: 'aa111111-1111-4111-b111-111111111111',
    type: 'CODE_CHANGE',
    rank: 1,
    status: 'NEW',
    data: { title: 'Update hero image', from: '/old-hero.png', to: '/new-hero.webp' },
    kpi_deltas: { estimatedKPILift: 0.15 },
  },
  {
    id: 'bb222222-2222-4222-a222-222222222222',
    opportunity_id: 'aa111111-1111-4111-b111-111111111111',
    type: 'REDIRECT_UPDATE',
    rank: 2,
    status: 'APPROVED',
    data: { title: 'Fix redirect chain', from: '/old-page', to: '/new-page' },
  },
  {
    id: 'bb333333-3333-4333-b333-333333333333',
    opportunity_id: 'aa111111-1111-4111-b111-111111111111',
    type: 'CODE_CHANGE',
    rank: 3,
    status: 'NEW',
    data: { title: 'Lazy load images', from: 'eager', to: 'lazy' },
  },
];
