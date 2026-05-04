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

const SIGNATURE_PATTERN = /^sha256=[a-f0-9]{64}$/;
const WEBHOOK_PATH_PATTERN = /^\/?webhooks\//;
// Real GitHub webhook payloads are typically under 100 KB; GitHub caps at 25 MB.
// Reject larger bodies before HMAC computation to prevent pre-auth resource exhaustion.
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

class GitHubWebhookHmacHandler extends AbstractHandler {
  constructor(log) {
    super('github-webhook-hmac', log);
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
    // Must run before the secret presence check to prevent error-log amplification
    // on pre-auth malformed requests when GITHUB_WEBHOOK_SECRET is unset.
    // Also prevents timingSafeEqual from throwing on length mismatch later.
    if (!SIGNATURE_PATTERN.test(signature)) {
      this.log('Malformed X-Hub-Signature-256 header', 'warn');
      return null;
    }

    const secret = context.env?.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      this.log('GITHUB_WEBHOOK_SECRET not configured (misconfigured=true)', 'error');
      return null;
    }

    // Two-tier size check:
    //   - Pre-read via Content-Length: honest-client-only (attacker can omit the
    //     header to skip this branch). Saves the body read when the header is set.
    //   - Post-read via Buffer.byteLength (below): the actual enforcement, catches
    //     missing or falsified Content-Length.
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      this.log(`Payload too large: ${contentLength} bytes`, 'warn');
      return null;
    }

    // Read raw body from request. bodyData middleware runs BEFORE authWrapper
    // in the .with() chain (last .with() = outermost = runs first), so bodyData
    // has already consumed the stream and set context.data. request.text()
    // returns the cached body via @adobe/helix-universal's Request implementation.
    const rawBody = await request.text();
    if (!rawBody) {
      this.log('Empty request body for webhook', 'warn');
      return null;
    }

    // Second size check after reading (content-length may be absent or wrong).
    // Use byte length (not JS string length) for a byte-accurate cap.
    const byteLength = Buffer.byteLength(rawBody, 'utf8');
    if (byteLength > MAX_BODY_BYTES) {
      this.log(`Payload too large after read: ${byteLength} bytes`, 'warn');
      return null;
    }

    // Compute expected HMAC
    const expected = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex')}`;

    // Timing-safe comparison (both are guaranteed 71 chars: "sha256=" + 64 hex)
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      this.log('HMAC signature mismatch', 'warn');
      return null;
    }

    return new AuthInfo()
      .withAuthenticated(true)
      .withProfile({ user_id: 'github-webhook' })
      .withType('github_webhook');
  }
}

export default GitHubWebhookHmacHandler;
