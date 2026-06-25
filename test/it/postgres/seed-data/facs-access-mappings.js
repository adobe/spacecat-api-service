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
  ORG_1_IMS_ORG_ID,
  BRAND_MANAGER_SUBJECT,
  MANAGED_BRAND_ID,
  UNMANAGED_BRAND_ID,
  UNMANAGED_MAPPING_ID,
} from '../../shared/seed-ids.js';

/*
 * Baseline `facs_access_mappings` bindings for the hybrid-model §8.3 tests.
 *
 *  1. The brandManager persona (sub = BRAND_MANAGER_SUBJECT, empty JWT
 *     facs_permissions) holds state-layer `llmo/can_manage_users` on
 *     MANAGED_BRAND_ID only — making it a resource-scoped state-layer manager.
 *  2. A pre-existing `llmo/can_view` binding on UNMANAGED_BRAND_ID (a different
 *     user) lets the tests assert the brandManager cannot PATCH / DELETE
 *     bindings on resources it does not manage.
 *
 * Standalone table (ims_org_id is TEXT, no FK), so these are not bound to the
 * organizations seed. anon holds INSERT on this table (default privileges), so
 * the seed inserts without the writer JWT.
 *
 * Format: snake_case (PostgreSQL / PostgREST)
 */
export const facsAccessMappings = [
  {
    subject_type: 'user',
    subject_id: BRAND_MANAGER_SUBJECT,
    resource_type: 'brand',
    resource_id: MANAGED_BRAND_ID,
    ims_org_id: ORG_1_IMS_ORG_ID,
    product: 'LLMO',
    granted_capabilities: ['llmo/can_manage_users', 'llmo/can_view'],
    created_by: 'seed',
  },
  {
    id: UNMANAGED_MAPPING_ID,
    subject_type: 'user',
    subject_id: 'other-grantee@AdobeID',
    resource_type: 'brand',
    resource_id: UNMANAGED_BRAND_ID,
    ims_org_id: ORG_1_IMS_ORG_ID,
    product: 'LLMO',
    granted_capabilities: ['llmo/can_view'],
    created_by: 'seed',
  },
];
