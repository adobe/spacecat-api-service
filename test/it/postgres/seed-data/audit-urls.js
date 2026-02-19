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
 * Immutable baseline audit URLs for IT tests.
 * All under SITE_1 (accessible).
 *
 * - URL_1: byCustomer=true, audits: cwv + apex
 * - URL_2: byCustomer=true, no audits
 * - URL_3: byCustomer=false (system-added), audit: cwv
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const auditUrls = [
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    url: 'https://site1.example.com/page-one',
    by_customer: true,
    audits: ['cwv', 'apex'],
    created_by: 'seed@test.com',
  },
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    url: 'https://site1.example.com/page-two',
    by_customer: true,
    audits: [],
    created_by: 'seed@test.com',
  },
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    url: 'https://site1.example.com/page-three',
    by_customer: false,
    audits: ['cwv'],
    created_by: 'seed@test.com',
  },
];
