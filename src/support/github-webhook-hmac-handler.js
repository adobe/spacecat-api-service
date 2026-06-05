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

import crypto from 'crypto';
import AbstractHandler from '@adobe/spacecat-shared-http-utils/src/auth/handlers/abstract.js';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { extractClassificationMetadata, parseDestinations, classifyDestination } from './github-targets.js';
import { emitMetric, resolveEnvironment } from './metrics-emf.js';

const SIGNATURE_PATTERN = /^sha256=[a-f0-9]{64}$/;
const WEBHOOK_PATH_PATTERN = /^\/?webhooks\//;
// Real GitHub webhook payloads are typically under 100 KB; GitHub caps at 25 MB.
// Reject larger bodies before HMAC computation to prevent pre-auth resource exhaustion.
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

// Timing-safe HMAC compare. Both buffers are 71 chars ("sha256=" + 64 hex):
// SIGNATURE_PATTERN guaranteed the input length and the HMAC hex is fixed-length,
// so timingSafeEqual will not throw on a length mismatch.
function verifySignature(signature, rawBody, secret) {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

class GitHubWebhookHmacHandler extends AbstractHandler {
  constructor(log) {
    super('github-webhook-hmac', log);
  }

  // Read the raw body and enforce the 1 MiB cap. Returns the raw string, or null
  // (already logged) on empty / oversized. Two-tier: a Content-Length precheck
  // (honest-client-only; attacker can omit the header) then the post-read byte
  // length (the real enforcement). request.text() returns the cached body.
  // The `rejected` callback receives a stable reason label and emits a metric;
  // it is provided by checkAuth once context.env is available. Defaults to a
  // no-op so a standalone call (e.g. a direct unit test) cannot throw on reject.
  async readBodyWithLimits(request, rejected = () => {}) {
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      this.log(`Payload too large: ${contentLength} bytes`, 'warn');
      rejected('body_too_large');
      return null;
    }
    const rawBody = await request.text();
    if (!rawBody) {
      this.log('Empty request body for webhook', 'warn');
      rejected('empty_body');
      return null;
    }
    const byteLength = Buffer.byteLength(rawBody, 'utf8');
    if (byteLength > MAX_BODY_BYTES) {
      this.log(`Payload too large after read: ${byteLength} bytes`, 'warn');
      rejected('body_too_large');
      return null;
    }
    return rawBody;
  }

  async checkAuth(request, context) {
    // Path-scoped: only handle /webhooks/* routes. Tolerate suffix with or
    // without leading slash (production sets it with leading slash).
    if (!WEBHOOK_PATH_PATTERN.test(context.pathInfo?.suffix || '')) {
      return null;
    }

    const signature = request.headers.get('x-hub-signature-256');
    // Not a GitHub webhook request -- let other handlers try
    if (!signature) {
      return null;
    }

    // Best-effort metric helpers — defined here so context.env is in scope.
    // Both swallow errors (emitMetric is itself best-effort, and these are
    // called on auth-rejection paths where we must never throw).
    const environment = resolveEnvironment(context.env);
    const rejected = (reason) => emitMetric(
      { name: 'WebhookRejected', dimensions: { Reason: reason } },
      { environment },
    );
    const misconfigured = () => emitMetric(
      { name: 'WebhookDestinationsMisconfigured' },
      { environment },
    );

    // Validate signature format FIRST: structural check, no I/O, no config.
    // Runs before any secret/registry work to prevent error-log amplification on
    // pre-auth malformed requests, and before timingSafeEqual to avoid a throw.
    if (!SIGNATURE_PATTERN.test(signature)) {
      this.log('Malformed X-Hub-Signature-256 header', 'warn');
      rejected('malformed_signature');
      return null;
    }

    // Consolidated registry is the only routing path. GITHUB_DESTINATIONS is a
    // keyed object (target_id -> { match, webhook_secret, reviewer_login })
    // loaded at runtime from Vault. Classify from the SIGNED body, select the
    // matched destination's inline webhook_secret, verify HMAC once. Parsing
    // before verifying is safe: a forged body just selects a candidate whose
    // secret it cannot forge.
    if (!context.env?.GITHUB_DESTINATIONS) {
      this.log('GITHUB_DESTINATIONS not configured (misconfigured=true)', 'error');
      misconfigured();
      return null;
    }
    let destinations;
    try {
      destinations = parseDestinations(context.env);
    } catch (e) {
      // Malformed registry is a misconfiguration; null -> 401 (visible failed
      // delivery). Do NOT interpolate the value (it is secret-bearing); the
      // parser's message names only keys/fields, never secrets.
      this.log(`Invalid GITHUB_DESTINATIONS config (misconfigured=true): ${e.message}`, 'error');
      misconfigured();
      return null;
    }
    const rawBody = await this.readBodyWithLimits(request, rejected);
    if (rawBody === null) {
      return null;
    }
    const meta = extractClassificationMetadata(rawBody);
    if (meta === null) {
      this.log('Webhook body is not valid JSON', 'warn');
      rejected('not_json');
      return null;
    }
    const result = classifyDestination(meta, destinations);
    // host not an in-scope GitHub destination (e.g. a GHES host): skip + log,
    // NO HMAC. The body is untrusted, so do not interpolate meta.host.
    if (result.skip) {
      this.log('Skipping webhook: host is not an in-scope GitHub destination', 'warn');
      rejected('non_inscope_host');
      return null;
    }
    // webhook_secret is inline + validated non-empty at parse, so it is present
    // on a validated registry; verify HMAC once.
    if (!verifySignature(signature, rawBody, result.webhook_secret)) {
      this.log('HMAC signature mismatch', 'warn');
      rejected('hmac_mismatch');
      return null;
    }
    return new AuthInfo()
      .withAuthenticated(true)
      .withProfile({
        user_id: 'github-webhook',
        target_id: result.target_id,
        // reviewer_login is required on every destination entry (no global
        // fallback), so it is always set here.
        reviewer_login: result.reviewer_login,
      })
      .withType('github_webhook');
  }
}

export default GitHubWebhookHmacHandler;
