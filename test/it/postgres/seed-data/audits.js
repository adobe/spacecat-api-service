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
 * Immutable baseline audits for IT tests.
 *
 * - A1 + A2: Two cwv audits for SITE_1 (tests ordering + latest derivation)
 * - A3: One apex audit for SITE_1 (tests type filtering + latest per type)
 * - A4: One cwv audit for SITE_3/denied (tests access control)
 *
 * LatestAudit is a PostgreSQL VIEW — no separate seeding needed.
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 * Note: entity ID field maps to `id` in the database.
 */
export const audits = [
  {
    id: 'aa111111-aa11-4a11-ba11-aa1111111111',
    site_id: '33333333-3333-4333-b333-333333333333',
    audit_type: 'cwv',
    audited_at: '2025-01-15T10:00:00.000Z',
    audit_result: { scores: { lcp: 1200, cls: 0.05, inp: 120 } },
    full_audit_ref: 'https://audit-ref.example.com/site1-cwv-1',
    is_live: true,
    is_error: false,
  },
  {
    id: 'aa222222-aa22-4a22-ba22-aa2222222222',
    site_id: '33333333-3333-4333-b333-333333333333',
    audit_type: 'cwv',
    audited_at: '2025-01-20T10:00:00.000Z',
    audit_result: { scores: { lcp: 800, cls: 0.02, inp: 90 } },
    full_audit_ref: 'https://audit-ref.example.com/site1-cwv-2',
    is_live: true,
    is_error: false,
    invocation_id: 'inv-20250120-site1-cwv',
  },
  {
    id: 'aa333333-aa33-4a33-ba33-aa3333333333',
    site_id: '33333333-3333-4333-b333-333333333333',
    audit_type: 'apex',
    audited_at: '2025-01-18T10:00:00.000Z',
    audit_result: { result: { apex: 'A' } },
    full_audit_ref: 'https://audit-ref.example.com/site1-apex-1',
    is_live: true,
    is_error: false,
  },
  {
    id: 'aa444444-aa44-4a44-ba44-aa4444444444',
    site_id: '55555555-5555-4555-9555-555555555555',
    audit_type: 'cwv',
    audited_at: '2025-01-17T10:00:00.000Z',
    audit_result: { scores: { lcp: 2500, cls: 0.15, inp: 300 } },
    full_audit_ref: 'https://audit-ref.example.com/site3-cwv-1',
    is_live: true,
    is_error: false,
  },
];
