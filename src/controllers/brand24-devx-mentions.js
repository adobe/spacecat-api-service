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
 * Brand24 "devx" mentions-by-event/topic proxy (POC — separate integration from the main
 * `Brand24Controller`). A DIFFERENT host (`BRAND24_DEVX_BASE_URL`, not `api-data.brand24.com`)
 * and a DIFFERENT auth mechanism from the rest of this file's siblings — not documented in the
 * public Brand24 OpenAPI spec.
 *
 * Auth — VERIFIED live (2026-08-26): every path on this host, unauthenticated, returns a
 * blanket `401` with `WWW-Authenticate: Basic realm="go away"` from an nginx/Caddy edge layer —
 * there is no separate OAuth token endpoint in front of it (a probed `/oauth/token` returns the
 * exact same edge 401, not an OAuth-shaped error). So despite the source describing this as
 * "oauth", the actual mechanism the edge wants is plain HTTP Basic auth. On top of that, the
 * caller confirmed a second, application-level credential is required: an `x-api-key` header,
 * plus the real Brand24 project id (the same numeric id `projects-list` returns for Lovesac on
 * the main `api-data.brand24.com` host — NOT the test id originally pasted in chat, which
 * belonged to a different project and produced this host's own `{"message":"Not authorized"}`).
 *
 * Credentials are supplied ONLY via env (`BRAND24_DEVX_USERNAME`/`BRAND24_DEVX_PASSWORD` for
 * Basic auth, `BRAND24_DEVX_API_KEY` for `x-api-key` — falling back to the existing
 * `BRAND24_API_KEY` if no devx-specific key is set, or a full `BRAND24_DEVX_AUTH_HEADER`
 * override for the Authorization header alone) — never hardcoded or logged here.
 */

import { badRequest, ok, internalServerError } from '@adobe/spacecat-shared-http-utils';

const DEFAULT_BASE_URL = 'https://gkielar-prod-net.b24-devx.org';

function resolveAuthHeader(env) {
  if (env?.BRAND24_DEVX_AUTH_HEADER) {
    return env.BRAND24_DEVX_AUTH_HEADER;
  }
  const username = env?.BRAND24_DEVX_USERNAME;
  const password = env?.BRAND24_DEVX_PASSWORD;
  if (!username || !password) {
    return null;
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function resolveApiKey(env) {
  return env?.BRAND24_DEVX_API_KEY || env?.BRAND24_API_KEY || null;
}

function Brand24DevxMentionsController(context, log, env) {
  const getMentions = async (reqContext) => {
    const params = new URL(reqContext.request.url).searchParams;

    const eventDate = params.get('event_date');
    const topicId = params.get('topic_id');
    if (!eventDate && !topicId) {
      return badRequest('Provide event_date or topic_id');
    }

    const projectId = params.get('project_id') || env?.BRAND24_DEVX_PROJECT_ID;
    if (!projectId) {
      return badRequest('Missing project_id (and BRAND24_DEVX_PROJECT_ID is not configured)');
    }

    const authHeader = resolveAuthHeader(env);
    if (!authHeader) {
      return internalServerError(
        'BRAND24_DEVX_USERNAME/BRAND24_DEVX_PASSWORD (or BRAND24_DEVX_AUTH_HEADER) are not configured',
      );
    }

    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      return internalServerError('BRAND24_DEVX_API_KEY (or BRAND24_API_KEY) is not configured');
    }

    const baseUrl = env?.BRAND24_DEVX_BASE_URL || DEFAULT_BASE_URL;
    const upstreamQuery = new URLSearchParams();
    if (eventDate) {
      upstreamQuery.set('event_date', eventDate);
    }
    if (topicId) {
      upstreamQuery.set('topic_id', topicId);
    }

    const upstreamUrl = `${baseUrl}/api-data/v1/project/${projectId}/mentions/fetch?${upstreamQuery.toString()}`;

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        headers: { Authorization: authHeader, 'x-api-key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      log.error('[brand24-devx-mentions] upstream request failed', error);
      return internalServerError('Failed to reach the devx mentions endpoint');
    }

    let upstreamBody;
    try {
      upstreamBody = await upstreamResponse.json();
    } catch {
      return internalServerError('Malformed response from the devx mentions endpoint');
    }

    if (!upstreamResponse.ok) {
      log.warn(`[brand24-devx-mentions] upstream status=${upstreamResponse.status}`);
      const message = typeof upstreamBody?.message === 'string' ? upstreamBody.message : 'devx mentions request failed';
      return badRequest(message);
    }

    return ok(upstreamBody);
  };

  return { getMentions };
}

export default Brand24DevxMentionsController;
