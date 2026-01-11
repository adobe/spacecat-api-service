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

import dataAccessLib from '@adobe/spacecat-shared-data-access';

/**
 * Creates a mock data access object with minimal entity collections.
 * This prevents errors when code tries to access dataAccess properties.
 *
 * @returns {object} Mock data access object
 */
function createMockDataAccess() {
  const mockEntity = {
    findById: async () => null,
    findByOrganizationId: async () => null,
    findByHashedApiKey: async () => null, // For API key auth
    create: async () => {
      throw new Error('DynamoDB is disabled in dev mode. Enable it by setting DEV_SKIP_DYNAMODB=false or implement controller-specific mocking.');
    },
    all: async () => [],
    allByImsOrgId: async () => [],
    allBySiteId: async () => [],
  };

  // Return an object with all the entity types that controllers might expect
  return {
    Site: mockEntity,
    Organization: mockEntity,
    Audit: mockEntity,
    Configuration: mockEntity,
    Entitlement: mockEntity,
    Experiment: mockEntity,
    ExperimentVariant: mockEntity,
    FixEntity: mockEntity,
    ImportJob: mockEntity,
    Opportunity: mockEntity,
    OrganizationIdentityProvider: mockEntity,
    PreflightConfiguration: mockEntity,
    Report: mockEntity,
    Suggestion: mockEntity,
    SiteEnrollment: mockEntity,
    SiteCandidate: mockEntity,
    TrialUser: mockEntity,
    UserActivity: mockEntity,
    // Auth-related entities (required by authentication handlers)
    ApiKey: mockEntity,
    ScopedApiKey: mockEntity,
  };
}

/**
 * Conditional Data Access Wrapper
 *
 * This wrapper conditionally initializes the data access layer based on environment variables.
 * If DEV_SKIP_DYNAMODB=true in dev environment, it skips DynamoDB initialization and provides
 * mock entities instead, avoiding AWS credential issues in local development.
 *
 * @param {function} fn - The function to wrap
 * @returns {function} - The wrapped function
 */
export default function conditionalDataAccessWrapper(fn) {
  return async (request, context) => {
    const { env, log } = context;

    // Check if we should skip DynamoDB initialization
    if (env.ENV === 'dev' && env.DEV_SKIP_DYNAMODB === 'true') {
      log.info('DEV_SKIP_DYNAMODB=true: Skipping DynamoDB initialization, using mock data access');

      // Create mock data access object with empty entity collections
      // Controllers that support dev mode will handle their own mocking
      context.dataAccess = createMockDataAccess();

      return fn(request, context);
    }

    // Otherwise, use the standard data access wrapper
    return dataAccessLib(fn)(request, context);
  };
}
