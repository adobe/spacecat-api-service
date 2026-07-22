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

import { hasText } from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from '../utils.js';
import { ElementsTransportError } from './errors.js';

const ELEMENTS_API_PATH = '/enterprise/pages/api/v3/workspaces';
// Verified against a real Semrush-provisioned brand: individual Stats-per-URL
// calls were timing out at 15s roughly half the time; 30s was needed for them
// to reliably complete (and even then, some calls come in close to that
// ceiling). Endpoints with a wide fan-out (e.g. getUrlInspectorStats) bound
// their OWN total wall time separately (see STATS_FANOUT_CONCURRENCY /
// maxTrendWeeks in elements-service.js) rather than relying on this transport
// timeout to keep the whole request under the gateway's hard integration
// timeout ceiling.
const DEFAULT_TIMEOUT_MS = 30_000;

// Retry defaults match the shared Project Engine client (same Semrush gateway contract).
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;

/**
 * Upper bound on a single inter-attempt wait. Caps a hostile or fat-fingered `Retry-After`
 * (and runaway exponential growth) so a retry can never hang the request past a sane ceiling.
 */
const MAX_RETRY_DELAY_MS = 20_000;

/**
 * Validates and returns the canonical origin of SEMRUSH_PROJECTS_BASE_URL.
 * Enforces HTTPS. Returns `protocol//host` with no trailing path so URL
 * segments injected later cannot be escaped by a misconfigured base URL.
 */
