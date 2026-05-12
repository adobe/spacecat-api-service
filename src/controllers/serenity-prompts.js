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

  return {
    listPrompts,
    createPrompts,
    updatePrompt,
    bulkDeletePrompts,
    listProjects,
  };
}

export default SerenityPromptsController;
