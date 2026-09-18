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
 * Immutable baseline oae_validations rows for IT tests.
 *
 * OAE_JOB_1: one COMPLETE row for SUGG_1 (OPPTY_1, SITE_1 — accessible to the
 * `user` persona). Exercises GET /oae-validation/jobs/{jobId} happy path.
 *
 * OAE_JOB_SITE_3: one COMPLETE row for SUGG_4 (OPPTY_3, SITE_3 — denied to the
 * `user` persona). Used to assert cross-tenant job reads 404 (no existence
 * disclosure), the same IDOR-scoping shape as the Preflight/AsyncJob IT.
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const OAE_JOB_1_ID = 'ffff1111-1111-4111-b111-111111111111';
export const OAE_JOB_SITE_3_ID = 'ffff3333-3333-4333-b333-333333333333';

export const oaeValidations = [
  {
    id: 'ffee1111-1111-4111-b111-111111111111',
    job_id: OAE_JOB_1_ID,
    suggestion_id: 'bb111111-1111-4111-b111-111111111111', // SUGG_1 (SITE_1, accessible)
    status: 'COMPLETE',
    type: 'routing',
    outcome: 'pass',
    completed_at: '2026-01-01T00:00:00.000Z',
    metadata: { origin_status: 200 },
  },
  {
    id: 'ffee3333-3333-4333-b333-333333333333',
    job_id: OAE_JOB_SITE_3_ID,
    suggestion_id: 'bb444444-4444-4444-a444-444444444444', // SUGG_4 (SITE_3, denied)
    status: 'COMPLETE',
    type: 'routing',
    outcome: 'fail',
    completed_at: '2026-01-01T00:00:00.000Z',
    metadata: { origin_status: 403 },
  },
];
