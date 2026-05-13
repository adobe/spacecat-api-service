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

import {
  badRequest, createResponse, internalServerError, ok,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import { createSerenityTransport, SerenityTransportError } from '../support/serenity/rest-transport.js';
import { createSerenityReportingTransport } from '../support/serenity/reporting-transport.js';
import { MatrixNotConfiguredError, listProjectsForBrand } from '../support/serenity/matrix.js';
import {
  handleListPrompts,
  handleCreatePrompts,
  handleUpdatePrompt,
  handleBulkDeletePrompts,
} from '../support/serenity/handlers/prompts.js';

function getImsToken(context) {
  const header = context?.pathInfo?.headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

function extractQuery(context) {
  if (context?.request?.url) {
    try {
      const u = new URL(context.request.url);
      const out = {};
      for (const [k, v] of u.searchParams) {
        out[k] = v;
      }
      return out;
    } catch { /* fall through */ }
  }
  return context?.data || {};
}

function mapTransportError(e, log) {
  if (e instanceof MatrixNotConfiguredError) {
    return createResponse({ error: 'matrixNotConfigured', message: e.message }, 503);
  }
  if (e instanceof SerenityTransportError) {
    log.error('Serenity transport error', e);
    return createResponse({
      error: 'semrushUpstreamError',
      status: e.status,
      message: e.message,
      body: e.body,
    }, e.status || 502);
  }
  log.error('Serenity controller error', e);
  return internalServerError(e.message);
}

function SerenityPromptsController(context, log) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }
  if (!log) {
    throw new Error('Log required');
  }

  function buildTransport(ctx) {
    const imsToken = getImsToken(ctx);
    const hasCookie = Boolean((ctx?.env?.SEMRUSH_COOKIE || '').trim());
    if (!imsToken && !hasCookie) {
      return null;
    }
    return createSerenityTransport({ env: ctx.env, imsToken });
  }

  const listPrompts = async (ctx) => {
    const brandId = ctx?.params?.brandId;
    const transport = buildTransport(ctx);
    if (!transport) {
      return badRequest('Missing IMS bearer token and SEMRUSH_COOKIE is not configured');
    }
    try {
      const result = await handleListPrompts(transport, ctx.env, brandId, extractQuery(ctx));
      return ok(result);
    } catch (e) {
      return mapTransportError(e, log);
    }
  };

  const createPrompts = async (ctx) => {
    const brandId = ctx?.params?.brandId;
    const transport = buildTransport(ctx);
    if (!transport) {
      return badRequest('Missing IMS bearer token and SEMRUSH_COOKIE is not configured');
    }
    try {
      const result = await handleCreatePrompts(transport, ctx.env, brandId, ctx.data || {}, log);
      return createResponse(result, 201);
    } catch (e) {
      return mapTransportError(e, log);
    }
  };

  const updatePrompt = async (ctx) => {
    const brandId = ctx?.params?.brandId;
    const logicalId = ctx?.params?.promptId;
    if (!logicalId) {
      return badRequest('Missing promptId');
    }
    const transport = buildTransport(ctx);
    if (!transport) {
      return badRequest('Missing IMS bearer token and SEMRUSH_COOKIE is not configured');
    }
    try {
      const result = await handleUpdatePrompt(
        transport,
        ctx.env,
        brandId,
        logicalId,
        ctx.data || {},
        log,
      );
      return createResponse(result.body, result.status);
    } catch (e) {
      return mapTransportError(e, log);
    }
  };

  const bulkDeletePrompts = async (ctx) => {
    const brandId = ctx?.params?.brandId;
    const transport = buildTransport(ctx);
    if (!transport) {
      return badRequest('Missing IMS bearer token and SEMRUSH_COOKIE is not configured');
    }
    try {
      const result = await handleBulkDeletePrompts(
        transport,
        ctx.env,
        brandId,
        ctx.data || {},
        log,
      );
      return ok(result);
    } catch (e) {
      return mapTransportError(e, log);
    }
  };

  const listProjects = async (ctx) => {
    const brandId = ctx?.params?.brandId;
    try {
      const projects = listProjectsForBrand(ctx.env, brandId);
      const uniq = (xs) => Array.from(new Set(xs.filter(Boolean))).sort();
      const categories = uniq(projects.map((p) => p.category));
      const regions = uniq(projects.map((p) => p.market));
      const languages = uniq(projects.map((p) => p.language));
      return ok({
        projects,
        facets: { categories, regions, languages },
      });
    } catch (e) {
      return mapTransportError(e, log);
    }
  };

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/projects/:workspaceId/:projectId/tags
   *
   * Returns the set of unique tag names attached to prompts in a specific
   * Semrush project. Used by the Brand Presence dashboard where the project
   * is pinned outside of the matrix env var, so the existing matrix-driven
   * `listPrompts` aggregation cannot surface it.
   */
  const listProjectTags = async (ctx) => {
    const { workspaceId, projectId } = ctx?.params || {};
    if (!workspaceId || !projectId) {
      return badRequest('Missing workspaceId / projectId');
    }
    const transport = buildTransport(ctx);
    if (!transport) {
      return badRequest('Missing IMS bearer token and SEMRUSH_COOKIE is not configured');
    }
    try {
      const tagNames = new Set();
      let page = 1;
      const LIMIT = 200;
      while (page <= 50) {
        // eslint-disable-next-line no-await-in-loop
        const resp = await transport.listPromptsByTags(workspaceId, projectId, {
          tag_ids: [],
          page,
          limit: LIMIT,
        });
        const items = Array.isArray(resp?.items) ? resp.items : [];
        for (const item of items) {
          const tags = Array.isArray(item?.tags) ? item.tags : [];
          for (const t of tags) {
            const name = typeof t === 'string' ? t : t?.name;
            if (name) {
              tagNames.add(name);
            }
          }
        }
        if (items.length < LIMIT) {
          break;
        }
        page += 1;
      }
      return ok({ tags: Array.from(tagNames).sort() });
    } catch (e) {
      return mapTransportError(e, log);
    }
  };

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/workspaces/:workspaceId/projects
   *
   * Lists all Semrush projects in a workspace. Used by the Brand Presence
   * dashboard's Category filter — each project becomes one Category option.
   */
  const listWorkspaceProjects = async (ctx) => {
    const { workspaceId } = ctx?.params || {};
    if (!workspaceId) {
      return badRequest('Missing workspaceId');
    }
    const transport = buildTransport(ctx);
    if (!transport) {
      return badRequest('Missing IMS bearer token and SEMRUSH_COOKIE is not configured');
    }
    try {
      const resp = await transport.listWorkspaceProjects(workspaceId);
      const items = Array.isArray(resp?.items) ? resp.items : [];
      const projects = items
        .filter((p) => p && typeof p === 'object' && p.id)
        .map((p) => ({
          id: p.id,
          name: p.name,
          domain: p.domain,
        }));
      return ok({ projects });
    } catch (e) {
      return mapTransportError(e, log);
    }
  };

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/projects/:workspaceId/:projectId/models
   *
   * Returns the AI models configured for a specific Semrush AIO project. Each
   * entry exposes `{ id, key, name, icon }` where `key` is the value the
   * Reporting API expects in `CBF_model` filter clauses.
   */
  const listProjectModels = async (ctx) => {
    const { workspaceId, projectId } = ctx?.params || {};
    if (!workspaceId || !projectId) {
      return badRequest('Missing workspaceId / projectId');
    }
    const transport = buildTransport(ctx);
    if (!transport) {
      return badRequest('Missing IMS bearer token and SEMRUSH_COOKIE is not configured');
    }
    try {
      const resp = await transport.listAiModels(workspaceId, projectId);
      const items = Array.isArray(resp?.items) ? resp.items : [];
      const models = items
        .map((it) => it?.model)
        .filter((m) => m && typeof m === 'object')
        .map((m) => ({
          id: m.id,
          key: m.key,
          name: m.name,
          icon: m.icon,
        }));
      return ok({ models });
    } catch (e) {
      return mapTransportError(e, log);
    }
  };

  /**
   * POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/reporting/elements/:elementId
   *
   * Forwards a Brand Presence dashboard widget request to the Semrush v4-raw
   * Reporting API. Body must contain `{ workspaceId, render_data }` matching
   * the shape documented in `feat-serenity/api_requests.md`.
   */
  const queryReportingElement = async (ctx) => {
    const elementId = ctx?.params?.elementId;
    if (!elementId) {
      return badRequest('Missing elementId');
    }
    const { workspaceId, render_data: renderData } = ctx?.data || {};
    if (!workspaceId) {
      return badRequest('Missing workspaceId');
    }
    if (!isNonEmptyObject(renderData)) {
      return badRequest('Missing render_data');
    }
    try {
      const transport = createSerenityReportingTransport({ env: ctx.env });
      const result = await transport.queryElement(
        workspaceId,
        elementId,
        { render_data: renderData },
      );
      return ok(result);
    } catch (e) {
      return mapTransportError(e, log);
    }
  };

  return {
    listPrompts,
    createPrompts,
    updatePrompt,
    bulkDeletePrompts,
    listProjects,
    listProjectTags,
    listProjectModels,
    listWorkspaceProjects,
    queryReportingElement,
  };
}

export default SerenityPromptsController;
