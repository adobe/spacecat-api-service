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

import { ORG_1_ID } from '../../shared/seed-ids.js';

/**
 * Baseline feature flags for IT tests.
 *
 * ORG_1 has the org-wide `LLMO/serenity` rollout flag ON so the serenity suite
 * (which drives the REAL controller through `isSerenityActiveForOrg`) reaches
 * its handlers. The feature-flags suite asserts membership via `.find()` (not an
 * exact count) and uses ORG_2 for its "no flags" case, so this extra row is
 * inert there. Cascade-deleted with `organizations` on reset.
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST).
 */
export const featureFlags = [
  {
    organization_id: ORG_1_ID,
    product: 'LLMO',
    flag_name: 'serenity',
    flag_value: true,
    updated_by: 'seed',
  },
];
