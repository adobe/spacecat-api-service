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
 * Immutable baseline sentiment guidelines for IT tests.
 * All under SITE_1 (accessible).
 *
 * - GUIDELINE_1: enabled, audits: wikipedia-analysis + reddit-analysis
 * - GUIDELINE_2: enabled, no audits
 * - GUIDELINE_3: disabled, audit: youtube-analysis
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const sentimentGuidelines = [
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    guideline_id: 'b1111111-1111-4111-b111-111111111111',
    name: 'Wikipedia Tone',
    instruction: 'Analyze Wikipedia articles for neutral tone',
    audits: ['wikipedia-analysis', 'reddit-analysis'],
    enabled: true,
    created_by: 'seed@test.com',
  },
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    guideline_id: 'b2222222-2222-4222-a222-222222222222',
    name: 'Social Media Sentiment',
    instruction: 'Evaluate social media posts for brand sentiment',
    audits: [],
    enabled: true,
    created_by: 'seed@test.com',
  },
  {
    site_id: '33333333-3333-4333-b333-333333333333',
    guideline_id: 'b3333333-3333-4333-b333-333333333333',
    name: 'Archived Guideline',
    instruction: 'This guideline is no longer active',
    audits: ['youtube-analysis'],
    enabled: false,
    created_by: 'seed@test.com',
  },
];
