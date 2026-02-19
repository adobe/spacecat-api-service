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
 * Format: camelCase (v2 / DynamoDB / ElectroDB)
 */
export const projects = [
  {
    projectId: 'ff111111-1111-4111-b111-111111111111',
    organizationId: '11111111-1111-4111-b111-111111111111',
    projectName: 'Test Project Alpha',
  },
  {
    projectId: 'ff222222-2222-4222-a222-222222222222',
    organizationId: '22222222-2222-4222-a222-222222222222',
    projectName: 'Test Project Denied',
  },
];
