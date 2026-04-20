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
 * Creates a mock SEO client with configurable responses
 * @param {Object} responses - Map of URL to response data (array of pages)
 * @returns {Object} Mock SEO client
 */
export const createMockSeoClient = (responses = {}) => {
  const mockClient = {
    getTopPages: sinon.stub(),
  };

  Object.entries(responses).forEach(([url, pages]) => {
    mockClient.getTopPages
      .withArgs(url, { limit: 1 })
      .resolves({ result: { pages } });
  });

  return mockClient;
};

/**
 * Sets up a test for determineOverrideBaseURL with mocked SEO client
 * @param {Object} mockSeoClient - Mock SEO client
 * @returns {Promise<Object>} Mocked module
 */
export const setupDetermineOverrideBaseURLTest = async (mockSeoClient) => esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
  '@adobe/mysticat-shared-seo-client': {
    default: {
      createFrom: sinon.stub().returns(mockSeoClient),
    },
  },
});

/**
 * Helper function to test determineOverrideBaseURL with given URL and responses
 * @param {string} baseURL - The base URL to test
 * @param {Object} responses - Map of URL to response data (array of pages)
 * @param {Object} context - Test context with log and env
 * @returns {Promise<Object>} Object containing result and mockSeoClient
 */
export const testDetermineOverrideBaseURL = async (baseURL, responses, context) => {
  const mockSeoClient = createMockSeoClient(responses);
  const { determineOverrideBaseURL } = await setupDetermineOverrideBaseURLTest(mockSeoClient);
  const result = await determineOverrideBaseURL(baseURL, context);

  return { result, mockSeoClient };
};
