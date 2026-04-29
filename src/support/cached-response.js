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

import { ok } from '@adobe/spacecat-shared-http-utils';

/**
 * Drop-in replacement for `ok(body, headers)` that opts the response into the
 * browser's private HTTP cache. Use on read-only GET endpoints whose payload
 * can safely be served from disk for ~2 hours.
 *
 * Defaults:
 *  - `Cache-Control: private, max-age=7200` — only the user's own browser
 *    caches; shared caches (Fastly/Varnish, corporate proxies) bypass.
 *
 * No `Vary: Authorization`: the SpaceCat session JWT is regenerated on every
 * page reload (different signature even for the same user), so adding it to
 * Vary changes the cache key on every reload and defeats caching entirely.
 * The browser's private HTTP cache is per-profile, and `Cache-Control: private`
 * keeps shared caches out, so cross-user contamination on a single profile
 * remains unlikely.
 *
 * Caller-supplied headers in the second argument override the defaults
 * (e.g. `cachedOk(data, { 'Cache-Control': 'private, max-age=60' })`).
 *
 * The defaults are a fresh object per call because the upstream
 * `createResponse()` mutates the headers it receives (sets Content-Type).
 * A shared/frozen constant would either throw or leak state across requests.
 *
 * Never use on mutation responses (POST/PATCH/PUT/DELETE) — call `ok()`
 * directly instead.
 */
export function cachedOk(body = '', additionalHeaders = {}) {
  return ok(body, {
    'Cache-Control': 'private, max-age=7200',
    ...additionalHeaders,
  });
}
