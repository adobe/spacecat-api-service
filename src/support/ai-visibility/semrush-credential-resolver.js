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

/**
 * Auth seam for the Spacecat -> Semrush AI Visibility gRPC backend (LLMO-6836, PR-3a).
 *
 * This module is the provider-agnostic *skeleton* for resolving the Semrush
 * credential per brand so an unattended server-side run can be authorized. It is
 * inert by default: no provider is configured, so {@link resolveSemrushCredential}
 * returns `null` and callers fall back to the existing shared client_credentials
 * path in `grpc-transport.js`.
 *
 * A future PR (3b) installs a real provider via {@link setSemrushCredentialProvider}.
 * The provider may mint a per-org OAuth2 client_credentials token OR a future IMS
 * technical-account token -- this module does not care which. It only understands a
 * credential *descriptor*:
 *
 *   { key: string, getAuthToken: (env) => Promise<string> }
 *
 * where `key` is a stable cache key for the credential scope (e.g. the brand/org id)
 * and `getAuthToken` yields the raw token string (NO "Bearer " prefix).
 */

/**
 * @typedef {object} SemrushCredential
 * @property {string} key - stable cache key for the credential scope (brand/org id).
 * @property {(env: object) => Promise<string>} getAuthToken - yields the raw token.
 */

/**
 * @typedef {(brand: unknown, env: object) => (SemrushCredential | null)} SemrushCredentialProvider
 */

/**
 * @typedef {string | { token: string, expiresInMs?: number, expiresAtMs?: number }} MintResult
 */

/** Conservative fallback token lifetime when the mint result carries no expiry. */
const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Default upper bound on distinct credential scopes cached at once. */
const DEFAULT_MAX_TOKEN_CACHE_SIZE = 1000;

/**
 * Pluggable credential provider. `null` = no provider configured (default),
 * which makes {@link resolveSemrushCredential} return `null`.
 * @type {SemrushCredentialProvider | null}
 */
let credentialProvider = null;

/** Per-credential token cache: key -> { token, expiresAtMs }. */
const tokenCache = new Map();

/** Mutable so tests can exercise eviction without minting thousands of tokens. */
let maxTokenCacheSize = DEFAULT_MAX_TOKEN_CACHE_SIZE;

/**
 * Install (or clear) the credential provider. Passing a non-function (e.g. `null`)
 * disables per-brand resolution and restores the default fall-back behavior.
 * @param {SemrushCredentialProvider | null} fn
 */
export function setSemrushCredentialProvider(fn) {
  credentialProvider = typeof fn === 'function' ? fn : null;
}

/**
 * Resolve the Semrush credential descriptor for a brand.
 *
 * @param {unknown} brand - brand/org scope the caller wants a credential for.
 * @param {object} env - request environment (secrets, config).
 * @returns {SemrushCredential | null} `null` when no provider is configured (caller
 *   falls back to the shared client_credentials path), otherwise the descriptor.
 */
export function resolveSemrushCredential(brand, env) {
  if (!credentialProvider) {
    return null;
  }
  return credentialProvider(brand, env) || null;
}

/**
 * TTL token cache generalizing today's mint-every-request behavior. Reuses a cached
 * token for `key` until it expires, then re-mints via `mintFn`. `now` is injected so
 * tests can drive expiry deterministically.
 *
 * `mintFn` may resolve to either the raw token string, or an object
 * `{ token, expiresInMs }` / `{ token, expiresAtMs }` so a provider can pass through
 * the credential's real lifetime. When no expiry is supplied a conservative default
 * TTL is used.
 *
 * @param {string} key - stable cache key for the credential scope.
 * @param {() => Promise<MintResult>} mintFn - MUST resolve a non-empty token string
 *   or an object with a string `token`; anything else throws and caches nothing.
 * @param {number} [nowMs=Date.now()] - current time in ms (injectable for tests).
 * @returns {Promise<string>} the raw token string.
 * @throws {Error} when `mintFn` violates the contract above.
 */
export async function getCachedToken(key, mintFn, nowMs = Date.now()) {
  const existing = tokenCache.get(key);
  if (existing && nowMs < existing.expiresAtMs) {
    return existing.token;
  }

  const minted = await mintFn();

  let token;
  let expiresAtMs;
  if (typeof minted === 'string') {
    token = minted;
    expiresAtMs = nowMs + DEFAULT_TOKEN_TTL_MS;
  } else if (minted && typeof minted.token === 'string') {
    token = minted.token;
    if (typeof minted.expiresAtMs === 'number') {
      expiresAtMs = minted.expiresAtMs;
    } else if (typeof minted.expiresInMs === 'number') {
      expiresAtMs = nowMs + minted.expiresInMs;
    } else {
      expiresAtMs = nowMs + DEFAULT_TOKEN_TTL_MS;
    }
  } else {
    // Enforce the mint contract: nothing is cached when it is violated, so the
    // caller sees a clear error instead of a `Bearer undefined` header downstream.
    throw new Error(
      'getCachedToken: mintFn must resolve a token string or { token: string, ... }',
    );
  }

  // FIFO by mint time: a re-mint deletes then re-inserts the key so it sorts last,
  // but a cache HIT (returned above) does NOT refresh recency -- this is not LRU.
  tokenCache.delete(key);
  // Bound the cache: evict oldest entries when at capacity. Brand count can grow.
  while (tokenCache.size >= maxTokenCacheSize) {
    const oldestKey = tokenCache.keys().next().value;
    tokenCache.delete(oldestKey);
  }
  tokenCache.set(key, { token, expiresAtMs });
  return token;
}

/** @visibleForTesting */
export function resetSemrushCredentialCache() {
  tokenCache.clear();
  maxTokenCacheSize = DEFAULT_MAX_TOKEN_CACHE_SIZE;
}

/** @visibleForTesting */
export function setTokenCacheMaxSize(n) {
  maxTokenCacheSize = n;
}

/** @visibleForTesting */
export function getTokenCacheSize() {
  return tokenCache.size;
}
