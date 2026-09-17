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

/*
 * FACS state-mapping audit events for ORG_1 (ims_org_id
 * AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg), product LLMO. In production these rows are
 * hydrated by a consumer Lambda off the CloudWatch log stream; the IT seeds
 * them directly so the read endpoint
 * (GET /organizations/:organizationId/permission/audit-logs) has data.
 *
 * Standalone table (ims_org_id is TEXT, no FK), so these are not bound to the
 * organizations seed.
 *
 * Format: snake_case (PostgreSQL / PostgREST)
 */
export const facsAccessMappingAuditEvents = [
  {
    request_id: 'it-audit-req-1',
    ims_org_id: 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg',
    actor_id: 'admin@AdobeID',
    operation: 'create',
    outcome: 'allow',
    status_code: 201,
    binding_subject_type: 'user',
    binding_subject_id: 'grantee@AdobeID',
    resource_type: 'brand',
    resource_id: 'b1111111-1111-4111-8111-111111111111',
    product: 'LLMO',
    granted_capabilities: ['llmo/can_view'],
  },
  {
    request_id: 'it-audit-req-2',
    ims_org_id: 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg',
    actor_id: 'admin@AdobeID',
    operation: 'update_capabilities',
    outcome: 'allow',
    status_code: 200,
    binding_subject_type: 'user',
    binding_subject_id: 'grantee@AdobeID',
    resource_type: 'brand',
    resource_id: 'b1111111-1111-4111-8111-111111111111',
    product: 'LLMO',
    granted_capabilities: ['llmo/can_view', 'llmo/can_configure'],
  },
  {
    // A denied attempt — exercises the outcome=deny + denial_reason columns.
    request_id: 'it-audit-req-3',
    ims_org_id: 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg',
    actor_id: 'admin@AdobeID',
    operation: 'create',
    outcome: 'deny',
    denial_reason: 'duplicate',
    status_code: 409,
    binding_subject_type: 'user',
    binding_subject_id: 'grantee@AdobeID',
    resource_type: 'brand',
    resource_id: 'b1111111-1111-4111-8111-111111111111',
    product: 'LLMO',
  },
];
