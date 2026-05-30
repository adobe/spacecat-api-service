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
import { parseTargets, classify, extractClassificationMetadata } from './github-targets.js';

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
  async readBodyWithLimits(request) {
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      this.log(`Payload too large: ${contentLength} bytes`, 'warn');
      return null;
    }
    const rawBody = await request.text();
    if (!rawBody) {
      this.log('Empty request body for webhook', 'warn');
      return null;
    }
    const byteLength = Buffer.byteLength(rawBody, 'utf8');
    if (byteLength > MAX_BODY_BYTES) {
      this.log(`Payload too large after read: ${byteLength} bytes`, 'warn');
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
    // Validate signature format FIRST: structural check, no I/O, no config.
    // Runs before any secret/registry work to prevent error-log amplification on
    // pre-auth malformed requests, and before timingSafeEqual to avoid a throw.
    if (!SIGNATURE_PATTERN.test(signature)) {
      this.log('Malformed X-Hub-Signature-256 header', 'warn');
      return null;
    }

    const targetsRaw = context.env?.GITHUB_TARGETS;

    // ---- Legacy path: no registry configured -> today's exact behaviour ----
    // Single GITHUB_WEBHOOK_SECRET, no target_id. The secret presence is checked
    // BEFORE reading the body, preserving the early-bail.
    if (!targetsRaw) {
      const secret = context.env?.GITHUB_WEBHOOK_SECRET;
      if (!secret) {
        this.log('GITHUB_WEBHOOK_SECRET not configured (misconfigured=true)', 'error');
        return null;
      }
      const rawBody = await this.readBodyWithLimits(request);
      if (rawBody === null) {
        return null;
      }
      if (!verifySignature(signature, rawBody, secret)) {
        this.log('HMAC signature mismatch', 'warn');
        return null;
      }
      return new AuthInfo()
        .withAuthenticated(true)
        .withProfile({ user_id: 'github-webhook' })
        .withType('github_webhook');
    }

    // ---- Registry path: classify from the SIGNED body, select the candidate ----
    // target's secret, verify HMAC once. Parsing before verifying is safe: a
    // forged body just selects a candidate whose secret it cannot forge.
    let targets;
    try {
      targets = parseTargets(context.env);
    } catch (e) {
      // Malformed registry is a misconfiguration; null -> 401 (visible failed
      // delivery), matching the missing-secret handling above.
      this.log(`Invalid GITHUB_TARGETS config (misconfigured=true): ${e.message}`, 'error');
      return null;
    }
    const rawBody = await this.readBodyWithLimits(request);
    if (rawBody === null) {
      return null;
    }
    const meta = extractClassificationMetadata(rawBody);
    if (meta === null) {
      this.log('Webhook body is not valid JSON', 'warn');
      return null;
    }
    const result = classify(meta, targets);
    // host not an in-scope GitHub destination (e.g. a GHES host): skip + log, NO
    // HMAC. The body is untrusted, so do not interpolate meta.host into the log.
    if (result.skip) {
      this.log('Skipping webhook: host is not an in-scope GitHub destination', 'warn');
      return null;
    }
    const secret = context.env?.[result.webhookSecretEnvVar];
    if (!secret) {
      this.log(`Webhook secret for target ${result.id} not configured (misconfigured=true)`, 'error');
      return null;
    }
    if (!verifySignature(signature, rawBody, secret)) {
      this.log('HMAC signature mismatch', 'warn');
      return null;
    }
    return new AuthInfo()
      .withAuthenticated(true)
      .withProfile({
        user_id: 'github-webhook',
        target_id: result.id,
        app_slug: result.appSlug,
        // Per-target reviewer-gate identity (undefined on the default entry,
        // which falls back to env.GITHUB_REVIEWER_LOGIN in the controller).
        reviewer_login: result.reviewerLogin,
      })
      .withType('github_webhook');
  }
}

export default GitHubWebhookHmacHandler;
