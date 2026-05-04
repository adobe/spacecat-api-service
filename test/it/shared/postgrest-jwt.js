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
 * PostgREST JWT utilities for IT tests.
 *
 * Creates minimal HS256 JWTs for PostgREST authentication.
 * Mirrors the _make_jwt() function from mysticat-data-service/tests/conftest.py
 *
 * After PR #92 (postgrest_writer role), DELETE and UPDATE operations require
 * JWT authentication. The dev server uses POSTGREST_API_KEY to authenticate
 * to PostgREST via @adobe/spacecat-shared-data-access.
 */

import crypto from 'crypto';

// Must match PGRST_JWT_SECRET in docker-compose.yml
export const POSTGREST_JWT_SECRET = 'local-dev-jwt-secret-for-postgrest-only';

/**
 * Base64url encode (RFC 4648 §5).
 * @param {string|Buffer} data - Data to encode
 * @returns {string} Base64url-encoded string
 */
function base64url(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Creates a minimal HS256 JWT for PostgREST authentication.
 *
 * @param {string} secret - JWT secret (must match PGRST_JWT_SECRET)
 * @param {string} role - PostgreSQL role to assume (e.g., 'postgrest_writer')
 * @returns {string} Signed JWT token
 */
export function makePostgrestJwt(secret, role) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ role }));
  const signature = base64url(
    crypto.createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest(),
  );
  return `${header}.${payload}.${signature}`;
}

/**
 * Pre-generated JWT for postgrest_writer role.
 * Used by the dev server to authenticate DELETE/UPDATE operations to PostgREST.
 */
export const POSTGREST_WRITER_JWT = makePostgrestJwt(
  POSTGREST_JWT_SECRET,
  'postgrest_writer',
);
