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
 * Baseline brands for IT tests.
 *
 * BRAND_1 belongs to ORG_1 (accessible org).
 *
 * Format: snake_case (PostgreSQL / PostgREST)
 */
export const brands = [
  {
    id: 'ab111111-1111-4111-b111-111111111111',
    organization_id: '11111111-1111-4111-b111-111111111111',
    name: 'Test Brand',
    status: 'active',
    origin: 'human',
    regions: ['us'],
    updated_by: 'seed',
  },
];
