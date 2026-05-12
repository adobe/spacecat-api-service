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

function buildHeaders(imsToken) {
  if (!hasText(imsToken)) {
    throw new SerenityTransportError(401, 'Missing IMS bearer token for Semrush passthrough');
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

async function request(method, url, imsToken, body) {
  const init = {
    method,
    headers: buildHeaders(imsToken),
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
      return request('POST', url, imsToken, {
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
      return request('POST', url, imsToken, { prompts: promptsByTag });
    },

    /**
     * DELETE /v2/.../aio/prompts — deletes prompts by their Semrush IDs in
     * this project. Body shape: { ids: [...] }. Returns 204 No Content.
     */
    async deletePromptsByIds(workspaceId, projectId, ids) {
      const url = `${root}${projectPath(workspaceId, projectId, '')}`;
      return request('DELETE', url, imsToken, { ids });
    },
  };
}
