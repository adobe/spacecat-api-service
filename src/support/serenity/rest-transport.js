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

// @ts-check

import { hasText } from '@adobe/spacecat-shared-utils';
import { createSerenityProjectEngineApiClient } from '@adobe/spacecat-shared-project-engine-client';
import { createSerenityUserManagerApiClient } from '@adobe/spacecat-shared-user-manager-client';
import { ErrorWithStatusCode } from '../utils.js';
// Two typed Semrush clients back this transport, each owning its own gateway
// prefix, IMS-Bearer auth, and request shaping:
//  - Project Engine ('/enterprise/projects/api') — project / prompt / benchmark ops.
//  - User Manager   ('/enterprise/users/api')    — sub-workspace lifecycle
//    (create child / status / family / resources transfer / delete). A DIFFERENT
//    gateway than project ops (verified live 2026-06-15: the project prefix 404s
//    these routes); the typed client appends the prefix internally.
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
 * Returns a client-safe message for an error that may be a SerenityTransportError.
 * A SerenityTransportError's message embeds the gateway URL (internal host +
 * workspace/project UUIDs), so it must never be echoed to clients (response
 * bodies, per-item `failed[].message`). App-level errors carry safe messages and
 * pass through unchanged.
 */
export function redactUpstreamMessage(e) {
  if (e instanceof SerenityTransportError) {
    return (e.status === 401 || e.status === 403)
      ? 'Upstream authorization failed'
      : 'Upstream request failed';
  }
  return e?.message;
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
 * Wraps global fetch with the transport's 15s ceiling and the
 * `Accept: application/json` header sent on every call — neither of which the
 * typed client imposes itself. An abort maps to the same 504
 * SerenityTransportError the hand-rolled user-manager path raises. openapi-fetch
 * invokes this with a `Request` object as `input`; the timeout signal is applied
 * via the `init` argument (which fetch honours even for a Request input).
 */
function createTimeoutFetch(timeoutMs) {
  return async function timeoutFetch(input, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (input instanceof Request && !input.headers.has('Accept')) {
      input.headers.set('Accept', 'application/json');
    }
    try {
      return await fetch(input, { ...(init ?? {}), signal: controller.signal });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new SerenityTransportError(
          504,
          `Semrush request timed out after ${timeoutMs}ms`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Translates an openapi-fetch result `{ data, error, response }` into the
 * transport's throw-or-return contract. The typed client never throws on an HTTP
 * error — it returns the parsed error body in `error` and the raw `response`. A
 * non-2xx becomes a SerenityTransportError (upstream status + parsed body, kept
 * for server-side logging and redacted for clients by the controller's
 * mapError); a 2xx returns the parsed body (or null for an empty body), matching
 * the previous hand-rolled `request()` return shape exactly.
 */
function unwrap(method, result) {
  // openapi-fetch always resolves to `{ data, error, response }` with a real
  // `response` — a thrown fetch/auth error propagates before unwrap is reached —
  // so `response` is accessed directly rather than defensively.
  const { data, error, response } = result;
  if (!response.ok) {
    // openapi-fetch surfaces an empty error body as '' (not undefined); normalise
    // it to null so `.body` matches the previous hand-rolled `request()` shape
    // (which returned null for an empty body).
    const body = error ?? data ?? null;
    throw new SerenityTransportError(
      response.status,
      `Semrush ${method} ${response.url} failed: ${response.status}`,
      body === '' ? null : body,
    );
  }
  return data ?? null;
}

/**
 * Creates the Semrush HTTP client. Each request is authenticated with the
 * caller's IMS bearer token; the Adobe gateway exchanges it server-side for
 * Semrush's internal credential.
 *
 * Project-API operations are issued through the vendored typed Project Engine
 * client; the sub-workspace lifecycle operations remain hand-rolled against the
 * separate user-manager gateway.
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

  // Shared IMS-bearer getter for both typed clients. Raises the transport's own
  // 401 on a missing token (instead of the client's generic empty-token error)
  // so the controller's mapError keeps classifying it as an auth failure.
  const authToken = () => {
    if (!hasText(imsToken)) {
      throw new SerenityTransportError(
        401,
        'Missing IMS bearer token for Semrush transport',
      );
    }
    return imsToken;
  };

  // Typed Project Engine client over the project gateway. maxRetries:0 preserves
  // the one-shot behaviour the hand-rolled transport had; the injected fetch
  // re-adds the 15s timeout + Accept header the client does not impose. `root` is
  // the validated origin; the client appends its own '/enterprise/projects/api'
  // prefix.
  const projects = createSerenityProjectEngineApiClient({
    baseUrl: root,
    authToken,
    maxRetries: 0,
    fetch: createTimeoutFetch(DEFAULT_TIMEOUT_MS),
  });

  // Typed User Manager client over the sub-workspace lifecycle gateway. Same
  // shape as the project client; appends its own '/enterprise/users/api' prefix.
  const users = createSerenityUserManagerApiClient({
    baseUrl: root,
    authToken,
    maxRetries: 0,
    fetch: createTimeoutFetch(DEFAULT_TIMEOUT_MS),
  });

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
      return unwrap('POST', await projects.POST(
        '/v2/workspaces/{id}/projects/{project_id}/aio/prompts/by_tags',
        {
          params: { path: { id: semrushWorkspaceId, project_id: projectId } },
          body: {
            tag_ids: body?.tag_ids ?? [],
            page: body?.page ?? 1,
            limit: body?.limit ?? 200,
            search: body?.search,
            unassigned: body?.unassigned,
          },
        },
      ));
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
      return unwrap('POST', await projects.POST(
        '/v2/workspaces/{id}/projects/{project_id}/aio/prompts/tagged',
        {
          params: { path: { id: semrushWorkspaceId, project_id: projectId } },
          body: { prompts: promptsByTag },
        },
      ));
    },

    /**
     * DELETE /v2/.../aio/prompts — deletes prompts by their Semrush ids in
     * this project. Body shape: { ids: [...] }.
     */
    async deletePromptsByIds(semrushWorkspaceId, projectId, ids) {
      return unwrap('DELETE', await projects.DELETE(
        '/v2/workspaces/{id}/projects/{project_id}/aio/prompts',
        {
          params: { path: { id: semrushWorkspaceId, project_id: projectId } },
          body: { ids },
        },
      ));
    },

    /**
     * POST /v1/workspaces/{ws}/projects/{pid}/publish — moves draft state to
     * live. Semrush publishes asynchronously; mutations land in draft until
     * this is called.
     */
    async publishProject(semrushWorkspaceId, projectId) {
      return unwrap('POST', await projects.POST(
        '/v1/workspaces/{id}/projects/{project_id}/publish',
        { params: { path: { id: semrushWorkspaceId, project_id: projectId } } },
      ));
    },

    /**
     * GET /v1/workspaces/{ws}/projects/{pid}/ai_models — list AI models
     * configured for a project. `model.key` is the value the Reporting API
     * expects as `CBF_model`.
     */
    async listAiModels(semrushWorkspaceId, projectId, { page = 1, limit = 100 } = {}) {
      return unwrap('GET', await projects.GET(
        '/v1/workspaces/{id}/projects/{project_id}/ai_models',
        {
          params: {
            path: { id: semrushWorkspaceId, project_id: projectId },
            query: { page, limit },
          },
        },
      ));
    },

    /**
     * GET /v1/workspaces/{ws}/brand-topics?domain=&country= — generates the top
     * brand topics (with up to 100 prompt strings each) for a domain + market,
     * fetched live from the AI-SEO service. Workspace-scoped, NOT project-scoped.
     * Returns an array of `{ topic, volume, prompts: string[] }`. Used at
     * brand-create to seed the new project's prompts (tagged `topic:<NAME>`).
     */
    async getBrandTopics(semrushWorkspaceId, { domain, country }) {
      return unwrap('GET', await projects.GET(
        '/v1/workspaces/{id}/brand-topics',
        {
          params: {
            path: { id: semrushWorkspaceId },
            query: { domain: String(domain ?? ''), country: String(country ?? '') },
          },
        },
      ));
    },

    /**
     * POST /v2/workspaces/{ws}/projects/{pid}/aio/tags — creates project-level
     * AIO tags (the standard taxonomy: intent/source/type) independent of any
     * prompt. Body shape: { names: string[] } (model.TreeNodeListRequest; flat —
     * `parent_id` omitted). Tags already attached to prompts are reused by name,
     * so pre-creating a tag that a later prompt also carries does not duplicate.
     */
    async createProjectTags(semrushWorkspaceId, projectId, names) {
      return unwrap('POST', await projects.POST(
        '/v2/workspaces/{id}/projects/{project_id}/aio/tags',
        {
          params: { path: { id: semrushWorkspaceId, project_id: projectId } },
          body: { names },
        },
      ));
    },

    /**
     * POST /v1/workspaces/{ws}/projects — creates a new Semrush AIO project.
     */
    async createProject(semrushWorkspaceId, body) {
      return unwrap('POST', await projects.POST(
        '/v1/workspaces/{id}/projects',
        { params: { path: { id: semrushWorkspaceId } }, body },
      ));
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
      return unwrap('DELETE', await projects.DELETE(
        '/v1/workspaces/{id}/projects/{project_id}',
        { params: { path: { id: semrushWorkspaceId, project_id: projectId } } },
      ));
    },

    /**
     * PATCH /v1/workspaces/{ws}/projects/{pid} — partial project update
     * (projects-patch-project). Body is a `model.ProjectUpdateRequest`; we use it
     * to re-sync the project's own-brand identity — `brand_name_display` +
     * `brand_names` (the display name and brand aliases that classify branded
     * prompts) — when a brand's aliases change. Upstream PATCH confirmed live on
     * prod 2026-06-24 (OPTIONS .../projects/{pid} → 405 allow: PATCH, DELETE, GET).
     */
    async updateProject(semrushWorkspaceId, projectId, body) {
      return unwrap('PATCH', await projects.PATCH(
        '/v1/workspaces/{id}/projects/{project_id}',
        {
          params: { path: { id: semrushWorkspaceId, project_id: projectId } },
          body,
        },
      ));
    },

    /**
     * POST /v2/workspaces/{ws}/projects/{pid}/ai_models — adds one AI model
     * to a project. `modelId` is the catalog model identifier from
     * `AIModelResponse.id` on the GET listing. Returns the new assignment row.
     * V2: identical request (CreateProjectAIModelRequest `{ model_id }`) and
     * response (ProjectAIModelResponse) to the v1 route, so it is a drop-in —
     * matching the createBenchmarks v2 move. The sibling list/delete ai_models
     * routes have no v2 variant (v2 ai_models is POST-only) and stay on v1.
     */
    async addAiModel(semrushWorkspaceId, projectId, modelId) {
      return unwrap('POST', await projects.POST(
        '/v2/workspaces/{id}/projects/{project_id}/ai_models',
        {
          params: { path: { id: semrushWorkspaceId, project_id: projectId } },
          body: { model_id: modelId },
        },
      ));
    },

    /**
     * DELETE /v1/workspaces/{ws}/projects/{pid}/ai_models — removes AI model
     * assignments by their assignment ids (the outer `id` on
     * `ProjectAIModelResponse`, NOT the catalog `model.id`).
     */
    async deleteAiModelsByIds(semrushWorkspaceId, projectId, ids) {
      return unwrap('DELETE', await projects.DELETE(
        '/v1/workspaces/{id}/projects/{project_id}/ai_models',
        {
          params: { path: { id: semrushWorkspaceId, project_id: projectId } },
          body: { ids },
        },
      ));
    },

    /**
     * GET /v1/ai_models — global catalog of all AI models available for
     * tracking across any workspace. Not scoped to a workspace or project.
     * Used to populate the "available models" list in the UI.
     * Returns {page, total, items: [{id, key, name, icon}]}.
     */
    async listGlobalAiModels({ page = 1, limit = 100 } = {}) {
      return unwrap('GET', await projects.GET(
        '/v1/ai_models',
        { params: { query: { page, limit } } },
      ));
    },

    /**
     * GET /v1/languages — returns Semrush's language catalog. Used to resolve
     * the language_id UUID from an ISO 639-1 code (e.g. 'en' → UUID). The
     * caller is expected to cache the result (catalog is stable).
     */
    async listLanguages() {
      return unwrap('GET', await projects.GET('/v1/languages', {}));
    },

    // ─────────────────────────────────────────────────────────────────────
    // Sub-workspace lifecycle (serenity dual-mode, subworkspace path).
    //
    // Routed through the typed User Manager client (`users`) against the SEPARATE
    // user-manager gateway. Behaviour pins live in serenity-docs
    // brand-semrush-workspace-provisioning-details §4/§5/§7 and the design's §6
    // error classification (see errors.js).
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
      return unwrap('POST', await users.POST(
        '/v2/workspaces/{id}/child',
        { params: { path: { id: parentWorkspaceId } }, body: { title, resources } },
      ));
    },

    /**
     * GET /v1/workspaces/{ws}/status — poll until `created` after a subworkspace
     * create (creating projects against `not ready` can 500).
     */
    async getWorkspaceStatus(workspaceId) {
      return unwrap('GET', await users.GET(
        '/v1/workspaces/{id}/status',
        { params: { path: { id: workspaceId } } },
      ));
    },

    /**
     * GET /v1/workspaces/{parent}/family — list the parent's sub-workspaces
     * (and nested sub-workspaces). Used for ambiguous-create recovery: on a
     * timed-out create, match the exact title and adopt a `created`,
     * project-empty sub-workspace (design §6).
     */
    async listWorkspaceFamily(parentWorkspaceId) {
      return unwrap('GET', await users.GET(
        '/v1/workspaces/{id}/family',
        { params: { path: { id: parentWorkspaceId } } },
      ));
    },

    /**
     * POST /v2/workspaces/{ws}/resources/transfer — grant an allocation onto a
     * subworkspace (activation / re-grant) and release it back to the parent pool
     * (decommission). A public user-token endpoint (workspace doc §5/§7).
     * V2 wraps the resources under a `resources` key (WorkspaceResourcesTransferV2Form
     * → createWorkspaceV2Resources); `payload` is the bare resources object
     * (`{ ai: { projects, prompts } }`, the aiProductResources shape), so wrap it
     * here. That `ai` shape is the SAME one already proven live as the v2 child-create
     * `resources` body (createSubworkspace), so this is contract-compatible — the v1
     * route's documented body (flat WorkspaceResources, no `ai` key) never matched
     * what we send. The exact allocation values remain a Gate-A live-smoke pin.
     */
    async transferWorkspaceResources(workspaceId, payload) {
      return unwrap('POST', await users.POST(
        '/v2/workspaces/{id}/resources/transfer',
        { params: { path: { id: workspaceId } }, body: { resources: payload } },
      ));
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
      return unwrap('DELETE', await users.DELETE(
        '/v1/workspaces/{id}',
        { params: { path: { id: workspaceId } } },
      ));
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
      return unwrap('GET', await projects.GET(
        '/v1/workspaces/{id}/projects',
        { params: { path: { id: workspaceId }, query: { type: 'ai' } } },
      ));
    },

    /**
     * GET /v1/workspaces/{ws}/projects/{pid}?draft=&type=ai — a single project
     * with its full settings (`settings.ci.competitors`, `settings.ai…`). The
     * `draft` query is REQUIRED upstream; we read the draft view (draft=true) so
     * pre-publish edits and Semrush's auto-generated CI competitors are both
     * visible. Used by the CI-competitor sync to read the current list before the
     * destructive PUT.
     */
    async getProject(workspaceId, projectId, { draft = true } = {}) {
      return unwrap('GET', await projects.GET(
        '/v1/workspaces/{id}/projects/{project_id}',
        {
          params: {
            path: { id: workspaceId, project_id: projectId },
            query: { draft: String(draft), type: 'ai' },
          },
        },
      ));
    },

    /**
     * PUT /v1/workspaces/{ws}/projects/{pid}/ci/competitors — FULL replace of the
     * project's CI competitor list (deletes all, inserts exactly the body).
     * Body: { ci_competitors: [{ domain, color? }] }. Because it is destructive
     * and Semrush auto-generates its own competitors, callers must read-merge
     * (getProject → merge → put) rather than send only our list. Returns the
     * resulting { ci_competitors: [...] }.
     */
    async updateCiCompetitors(workspaceId, projectId, ciCompetitors) {
      return unwrap('PUT', await projects.PUT(
        '/v1/workspaces/{id}/projects/{project_id}/ci/competitors',
        {
          params: { path: { id: workspaceId, project_id: projectId } },
          body: { ci_competitors: ciCompetitors },
        },
      ));
    },

    /**
     * GET /v1/workspaces/{ws}/projects/{pid}/aio/init_status — AIO readiness
     * for a live project (`{ initialized: bool }`). Surfaced on the single
     * market-detail read only, never per-item in the list (would be N+1).
     */
    async getInitStatus(workspaceId, projectId) {
      return unwrap('GET', await projects.GET(
        '/v1/workspaces/{id}/projects/{project_id}/aio/init_status',
        { params: { path: { id: workspaceId, project_id: projectId } } },
      ));
    },

    // ─────────────────────────────────────────────────────────────────────
    // Brand URLs (project benchmarks). A project's "main brand" benchmark is
    // auto-created from the project's brand_name_display/brand_names/domain;
    // brand URLs (own site, social, earned) attach to that benchmark. URLs are
    // unique per PROJECT — a duplicate create is silently skipped upstream and
    // reported via `existing_count`. Used to push brand-level URLs onto every
    // market/project in the brand (mirrors brand_names/alias propagation).
    // ─────────────────────────────────────────────────────────────────────

    /**
     * GET /v1/workspaces/{ws}/projects/{pid}/ai_models/benchmarks — list the
     * project's benchmarks (the project's own brand plus competitors). The own
     * brand carries `main_brand: true`; its `id` is the `benchmark_id` the brand
     * URL endpoints require. Returns `{ aio_benchmarks: [...] }`.
     */
    async listBenchmarks(workspaceId, projectId) {
      return unwrap('GET', await projects.GET(
        '/v1/workspaces/{id}/projects/{project_id}/ai_models/benchmarks',
        { params: { path: { id: workspaceId, project_id: projectId } } },
      ));
    },

    /**
     * POST /v2/workspaces/{ws}/projects/{pid}/ai_models/benchmarks — batch-create
     * benchmarks. Body is an ARRAY of `{ brand_name, domain, brand_aliases?,
     * color? }`. The API cannot set `main_brand` (system-managed); a created
     * benchmark is a regular tracked brand. Returns `{ ids: [...], existing_count }`.
     * We use it to create the project's own-brand benchmark when Semrush has not
     * auto-provisioned one (the `benchmark_id` brand URLs must attach to).
     */
    async createBenchmarks(workspaceId, projectId, benchmarks) {
      return unwrap('POST', await projects.POST(
        '/v2/workspaces/{id}/projects/{project_id}/ai_models/benchmarks',
        {
          params: { path: { id: workspaceId, project_id: projectId } },
          body: benchmarks,
        },
      ));
    },

    /**
     * DELETE /v1/workspaces/{ws}/projects/{pid}/ai_models/benchmarks — batch-delete
     * benchmarks by id (body `{ ids: [...] }`). The main-brand benchmark cannot be
     * deleted (409). Used by the competitor-benchmark edit re-sync to drop a
     * competitor that was removed from the brand.
     */
    async deleteBenchmarks(workspaceId, projectId, ids) {
      return unwrap('DELETE', await projects.DELETE(
        '/v1/workspaces/{id}/projects/{project_id}/ai_models/benchmarks',
        {
          params: { path: { id: workspaceId, project_id: projectId } },
          body: { ids },
        },
      ));
    },

    /**
     * PUT /v1/workspaces/{ws}/projects/{pid}/ai_models/benchmarks/{bid} — update a
     * benchmark in place (ai-update-benchmark). Body is a `model.AIOBenchmarkRequest`
     * ({ brand_name, brand_aliases, domain, color, favorite }). Used to re-sync a
     * benchmark's `brand_aliases` (own-brand or a competitor) when the alias set
     * changes but the domain does not — the create/delete pair cannot express an
     * in-place alias edit. Upstream PUT confirmed live on prod 2026-06-24
     * (OPTIONS .../benchmarks/{bid} → 405 allow: PUT). Semrush may silently reject
     * some aliases; read them back from `listBenchmarks` (`rejected_brand_aliases`).
     */
    async updateBenchmark(workspaceId, projectId, benchmarkId, benchmark) {
      return unwrap('PUT', await projects.PUT(
        '/v1/workspaces/{id}/projects/{project_id}/ai_models/benchmarks/{benchmark_id}',
        {
          params: {
            path: { id: workspaceId, project_id: projectId, benchmark_id: benchmarkId },
          },
          body: benchmark,
        },
      ));
    },

    /**
     * GET /v2/.../aio/benchmarks/{bid}/brand_urls — list a benchmark's brand
     * URLs. Returns `{ brand_urls: [{ id, url, type, ... }] }`. Used by the
     * brand-edit re-sync to diff the live set before adding/removing.
     */
    async listBrandUrls(workspaceId, projectId, benchmarkId) {
      return unwrap('GET', await projects.GET(
        '/v2/workspaces/{id}/projects/{project_id}/aio/benchmarks/{benchmark_id}/brand_urls',
        {
          params: {
            path: { id: workspaceId, project_id: projectId, benchmark_id: benchmarkId },
          },
        },
      ));
    },

    /**
     * POST /v2/.../aio/benchmarks/{bid}/brand_urls — batch-create brand URLs
     * under a benchmark. Body is an ARRAY of `{ url, type }` (url must be https,
     * type ≤ 32 chars). URLs already present in the project are skipped (not
     * duplicated) and counted in the response `existing_count`.
     */
    async createBrandUrls(workspaceId, projectId, benchmarkId, entries) {
      return unwrap('POST', await projects.POST(
        '/v2/workspaces/{id}/projects/{project_id}/aio/benchmarks/{benchmark_id}/brand_urls',
        {
          params: {
            path: { id: workspaceId, project_id: projectId, benchmark_id: benchmarkId },
          },
          body: entries,
        },
      ));
    },

    /**
     * DELETE /v2/.../aio/benchmarks/{bid}/brand_urls — batch-delete brand URLs
     * by id. Body `{ ids: [...] }`. Ids not in this benchmark are ignored.
     */
    async deleteBrandUrls(workspaceId, projectId, benchmarkId, ids) {
      return unwrap('DELETE', await projects.DELETE(
        '/v2/workspaces/{id}/projects/{project_id}/aio/benchmarks/{benchmark_id}/brand_urls',
        {
          params: {
            path: { id: workspaceId, project_id: projectId, benchmark_id: benchmarkId },
          },
          body: { ids },
        },
      ));
    },
  };
}
