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
 * Baseline tickets for IT tests.
 *
 * - TICKET_1: ORG_1, linked to OPPTY_1, will have a TicketSuggestion bridge row
 * - TICKET_2: ORG_1, linked to OPPTY_1, no suggestion link
 */
import {
  TICKET_1_ID,
  TICKET_2_ID,
  CONN_1_ID,
  ORG_1_ID,
  OPPTY_1_ID,
} from '../../shared/seed-ids.js';

export const tickets = [
  {
    id: TICKET_1_ID,
    organization_id: ORG_1_ID,
    connection_id: CONN_1_ID,
    opportunity_id: OPPTY_1_ID,
    external_ticket_id: '10001',
    ticket_key: 'TEST-1',
    ticket_url: 'https://org1.atlassian.net/browse/TEST-1',
    ticket_status: 'Open',
    ticket_provider: 'jira_cloud',
    created_by: 'test-user-sub',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: TICKET_2_ID,
    organization_id: ORG_1_ID,
    connection_id: CONN_1_ID,
    opportunity_id: OPPTY_1_ID,
    external_ticket_id: '10002',
    ticket_key: 'TEST-2',
    ticket_url: 'https://org1.atlassian.net/browse/TEST-2',
    ticket_status: 'Open',
    ticket_provider: 'jira_cloud',
    created_by: 'test-user-sub',
    created_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  },
];