function baseUrl(env) {
  const raw = typeof env?.SEMRUSH_PROJECTS_BASE_URL === 'string'
    ? env.SEMRUSH_PROJECTS_BASE_URL.trim()
    : env?.SEMRUSH_PROJECTS_BASE_URL;
  if (!hasText(raw)) {
    throw new ErrorWithStatusCode(
      'SEMRUSH_PROJECTS_BASE_URL is not set. Configure it via Vault '
      + '(dx_mysticat/<env>/api-service) or .env for local dev.',
      503,
    );
  }
  const candidate = raw.replace(/\/$/, '');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ErrorWithStatusCode(
      `SEMRUSH_PROJECTS_BASE_URL is not a valid URL: ${candidate}`,
      503,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new ErrorWithStatusCode(
      `SEMRUSH_PROJECTS_BASE_URL must use https (got ${parsed.protocol})`,
      503,
    );
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function buildHeaders(imsToken) {
  if (!hasText(imsToken)) {
    throw new ElementsTransportError(401, 'Missing IMS bearer token for Elements transport');
  }
  return {
    Authorization: `Bearer ${imsToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function enc(segment) {
  return encodeURIComponent(String(segment ?? ''));
}

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Parses a `Retry-After` header into milliseconds. Supports both RFC 9110 forms: delta-seconds
 * (e.g. `"5"`) and an HTTP-date. Returns null when the header is absent or unparseable, so the
 * caller falls back to backoff. Mirrors the shared Project Engine client's `parseRetryAfterMs`.
 * @param {Response} response
 * @returns {number | null}
 */
function parseRetryAfterMs(response) {
  const raw = response.headers?.get('retry-after');
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    // A negative delta-seconds is non-conforming (RFC 9110); treat it as absent so the caller
    // falls back to jittered backoff rather than reading it as "retry immediately".
    return seconds >= 0 ? Math.round(seconds * 1000) : null;
  }
  const epochMs = Date.parse(raw);
  if (Number.isNaN(epochMs)) {
    return null;
  }
  return Math.max(0, epochMs - Date.now());
}

/**
 * The wait before the next attempt: the larger of (a) exponential backoff with equal jitter —
 * `baseDelayMs * 2 ** completedAttempt` scaled by a random factor in `[0.5, 1)` to de-correlate
 * concurrent clients and avoid a thundering herd on a shared 429 — and (b) the server's
 * `Retry-After`, when present (so we never retry sooner than the server asked). Clamped to
 * {@link MAX_RETRY_DELAY_MS}. Mirrors the shared Project Engine client's `nextRetryDelayMs`.
 * @param {number} completedAttempt zero-based index of the attempt that just failed
 * @param {number} baseDelayMs
 * @param {Response} response the retryable response (for `Retry-After`)
 * @returns {number}
 */
function nextRetryDelayMs(completedAttempt, baseDelayMs, response) {
  const backoff = baseDelayMs * 2 ** completedAttempt;
  const jittered = backoff * (0.5 + Math.random() * 0.5);
  const retryAfter = parseRetryAfterMs(response);
  const delay = retryAfter == null ? jittered : Math.max(jittered, retryAfter);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * POSTs to the Elements API with bounded retry on HTTP 429.
 *
 * Retry is limited to 429 ON PURPOSE: `fetchElement` is a non-idempotent POST, so 5xx, network
 * errors, and AbortError/timeout are NEVER replayed — a write that may already have been processed
 * must not be re-sent (double-write risk). 429 is the one safe case because the Semrush gateway
 * rejects rate-limited requests at the edge, before the write handler runs, so the create never
 * happened and replaying it cannot duplicate a resource — the same assumption and rationale as the
 * shared Project Engine client's `isRetryableStatus`.
 *
 * Each attempt gets a FRESH `AbortController` + timeout timer (per-attempt, not a whole-loop
 * budget). The body is a JSON string, so it is safe to re-send unchanged across attempts.
 *
 * @param {string} url
 * @param {string} imsToken
 * @param {object} body request payload (serialised once, re-sent per attempt)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] per-attempt timeout
 * @param {number} [opts.maxRetries] number of retries after the first attempt; <=0 ⇒ single attempt
 * @param {number} [opts.retryBaseDelayMs] base delay for the jittered exponential backoff
 * @returns {Promise<*>} parsed response body on success
 */
async function request(url, imsToken, body, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
} = {}) {
  const jsonBody = JSON.stringify(body);
  // Floor at 0: a negative/zero maxRetries degrades to a single attempt (no retry).
  const retries = Math.max(0, maxRetries);

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(imsToken),
        signal: controller.signal,
        body: jsonBody,
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new ElementsTransportError(504, `Elements API POST ${url} timed out after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    // eslint-disable-next-line no-await-in-loop
    const parsed = await parseBody(response);
    if (response.ok) {
      return parsed;
    }

    // Retry only on 429, and only while retries remain (see function doc for the POST rationale).
    if (response.status === 429 && attempt < retries) {
      const delayMs = nextRetryDelayMs(attempt, retryBaseDelayMs, response);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    } else {
      throw new ElementsTransportError(
        response.status,
        `Elements API POST ${url} failed: ${response.status}`,
        parsed,
      );
    }
  }
}

/**
 * Creates the Semrush Elements API HTTP transport.
 * All element calls are POST requests authenticated with the caller's IMS bearer token.
 *
 * @param {object} args
 * @param {object} args.env - Environment (reads SEMRUSH_PROJECTS_BASE_URL).
 * @param {string} args.imsToken - IMS user bearer token (without 'Bearer ' prefix).
 * @param {number} [args.maxRetries] - Retries after the first attempt on a 429 (default 2;
 *   <=0 ⇒ single attempt). Defaults match the shared Project Engine client.
 * @param {number} [args.retryBaseDelayMs] - Base delay for the jittered backoff (default 200).
 *
 * Worst-case wall time per `fetchElement` is bounded but can be significant. The retry loop
 * only ever retries a 429 (see `request`'s doc for why non-idempotent POSTs can't safely retry
 * on timeout/5xx) — a plain timeout throws immediately on the FIRST attempt, so that path costs
 * exactly one `timeoutMs` (30s by default), not the multi-attempt figure below. The multi-attempt
 * ceiling only applies to a run of repeated 429s: with the defaults (`maxRetries` 2, per-attempt
 * `timeoutMs` 30s, backoff capped at `MAX_RETRY_DELAY_MS` 20s) that theoretical ceiling is ~130s
 * (3 × 30s attempts + up to 2 × 20s waits). Callers on a tight execution budget (e.g. a Lambda
 * timeout, or an API-Gateway-fronted route with a hard ~29-30s integration timeout that no
 * Lambda-side setting can raise) should lower `maxRetries` / `timeoutMs` accordingly, and bound
 * their OWN fan-out width so a single request doesn't need more than one round of concurrent
 * calls to complete (see `getUrlInspectorStats` in elements-service.js for an example).
 */
export function createElementsTransport({
  env,
  imsToken,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
}) {
  const root = baseUrl(env);

  return {
    /**
     * POST /enterprise/pages/api/v3/workspaces/{workspaceId}/products/ai/elements/{elementId}/data
     */
    async fetchElement(workspaceId, elementId, payload) {
      const url = `${root}${ELEMENTS_API_PATH}/${enc(workspaceId)}/products/ai/elements/${enc(elementId)}/data`;
      return request(url, imsToken, payload, { maxRetries, retryBaseDelayMs });
    },
  };
}
