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
 * Suggestion Entity Spec
 *
 * This spec demonstrates the dynamic entity pattern for Suggestion entities
 * with a non-standard create endpoint (207 Multi-Status batch response).
 *
 * Pattern: Dynamic Entity (Pattern B)
 * - Entity is created by the test
 * - Entity is deleted by the test (cleanup)
 * - Uses setupChain to access parent Site (static) and Opportunity (dynamic)
 *
 * Special handling:
 * - POST creates multiple suggestions, returns 207 Multi-Status
 * - captureEntity uses a function to extract entity from batch response
 */

// Initial data for creating a new suggestion
// The POST endpoint expects an array of suggestions
// Data conforms to BrokenBacklinksRedirectData schema
const initialData = {
  type: 'REDIRECT_UPDATE',
  rank: 1000,
  data: {
    title: 'E2E Test Suggestion',
    url_from: 'https://example.com/referring-page',
    url_to: 'https://example.com/broken-target',
    urls_suggested: ['https://example.com/new-target'],
    traffic_domain: 500,
  },
};

// Destructure for use in operations
const { type, rank, data } = initialData;

// Updated values for mutation testing
const updatedRank = 2000;

export const suggestionSpec = {
  entityName: 'Suggestion',
  // basePath uses parentIds to get both siteId and opportunityId
  basePath: (parentIds) => `/sites/${parentIds.Site}/opportunities/${parentIds.Opportunity}/suggestions`,
  initialData,

  // Suggestion belongs to Opportunity, which belongs to Site
  // Site is static fixture, Opportunity is dynamic
  setupChain: [siteSpec, opportunitySpec],

  operations: {
    create: {
      operationId: 'create-suggestion',
      method: 'POST',
      path: () => '',
      // POST endpoint expects an array of suggestions
      requestPayload: [{ type, rank, data }],
      expectedStatus: 207,
      // 207 Multi-Status returns: { suggestions: [{ statusCode, suggestion }], metadata }
      // Use function to extract entity from first successful item
      captureEntity: (body) => body.suggestions?.[0]?.suggestion,
    },
    get: {
      operationId: 'get-suggestion',
      method: 'GET',
      path: (entity) => `/${entity.id}`,
      requestPayload: null,
      expectedStatus: 200,
      responseSchema: 'Suggestion',
      expectedFields: {
        type,
        rank,
        status: 'NEW', // Default status for new suggestions
      },
    },
    update: {
      operationId: 'update-suggestion',
      method: 'PATCH',
      path: (entity) => `/${entity.id}`,
      requestPayload: {
        rank: updatedRank,
      },
      expectedStatus: 200,
      responseSchema: 'Suggestion',
      expectedFields: {
        type,
        rank: updatedRank,
      },
    },
    delete: {
      operationId: 'delete-suggestion',
      method: 'DELETE',
      path: (entity) => `/${entity.id}`,
      requestPayload: null,
      expectedStatus: 204,
      releaseEntity: true,
    },
  },
};
