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
 * Baseline task-management connections for IT tests.
 *
 * - CONN_1: ORG_1, jira_cloud, active — primary connection for ticket creation tests
 * - CONN_2: ORG_2, jira_cloud, active — used to verify cross-org isolation
 */
import {
  CONN_1_ID,
  CONN_2_ID,
  ORG_1_ID,
  ORG_2_ID,
} from '../../shared/seed-ids.js';

export const taskManagementConnections = [
  {
    id: CONN_1_ID,
    organization_id: ORG_1_ID,
    provider: 'jira_cloud',
    status: 'active',
    display_name: 'Org1 Jira',
    instance_url: 'https://org1.atlassian.net',
    connected_by: 'test-user-sub',
    external_instance_id: 'aabbccdd-0001-4000-b000-000000000001',
    metadata: { cloudId: 'aabbccdd-0001-4000-b000-000000000001', scopes: ['read:jira-work', 'write:jira-work'] },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: CONN_2_ID,
    organization_id: ORG_2_ID,
    provider: 'jira_cloud',
    status: 'active',
    display_name: 'Org2 Jira',
    instance_url: 'https://org2.atlassian.net',
    connected_by: 'test-user-sub',
    external_instance_id: 'aabbccdd-0002-4000-b000-000000000002',
    metadata: { cloudId: 'aabbccdd-0002-4000-b000-000000000002', scopes: ['read:jira-work', 'write:jira-work'] },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];
