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

/**
 * Baseline ticket-suggestion bridge rows for IT tests.
 *
 * - TICKET_SUGG_1: links TICKET_1 ↔ TASK_MGMT_SUGGESTION_ID (logical DynamoDB ID, no FK)
 *
 * suggestion_id is a TEXT column (not a FK) — suggestions live in DynamoDB.
 */
import {
  TICKET_SUGG_1_ID,
  TICKET_1_ID,
  OPPTY_1_ID,
  TASK_MGMT_SUGGESTION_ID,
} from '../../shared/seed-ids.js';

export const ticketSuggestions = [
  {
    id: TICKET_SUGG_1_ID,
    ticket_id: TICKET_1_ID,
    suggestion_id: TASK_MGMT_SUGGESTION_ID,
    opportunity_id: OPPTY_1_ID,
    created_by: 'test-user-sub',
    created_at: '2026-01-01T00:00:00.000Z',
  },
];
