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
 * Immutable baseline suggestion grants for IT tests (PostgreSQL only).
 *
 * - GRANT_1: SUGG_1 granted via TOKEN_1 — verifies grant-gated filtering
 *   SUGG_2 and SUGG_3 are NOT granted
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const suggestionGrants = [
  {
    id: 'f2222222-2222-4222-a222-222222222222',
    grant_id: 'f3333333-3333-4333-b333-333333333333',
    suggestion_id: 'bb111111-1111-4111-b111-111111111111',
    site_id: '33333333-3333-4333-b333-333333333333',
    token_id: 'f1111111-1111-4111-b111-111111111111',
    token_type: 'grant_cwv',
    granted_at: '2025-01-20T10:00:00.000Z',
  },
];
