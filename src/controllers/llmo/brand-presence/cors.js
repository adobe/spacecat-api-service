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

/**
 * CORS headers for brand presence endpoints
 * These should be included in all responses (success and error) to prevent CORS issues
 */
export const BRAND_PRESENCE_CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'x-api-key, authorization, content-type, x-edge-authorization, x-product',
};

/**
 * Adds CORS headers to a response object
 * @param {object} responseHeaders - The existing headers to merge with CORS headers
 * @returns {object} - The merged headers
 */
export function withCorsHeaders(responseHeaders = {}) {
  return {
    ...BRAND_PRESENCE_CORS_HEADERS,
    ...responseHeaders,
  };
}
