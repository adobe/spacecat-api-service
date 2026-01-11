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

import { BRAND_PRESENCE_CORS_HEADERS } from './cors.js';

/**
 * Handles OPTIONS preflight requests for brand presence endpoints
 * Returns 200 OK with CORS headers
 * @param {object} context - The request context
 * @returns {Promise<Response>} The response with CORS headers
 */
export async function handleBrandPresenceOptions() {
  return new Response('', {
    status: 200,
    headers: BRAND_PRESENCE_CORS_HEADERS,
  });
}
