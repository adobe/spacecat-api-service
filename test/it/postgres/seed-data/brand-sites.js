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
 * Baseline brand_sites for IT tests.
 *
 * One row: BRAND_1 (ORG_1) linked to the Serenity market-mirror Site via a
 * `brand_sites` row tagged type='serenity'. This is a pure backend linkage —
 * the market's domain is NOT a brand URL (the brand is a shell with no domain
 * of its own), so the GET-brand response must EXCLUDE it from urls[]/siteIds
 * (see mapDbBrandToV2). The type='serenity' value requires the brand_sites
 * CHECK constraint extended by mysticat-data-service migration in v5.44.0.
 *
 * Format: snake_case (PostgreSQL / PostgREST)
 */
export const brandSites = [
  {
    organization_id: '11111111-1111-4111-b111-111111111111',
    brand_id: 'ab111111-1111-4111-b111-111111111111',
    site_id: '5e111111-1111-4111-b111-1111111111fe',
    paths: ['/'],
    type: 'serenity',
    updated_by: 'seed',
  },
];
