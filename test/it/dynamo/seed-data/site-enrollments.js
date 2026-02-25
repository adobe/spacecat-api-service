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
 * Immutable baseline site enrollments for IT tests.
 *
 * - SE_1: SITE_1 → ENTITLEMENT_1 (LLMO FREE_TRIAL)
 *
 * Format: camelCase (v2 / DynamoDB / ElectroDB)
 */
export const siteEnrollments = [
  {
    siteEnrollmentId: 'ee111111-1111-4111-b111-111111111111',
    siteId: '33333333-3333-4333-b333-333333333333',
    entitlementId: 'dd111111-1111-4111-b111-111111111111',
  },
];
