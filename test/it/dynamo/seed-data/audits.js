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
 * v2 Audit.create() auto-creates LatestAudit via post-create hook.
 *
 * Format: camelCase (v2 / DynamoDB / ElectroDB)
 */
export const audits = [
  {
    siteId: '33333333-3333-4333-b333-333333333333',
    auditType: 'cwv',
    auditedAt: '2025-01-15T10:00:00.000Z',
    auditResult: { scores: { lcp: 1200, cls: 0.05, inp: 120 } },
    fullAuditRef: 'https://audit-ref.example.com/site1-cwv-1',
    isLive: true,
    isError: false,
  },
  {
    siteId: '33333333-3333-4333-b333-333333333333',
    auditType: 'cwv',
    auditedAt: '2025-01-20T10:00:00.000Z',
    auditResult: { scores: { lcp: 800, cls: 0.02, inp: 90 } },
    fullAuditRef: 'https://audit-ref.example.com/site1-cwv-2',
    isLive: true,
    isError: false,
    invocationId: 'inv-20250120-site1-cwv',
  },
  {
    siteId: '33333333-3333-4333-b333-333333333333',
    auditType: 'apex',
    auditedAt: '2025-01-18T10:00:00.000Z',
    auditResult: { result: { apex: 'A' } },
    fullAuditRef: 'https://audit-ref.example.com/site1-apex-1',
    isLive: true,
    isError: false,
  },
  {
    siteId: '55555555-5555-4555-9555-555555555555',
    auditType: 'cwv',
    auditedAt: '2025-01-17T10:00:00.000Z',
    auditResult: { scores: { lcp: 2500, cls: 0.15, inp: 300 } },
    fullAuditRef: 'https://audit-ref.example.com/site3-cwv-1',
    isLive: true,
    isError: false,
  },
];
