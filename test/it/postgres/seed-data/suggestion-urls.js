/*
 * Copyright 2026 Adobe. All rights reserved.
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
 * Immutable baseline `suggestion_urls` rows for IT tests (Lookup Service, POST
 * .../suggestions/by-urls). `url` is always the CANONICAL form (scheme/www/trailing-slash
 * stripped, lowercased) - exactly what the real shared writer (`syncUrlIndexMany`) persists.
 *
 * - Row 1: SUGG_1 (under OPPTY_1, SITE_1, NEW) <- example.com/hero-image-source
 * - Row 2: SUGG_2 (under OPPTY_1, SITE_1, APPROVED) <- example.com/redirect-source
 * - Row 3: SUGG_4 (under OPPTY_3, SITE_3, denied to the `user` persona)
 *   <- example.com/denied-suggestion-source
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const suggestionUrls = [
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    entity_id: 'bb111111-1111-4111-b111-111111111111',
    entity_type: 'code-suggestions',
    url: 'example.com/hero-image-source',
    updated_by: 'it-seed',
  },
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    entity_id: 'bb222222-2222-4222-a222-222222222222',
    entity_type: 'code-suggestions',
    url: 'example.com/redirect-source',
    updated_by: 'it-seed',
  },
  {
    site_id: '55555555-5555-4555-9555-555555555555',
    entity_id: 'bb444444-4444-4444-a444-444444444444',
    entity_type: 'code-suggestions',
    url: 'example.com/denied-suggestion-source',
    updated_by: 'it-seed',
  },
];
