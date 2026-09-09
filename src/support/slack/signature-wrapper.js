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

import crypto from 'crypto';
import { Response } from '@adobe/fetch';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';
import { hasText } from '@adobe/spacecat-shared-utils';
import { checkBodySize } from '../../utils/validations.js';

/**
 * Slack request-signature verification (VULN-39365).
 *
 * `/slack/events` is listed in ANONYMOUS_ENDPOINTS in spacecat-shared's authWrapper, so the
 * authentication manager never runs for it. Bolt's own signature check lives in its HTTP
 * receiver, which this service bypasses by calling `app.processEvent({ body, ack })` on an
 * already-parsed body — so the configured `signingSecret` was never actually exercised. The
 * result was an unauthenticated RCE-adjacent surface: forged event and interactive payloads
 * reached every registered command/action handler, including ones that fetch an
 * attacker-supplied `url_private` with the bot token attached, and `approveOrg`.
 *
 * This wrapper closes that hole at the edge, before any Slack payload is parsed or dispatched.
 *
 * Placement (src/index.js): declared immediately BEFORE `enrichPathInfo` in the `.with()` chain.
 * helix-shared-wrap treats the last `.with()` as outermost, so declaration order bottom-to-top is
 * execution order — this puts the wrapper directly after `enrichPathInfo` (so `context.pathInfo`
 * is populated) and before `multipartFormData` / `bodyData` (so the body is still unread).
 *
 * The body is read via `request.clone().text()`, never `request.text()`: `bodyData` downstream
 * consumes the body itself and would fail on an already-consumed stream.
 */

// Slack's documented replay window. Slack itself recommends rejecting anything older than
// five minutes; we apply it symmetrically to also reject far-future timestamps, which a
// forger would need in order to mint a signature that stays valid.
export const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

// Reject oversized bodies before doing any HMAC work, so an unauthenticated caller cannot
// force unbounded hashing. Real Slack payloads are a few KB; Slack does not document a hard
// cap, so 1 MiB is a generous ceiling (matches github-webhook-hmac-handler.js).
export const MAX_BODY_BYTES = 1024 * 1024;

// "v0=" plus a 64-char lowercase hex HMAC-SHA256 digest. Checked before timingSafeEqual so a
// malformed header cannot throw on a Buffer length mismatch.
const SIGNATURE_PATTERN = /^v0=[a-f0-9]{64}$/;

const SIGNATURE_HEADER = 'x-slack-signature';
const TIMESTAMP_HEADER = 'x-slack-request-timestamp';

// Only the Slack-facing route. Everything else passes through untouched. `/slack/channels/
// invite-by-user-id` is deliberately NOT included: it is an inbound Adobe-side call
// authenticated by RouteScopedLegacyApiKeyHandler, not a request signed by Slack.
const SLACK_SIGNED_PATHS = new Set(['/slack/events', 'slack/events']);

// Fail-closed backstop, matched against the RAW request URL rather than context.pathInfo.
//
// `isSlackSignedRoute` keys off `context.pathInfo.suffix`, which is populated upstream by
// `enrichPathInfo`. If this wrapper were ever re-ordered to run BEFORE that (or pathInfo were
// otherwise unpopulated), `suffix` would be empty, the guard would be skipped, and the request
// would pass through UNVERIFIED -- i.e. fail open, which is precisely the VULN-39365 surface.
// Consulting the request URL as well makes the guard independent of wrapper ordering: the worst
// case becomes a 401 on a path nothing serves, never an unverified Slack payload.
const SLACK_EVENTS_URL_PATH = /(^|\/)slack\/events\/?$/;

// CORS preflight is answered by `run()` in src/index.js with a 204 before any route handler is
// reached, and carries no body to sign. Excluding it keeps that behaviour intact rather than
// turning every preflight into a 401. Every other method on the guarded suffix is verified --
// deliberately wider than the single `POST` the router exposes today, so that re-adding a route
// on this path cannot silently create an unverified entry point.
const UNVERIFIED_METHODS = new Set(['OPTIONS']);

/**
 * Constant-time comparison of the received signature against the expected one.
 * Both operands are known to be 67 ASCII chars ("v0=" + 64 hex) because the caller has already
 * matched SIGNATURE_PATTERN and we generate the expected value ourselves, so timingSafeEqual
 * cannot throw on differing lengths.
 *
 * @param {string} received - the `x-slack-signature` header value.
 * @param {string} expected - the locally computed signature.
 * @returns {boolean} true when they match.
 */
function signaturesMatch(received, expected) {
  return crypto.timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'));
}

/**
 * Computes the Slack v0 signature for a raw body.
 *
 * The HMAC is taken over the UTF-8 encoding of the decoded body text. This matches Slack's own
 * Bolt SDK, which signs `` `${version}:${timestamp}:${body}` `` with `body` as a string
 * (`@slack/bolt/dist/receivers/verify-request.js`). Slack payloads are UTF-8 JSON or
 * form-urlencoded, so the decode/encode round-trip is lossless; a body that is not valid UTF-8
 * is not a legitimate Slack payload and fails closed on the signature comparison.
 *
 * @param {string} signingSecret - the Slack app signing secret.
 * @param {string} timestamp - the raw `x-slack-request-timestamp` value (unix seconds).
 * @param {string} rawBody - the request body, as text.
 * @returns {string} the `v0=<hex>` signature.
 */
export function computeSlackSignature(signingSecret, timestamp, rawBody) {
  const baseString = `v0:${timestamp}:${rawBody}`;
  return `v0=${crypto.createHmac('sha256', signingSecret).update(baseString, 'utf8').digest('hex')}`;
}

