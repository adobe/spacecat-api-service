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

import { siteSpec } from './site.spec.js';
import { opportunitySpec } from './opportunity.spec.js';

/**
 * Fix Entity Spec
 *
 * This spec demonstrates the dynamic entity pattern for Fix entities
 * with a non-standard create endpoint (207 Multi-Status batch response).
 *
 * Pattern: Dynamic Entity (Pattern B)
 * - Entity is created by the test
 * - Entity is deleted by the test (cleanup)
 * - Uses setupChain to access parent Site (static) and Opportunity (dynamic)
 *
 * Special handling:
 * - POST creates multiple fixes, returns 207 Multi-Status
 * - captureEntity uses a function to extract entity from batch response
 */

// Initial data for creating a new fix
// The POST endpoint expects an array of fixes
const initialData = {
  type: 'REDIRECT_UPDATE',
  changeDetails: {
    from: 'https://example.com/old-page',
    to: 'https://example.com/new-page',
    reason: 'E2E test fix - broken backlink redirect',
  },
};

// Destructure for use in operations
const { type, changeDetails } = initialData;

// Updated values for mutation testing
const updatedChangeDetails = {
  from: 'https://example.com/old-page',
  to: 'https://example.com/updated-target',
  reason: 'E2E test fix - updated redirect target',
};

export const fixSpec = {
  entityName: 'Fix',
  // basePath uses parentIds to get both siteId and opportunityId
  basePath: (parentIds) => `/sites/${parentIds.Site}/opportunities/${parentIds.Opportunity}/fixes`,
  initialData,

  // Fix belongs to Opportunity, which belongs to Site
  // Site is static fixture, Opportunity is dynamic
  setupChain: [siteSpec, opportunitySpec],

  operations: {
    create: {
      operationId: 'create-fix',
      method: 'POST',
      path: () => '',
      // POST endpoint expects an array of fixes
      requestPayload: [{ type, changeDetails }],
      expectedStatus: 207,
      // 207 Multi-Status returns: { fixes: [{ statusCode, fix }], metadata }
      // Use function to extract entity from first successful item
      captureEntity: (body) => body.fixes?.[0]?.fix,
    },
    get: {
      operationId: 'get-fix',
      method: 'GET',
      path: (entity) => `/${entity.id}`,
      requestPayload: null,
      expectedStatus: 200,
      responseSchema: 'Fix',
      expectedFields: {
        type,
        status: 'PENDING',
      },
    },
    update: {
      operationId: 'update-fix',
      method: 'PATCH',
      path: (entity) => `/${entity.id}`,
      requestPayload: {
        changeDetails: updatedChangeDetails,
      },
      expectedStatus: 200,
      responseSchema: 'Fix',
      expectedFields: {
        type,
        changeDetails: updatedChangeDetails,
      },
    },
    delete: {
      operationId: 'delete-fix',
      method: 'DELETE',
      path: (entity) => `/${entity.id}`,
      requestPayload: null,
      expectedStatus: 204,
      releaseEntity: true,
    },
  },
};
