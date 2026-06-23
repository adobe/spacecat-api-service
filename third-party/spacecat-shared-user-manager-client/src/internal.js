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
 * Framework-agnostic building blocks for the User Manager client.
 * Deliberately free of `openapi-fetch` and generated-type imports so they can be
 * unit-tested without the generated spec output being present.
 */

/**
 * Supplies the caller's IMS JWT — forwarded verbatim, never minted or exchanged.
 * @typedef {string | (() => string | Promise<string>)} AuthTokenSource
 */

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

/**
 * Resolves the HTTP method for a fetch call the same way the platform does.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 * @returns {string} the upper-cased method
 */
export function methodOf(input, init) {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return method.toUpperCase();
}

/**
 * @param {string} method
 * @returns {boolean} whether the method is safe to replay
 */
export function isIdempotent(method) {
  return IDEMPOTENT_METHODS.has(method);
}

/**
 * 429 is retried for ANY method, including non-idempotent ones (POST). The assumption: the
 * Semrush gateway rejects a rate-limited request at the edge, before it reaches the handler, so
 * the create never happened and replaying it cannot duplicate a resource. This holds for the
 * deployed API today, but it IS an upstream contract: if Semrush ever rate-limits *after*
 * partially processing a write, a 429-retried POST (e.g. create-child-workspace, add-member)
 * could double-create. There is no idempotency-key header on these endpoints to
 * lean on; revisit this method-agnostic 429 retry if that upstream behaviour changes. A 5xx, by
 * contrast, is retried only for idempotent methods, so a POST that may have already created a
 * resource is never replayed.
 * @param {string} method
 * @param {number} status
 * @returns {boolean}
 */
