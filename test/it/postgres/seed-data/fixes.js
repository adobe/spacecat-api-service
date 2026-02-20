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
 * Immutable baseline fix entities for IT tests.
 * All under OPPTY_1 (SITE_1, accessible).
 *
 * - FIX_1: CODE_CHANGE, PENDING — linked to SUGG_1 via junction
 * - FIX_2: CODE_CHANGE, DEPLOYED — different status for by-status filter
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const fixes = [
  {
    id: 'cc111111-1111-4111-b111-111111111111',
    opportunity_id: 'aa111111-1111-4111-b111-111111111111',
    type: 'CODE_CHANGE',
    status: 'PENDING',
    change_details: { file: '/blocks/hero/hero.js', diff: '+import { lazy } from ...' },
    origin: 'spacecat',
    executed_at: '2025-01-20T12:00:00.000Z',
    executed_by: 'test-bot@example.com',
    published_at: '2025-01-21T08:00:00.000Z',
  },
  {
    id: 'cc222222-2222-4222-a222-222222222222',
    opportunity_id: 'aa111111-1111-4111-b111-111111111111',
    type: 'CODE_CHANGE',
    status: 'DEPLOYED',
    change_details: { file: '/blocks/footer/footer.js', diff: '-old +new' },
    origin: 'spacecat',
  },
];

/**
 * Junction table: fix_entity_suggestions
 * Links FIX_1 → SUGG_1
 */
export const fixEntitySuggestions = [
  {
    fix_entity_id: 'cc111111-1111-4111-b111-111111111111',
    suggestion_id: 'bb111111-1111-4111-b111-111111111111',
    opportunity_id: 'aa111111-1111-4111-b111-111111111111',
    fix_entity_created_at: '2025-01-20T12:00:00.000Z',
  },
];
