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

import { apiBaseUrl } from './spacecat-utils.js';

// x-api-key is deprecated starting August 2026. New suites authenticate via
// POST /auth/login (IMS user access token -> service-signed session token),
// then send it as `Authorization: Bearer <sessionToken>`.
// https://opensource.adobe.com/spacecat-api-service/#tag/auth/operation/login
let cachedSessionTokenPromise;

async function login() {
  const accessToken = process.env.IMS_ACCESS_TOKEN;
  if (!accessToken) {
    return null;
  }
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }),
  });
  if (!response.ok) {
    throw new Error(`POST /auth/login failed with status ${response.status}`);
  }
  const { sessionToken } = await response.json();
  return sessionToken;
}

/**
 * Resolves to the cached session token, logging in once per test run.
 * Resolves to null (not a throw) when IMS_ACCESS_TOKEN is unset, so callers
 * can skip gracefully instead of failing when no credential was provided.
 * @returns {Promise<string|null>}
 */
export function getSessionToken() {
  if (!cachedSessionTokenPromise) {
    // Clear the cache on rejection (e.g. a transient network error) so the
    // next call retries login instead of replaying the same failure forever.
    cachedSessionTokenPromise = login().catch((err) => {
      cachedSessionTokenPromise = null;
      throw err;
    });
  }
  return cachedSessionTokenPromise;
}
