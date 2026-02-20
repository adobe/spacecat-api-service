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
 * Immutable baseline async jobs for IT tests.
 *
 * JOB_1: A completed preflight job referencing SITE_1.
 *
 * Note: AsyncJob only exists in v3 (PostgreSQL) — no DynamoDB equivalent.
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const asyncJobs = [
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
];
