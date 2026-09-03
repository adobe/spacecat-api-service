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
 * Immutable baseline `opportunity_urls` rows for IT tests (Lookup Service, POST
 * .../opportunities/by-urls). `url` is always the CANONICAL form (scheme/www/trailing-slash
 * stripped, lowercased) - exactly what the real shared writer (`syncUrlIndex`) persists -
 * so these rows exercise the real writer/reader canonicalization agreement, not a fixture
 * that assumes it.
 *
 * - Row 1: OPPTY_1 (SITE_1, code-suggestions, NEW) <- example.com/cwv-article
 * - Row 2: OPPTY_2 (SITE_1, broken-backlinks, RESOLVED) <- example.com/broken-link-source
 * - Row 3: OPPTY_3 (SITE_3, denied to the `user` persona) <- example.com/denied-source
 * - Row 4: a deliberately mis-scoped row - site_id says SITE_1, but entity_id (OPPTY_3)
 *   actually belongs to SITE_3. Simulates a stale/cross-site index row (the index is
 *   derived, best-effort-written data - see ADR 006 / the Lookup Service design doc) so the
 *   by-urls endpoint's own siteId re-check on the hydrated entity has something real to
 *   catch; PostgREST's own site-scoped index query cannot exercise this by itself.
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const opportunityUrls = [
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    entity_id: 'aa111111-1111-4111-b111-111111111111',
    entity_type: 'code-suggestions',
    url: 'example.com/cwv-article',
    updated_by: 'it-seed',
  },
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    entity_id: 'aa222222-2222-4222-a222-222222222222',
    entity_type: 'broken-backlinks',
    url: 'example.com/broken-link-source',
    updated_by: 'it-seed',
  },
  {
    site_id: '55555555-5555-4555-9555-555555555555',
    entity_id: 'aa333333-3333-4333-b333-333333333333',
    entity_type: 'code-suggestions',
    url: 'example.com/denied-source',
    updated_by: 'it-seed',
  },
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    entity_id: 'aa333333-3333-4333-b333-333333333333',
    entity_type: 'code-suggestions',
    url: 'example.com/cross-site-drift',
    updated_by: 'it-seed',
  },
];
