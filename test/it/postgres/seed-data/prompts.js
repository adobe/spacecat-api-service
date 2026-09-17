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

import {
  ORG_1_ID,
  BRAND_1_ID,
  BP_PROMPT_1_ID,
  BP_PROMPT_1_INTENT,
} from '../../shared/seed-ids.js';

// A single active prompt carrying an `intent`, referenced by the seeded
// brand_presence_executions row so the topic-prompts endpoint can enrich
// `userIntent` from the prompts table.
export const prompts = [
  {
    id: BP_PROMPT_1_ID,
    organization_id: ORG_1_ID,
    brand_id: BRAND_1_ID,
    prompt_id: 'bp-intent-it',
    name: 'Intent IT Prompt',
    text: 'best pdf editor for mac',
    regions: ['us'],
    status: 'active',
    origin: 'human',
    source: 'config',
    intent: BP_PROMPT_1_INTENT,
  },
];
