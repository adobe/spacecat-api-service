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
// Workspace lifecycle (create subworkspace / status / family / resources / members)
// is served by a DIFFERENT gateway service than project ops — the
// "user-manager" API under /enterprise/users/api (verified live 2026-06-15
// against the dev parent; the project prefix 404s these routes). Project ops
// stay on API_PREFIX above.
const USERS_API_PREFIX = '/enterprise/users/api';
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

function aioPromptsPath(semrushWorkspaceId, projectId, suffix) {
  return `${API_PREFIX}/v2/workspaces/${enc(semrushWorkspaceId)}/projects/${enc(projectId)}/aio/prompts${suffix}`;
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

  // Fail-closed guard for the destructive workspace delete. Deleting a
  // sub-workspace must be IMPOSSIBLE in every deployed environment
  // (dev/stage/prod) — production decommission empties and releases a
  // workspace but never deletes it (design §6); upstream deprovisioning is
  // Semrush CS's act. The capability is retained only so the net-zero live
  // smoke can tidy up after itself, and is unlocked solely by this explicit
  // opt-in flag, which no deployed environment sets (local test-cleanup only).
  const allowWorkspaceDelete = env?.SERENITY_ALLOW_WORKSPACE_DELETE === 'true';

  return {
    /**
     * POST /v2/.../aio/prompts/by_tags — paginated list of prompts in a
     * project. Pass an empty `tag_ids` array to list all prompts.
     * Multiple tag IDs use OR semantics: any prompt carrying at least one of
     * the supplied IDs is included. AND filtering must be done by the caller.
     *
     * Note: Semrush rejects `sort_field` / `sort_dir` on this endpoint (see
     * commit history on the prior `serenity` handler). Body is restricted to
     * the fields the upstream documents as accepted.
     */
    async listPromptsByTags(semrushWorkspaceId, projectId, body) {
      const url = `${root}${aioPromptsPath(semrushWorkspaceId, projectId, '/by_tags')}`;
      return request('POST', url, imsToken, {
        tag_ids: body?.tag_ids ?? [],
        page: body?.page ?? 1,
        limit: body?.limit ?? 200,
        search: body?.search,
        unassigned: body?.unassigned,
      });
    },

    /**
     * POST /v2/.../aio/prompts/tagged — bulk-creates prompts with their tags.
     * Body shape: { prompts: { [promptText]: [tagName, ...] } } — keyed by
     * prompt text, each value the list of tag names to attach. Both flat and
     * subworkspace callers send this same prompt-text-keyed shape; `promptsByTag`
     * is a legacy parameter name kept for continuity, not an indication of the
     * key.
     */
    async createTaggedPrompts(semrushWorkspaceId, projectId, promptsByTag) {
      const url = `${root}${aioPromptsPath(semrushWorkspaceId, projectId, '/tagged')}`;
      return request('POST', url, imsToken, { prompts: promptsByTag });
    },

    /**
     * DELETE /v2/.../aio/prompts — deletes prompts by their Semrush ids in
     * this project. Body shape: { ids: [...] }.
     */
    async deletePromptsByIds(semrushWorkspaceId, projectId, ids) {
      const url = `${root}${aioPromptsPath(semrushWorkspaceId, projectId, '')}`;
      return request('DELETE', url, imsToken, { ids });
    },

    /**
     * POST /v1/workspaces/{ws}/projects/{pid}/publish — moves draft state to
     * live. Semrush publishes asynchronously; mutations land in draft until
     * this is called.
     */
    async publishProject(semrushWorkspaceId, projectId) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${enc(semrushWorkspaceId)}/projects/${enc(projectId)}/publish`;
      return request('POST', url, imsToken, undefined);
    },

    /**
     * GET /v1/workspaces/{ws}/projects/{pid}/ai_models — list AI models
     * configured for a project. `model.key` is the value the Reporting API
     * expects as `CBF_model`.
     */
    async listAiModels(semrushWorkspaceId, projectId, { page = 1, limit = 100 } = {}) {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      const url = `${root}${API_PREFIX}/v1/workspaces/${enc(semrushWorkspaceId)}/projects/${enc(projectId)}/ai_models?${params.toString()}`;
      return request('GET', url, imsToken, undefined);
    },

    /**
     * POST /v1/workspaces/{ws}/projects — creates a new Semrush AIO project.
     */
    async createProject(semrushWorkspaceId, body) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${enc(semrushWorkspaceId)}/projects`;
      return request('POST', url, imsToken, body);
    },

    /**
     * DELETE /v1/workspaces/{ws}/projects/{pid} — removes an upstream
     * project. Upstream support verified 2026-05-28 against
     * adobe-hackathon.semrush.com:
     *
     *   OPTIONS /v1/workspaces/{ws}/projects/{pid} → 405, allow: DELETE, GET, PATCH
     *   DELETE  /v1/workspaces/{ws}/projects/<bogus> → 404 {"message":"not found"}
     *
     * Callers (handleDeleteMarket) treat upstream 404 as idempotent success.
     */
    async deleteProject(semrushWorkspaceId, projectId) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${enc(semrushWorkspaceId)}/projects/${enc(projectId)}`;
      return request('DELETE', url, imsToken, undefined);
    },

    /**
     * POST /v1/workspaces/{ws}/projects/{pid}/ai_models — adds one AI model
     * to a project. `modelId` is the catalog model identifier from
     * `AIModelResponse.id` on the GET listing. Returns the new assignment row.
     */
    async addAiModel(semrushWorkspaceId, projectId, modelId) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${enc(semrushWorkspaceId)}/projects/${enc(projectId)}/ai_models`;
      return request('POST', url, imsToken, { model_id: modelId });
    },

    /**
     * DELETE /v1/workspaces/{ws}/projects/{pid}/ai_models — removes AI model
     * assignments by their assignment ids (the outer `id` on
     * `ProjectAIModelResponse`, NOT the catalog `model.id`).
     */
    async deleteAiModelsByIds(semrushWorkspaceId, projectId, ids) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${enc(semrushWorkspaceId)}/projects/${enc(projectId)}/ai_models`;
      return request('DELETE', url, imsToken, { ids });
    },

    /**
     * GET /v1/ai_models — global catalog of all AI models available for
     * tracking across any workspace. Not scoped to a workspace or project.
     * Used to populate the "available models" list in the UI.
     * Returns {page, total, items: [{id, key, name, icon}]}.
     */
    async listGlobalAiModels({ page = 1, limit = 100 } = {}) {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      const url = `${root}${API_PREFIX}/v1/ai_models?${params.toString()}`;
      return request('GET', url, imsToken, undefined);
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

    // ─────────────────────────────────────────────────────────────────────
    // Sub-workspace lifecycle (serenity dual-mode, subworkspace path).
    //
    // These are thin URL+verb wrappers, deliberately colocated with the
    // project ops so the later swap to the typed sub-workspace-API client is
    // mechanical (call sites don't change, only these internals). Behaviour
    // pins live in serenity-docs brand-semrush-workspace-provisioning-details
    // §4/§5/§7 and the design's §6 error classification (see errors.js).
    // ─────────────────────────────────────────────────────────────────────

    /**
     * POST /v2/workspaces/{parent}/child — create a brand's child (sub-)workspace
     * under the parent. The route is `/child`, NOT `/subworkspace` (the latter is
     * unrouted and returns a bare gateway 404; `/child` returns 405 to GET/OPTIONS,
     * confirming a POST-only route — verified live 2026-06-16 against the LLMO-Dev-2
     * parent). v2 takes NO `X-Upload-Receipt` header (v1-only); tier/products
     * inherit from the parent. The new workspace settles `not ready → created` in
     * seconds; poll getWorkspaceStatus before creating projects against it.
     */
    async createSubworkspace(parentWorkspaceId, title, resources) {
      const url = `${root}${USERS_API_PREFIX}/v2/workspaces/${enc(parentWorkspaceId)}/child`;
      return request('POST', url, imsToken, { title, resources });
    },

    /**
     * GET /v1/workspaces/{ws}/status — poll until `created` after a subworkspace
     * create (creating projects against `not ready` can 500).
     */
    async getWorkspaceStatus(workspaceId) {
      const url = `${root}${USERS_API_PREFIX}/v1/workspaces/${enc(workspaceId)}/status`;
      return request('GET', url, imsToken, undefined);
    },

    /**
     * GET /v1/workspaces/{parent}/family — list the parent's sub-workspaces
     * (and nested sub-workspaces). Used for ambiguous-create recovery: on a
     * timed-out create, match the exact title and adopt a `created`,
     * project-empty sub-workspace (design §6).
     */
    async listWorkspaceFamily(parentWorkspaceId) {
      const url = `${root}${USERS_API_PREFIX}/v1/workspaces/${enc(parentWorkspaceId)}/family`;
      return request('GET', url, imsToken, undefined);
    },

    /**
     * POST /v1/workspaces/{ws}/resources/transfer — grant an allocation onto a
     * subworkspace (activation / re-grant) and release it back to the parent pool
     * (decommission). A public user-token endpoint (workspace doc §5/§7). The
     * exact payload shape is pinned by the Gate-A live smoke.
     */
    async transferWorkspaceResources(workspaceId, payload) {
      const url = `${root}${USERS_API_PREFIX}/v1/workspaces/${enc(workspaceId)}/resources/transfer`;
      return request('POST', url, imsToken, payload);
    },

    /**
     * DELETE /v1/workspaces/{ws} — TEST CLEANUP ONLY, and fail-closed: throws
     * unless SERENITY_ALLOW_WORKSPACE_DELETE === 'true' is set in the env, which
     * no deployed environment (dev/stage/prod) does. Production flows NEVER
     * delete sub-workspaces (decommission empties and disconnects them but
     * never deletes — design §6); workspace deprovisioning at offboarding is
     * Semrush CS's act. Kept here so the
     * net-zero live smoke can tidy up after itself. Delete cascades over the
     * workspace's projects; subsequent reads return 403 (workspace doc §4).
     */
    async deleteWorkspace(workspaceId) {
      if (!allowWorkspaceDelete) {
        throw new Error(
          'Serenity workspace deletion is disabled. It is test-cleanup only and '
          + 'must never run in a deployed environment; set '
          + 'SERENITY_ALLOW_WORKSPACE_DELETE=true to enable it locally.',
        );
      }
      const url = `${root}${USERS_API_PREFIX}/v1/workspaces/${enc(workspaceId)}`;
      return request('DELETE', url, imsToken, undefined);
    },

    /**
     * GET /v1/workspaces/{ws}/projects?type=ai — the v1 DEFAULT view, the only
     * draft-faithful listing (workspace doc §6/§10 V1). The `type=ai` query is
     * REQUIRED (verified live 2026-06-15: omitting it 500s; the v2 list 400s
     * with "type query parameter is required"). Subworkspace mode enumerates a brand's
     * markets from this; never the v2 list for draft settings (v2 returns a
     * live-view shape with `brand_names: null` for drafts).
     */
    async listProjects(workspaceId) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${enc(workspaceId)}/projects?type=ai`;
      return request('GET', url, imsToken, undefined);
    },

    /**
     * GET /v1/workspaces/{ws}/projects/{pid}/aio/init_status — AIO readiness
     * for a live project (`{ initialized: bool }`). Surfaced on the single
     * market-detail read only, never per-item in the list (would be N+1).
     */
    async getInitStatus(workspaceId, projectId) {
      const url = `${root}${API_PREFIX}/v1/workspaces/${enc(workspaceId)}/projects/${enc(projectId)}/aio/init_status`;
      return request('GET', url, imsToken, undefined);
    },
  };
}
