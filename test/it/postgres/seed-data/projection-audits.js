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

import { SITE_1_ID } from '../../shared/seed-ids.js';

export const projectionAudits = [
  {
    correlation_id: 'corr-seed-1',
    source: 'sqs',
    event_type: 'audit.completed',
    scope_prefix: SITE_1_ID,
    handler_name: 'wrpc_import_brand_presence',
    output_entity: 'brand_presence',
    output_count: 42,
    skipped: false,
    projected_at: '2026-04-14T10:00:00Z',
  },
  {
    correlation_id: 'corr-seed-2',
    source: 'sqs',
    event_type: 'audit.completed',
    scope_prefix: SITE_1_ID,
    handler_name: 'wrpc_import_brand_presence',
    output_entity: 'brand_presence',
    output_count: 38,
    skipped: false,
    projected_at: '2026-04-14T09:00:00Z',
  },
  {
    correlation_id: 'corr-seed-3',
    source: 'sqs',
    event_type: 'audit.completed',
    scope_prefix: SITE_1_ID,
    handler_name: 'wrpc_import_brand_presence',
    output_entity: 'brand_presence',
    output_count: 0,
    skipped: true,
    projected_at: '2026-04-14T08:00:00Z',
  },
];
