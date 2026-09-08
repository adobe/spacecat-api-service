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
import { hasText } from '@adobe/spacecat-shared-utils';

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
 * @param {string} signingSecret - the Slack app signing secret.
 * @param {string} timestamp - the raw `x-slack-request-timestamp` value (unix seconds).
 * @param {string} rawBody - the exact request body bytes, as text.
 * @returns {string} the `v0=<hex>` signature.
 */
export function computeSlackSignature(signingSecret, timestamp, rawBody) {
  const baseString = `v0:${timestamp}:${rawBody}`;
  return `v0=${crypto.createHmac('sha256', signingSecret).update(baseString, 'utf8').digest('hex')}`;
}

/**
 * True when the route is one Slack signs. Tolerates a suffix with or without a leading slash
 * (production sets it with one; some test harnesses do not).
 *
 * @param {object} context - the universal context.
 * @returns {boolean}
 */
function isSlackSignedRoute(context) {
  return SLACK_SIGNED_PATHS.has(context?.pathInfo?.suffix || '');
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
    if (!isSlackSignedRoute(context)) {
      return fn(request, context);
    }

    const { log = console, pathInfo: { headers = {} } = {} } = context;
    // enrichPathInfo lowercases header names via request.headers.plain().
    const signature = headers[SIGNATURE_HEADER];
    const timestamp = headers[TIMESTAMP_HEADER];

    const unauthorized = (reason) => {
      // Log the reason, never the signature, body or secret.
      log.warn(`Slack signature verification failed: ${reason}`);
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'x-error': 'slack signature verification failed' },
      });
    };

    const { SLACK_SIGNING_SECRET: signingSecret } = context.env || {};
    // Fail closed on misconfiguration. An unsigned-but-accepted request is exactly the
    // vulnerability being fixed, so a missing secret must never degrade to "allow".
    if (!hasText(signingSecret)) {
      return unauthorized('SLACK_SIGNING_SECRET is not configured');
    }

    if (!hasText(signature) || !hasText(timestamp)) {
      return unauthorized('missing signature or timestamp header');
    }

    if (!SIGNATURE_PATTERN.test(signature)) {
      return unauthorized('malformed signature header');
    }

    // Slack sends unix seconds. Reject anything non-numeric outright rather than letting
    // Number() coerce (e.g. '' -> 0, '  12 ' -> 12) into a value that could pass the window.
    if (!/^\d+$/.test(timestamp)) {
      return unauthorized('malformed timestamp header');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - Number(timestamp)) > MAX_TIMESTAMP_SKEW_SECONDS) {
      return unauthorized('timestamp outside the allowed replay window');
    }

    // Content-Length is an honest-client hint only (a forger can omit or lie about it); the
    // post-read byte length below is the real enforcement. Checking it first lets us reject
    // a declared-oversized body without buffering it.
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return unauthorized('request body too large');
    }

    let rawBody;
    try {
      // clone() so the body remains readable by multipartFormData / bodyData downstream.
      rawBody = await request.clone().text();
    } catch (e) {
      return unauthorized(`could not read request body: ${e.message}`);
    }

    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
      return unauthorized('request body too large');
    }

    const expected = computeSlackSignature(signingSecret, timestamp, rawBody);
    if (!signaturesMatch(signature, expected)) {
      return unauthorized('signature mismatch');
    }

    return fn(request, context);
  };
}

export default slackSignatureWrapper;
