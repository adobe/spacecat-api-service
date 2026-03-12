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
  CONSUMER_1_ID,
  CONSUMER_1_CLIENT_ID,
  CONSUMER_1_TECHNICAL_ACCOUNT_ID,
  CONSUMER_1_IMS_ORG_ID,
} from '../../shared/seed-ids.js';

/**
 * Immutable baseline consumers for IT tests.
 * Consumer 1 — ACTIVE, used for GET/update/revoke tests.
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */
export const consumers = [
  {
    id: CONSUMER_1_ID,
    client_id: CONSUMER_1_CLIENT_ID,
    technical_account_id: CONSUMER_1_TECHNICAL_ACCOUNT_ID,
    ims_org_id: CONSUMER_1_IMS_ORG_ID,
    consumer_name: 'IT Test Consumer',
    status: 'ACTIVE',
    capabilities: ['site:read', 'site:write'],
    revoked_at: null,
    created_at: '2026-01-15T10:00:00.000Z',
    updated_at: '2026-01-15T10:00:00.000Z',
    updated_by: 'system',
  },
];
