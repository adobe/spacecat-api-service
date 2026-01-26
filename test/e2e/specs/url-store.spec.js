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

/**
 * UrlStore Entity Spec
 *
 * This spec demonstrates handling of entities with non-standard path keys
 * and bulk operations.
 *
 * Pattern: Dynamic Entity (Pattern B)
 * - Entity is created by the test
 * - Entity is deleted by the test (cleanup)
 * - Uses setupChain to access parent Site (static fixture)
 *
 * Special handling:
 * - No `id` field - entity uses composite key: siteId + url
 * - GET single uses base64url-encoded URL in path
 * - POST, PATCH, DELETE are bulk operations (accept/return arrays)
 * - DELETE requires request body and returns 200 (not 204)
 */

// Initial data for creating a new URL entry
// The POST endpoint expects an array of AuditUrlInput objects
const initialData = {
  url: 'https://example.com/e2e-test-url-store-page',
  byCustomer: true,
  // audits: ['broken-backlinks-auto-suggest'],
  audits: ['broken-backlinks-auto-suggest'],
};

// Destructure for use in operations
const { url, byCustomer, audits } = initialData;

// Updated values for mutation testing
const updatedAudits = ['broken-backlinks-auto-suggest'];

export const urlStoreSpec = {
  entityName: 'UrlStore',
  basePath: (parentIds) => `/sites/${parentIds.Site}/url-store`,
  initialData,

  // UrlStore belongs to Site (static fixture)
  setupChain: [siteSpec],

  operations: {
    create: {
      operationId: 'create-url-store',
      method: 'POST',
      path: () => '',
      // path: (entity) => `/${Buffer.from(url).toString('base64url')}`,
      // POST endpoint expects an array of AuditUrlInput
      requestPayload: [{ url, byCustomer, audits }],
      expectedStatus: 201,
      responseSchema: 'AuditUrlBulkResponse',
      // Bulk response returns: { metadata, failures, items: [AuditUrl] }
      expectedFields: {
        metadata: {
          total: 1,
          success: 1,
          failure: 0,
        },
      },
      // Extract the first item from the bulk response
      captureEntity: (body) => body.items?.[0],
    },
    get: {
      operationId: 'get-url-store',
      method: 'GET',
      // Path uses base64url-encoded URL (RFC 4648 §5, no padding)
      path: (entity) => `/${Buffer.from(entity.url).toString('base64url')}`,
      requestPayload: null,
      expectedStatus: 200,
      responseSchema: 'AuditUrl',
      expectedFields: {
        url,
        byCustomer,
        audits,
      },
    },
    update: {
      operationId: 'update-url-store',
      method: 'PATCH',
      path: () => '',
      // path: (entity) => `/${Buffer.from(entity.url).toString('base64url')}`,
      // PATCH endpoint expects an array of AuditUrlUpdate
      requestPayload: (parentIds, entity) => [{ url: entity.url, audits: updatedAudits }],
      expectedStatus: 200,
      responseSchema: 'AuditUrlBulkResponse',
      expectedFields: {
        metadata: {
          total: 1,
          success: 1,
          failure: 0,
        },
      },
    },
    delete: {
      operationId: 'delete-url-store',
      method: 'DELETE',
      path: () => '',
      // path: (entity) => `/${Buffer.from(entity.url).toString('base64url')}`,
      // DELETE endpoint expects { urls: [...] } in body
      requestPayload: (parentIds, entity) => ({ urls: [entity.url] }),
      expectedStatus: 200,
      responseSchema: 'AuditUrlDeleteResponse',
      expectedFields: {
        metadata: {
          total: 1,
          success: 1,
          failure: 0,
        },
      },
      releaseEntity: true,
    },
  },
};