/**
 * True when the request must carry a valid Slack signature: the route is one Slack signs, and
 * the method is one that can carry a signed body.
 *
 * The route is resolved from `context.pathInfo.suffix` when available (tolerating a suffix with
 * or without a leading slash), and otherwise from the raw request URL. That fallback is what
 * makes the guard fail CLOSED rather than open if `pathInfo` is ever unpopulated -- see
 * SLACK_EVENTS_URL_PATH.
 *
 * @param {Request} request - the universal request.
 * @param {object} context - the universal context.
 * @returns {boolean}
 */
function isSlackSignedRoute(request, context) {
  // Prefer pathInfo.method (set by enrichPathInfo), fall back to the request's own method.
  const method = (context?.pathInfo?.method || request?.method || '').toUpperCase();
  if (UNVERIFIED_METHODS.has(method)) {
    return false;
  }

  const suffix = context?.pathInfo?.suffix;
  if (typeof suffix === 'string' && suffix.length > 0) {
    return SLACK_SIGNED_PATHS.has(suffix);
  }

  try {
    return SLACK_EVENTS_URL_PATH.test(new URL(request.url).pathname);
  } catch {
    // An unparseable URL cannot be shown to be a non-Slack route, so guard it.
    return true;
  }
}

/**
 * Wraps a universal function so that requests to `/slack/events` must carry a valid Slack
 * request signature. Fails closed: any missing, malformed, stale, oversized or mismatching
 * input yields 401 and the request never reaches the Slack controller.
 *
 * @param {UniversalFunction} fn - the function to wrap.
 * @returns {UniversalFunction} the wrapped function.
 */
export function slackSignatureWrapper(fn) {
  return async (request, context) => {
    if (!isSlackSignedRoute(request, context)) {
      return fn(request, context);
    }

    const { log = console, pathInfo: { headers = {} } = {} } = context;
    // enrichPathInfo lowercases header names via request.headers.plain().
    const signature = headers[SIGNATURE_HEADER];
    const timestamp = headers[TIMESTAMP_HEADER];

    // Emits a 401 plus a diagnosable log line. `reason` is a stable label for alerting;
    // `detail` carries non-sensitive context so on-call can tell a stripped header (e.g. a CDN
    // dropping X-Slack-Signature) apart from clock skew or an oversized body WITHOUT having to
    // reproduce. Never logs the signature, the signing secret or any part of the body.
    const unauthorized = (reason, detail = {}) => {
      const fields = {
        reason,
        method: context?.pathInfo?.method,
        suffix: context?.pathInfo?.suffix,
        traceId: context?.traceId,
        hasSignatureHeader: hasText(signature),
        hasTimestampHeader: hasText(timestamp),
        ...detail,
      };
      const rendered = Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      log.warn(`Slack signature verification failed: ${rendered}`);
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'x-error': 'slack signature verification failed' },
      });
    };

    const { SLACK_SIGNING_SECRET: signingSecret } = context.env || {};
    // Fail closed on misconfiguration. An unsigned-but-accepted request is exactly the
    // vulnerability being fixed, so a missing secret must never degrade to "allow".
    if (!hasText(signingSecret)) {
      return unauthorized('secret_not_configured');
    }

    if (!hasText(signature) || !hasText(timestamp)) {
      // Split so on-call can see WHICH header is absent -- a CDN/proxy stripping one of them
      // is a realistic production failure and looks nothing like a forged request.
      return unauthorized('missing_header');
    }

    if (!SIGNATURE_PATTERN.test(signature)) {
      return unauthorized('malformed_signature');
    }

    // Slack sends unix seconds. Reject anything non-numeric outright rather than letting
    // Number() coerce (e.g. '' -> 0, '  12 ' -> 12) into a value that could pass the window.
    if (!/^\d+$/.test(timestamp)) {
      return unauthorized('malformed_timestamp');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const skewSeconds = nowSeconds - Number(timestamp);
    if (Math.abs(skewSeconds) > MAX_TIMESTAMP_SKEW_SECONDS) {
      // Surfacing the delta distinguishes genuine replay from server clock drift.
      return unauthorized('stale_timestamp', { skewSeconds, maxSkewSeconds: MAX_TIMESTAMP_SKEW_SECONDS });
    }

    // Content-Length is an honest-client hint only (a forger can omit or lie about it); the
    // post-read byte length below is the real enforcement. Checking it first lets us reject
    // a declared-oversized body without buffering it.
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return unauthorized('body_too_large', { declaredBytes: contentLength, maxBytes: MAX_BODY_BYTES });
    }

    let rawBody;
    try {
      // clone() so the body remains readable by multipartFormData / bodyData downstream.
      rawBody = await request.clone().text();
    } catch (e) {
      return unauthorized('body_unreadable', { error: cleanupHeaderValue(e.message) });
    }

    const bodyBytes = Buffer.byteLength(rawBody, 'utf8');
    // Reuse the repo's shared body-size helper for the post-read (authoritative) check. The
    // Content-Length pre-check above has no equivalent there: it measures a client-supplied
    // header, not a body, and exists only to reject a declared-oversized request before
    // buffering it.
    if (!checkBodySize(rawBody, MAX_BODY_BYTES)) {
      return unauthorized('body_too_large', { bodyBytes, maxBytes: MAX_BODY_BYTES });
    }

    const expected = computeSlackSignature(signingSecret, timestamp, rawBody);
    if (!signaturesMatch(signature, expected)) {
      // bodyBytes is the single most useful field here: a mismatch with a plausible body size
      // usually means a body-rewriting proxy, not a forgery.
      return unauthorized('signature_mismatch', { bodyBytes });
    }

    return fn(request, context);
  };
}

export default slackSignatureWrapper;
