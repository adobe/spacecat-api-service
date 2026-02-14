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

import esmock from 'esmock';
import sinon from 'sinon';

/**
 * Creates a mock canonical resolver with configurable responses.
 * @param {Object} responses - Map of URL to canonical URL (string), null, or Error.
 * @returns {sinon.SinonStub} Mock canonical resolver.
 */
export const createMockCanonicalResolver = (responses = {}) => {
  const resolver = sinon.stub().resolves(null);

  Object.entries(responses).forEach(([url, response]) => {
    if (response instanceof Error) {
      resolver.withArgs(url).rejects(response);
    } else {
      resolver.withArgs(url).resolves(response);
    }
  });

  return resolver;
};

/**
 * Sets up a test for determineOverrideBaseURL with mocked canonical resolver.
 * @param {sinon.SinonStub} mockCanonicalResolver - Mock canonical resolver.
 * @returns {Promise<Object>} Mocked module.
 */
export const setupDetermineOverrideBaseURLTest = async (mockCanonicalResolver) => esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
  '@adobe/spacecat-shared-utils': {
    composeBaseURL: (domain) => `https://${domain}`,
    tracingFetch: sinon.stub(),
    resolveCanonicalUrl: mockCanonicalResolver,
  },
});

/**
 * Helper function to test determineOverrideBaseURL with given URL and responses.
 * @param {string} baseURL - The base URL to test
 * @param {Object} responses - Map of URL to canonical URL (string), null, or Error
 * @param {Object} context - Test context with log and env
 * @returns {Promise<Object>} Object containing result and mockCanonicalResolver
 */
export const testDetermineOverrideBaseURL = async (baseURL, responses, context) => {
  const mockCanonicalResolver = createMockCanonicalResolver(responses);
  const { determineOverrideBaseURL } = await setupDetermineOverrideBaseURLTest(
    mockCanonicalResolver,
  );
  const result = await determineOverrideBaseURL(baseURL, context);

  return { result, mockCanonicalResolver };
};
