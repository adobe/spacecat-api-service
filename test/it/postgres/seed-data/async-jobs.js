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

import {
  BRAND_1_ID,
  SERENITY_CLASSIFY_JOB_1_ID,
  SERENITY_CLASSIFY_JOB_OTHER_BRAND_ID,
} from '../../shared/seed-ids.js';

/**
 * Immutable baseline async jobs for IT tests.
 *
 * JOB_1: A completed preflight job referencing SITE_1.
 *
 * Serenity classify jobs (serenity-docs#33): a COMPLETED job owned by BRAND_1
 * (happy path for the poll endpoint) and one carrying a foreign brandId (the
 * endpoint's ownership guard 404s it even though its jobType matches).
 *
 * Note: AsyncJob only exists in v3 (PostgreSQL) — no DynamoDB equivalent.
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const asyncJobs = [
  {
    id: 'eeee2222-2222-4222-a222-222222222222',
    status: 'IN_PROGRESS',
    metadata: {
      payload: { domain: 'detect.example.com', hlxVersion: null },
      jobType: 'site-detection',
      tags: ['site-detection'],
    },
  },
  {
    id: 'eeee1111-1111-4111-b111-111111111111',
    status: 'COMPLETED',
    result_location: 'https://results.example.com/preflight-001',
    result_type: 'URL',
    result: { summary: { totalIssues: 3, criticalIssues: 1 } },
    metadata: {
      payload: {
        siteId: '33333333-3333-4333-b333-333333333333',
        urls: ['https://site1.example.com/page1'],
        step: 'identify',
      },
      jobType: 'preflight',
      tags: ['preflight'],
    },
    started_at: '2025-01-20T10:00:00.000Z',
    ended_at: '2025-01-20T10:05:00.000Z',
  },
  {
    id: SERENITY_CLASSIFY_JOB_1_ID,
    status: 'COMPLETED',
    result: {
      created: [], skipped: [], failed: [], published: true,
    },
    metadata: {
      jobType: 'serenity-classify-prompts',
      brandId: BRAND_1_ID,
      tags: ['serenity-classify-prompts'],
    },
    started_at: '2025-01-21T10:00:00.000Z',
    ended_at: '2025-01-21T10:00:30.000Z',
  },
  {
    id: SERENITY_CLASSIFY_JOB_OTHER_BRAND_ID,
    status: 'COMPLETED',
    result: {
      created: [], skipped: [], failed: [], published: true,
    },
    metadata: {
      jobType: 'serenity-classify-prompts',
      // A brand other than BRAND_1 — the poll endpoint's ownership guard must
      // 404 this for a BRAND_1 caller rather than leak another brand's job.
      brandId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      tags: ['serenity-classify-prompts'],
    },
    started_at: '2025-01-21T11:00:00.000Z',
    ended_at: '2025-01-21T11:00:30.000Z',
  },
];
