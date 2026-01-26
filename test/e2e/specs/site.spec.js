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
 * Site Entity Spec
 *
 * This spec demonstrates the static fixture pattern for Site entities.
 * Sites cannot be deleted via API (returns 403 Forbidden), so tests use
 * a pre-provisioned site and restore it to original state after mutations.
 *
 * Pattern: Static Fixture (Pattern A)
 * - Entity exists in test environment
 * - Tests do NOT create or delete it
 * - Cleanup restores original state after update tests
 */

// Static fixture - pre-provisioned test site
// All fields here represent the original/baseline state.
// The test runner uses these values to restore the entity after mutations.
const staticFixture = {
  id: 'b16b5a48-3f97-4841-ae9a-99b2488f0a53',
  baseURL: 'https://www.e2e-testing-spacecat-api-service.com',
  organizationId: '4eed02e2-a47d-48ba-8fef-0bdf2e4d0f28',
  deliveryType: 'aem_edge',
  isLive: false,
  name: 'e2e-api-testing',
  config: {
    slack: {},
    handlers: {},
  },
};

// Destructure for use in operations
const {
  id, baseURL, organizationId, deliveryType, isLive, name, config,
} = staticFixture;

// Updated value for mutation testing
const updatedName = 'e2e-updated-site-name';

// Base64 encode the URL for path parameter
const encodedBaseURL = Buffer.from(baseURL).toString('base64');

export const siteSpec = {
  entityName: 'Site',
  basePath: '/sites',
  staticFixture,

  // Site belongs to Organization
  setupChain: [organizationSpec],

  operations: {
    get: {
      operationId: 'get-site',
      method: 'GET',
      path: () => `/${id}`,
      requestPayload: null,
      expectedStatus: 200,
      responseSchema: 'Site',
      expectedFields: {
        id, baseURL, organizationId, deliveryType, isLive, name, config,
      },
    },
    getByBaseUrl: {
      operationId: 'get-site-by-base-url',
      method: 'GET',
      path: () => `/by-base-url/${encodedBaseURL}`,
      expectedStatus: 200,
      responseSchema: 'Site',
      expectedFields: {
        id, baseURL, organizationId, deliveryType, isLive, name, config,
      },
    },
    update: {
      operationId: 'update-site',
      method: 'PATCH',
      path: () => `/${id}`,
      requestPayload: {
        name: updatedName,
      },
      expectedStatus: 200,
      responseSchema: 'Site',
      expectedFields: {
        id, baseURL, organizationId, deliveryType, isLive, name: updatedName, config,
      },
    },
  },
};
