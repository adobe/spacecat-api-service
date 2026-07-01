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
  SITE_1_ID,
  BP_PROMPT_1_ID,
  BP_EXECUTION_1_ID,
  BP_TOPIC_1_NAME,
} from '../../shared/seed-ids.js';

// One execution row for BRAND_1 under topic BP_TOPIC_1_NAME, referencing the
// seeded prompt (BP_PROMPT_1_ID) via prompt_id. execution_date lands in the
// 2026_06 partition (present in the pinned mysticat-data-service IT image) and
// the test queries an explicit startDate/endDate around it so the assertion is
// not time-dependent. model matches the endpoint's DEFAULT_MODEL ('chatgpt-free').
export const brandPresenceExecutions = [
  {
    id: BP_EXECUTION_1_ID,
    organization_id: ORG_1_ID,
    brand_id: BRAND_1_ID,
    site_id: SITE_1_ID,
    prompt_id: BP_PROMPT_1_ID,
    model: 'chatgpt-free',
    execution_date: '2026-06-15',
    brand_name: 'Test Brand',
    category_name: 'Discovery',
    topics: BP_TOPIC_1_NAME,
    prompt: 'best pdf editor for mac',
    region_code: 'us',
    origin: 'human',
    mentions: true,
    citations: false,
    visibility_score: 80,
    sentiment: 'positive',
    dedupe_hash: 'bp-intent-it-dedupe-1',
  },
];
