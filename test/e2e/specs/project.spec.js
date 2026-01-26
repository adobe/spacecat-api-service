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

import { organizationSpec } from './organization.spec.js';

/**
 * Project Entity Spec
 *
 * This spec demonstrates the pattern for testing dynamic entities that are
 * created and deleted by the tests. Projects belong to organizations, so
 * the organization is referenced in setupChain.
 *
 * The test runner will:
 * 1. Setup: Use the organization from setupChain (static fixture, no create)
 * 2. Run tests: Create project, then delete project
 * 3. Cleanup: Delete the project if tests fail mid-way, then handle parents
 */

// Initial data for dynamic entity creation
// Unlike staticFixture, this does not have an `id` - it will be created by the API
// Note: The database schema uses `projectName`, not `name` (despite OpenAPI docs)
const initialData = {
  projectName: 'e2e-test-project',
};

const { projectName } = initialData;

const updatedProjectName = 'e2e-updated-test-project';

export const projectSpec = {
  entityName: 'Project',
  basePath: '/projects',
  initialData,

  // Parent specs in dependency order
  // Organization is a static fixture - runner will use its staticFixture.id
  setupChain: [organizationSpec],

  operations: {
    create: {
      operationId: 'create-project',
      method: 'POST',
      path: () => '',
      // organizationId is injected from parentIds at runtime
      requestPayload: (parentIds) => ({
        projectName,
        organizationId: parentIds.Organization,
      }),
      expectedStatus: 201,
      responseSchema: 'Project',
      expectedFields: (parentIds) => ({
        projectName,
        organizationId: parentIds.Organization,
      }),
      captureEntity: true, // Store created entity for subsequent operations
    },
    get: {
      operationId: 'get-project',
      method: 'GET',
      path: (entity) => `/${entity.id}`,
      requestPayload: null,
      expectedStatus: 200,
      responseSchema: 'Project',
      expectedFields: (parentIds, entity) => ({
        id: entity.id,
        projectName,
        organizationId: parentIds.Organization,
      }),
    },
    update: {
      operationId: 'update-project',
      method: 'PATCH',
      path: (entity) => `/${entity.id}`,
      requestPayload: {
        projectName: updatedProjectName,
      },
      expectedStatus: 200,
      responseSchema: 'Project',
      expectedFields: (parentIds, entity) => ({
        id: entity.id,
        projectName: updatedProjectName,
        organizationId: parentIds.Organization,
      }),
    },
    delete: {
      operationId: 'delete-project',
      method: 'DELETE',
      path: (entity) => `/${entity.id}`,
      requestPayload: null,
      expectedStatus: 204,
      releaseEntity: true, // Clear capturedEntity after successful delete - cleanup will skip
    },
  },
};
