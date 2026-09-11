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
 * LLMO-7369 Path A — interactive IMS OAuth (authorization_code + PKCE) helpers for one-stop
 * Slack onboarding: capture the operator's own real IMS user token via a browser sign-in, then
 * provision Semrush as them. No credential is ever placed in the Slack webhook, and the token is
 * used transiently and never stored.
 *
 * FLAG-GATED: the whole flow is inert unless an interactive IMS OAuth client is configured
 * (IMS_OAUTH_CLIENT_ID / IMS_OAUTH_CLIENT_SECRET / IMS_OAUTH_STATE_SECRET). Registering that
 * client (with the callback redirect URI) and a security review are external prerequisites — see
 * docs/LLMO-7369/path-a-oauth-onestop-plan.md §7.
 *
 * `@adobe/spacecat-shared-ims-client` has no authorization_code support (promise-token exchange
 * only), so the authorize URL and token exchange are built directly against IMS's OAuth endpoints.
 */

import crypto from 'node:crypto';
import { tracingFetch } from '@adobe/spacecat-shared-utils';

export const IMS_CALLBACK_PATH = '/auth/ims/callback';
const DEFAULT_IMS_HOST = 'https://ims-na1.adobelogin.com';
const DEFAULT_AUTHORIZE_PATH = '/ims/authorize/v2';
const DEFAULT_TOKEN_PATH = '/ims/token/v3';
const DEFAULT_SCOPES = 'openid,AdobeID';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * True only when the interactive IMS OAuth client is configured. Off by default — the entire
 * Path A flow is a no-op until these are set (post client-registration + security review).
 * @param {object} env
 * @returns {boolean}
 */
export function isOnestopAuthEnabled(env) {
  return Boolean(
    env?.IMS_OAUTH_CLIENT_ID
    && env?.IMS_OAUTH_CLIENT_SECRET
    && env?.IMS_OAUTH_STATE_SECRET,
  );
}

/**
 * Generate a PKCE (S256) verifier/challenge pair.
 * @returns {{ verifier: string, challenge: string }}
 */
export function generatePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Sign a short-TTL, single-use state token (HMAC-SHA256) carrying the flow context + PKCE
 * verifier. Format: `<base64url(json)>.<base64url(hmac)>`.
 * @param {object} payload
 * @param {string} secret
 * @param {number} [now]
 * @returns {string}
 */
export function signState(payload, secret, now = Date.now()) {
  const body = {
    ...payload,
    exp: now + STATE_TTL_MS,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Verify + decode a state token. Returns the payload, or null when tampered/expired/malformed.
 * Uses a constant-time signature comparison.
 * @param {string} token
 * @param {string} secret
 * @param {number} [now]
 * @returns {object|null}
 */
export function verifyState(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return null;
  }
  const [data, sig] = token.split('.');
  if (!data || !sig) {
    return null;
  }
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }
  let body;
  try {
    body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body?.exp || body.exp < now) {
    return null;
  }
  return body;
}

/**
 * The fixed callback redirect URI. Prefer an explicit override; else derive from the API base.
 * Never built from request-supplied content.
 * @param {object} env
 * @returns {string}
 */
export function callbackRedirectUri(env) {
  if (env?.IMS_OAUTH_REDIRECT_URI) {
    return env.IMS_OAUTH_REDIRECT_URI;
  }
  const base = (env?.SPACECAT_API_BASE_URL || '').replace(/\/$/, '');
  return `${base}${IMS_CALLBACK_PATH}`;
}

/**
 * Build the IMS /authorize URL for the interactive login.
 * @param {object} env
 * @param {string} state
 * @param {string} codeChallenge
 * @returns {string}
 */
export function buildAuthorizeUrl(env, state, codeChallenge) {
  const host = (env?.IMS_OAUTH_HOST || env?.IMS_HOST || DEFAULT_IMS_HOST).replace(/\/$/, '');
  const path = env?.IMS_OAUTH_AUTHORIZE_PATH || DEFAULT_AUTHORIZE_PATH;
  const params = new URLSearchParams({
    client_id: env.IMS_OAUTH_CLIENT_ID,
    redirect_uri: callbackRedirectUri(env),
    scope: env.IMS_OAUTH_SCOPES || DEFAULT_SCOPES,
    response_type: 'code',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${host}${path}?${params.toString()}`;
}

/**
 * Exchange an authorization code for the operator's IMS access token (authorization_code grant).
 * @param {object} env
 * @param {string} code
 * @param {string} codeVerifier
 * @param {Function} [fetchImpl]
 * @returns {Promise<string>} the access token
 */
export async function exchangeCodeForToken(env, code, codeVerifier, fetchImpl = tracingFetch) {
  const host = (env?.IMS_OAUTH_HOST || env?.IMS_HOST || DEFAULT_IMS_HOST).replace(/\/$/, '');
  const path = env?.IMS_OAUTH_TOKEN_PATH || DEFAULT_TOKEN_PATH;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.IMS_OAUTH_CLIENT_ID,
    client_secret: env.IMS_OAUTH_CLIENT_SECRET,
    code,
    code_verifier: codeVerifier,
    redirect_uri: callbackRedirectUri(env),
  });
  const res = await fetchImpl(`${host}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`IMS token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json?.access_token) {
    throw new Error('IMS token exchange returned no access_token');
  }
  return json.access_token;
}

/**
 * Provision Semrush by calling spacecat's own authenticated /serenity/activate as the operator
 * (the exchanged IMS user token). Reuses the exact endpoint the frontend uses — no handler
 * internals, no duplicated orchestration. With no markets supplied the endpoint provisions a
 * single US/EN default project (still meets the "sub-workspace + >=1 project" completion bar).
 * @returns {Promise<Response>}
 */
export async function activateBrandAsOperator(
  env,
  orgId,
  brandId,
  accessToken,
  markets,
  fetchImpl = tracingFetch,
) {
  const base = (env?.SPACECAT_API_BASE_URL || '').replace(/\/$/, '');
  const url = `${base}/v2/orgs/${orgId}/brands/${brandId}/serenity/activate`;
  const payload = Array.isArray(markets) && markets.length > 0 ? { markets } : {};
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'x-product': 'LLMO',
    },
    body: JSON.stringify(payload),
  });
}