export function isRetryableStatus(method, status) {
  if (status === 429) {
    return true;
  }
  if (status >= 500 && status <= 599) {
    return isIdempotent(method);
  }
  return false;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Upper bound on a single inter-attempt wait. Caps a hostile or fat-fingered `Retry-After`
 * (and runaway exponential growth) so a retry can never hang a Lambda past a sane ceiling.
 */
export const MAX_RETRY_DELAY_MS = 20_000;

/**
 * Parses a `Retry-After` header into milliseconds. Supports both RFC 9110 forms: delta-seconds
 * (e.g. `"5"`) and an HTTP-date. Returns null when the header is absent or unparseable, so the
 * caller falls back to backoff.
 * @param {Response} response
 * @returns {number | null}
 */
export function parseRetryAfterMs(response) {
  const raw = response.headers.get('retry-after');
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
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
 * concurrent clients and avoid thundering-herd alignment on a shared 429/503 — and (b) the
 * server's `Retry-After`, when present (so we never retry sooner than the server asked).
 * Clamped to {@link MAX_RETRY_DELAY_MS}.
 * @param {number} completedAttempt zero-based index of the attempt that just failed
 * @param {number} baseDelayMs
 * @param {Response | null} response the retryable response, if any (for `Retry-After`)
 * @returns {number}
 */
export function nextRetryDelayMs(completedAttempt, baseDelayMs, response) {
  const backoff = baseDelayMs * 2 ** completedAttempt;
  const jittered = backoff * (0.5 + Math.random() * 0.5);
  const retryAfter = response ? parseRetryAfterMs(response) : null;
  const delay = retryAfter == null ? jittered : Math.max(jittered, retryAfter);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * Invokes a best-effort {@link OnRetry} hook, swallowing both synchronous throws and asynchronous
 * rejections so a broken observability callback can never break the retry loop or the request.
 * The hook fires fire-and-forget (never awaited), so it cannot delay a retry. Its own failures are
 * deliberately silent (no signal is emitted) — surfacing them would itself need an observability
 * channel; observability must never affect the request outcome.
 * @param {OnRetry} [onRetry]
 * @param {object} info
 */
function notifyRetry(onRetry, info) {
  if (!onRetry) {
    return;
  }
  try {
    const result = onRetry(info);
    // An async onRetry returns a promise; sink its rejection here so a rejecting hook can't escape
    // as an unhandled promise rejection (which crashes the process in Node 18+). Not awaited.
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch {
    // best-effort: a throwing (sync) hook is swallowed, same as a rejecting (async) one above.
  }
}

/**
 * @callback OnRetry
 * @param {object} info
 * @param {number} info.attempt the 1-based number of the retry about to be made
 * @param {number} info.delayMs the wait before this retry
 * @param {string} info.method the HTTP method
 * @param {number} [info.status] the retryable response status that triggered the retry, if any
 * @param {Error} [info.error] the network error that triggered the retry, if any
 * @returns {void | Promise<void>} may be async; the return is not awaited (fire-and-forget)
 */

/**
 * Wraps a fetch with bounded exponential-backoff retries. Retryable statuses follow
 * {@link isRetryableStatus}; thrown network errors are retried only for idempotent methods.
 * The wait between attempts is {@link nextRetryDelayMs} — jittered exponential backoff that also
 * honours a `Retry-After` header. After exhausting retries it returns the last retryable response
 * (so the caller still sees e.g. the final 503) or rethrows the last network error.
 *
 * An optional `onRetry` callback is invoked just before each retry sleep, so consumers can log or
 * meter retry behaviour (otherwise a retry loop silently delays a response by up to
 * `maxRetries * MAX_RETRY_DELAY_MS`). It is best-effort and fire-and-forget: a throwing (sync) or
 * rejecting (async) `onRetry` is swallowed so a broken observability hook can never break the
 * request itself.
 * @param {typeof globalThis.fetch} baseFetch
 * @param {number} maxRetries
 * @param {number} baseDelayMs
 * @param {OnRetry} [onRetry] optional best-effort retry-observability hook
 * @returns {typeof globalThis.fetch}
 */
export function createRetryingFetch(baseFetch, maxRetries, baseDelayMs, onRetry) {
  return async function retryingFetch(input, init) {
    const method = methodOf(input, init);
    // Floor at 0: a negative maxRetries would skip the loop entirely, leaving both lastResponse
    // and lastError undefined and ending in `throw undefined`. Degrade to a single attempt instead.
    const attempts = Math.max(0, maxRetries);
    // openapi-fetch calls us with a Request object; fetch() consumes its body on use, so a
    // bare replay throws "Request ... already used". Clone per attempt and never touch the
    // original, so every retry (incl. a 429 on a bodied POST) sends a fresh, unconsumed body.
    // The clone preserves the request's headers — including the `Authorization` header the auth
    // middleware set once for this logical request — so all attempts share that one token. The
    // token is resolved per request, not per attempt; with the ceiling above the whole loop is
    // bounded well under an IMS token's lifetime, so mid-loop expiry is a non-issue.
    const forAttempt = () => (input instanceof Request ? input.clone() : input);
    let lastResponse;
    let lastError;
    let nextDelayMs = 0;

    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      if (attempt > 0) {
        notifyRetry(onRetry, {
          attempt, delayMs: nextDelayMs, method, status: lastResponse?.status, error: lastError,
        });
        // eslint-disable-next-line no-await-in-loop
        await sleep(nextDelayMs);
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await baseFetch(forAttempt(), init);
        if (!isRetryableStatus(method, response.status)) {
          return response;
        }
        lastResponse = response;
        lastError = undefined;
        nextDelayMs = nextRetryDelayMs(attempt, baseDelayMs, response);
      } catch (error) {
        if (!isIdempotent(method)) {
          throw error;
        }
        lastError = error;
        lastResponse = undefined;
        nextDelayMs = nextRetryDelayMs(attempt, baseDelayMs, null);
      }
    }

    if (lastResponse) {
      return lastResponse;
    }
    throw lastError;
  };
}

/**
 * Normalises an {@link AuthTokenSource} into a getter, so callers can pass either a static
 * token or a (sync/async) function resolved per request. Rejects any other type at construction
 * time — without this guard a stray `null`, number, or object would flow into the
 * `Authorization` header (`Bearer [object Object]`) and surface only as an opaque upstream 401.
 * @param {AuthTokenSource} source
 * @returns {() => string | Promise<string>}
 */
export function toTokenGetter(source) {
  if (typeof source === 'function') {
    return source;
  }
  if (typeof source === 'string') {
    return () => source;
  }
  throw new Error(
    `User Manager client: authToken must be a string or a function, got ${typeof source}`,
  );
}
