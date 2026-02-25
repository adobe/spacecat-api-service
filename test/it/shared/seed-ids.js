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
 * Canonical seed identifiers — used by shared tests and seed-data files.
 * Values must match across dynamo/seed-data and postgres/seed-data.
 * All IDs are valid UUIDv4 (position 13 = '4', position 17 = '8'|'9'|'a'|'b').
 */

// ── Organizations ──

export const ORG_1_ID = '11111111-1111-4111-b111-111111111111';
export const ORG_1_NAME = 'Test Org Accessible';
export const ORG_1_IMS_ORG_ID = 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg';

export const ORG_2_ID = '22222222-2222-4222-a222-222222222222';
export const ORG_2_NAME = 'Test Org Denied';
export const ORG_2_IMS_ORG_ID = 'DDDDDDDDEEEEEEEEFFFFFFFF@AdobeOrg';

// ── Sites ──

export const SITE_1_ID = '33333333-3333-4333-b333-333333333333';
export const SITE_1_BASE_URL = 'https://site1.example.com';

export const SITE_2_ID = '44444444-4444-4444-a444-444444444444';
export const SITE_2_BASE_URL = 'https://site2.example.com';

export const SITE_3_ID = '55555555-5555-4555-9555-555555555555';
export const SITE_3_BASE_URL = 'https://site3-denied.example.com';

// ── Audits ──

export const AUDIT_TYPE_CWV = 'cwv';
export const AUDIT_TYPE_APEX = 'apex';

// Known auditedAt timestamps for seed audits (used as composite keys with siteId + auditType)
export const AUDIT_1_AUDITED_AT = '2025-01-15T10:00:00.000Z'; // SITE_1 cwv (older)
export const AUDIT_2_AUDITED_AT = '2025-01-20T10:00:00.000Z'; // SITE_1 cwv (latest)
export const AUDIT_3_AUDITED_AT = '2025-01-18T10:00:00.000Z'; // SITE_1 apex
export const AUDIT_4_AUDITED_AT = '2025-01-17T10:00:00.000Z'; // SITE_3 cwv (denied)

// ── Opportunities ──

export const OPPTY_1_ID = 'aa111111-1111-4111-b111-111111111111'; // SITE_1, code-suggestions, NEW
export const OPPTY_2_ID = 'aa222222-2222-4222-a222-222222222222'; // SITE_1, broken-backlinks, RESOLVED
export const OPPTY_3_ID = 'aa333333-3333-4333-b333-333333333333'; // SITE_3 (denied), code-suggestions, NEW

// ── Suggestions (all under OPPTY_1) ──

export const SUGG_1_ID = 'bb111111-1111-4111-b111-111111111111'; // CODE_CHANGE, NEW
export const SUGG_2_ID = 'bb222222-2222-4222-a222-222222222222'; // REDIRECT_UPDATE, APPROVED
export const SUGG_3_ID = 'bb333333-3333-4333-b333-333333333333'; // CODE_CHANGE, NEW

// ── FixEntities (all under OPPTY_1) ──

export const FIX_1_ID = 'cc111111-1111-4111-b111-111111111111'; // CODE_CHANGE, PENDING
export const FIX_1_EXECUTED_AT = '2025-01-20T12:00:00.000Z'; // deterministic date for junction
export const FIX_1_CREATED_DATE = '2025-01-20'; // fixEntityCreatedDate derived from executedAt
export const FIX_2_ID = 'cc222222-2222-4222-a222-222222222222'; // CODE_CHANGE, DEPLOYED

// ── Experiments (under SITE_1) ──

export const EXP_1_EXP_ID = 'exp-001'; // full, ACTIVE
export const EXP_2_EXP_ID = 'exp-002'; // AB, INACTIVE

// ── Entitlements (under ORG_1) ──

export const ENTITLEMENT_1_ID = 'dd111111-1111-4111-b111-111111111111'; // LLMO, FREE_TRIAL
export const ENTITLEMENT_2_ID = 'dd222222-2222-4222-a222-222222222222'; // ASO, PAID

// ── SiteEnrollments ──

export const SITE_ENROLLMENT_1_ID = 'ee111111-1111-4111-b111-111111111111'; // SITE_1 → ENTITLEMENT_1

// ── Projects ──

export const PROJECT_1_ID = 'ff111111-1111-4111-b111-111111111111'; // ORG_1, accessible
export const PROJECT_1_NAME = 'Test Project Alpha';
export const PROJECT_2_ID = 'ff222222-2222-4222-a222-222222222222'; // ORG_2, denied
export const PROJECT_2_NAME = 'Test Project Denied';

// ── SentimentTopics (under SITE_1) ──

export const TOPIC_1_ID = 'a1111111-1111-4111-b111-111111111111'; // enabled, 2 subPrompts
export const TOPIC_2_ID = 'a2222222-2222-4222-a222-222222222222'; // enabled, 0 subPrompts
export const TOPIC_3_ID = 'a3333333-3333-4333-b333-333333333333'; // disabled

// ── SentimentGuidelines (under SITE_1) ──

export const GUIDELINE_1_ID = 'b1111111-1111-4111-b111-111111111111'; // enabled, 2 audits
export const GUIDELINE_2_ID = 'b2222222-2222-4222-a222-222222222222'; // enabled, 0 audits
export const GUIDELINE_3_ID = 'b3333333-3333-4333-b333-333333333333'; // disabled, 1 audit

// ── AuditUrls (under SITE_1) ──

export const AUDIT_URL_1 = 'https://site1.example.com/page-one'; // byCustomer=true, audits: cwv+apex
export const AUDIT_URL_2 = 'https://site1.example.com/page-two'; // byCustomer=true, no audits
export const AUDIT_URL_3 = 'https://site1.example.com/page-three'; // byCustomer=false (system)

// ── TrialUsers (under ORG_1) ──

export const TRIAL_USER_1_ID = 'c1111111-1111-4111-b111-111111111111';
export const TRIAL_USER_1_EMAIL = 'test-trial@example.com'; // matches jwt-trial-user

// ── TrialUserActivities (under SITE_1) ──

export const TRIAL_USER_ACTIVITY_1_ID = 'c2222222-2222-4222-a222-222222222222'; // SIGN_IN, LLMO

// ── AsyncJobs (preflight) ──

export const ASYNC_JOB_1_ID = 'eeee1111-1111-4111-b111-111111111111'; // COMPLETED preflight job
export const NON_EXISTENT_JOB_ID = 'eeee9999-9999-4999-b999-999999999999';

// ── Non-existent IDs for 404 tests ──

export const NON_EXISTENT_ORG_ID = '99999999-9999-4999-b999-999999999999';
export const NON_EXISTENT_SITE_ID = '88888888-8888-4888-a888-888888888888';
export const NON_EXISTENT_IMS_ORG_ID = 'ZZZZZZZZZZZZZZZZZZZZZZZZ@AdobeOrg';
export const NON_EXISTENT_OPPTY_ID = 'dd999999-9999-4999-b999-999999999999';
export const NON_EXISTENT_SUGG_ID = 'ee999999-9999-4999-b999-999999999999';
export const NON_EXISTENT_FIX_ID = 'ff999999-9999-4999-b999-999999999999';
export const NON_EXISTENT_PROJECT_ID = 'ff999999-9999-4999-a999-999999999999';
export const NON_EXISTENT_TOPIC_ID = 'a9999999-9999-4999-b999-999999999999';
export const NON_EXISTENT_GUIDELINE_ID = 'b9999999-9999-4999-b999-999999999999';
