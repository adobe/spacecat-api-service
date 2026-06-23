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

import createClient from 'openapi-fetch';
import { createRetryingFetch, toTokenGetter } from './internal.js';

/**
 * @typedef {import('./internal.js').AuthTokenSource} AuthTokenSource
 */

/**
 * A fully-typed User Manager client (all operations from the generated `paths`).
 * @typedef {import('openapi-fetch').Client<import('./generated/types.js').paths>}
 *   SerenityUserManagerApiClient
 */

/**
 * @typedef {object} SerenityUserManagerApiClientOptions
 * @property {string} baseUrl Base URL of the User Manager API — the origin of
 *   `SEMRUSH_PROJECTS_BASE_URL` (the host is shared with Project Engine, e.g.
 *   `https://adobe-hackathon.semrush.com`), or the Counterfact mock's origin for E2E / local dev.
 *   Only `protocol//host` is used; any path is dropped and the client appends the fixed
 *   `/enterprise/users/api` prefix itself, matching the deployed api-service transport
 *   (`rest-transport.js`).
 * @property {AuthTokenSource} authToken The caller's IMS JWT, or a (sync/async) getter resolved
 *   per request. Sent as the `Authorization: Bearer <token>` header. The client performs NO token
 *   exchange or minting — Semrush accepts the IMS bearer token directly, so the caller's token is
 *   forwarded as-is.
 * @property {number} [maxRetries=2] Retry attempts on 429 / retryable 5xx / network error.
 *   Default 2 (3 tries total).
 * @property {number} [retryBaseDelayMs=200] Base backoff in ms; grows exponentially per
 *   attempt. Default 200.
 * @property {import('./internal.js').OnRetry} [onRetry] Best-effort hook invoked before each
 *   retry sleep (`{ attempt, delayMs, method, status?, error? }`), for logging/metrics. A retry
 *   loop is otherwise silent — an operator can't tell "slow upstream" from "stuck in backoff". A
 *   throwing or rejecting hook is swallowed and never affects the request.
 * @property {typeof globalThis.fetch} [fetch] Injectable fetch (tests, custom agents).
 *   Defaults to the global fetch.
 */

/**
 * The User Manager API path prefix — the vendored spec's `basePath`. The generated `paths`
 * keys are relative to it, so the client owns it here, mirroring the deployed api-service
 * transport (`rest-transport.js`), which appends this same constant to the env-configured origin.
 */
const API_PREFIX = '/enterprise/users/api';

/**
 * Normalises the caller's base URL to `<origin>/enterprise/users/api`, mirroring
 * `rest-transport.js`: parse, keep only `protocol//host` — dropping any path or credentials so a
 * misconfigured value can't bleed into every request — then append the fixed prefix. Unlike the
 * prod-only transport it does NOT force https, since the client also targets the local Counterfact
 * mock over http.
 * @param {string} baseUrl
 * @returns {string}
 */
function resolveBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`User Manager client: invalid baseUrl ${JSON.stringify(baseUrl)}`);
  }
  // Restrict to http(s) so a `file:`/`ftp:`/etc. URL fails fast here with an actionable message
  // rather than deep inside fetch(). Both schemes are allowed — https for prod, http for the
  // local Counterfact mock.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `User Manager client: baseUrl must be http(s), got ${parsed.protocol} in ${JSON.stringify(baseUrl)}`,
    );
  }
  return `${parsed.protocol}//${parsed.host}${API_PREFIX}`;
}

/**
 * Builds the openapi-fetch middleware that authenticates each request with the caller's IMS token
 * as `Authorization: Bearer <token>` — the auth model proven by the deployed api-service transport
 * (`rest-transport.js`). Semrush accepts the IMS bearer directly; the client mints/exchanges
 * nothing.
 * @param {() => string | Promise<string>} getToken
 * @returns {import('openapi-fetch').Middleware}
 */
function authMiddleware(getToken) {
  return {
    async onRequest({ request }) {
      const token = await getToken();
      // Fail fast on a missing token rather than sending `Bearer undefined` (or an empty header),
      // which Semrush would reject with an opaque 401.
      if (!token) {
        throw new Error('User Manager client: authToken resolved to an empty value');
      }
      request.headers.set('Authorization', `Bearer ${token}`);
      return request;
    },
  };
}

/**
 * Creates a thin, typed client over the generated User Manager `paths`. It owns the base
 * URL (origin + `/enterprise/users/api`), retries, and authenticating each request with the
 * caller's IMS JWT as `Authorization: Bearer` — and nothing else; request/response shapes come
 * straight from the generated types.
 * @param {SerenityUserManagerApiClientOptions} options
 * @returns {SerenityUserManagerApiClient}
 */
export function createSerenityUserManagerApiClient(options) {
  const {
    baseUrl,
    authToken,
    maxRetries = 2,
    retryBaseDelayMs = 200,
    onRetry,
    fetch: injectedFetch = globalThis.fetch,
  } = options;

  const client = createClient({
    baseUrl: resolveBaseUrl(baseUrl),
    fetch: createRetryingFetch(injectedFetch, maxRetries, retryBaseDelayMs, onRetry),
  });
  // Auth runs as openapi-fetch middleware, so the token getter resolves once per logical request
  // and that token is reused across the request's retries (the retry layer clones the same Request
  // — see createRetryingFetch). toTokenGetter() rejects a non-string/function authToken up front.
  client.use(authMiddleware(toTokenGetter(authToken)));
  return client;
}
