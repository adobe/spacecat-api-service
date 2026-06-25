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
import AbstractHandler from '@adobe/spacecat-shared-http-utils/src/auth/handlers/abstract.js';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

// Path-scoped to the ASO redirect-overlay read route. The service shape mirrors
// the controller's own validation (RedirectsController SERVICE_RE), so only
// well-formed overlay requests are even considered for this credential.
// Tolerates the suffix with or without a leading slash (prod sets it with one).
const OVERLAY_ROUTE = /^\/?config\/cm-p\d{1,10}-e\d{1,10}\/redirects\.txt$/;

// Constant-time compare that does not leak input length: both inputs are HMAC'd
// to a fixed 32-byte digest before timingSafeEqual. The HMAC key is not a secret
// — it only normalises length. Never throws on non-string input.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const ha = crypto.createHmac('sha256', 'aso-key-compare').update(a).digest();
  const hb = crypto.createHmac('sha256', 'aso-key-compare').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Authenticates the ASO dispatcher-overlay read path
 * (`GET /config/:service/redirects.txt`) via the inbound `X-ASO-API-Key`,
 * validated against `ASO_OVERLAY_API_KEY` (current) and optionally
 * `ASO_OVERLAY_API_KEY_PREVIOUS` (rotation overlap). During a key rotation both
 * values are populated; in steady state the previous key is empty and only the
 * current key is checked. See ADR I13 for the rotation playbook.
 *
 * This must live in the auth-handler chain (not the controller): `authWrapper`
 * runs `authenticate()` before any controller, so a route that is neither in
 * `authWrapper`'s anonymous list nor claimed by a handler is rejected with 401
 * before its controller can run. Mirrors `GitHubWebhookHmacHandler`: path-scoped
 * (returns `null` for any other route so the remaining handlers run), validates
 * the header, and returns an `AuthInfo` only on success.
 *
 * Interim static-key bridge: once the dispatcher presents an S2S token the route
 * authenticates through the existing `s2sAuthWrapper`/`JwtHandler` chain and this
 * handler can be deleted. See the aso-dispatcher-overlay ADR.
 */
class AsoOverlayKeyHandler extends AbstractHandler {
  constructor(log) {
    super('aso-overlay-key', log);
  }

  async checkAuth(request, context) {
    const method = (context.pathInfo?.method || '').toUpperCase();
    const suffix = context.pathInfo?.suffix || '';

    // Path-scoped: only the overlay read route. Return null otherwise so the
    // remaining handlers run.
    if (method !== 'GET' || !OVERLAY_ROUTE.test(suffix)) {
      return null;
    }

    const providedKey = request.headers.get('x-aso-api-key');
    // No key supplied: not an overlay-key request. Fall through (→ 401 if no
    // other handler authenticates).
    if (!providedKey) {
      return null;
    }

    const expectedKey = context.env?.ASO_OVERLAY_API_KEY;
    if (!expectedKey) {
      this.log('ASO_OVERLAY_API_KEY is not configured', 'error');
      return null;
    }

    const previousKey = context.env?.ASO_OVERLAY_API_KEY_PREVIOUS;
    if (!safeEqual(providedKey, expectedKey)
        && !(previousKey && safeEqual(providedKey, previousKey))) {
      this.log('invalid X-ASO-API-Key', 'warn');
      return null;
    }

    return new AuthInfo()
      .withAuthenticated(true)
      .withProfile({ user_id: 'aso-overlay' })
      .withType('aso_overlay_key');
  }
}

export default AsoOverlayKeyHandler;
