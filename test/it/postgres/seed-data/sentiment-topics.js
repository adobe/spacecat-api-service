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
 * Immutable baseline sentiment topics for IT tests.
 * All under SITE_1 (accessible).
 *
 * - TOPIC_1: enabled, 2 urls
 * - TOPIC_2: enabled, 0 urls
 * - TOPIC_3: disabled
 *
 * Note: urls field is postgrestIgnore so not included here.
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const sentimentTopics = [
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    topic_id: 'a1111111-1111-4111-b111-111111111111',
    name: 'Product Quality',
    description: 'Tracks sentiment about product quality',
    enabled: true,
    created_by: 'seed@test.com',
  },
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    topic_id: 'a2222222-2222-4222-a222-222222222222',
    name: 'Customer Service',
    description: 'Tracks sentiment about customer service',
    enabled: true,
    created_by: 'seed@test.com',
  },
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    topic_id: 'a3333333-3333-4333-b333-333333333333',
    name: 'Pricing',
    description: 'Tracks sentiment about pricing',
    enabled: false,
    created_by: 'seed@test.com',
  },
];
