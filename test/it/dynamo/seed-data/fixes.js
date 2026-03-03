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
 * Format: camelCase (v2 / DynamoDB / ElectroDB)
 *
 * Note: suggestionIds is NOT a FixEntity field — junction is set separately
 * via FixEntity.setSuggestionsForFixEntity() after creation.
 */
export const fixes = [
  {
    fixEntityId: 'cc111111-1111-4111-b111-111111111111',
    opportunityId: 'aa111111-1111-4111-b111-111111111111',
    type: 'CODE_CHANGE',
    status: 'PENDING',
    changeDetails: { file: '/blocks/hero/hero.js', diff: '+import { lazy } from ...' },
    origin: 'spacecat',
    executedAt: '2025-01-20T12:00:00.000Z',
    executedBy: 'test-bot@example.com',
    publishedAt: '2025-01-21T08:00:00.000Z',
  },
  {
    fixEntityId: 'cc222222-2222-4222-a222-222222222222',
    opportunityId: 'aa111111-1111-4111-b111-111111111111',
    type: 'CODE_CHANGE',
    status: 'DEPLOYED',
    changeDetails: { file: '/blocks/footer/footer.js', diff: '-old +new' },
    origin: 'spacecat',
  },
];
