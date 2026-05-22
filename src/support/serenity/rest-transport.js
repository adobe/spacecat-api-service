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

const API_PREFIX = '/enterprise/projects/api';
// Cap upstream calls so a slow Semrush response doesn't pin the Lambda for its
// full wall budget. Semrush returns well under 5s in practice; 15s is a safe
// ceiling that still gives the user a clean error rather than a Lambda timeout.
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Error thrown when the Semrush upstream returns a non-2xx response or refuses
 * the auth header. `status` carries the upstream status; `body` is the parsed
 * JSON (or raw text when not valid JSON). The controller's `mapError` does
 * NOT leak `.body` to clients — it is kept here only for server-side logging.
 */
export class SerenityTransportError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'SerenityTransportError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Resolves and validates the upstream base URL. The URL is required and must
 * arrive via `env.SEMRUSH_PROJECTS_BASE_URL` — sourced from Vault
 * (`dx_mysticat/<env>/api-service`) and injected through AWS Secrets Manager.
 * No source default: the upstream host is operational config that must be
 * settable per-environment without a code change.
 *
 * Returns the canonical `protocol//host` origin — never the raw value. A
 * misconfigured value like `https://host/path-prefix` or
 * `https://user:pass@host` would otherwise silently bleed path/userinfo into
 * every outbound request (and the userinfo form would leak credentials in
 * each fetch's `Authorization`-adjacent metadata). Always returning the
 * parsed origin closes both classes of injection.
 *
 * Failure mapping (controller `mapError`):
 *   - Missing/invalid/non-https → throws ErrorWithStatusCode(503,
 *     'configurationError'): operational failure, not a runtime bug.
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

/**
 * Builds the outbound auth header. The Adobe-hosted Semrush gateway
 * authenticates via the caller's IMS bearer token; the cookie / Auth-Data-Jwt
 * branches that existed on feat/prompts-management are deliberately removed.
 */
function buildHeaders(imsToken) {
  if (!hasText(imsToken)) {
    throw new SerenityTransportError(
      401,
      'Missing IMS bearer token for Semrush transport',
    );
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

async function request(method, url, imsToken, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const init = {
    method,
    headers: buildHeaders(imsToken),
    signal: controller.signal,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new SerenityTransportError(
        504,
        `Semrush ${method} ${url} timed out after ${timeoutMs}ms`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const parsed = await parseBody(response);
  if (!response.ok) {
    throw new SerenityTransportError(
      response.status,
      `Semrush ${method} ${url} failed: ${response.status}`,
      parsed,
    );
  }
  return parsed;
}

// All path-segment interpolations route through encodeURIComponent so a
// caller-supplied id containing reserved URL chars can't break out of the
// expected segment. UUIDs are safe by construction today but the policy
// applies uniformly.
function enc(segment) {
  return encodeURIComponent(String(segment ?? ''));
}

function aioPromptsPath(workspaceId, projectId, suffix) {
  return `${API_PREFIX}/v2/workspaces/${enc(workspaceId)}/projects/${enc(projectId)}/aio/prompts${suffix}`;
}

/**
 * Creates the Semrush HTTP client. Each request is authenticated with the
 * caller's IMS bearer token; the Adobe gateway exchanges it server-side for
 * Semrush's internal credential.
 *
 * @param {object} args
 * @param {object} args.env - Environment (reads SEMRUSH_PROJECTS_BASE_URL override).
 * @param {string} args.imsToken - IMS user bearer token (without 'Bearer ' prefix).
 */
export function createSerenityTransport({ env, imsToken }) {
  const root = baseUrl(env);

  return {
    /**
     * POST /v2/.../aio/prompts/by_tags — paginated list of prompts in a
     * project. Pass an empty `tag_ids` array to list all prompts.
     *
     * Note: Semrush rejects `sort_field` / `sort_dir` on this endpoint (see
     * commit history on the prior `serenity` handler). Body is restricted to
     * the fields the upstream documents as accepted.
     */
    async listPromptsByTags(workspaceId, projectId, body) {
      const url = `${root}${aioPromptsPath(workspaceId, projectId, '/by_tags')}`;
      return request('POST', url, imsToken, {
        tag_ids: body?.tag_ids ?? [],
        page: body?.page ?? 1,
        limit: body?.limit ?? 200,
        search: body?.search,
        unassigned: body?.unassigned,
      });
    },

    /**
     * POST /v2/.../aio/prompts/tagged — creates prompts grouped by tag names.
     * Body shape: { prompts: { [tagName]: [promptText, ...] } }.
     */
    async createTaggedPrompts(workspaceId, projectId, promptsByTag) {
      const url = `${root}${aioPromptsPath(workspaceId, projectId, '/tagged')}`;
      return request('POST', url, imsToken, { prompts: promptsByTag });
    },

    /**
     * DELETE /v2/.../aio/prompts — deletes prompts by their Semrush ids in
     * this project. Body shape: { ids: [...] }.
     */
    async deletePromptsByIds(workspaceId, projectId, ids) {
      const url = `${root}${aioPromptsPath(workspaceId, projectId, '')}`;
      return request('DELETE', url, imsToken, { ids });
    },

    /**
     * POST /v1/workspaces/{ws}/projects/{pid}/publish — moves draft state to
     * live. Semrush publishes asynchronously; mutations land in draft until
     * this is called.
     */
    async publishProject(workspaceId, projectId) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${enc(workspaceId)}/projects/${enc(projectId)}/publish`;
      return request('POST', url, imsToken, undefined);
    },

    /**
     * GET /v2/workspaces/{ws}/projects?type=AIO&publish_status=live,…
     * Lists published AIO projects in a workspace. Drafts and failed
     * publishes are omitted. Paginated — yields the full set across pages.
     */
    async listWorkspaceProjects(workspaceId, { page = 1, limit = 100 } = {}) {
      const params = new URLSearchParams({
        type: 'AIO',
        publish_status: 'live,live_with_unpublished_updates',
        page: String(page),
        limit: String(limit),
      });
      const url = `${root}${API_PREFIX}/v2/workspaces/${enc(workspaceId)}/projects?${params.toString()}`;
      return request('GET', url, imsToken, undefined);
    },

    /**
     * GET /v1/workspaces/{ws}/projects/{pid}/ai_models — list AI models
     * configured for a project. `model.key` is the value the Reporting API
     * expects as `CBF_model`.
     */
    async listAiModels(workspaceId, projectId, { page = 1, limit = 100 } = {}) {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      const url = `${root}${API_PREFIX}/v1/workspaces/${enc(workspaceId)}/projects/${enc(projectId)}/ai_models?${params.toString()}`;
      return request('GET', url, imsToken, undefined);
    },

    /**
     * POST /v1/workspaces/{ws}/projects — creates a new Semrush AIO project.
     */
    async createProject(workspaceId, body) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${enc(workspaceId)}/projects`;
      return request('POST', url, imsToken, body);
    },

    /**
     * GET /v1/languages — returns Semrush's language catalog. Used to resolve
     * the language_id UUID from an ISO 639-1 code (e.g. 'en' → UUID). The
     * caller is expected to cache the result (catalog is stable).
     */
    async listLanguages() {
      const url = `${root}${API_PREFIX}/v1/languages`;
      return request('GET', url, imsToken, undefined);
    },
  };
}
