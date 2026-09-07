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

import { BRAND_1_ID } from '../../shared/seed-ids.js';

/**
 * Fixture for GET /v2/orgs/:spaceCatId/brands/:brandId/markets. NOT part of the
 * baseline seed (kept out of seed() below) — a `sites.js` IT asserts BRAND_1 has
 * ZERO `brand_to_semrush_projects` rows in the baseline, so this is only inserted
 * by the brand-markets suite via seedBrandMarketsFixture(), after that suite's
 * own resetPostgres().
 *
 * Three rows under BRAND_1:
 *  - a live whole-country row (India, geoTargetId 2356 = 2000 + ISO numeric 356)
 *  - a soft-deleted row (deleted_at set) — must be excluded from the response
 *  - a live row whose geoTargetId is not a whole country (sub-national) — must
 *    be skipped rather than mislabeled
 *
 * Format: snake_case (PostgreSQL / PostgREST)
 */
export const brandSemrushProjects = [
  {
    brand_id: BRAND_1_ID,
    semrush_project_id: 'it-brand-markets-live-in',
    semrush_location_id: 2356,
    language: 'en',
    deleted_at: null,
    updated_by: 'seed',
  },
  {
    brand_id: BRAND_1_ID,
    semrush_project_id: 'it-brand-markets-deleted-de',
    semrush_location_id: 2276,
    language: 'de',
    deleted_at: '2026-01-01T00:00:00.000Z',
    updated_by: 'seed',
  },
  {
    brand_id: BRAND_1_ID,
    semrush_project_id: 'it-brand-markets-noncountry',
    semrush_location_id: 1023191,
    language: 'en',
    deleted_at: null,
    updated_by: 'seed',
  },
];
