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
 * Opportunity Entity Spec
 *
 * This spec demonstrates the dynamic entity pattern for Opportunity entities.
 * Opportunities can be created and deleted via the API, so tests follow
 * the full CRUD lifecycle (without list to avoid touching non-test data).
 *
 * Pattern: Dynamic Entity (Pattern B)
 * - Entity is created by the test
 * - Entity is deleted by the test (cleanup)
 * - Uses setupChain to access parent Site (static fixture)
 */

// Initial data for creating a new opportunity
// Note: auditId uses a placeholder UUID - the API may accept this even if
// the audit doesn't exist (validation depends on backend implementation)
const initialData = {
  auditId: '00000000-0000-0000-0000-000000000000',
  runbook: 'https://example.com/runbook/e2e-test-opportunity',
  type: 'broken-backlinks',
  origin: 'ESS_OPS',
  title: 'E2E Test Opportunity - Broken Backlinks',
  description: 'This opportunity was created by E2E tests and should be deleted after the test run.',
  tags: ['e2e-test'],
};

// Destructure for use in operations
const {
  auditId, runbook, type, origin, title, description, tags,
} = initialData;

// Updated values for mutation testing
const updatedTitle = 'E2E Test Opportunity - Updated Title';
const updatedStatus = 'IN_PROGRESS';

export const opportunitySpec = {
  entityName: 'Opportunity',
  // basePath uses parentIds to get the siteId from the static fixture
  basePath: (parentIds) => `/sites/${parentIds.Site}/opportunities`,
  initialData,

  // Opportunity belongs to Site (static fixture)
  setupChain: [siteSpec],

  operations: {
    create: {
      operationId: 'create-opportunity',
      method: 'POST',
      path: () => '',
      requestPayload: {
        auditId,
        runbook,
        type,
        origin,
        title,
        description,
        tags,
      },
      expectedStatus: 201,
      responseSchema: 'Opportunity',
      expectedFields: {
        runbook,
        type,
        origin,
        title,
        description,
        tags,
        status: 'NEW', // Default status for new opportunities
      },
      captureEntity: true,
    },
    get: {
      operationId: 'get-opportunity',
      method: 'GET',
      path: (entity) => `/${entity.id}`,
      requestPayload: null,
      expectedStatus: 200,
      responseSchema: 'Opportunity',
      expectedFields: {
        runbook,
        type,
        origin,
        title,
        description,
        tags,
      },
    },
    update: {
      operationId: 'update-opportunity',
      method: 'PATCH',
      path: (entity) => `/${entity.id}`,
      requestPayload: {
        title: updatedTitle,
        status: updatedStatus,
      },
      expectedStatus: 200,
      responseSchema: 'Opportunity',
      expectedFields: {
        runbook,
        type,
        origin,
        title: updatedTitle,
        status: updatedStatus,
        description,
        tags,
      },
    },
    delete: {
      operationId: 'delete-opportunity',
      method: 'DELETE',
      path: (entity) => `/${entity.id}`,
      requestPayload: null,
      expectedStatus: 204,
      releaseEntity: true,
    },
  },
};
