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
 * Immutable baseline projects for IT tests.
 *
 * - PROJ_1: ORG_1 (accessible) — CRUD base
 * - PROJ_2: ORG_2 (denied) — 403 test
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const projects = [
  {
    id: 'ff111111-1111-4111-b111-111111111111',
    organization_id: '11111111-1111-4111-b111-111111111111',
    project_name: 'Test Project Alpha',
  },
  {
    id: 'ff222222-2222-4222-a222-222222222222',
    organization_id: '22222222-2222-4222-a222-222222222222',
    project_name: 'Test Project Denied',
  },
];
