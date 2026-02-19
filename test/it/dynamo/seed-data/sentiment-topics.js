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
 * - TOPIC_1: enabled, 2 subPrompts
 * - TOPIC_2: enabled, 0 subPrompts
 * - TOPIC_3: disabled
 *
 * Format: camelCase (v2 / DynamoDB / ElectroDB)
 */
export const sentimentTopics = [
  {
    siteId: '33333333-3333-4333-b333-333333333333',
    topicId: 'a1111111-1111-4111-b111-111111111111',
    name: 'Product Quality',
    description: 'Tracks sentiment about product quality',
    subPrompts: ['How is build quality?', 'Is the product reliable?'],
    enabled: true,
    createdBy: 'seed@test.com',
  },
  {
    siteId: '33333333-3333-4333-b333-333333333333',
    topicId: 'a2222222-2222-4222-a222-222222222222',
    name: 'Customer Service',
    description: 'Tracks sentiment about customer service',
    subPrompts: [],
    enabled: true,
    createdBy: 'seed@test.com',
  },
  {
    siteId: '33333333-3333-4333-b333-333333333333',
    topicId: 'a3333333-3333-4333-b333-333333333333',
    name: 'Pricing',
    description: 'Tracks sentiment about pricing',
    subPrompts: ['Is it affordable?'],
    enabled: false,
    createdBy: 'seed@test.com',
  },
];
