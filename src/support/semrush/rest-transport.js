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

const DEFAULT_BASE_URL = 'https://adobe-hackathon.semrush.com';
const API_PREFIX = '/enterprise/projects/api';

/**
 * Error thrown when the Semrush upstream returns a non-2xx response or refuses
 * the auth header. `status` carries the upstream status; `body` is the parsed
 * JSON (or raw text when not valid JSON).
 */
export class SemrushTransportError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'SemrushTransportError';
    this.status = status;
    this.body = body;
  }
}

function baseUrl(env) {
  return (env?.SEMRUSH_PROJECTS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

/**
 * Builds the outbound auth header. The Adobe-hosted Semrush gateway
 * authenticates via the caller's IMS bearer token; the cookie / Auth-Data-Jwt
 * branches that existed on feat/prompts-management are deliberately removed.
 */
function buildHeaders(imsToken) {
  if (!hasText(imsToken)) {
    throw new SemrushTransportError(
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
    throw new SemrushTransportError(
      response.status,
      `Semrush ${method} ${url} failed: ${response.status}`,
      parsed,
    );
  }
  return parsed;
}

function aioPromptsPath(workspaceId, projectId, suffix) {
  return `${API_PREFIX}/v2/workspaces/${workspaceId}/projects/${projectId}/aio/prompts${suffix}`;
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
export function createSemrushTransport({ env, imsToken }) {
  const root = baseUrl(env);

  return {
    /**
     * POST /v2/.../aio/prompts/by_tags — paginated list of prompts in a
     * project. Pass an empty `tag_ids` array to list all prompts.
     */
    async listPromptsByTags(workspaceId, projectId, body) {
      const url = `${root}${aioPromptsPath(workspaceId, projectId, '/by_tags')}`;
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
      const url = `${root}${API_PREFIX}/v1/workspaces/${workspaceId}/projects/${projectId}/publish`;
      return request('POST', url, imsToken, undefined);
    },

    /**
     * GET /v2/workspaces/{ws}/projects?type=AIO&publish_status=live,…
     * Lists published AIO projects in a workspace. Drafts and failed
     * publishes are omitted.
     */
    async listWorkspaceProjects(workspaceId) {
      const params = new URLSearchParams({
        type: 'AIO',
        publish_status: 'live,live_with_unpublished_updates',
        limit: '100',
      });
      const url = `${root}${API_PREFIX}/v2/workspaces/${workspaceId}/projects?${params.toString()}`;
      return request('GET', url, imsToken, undefined);
    },

    /**
     * GET /v1/workspaces/{ws}/projects/{pid}/ai_models — list AI models
     * configured for a project. `model.key` is the value the Reporting API
     * expects as `CBF_model`.
     */
    async listAiModels(workspaceId, projectId) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${workspaceId}/projects/${projectId}/ai_models?limit=100`;
      return request('GET', url, imsToken, undefined);
    },

    /**
     * POST /v1/workspaces/{ws}/projects — creates a new Semrush AIO project.
     * Body shape mirrors the model.ProjectRequest shape documented in
     * Semrush's public_swagger.json (see scripts/serenity/semrush_create_projects.py
     * for the field-by-field reference):
     *   { name, type: 'aio', brand_name_display, brand_names, domain,
     *     country_code, location_id, location_name, language_id }
     */
    async createProject(workspaceId, body) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${workspaceId}/projects`;
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
