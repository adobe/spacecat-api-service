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

// x-api-key is deprecated starting August 2026. Suites now authenticate as a
// registered S2S consumer (SITES-48671): IMS client-credentials grant -> IMS
// access token -> POST /auth/s2s/login -> service-signed session token, sent
// as `Authorization: Bearer <sessionToken>`.
// See docs/s2s/CONSUMER_INTEGRATION_GUIDE.md for the full flow and this
// consumer's registered scope/org.
const IMS_TOKEN_ENDPOINT = 'https://ims-na1-stg1.adobelogin.com/ims/token/v3';
const IMS_SCOPE = 'openid,AdobeID,user_management_sdk';
const IMS_ORG_ID = '8C6043F15F43B6390A49401A@AdobeOrg'; // AEM Sites Engineering

let cachedSessionTokenPromise;

async function getImsAccessToken(clientId, clientSecret) {
  const response = await fetch(IMS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: IMS_SCOPE,
    }),
  });
  if (!response.ok) {
    throw new Error(`IMS client-credentials token request failed with status ${response.status}`);
  }
  const { access_token: accessToken } = await response.json();
  return accessToken;
}

async function login() {
  const clientId = process.env.API_E2E_TESTS_CLIENT_ID_DEV;
  const clientSecret = process.env.API_E2E_TESTS_CLIENT_SECRET_DEV;
  if (!clientId || !clientSecret) {
    return null;
  }
  const imsAccessToken = await getImsAccessToken(clientId, clientSecret);
  const response = await fetch(`${apiBaseUrl}/auth/s2s/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${imsAccessToken}`,
    },
    body: JSON.stringify({ imsOrgId: IMS_ORG_ID }),
  });
  if (!response.ok) {
    throw new Error(`POST /auth/s2s/login failed with status ${response.status}`);
  }
  const { sessionToken } = await response.json();
  return sessionToken;
}

/**
 * Resolves to the cached session token, logging in once per test run.
 * Resolves to null (not a throw) when the S2S client credentials are unset,
 * so callers can skip gracefully instead of failing when none were provided.
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
