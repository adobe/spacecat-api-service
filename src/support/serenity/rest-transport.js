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

const DEFAULT_BASE_URL = 'https://www.semrush.com';
const API_PREFIX = '/enterprise/projects/api';
// Default UA matches the Python tooling — Semrush's edge will 403 a Node-style UA.
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class SerenityTransportError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'SerenityTransportError';
    this.status = status;
    this.body = body;
  }
}

function baseUrl(env) {
  return (env?.SEMRUSH_PROJECTS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

/**
 * Two auth modes. When `SEMRUSH_COOKIE` is configured the proxy forwards a
 * shared logged-in browser session (containing `sso_token`); Semrush's edge
 * translates it into the `Auth-Data-Jwt` the backend wants. Otherwise we
 * pass the caller's IMS bearer through unchanged.
 *
 * The cookie mode mirrors the auth in `feat-serenity/.../semrush_*.py` and is
 * the hackathon-friendly path until Adobe ↔ Semrush IMS trust is in place.
 */
function buildHeaders(env, imsToken) {
  const cookie = (env?.SEMRUSH_COOKIE || '').trim();
  if (cookie) {
    return {
      Cookie: cookie,
      'User-Agent': env?.SEMRUSH_USER_AGENT || DEFAULT_USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }
  if (!hasText(imsToken)) {
    throw new SerenityTransportError(
      401,
      'Missing IMS bearer token and SEMRUSH_COOKIE is not configured',
    );
  }
  return {
    'Auth-Data-Jwt': imsToken,
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

async function request(method, url, env, imsToken, body) {
  const init = {
    method,
    headers: buildHeaders(env, imsToken),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
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

function projectPath(workspaceId, projectId, suffix) {
  return `${API_PREFIX}/v2/workspaces/${workspaceId}/projects/${projectId}/aio/prompts${suffix}`;
}

export function createSerenityTransport({ env, imsToken }) {
  const root = baseUrl(env);

  return {
    /**
     * POST /v2/.../aio/prompts/by_tags — paginated list of prompts in a
     * project. Pass an empty `tag_ids` array to list all prompts. Returns
     * `{ items: [{id, name, tags: [...]}], page, total }`.
     */
    async listPromptsByTags(workspaceId, projectId, body) {
      const url = `${root}${projectPath(workspaceId, projectId, '/by_tags')}`;
      return request('POST', url, env, imsToken, {
        tag_ids: body?.tag_ids ?? [],
        page: body?.page ?? 1,
        limit: body?.limit ?? 200,
        search: body?.search,
        sort_field: body?.sort_field,
        sort_dir: body?.sort_dir,
        unassigned: body?.unassigned,
      });
    },

    /**
     * POST /v2/.../aio/prompts/tagged — creates prompts grouped by tag names.
     * Body shape: { prompts: { [tagName]: [promptText, ...] } }.
     * Response: { ids: [...], existing_count }.
     */
    async createTaggedPrompts(workspaceId, projectId, promptsByTag) {
      const url = `${root}${projectPath(workspaceId, projectId, '/tagged')}`;
      return request('POST', url, env, imsToken, { prompts: promptsByTag });
    },

    /**
     * DELETE /v2/.../aio/prompts — deletes prompts by their Semrush IDs in
     * this project. Body shape: { ids: [...] }. Returns 204 No Content.
     */
    async deletePromptsByIds(workspaceId, projectId, ids) {
      const url = `${root}${projectPath(workspaceId, projectId, '')}`;
      return request('DELETE', url, env, imsToken, { ids });
    },

    /**
     * POST /v1/workspaces/{ws}/projects/{pid}/publish — moves the project's
     * draft state to live. Semrush returns 202 Accepted and publishes
     * asynchronously; mutations (create/update/delete) land in draft until
     * this is called, which is why the UI count lagged behind Semrush's.
     */
    async publishProject(workspaceId, projectId) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${workspaceId}/projects/${projectId}/publish`;
      return request('POST', url, env, imsToken, undefined);
    },
  };
}
