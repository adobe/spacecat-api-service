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

import { expect } from 'chai';

// Environment configuration - follows existing pattern from config/config.js
function isTestingProd() {
  return process.env.ENVIRONMENT === 'prod';
}

const BASE_URL = 'https://spacecat.experiencecloud.live/api';
const CI_API_BASE = `${BASE_URL}/ci`;
const PROD_API_BASE = `${BASE_URL}/v1`;

export const apiBaseUrl = isTestingProd() ? PROD_API_BASE : CI_API_BASE;

// Hardcoded test site ID - no env variable needed
// This site has opportunities and suggestions for testing
export const TEST_SITE_ID = '3e9c2eab-b7ae-4366-aab7-00b37e722f94';

// Use USER_API_KEY for authentication (same as existing e2e tests)
export const apiKey = process.env.USER_API_KEY;

/**
 * Make a request to the SpaceCat API
 * @param {Object} options - Request options
 * @param {string} options.path - API path (e.g., '/sites/123/opportunities/456/suggestions')
 * @param {string} [options.method='GET'] - HTTP method
 * @param {Object} [options.body] - Request body (will be JSON stringified)
 * @param {Object} [options.headers={}] - Additional headers
 * @param {string} [options.key] - Override default API key
 * @param {boolean} [options.skipAuth=false] - Skip authentication (for testing 401)
 * @returns {Promise<Response>} Fetch response
 */
export async function makeSpacecatRequest({
  path,
  method = 'GET',
  body = null,
  headers = {},
  key = apiKey,
  skipAuth = false,
}) {
  const url = `${apiBaseUrl}${path}`;
  const requestHeaders = new Headers({
    'Content-Type': 'application/json',
    ...headers,
  });

  // Add authentication unless explicitly skipped
  if (!skipAuth && key) {
    requestHeaders.set('x-api-key', key);
  }

  const requestOptions = {
    method,
    headers: requestHeaders,
  };

  if (body) {
    requestOptions.body = JSON.stringify(body);
  }

  return fetch(url, requestOptions);
}

/**
 * Validate that a string is a valid UUID v4
 * @param {string} uuid - String to validate
 */
export function expectValidUUID(uuid) {
  expect(uuid).to.be.a('string');
  expect(uuid).to.match(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    `Expected valid UUID v4, got: ${uuid}`,
  );
}

/**
 * Validate that a string is a valid ISO 8601 date
 * @param {string} dateString - String to validate
 */
export function expectValidISODate(dateString) {
  expect(dateString).to.be.a('string');
  const date = new Date(dateString);
  expect(date.toString()).to.not.equal('Invalid Date', `Expected valid ISO date, got: ${dateString}`);
  expect(dateString).to.match(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/,
    `Expected ISO 8601 format, got: ${dateString}`,
  );
}
