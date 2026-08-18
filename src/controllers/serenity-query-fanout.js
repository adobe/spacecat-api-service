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
  badRequest, createResponse, forbidden, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isNonEmptyObject, isValidUUID } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';
import { resolveBrandWorkspace } from '../support/serenity/workspace-resolver.js';
import { createQueryFanoutTransport } from '../support/serenity/query-fanout-transport.js';
import { SerenityTransportError } from '../support/serenity/serenity-transport-error.js';
import { createElementsTransport } from '../support/elements/elements-transport.js';
import { ElementsTransportError } from '../support/elements/errors.js';
import { ErrorWithStatusCode, resolveSemrushImsToken } from '../support/utils.js';
import { X_PROMISE_TOKEN_HEADER, PROMISE_TOKEN_REQUIRED_ERROR_CODE } from '../utils/constants.js';

const BEARER_PREFIX = 'Bearer ';

// The fan-out coverage element (element_id) from the serenity-query-fanouts
// Postman collection. Hardcoded for this phase — see the design doc's "Open
// questions" for promoting this to config/env once a second element is needed.
const FANOUT_COVERAGE_ELEMENT_ID = '9f8bb77f-008e-4c80-8f3c-059986a045cd';

/**
 * Extracts and validates the IMS bearer token from the inbound Authorization header.
 * Throws 401 if missing, or if the caller authenticated via a non-IMS mechanism.
 *
 * NOTE — this is NOT the only path into the handler below: `x-promise-token`
 * (see `resolveSemrushImsToken`) is a second, always-on way to reach it without
 * passing this function's IMS-type check, by exchanging the promise token for
 * an IMS token instead of forwarding `Authorization` directly. In practice this
 * is now the ONLY reachable path in a deployed environment — the global
 * direct-IMS-token auth handler has been removed (see CLAUDE.md's Authentication
 * precedence), so `authInfo.getType()` can no longer be `'ims'` outside the
 * route-scoped `/tools/api-keys/*` handler. Mirrors `elements.js`/`serenity.js`.
 */
function requireImsBearer(ctx) {
  const authInfo = ctx?.attributes?.authInfo;
  if (authInfo?.getType && authInfo.getType() !== 'ims') {
    const err = new ErrorWithStatusCode(
      `Query fan-out proxy requires IMS authentication; send the ${X_PROMISE_TOKEN_HEADER} header instead`,
      401,
    );
    err.code = PROMISE_TOKEN_REQUIRED_ERROR_CODE;
    throw err;
  }
  const header = ctx?.pathInfo?.headers?.authorization;
  if (!hasText(header) || !header.startsWith(BEARER_PREFIX)) {
    throw new ErrorWithStatusCode('Missing or invalid Authorization header', 401);
  }
  return header.substring(BEARER_PREFIX.length);
}

/**
 * Aggregates row counts per `topic_name` from a fan-out coverage table, so a
 * caller can see topic breadth without scanning the full row array.
 * @param {Array<{topic_name?: string}>} rows
 * @returns {Array<{name: string, count: number}>}
 */
function summarizeTopics(rows) {
  const counts = new Map();
  for (const row of rows) {
    const name = row?.topic_name ?? 'Unknown';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

/**
 * Controller for checking an existing Semrush Query Fan-out run and, once it
 * has succeeded, reading its coverage table back via the Elements API.
 *
 * Deliberately does NOT expose a "create run" endpoint yet — see
 * `docs/plans/2026-08-18-serenity-query-fanout-status.md` for the phased plan.
 * A run is created out-of-band today (the serenity-query-fanouts Postman
 * collection's "Create run" request); this controller only checks status
 * and, on success, reads the resulting coverage data.
 *
 * @param {object} context - Request context.
 * @param {object} log - Logger.
 * @param {object} env - Environment variables.
 */
export default function SerenityQueryFanoutController(context, log, env) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }
  if (!log) {
    throw new Error('Log required');
  }

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/query-fanouts/:runId
   *
   * Resolves the brand's Semrush workspace, checks the run's status, and —
   * once `succeeded` — fetches the coverage table for that run from the
   * Elements API (element {@link FANOUT_COVERAGE_ELEMENT_ID}, scoped via the
   * `CBF_workflow_id` filter, mirroring the Postman collection's "Element
   * read — fan-out coverage" request).
   *
   * Response while the run is still in flight: `{ runId, workspaceId, status }`.
   * Response once succeeded: adds `rowCount`, `topics` (per-topic row counts),
   * and `data` (the raw coverage rows).
   */
  const getQueryFanoutStatus = async (ctx) => {
    const { spaceCatId, brandId, runId } = ctx.params;

    if (!isValidUUID(brandId)) {
      return badRequest('Brand id must be a valid UUID');
    }
    if (!hasText(runId)) {
      return badRequest('runId is required');
    }

    const { Organization } = ctx.dataAccess;
    const organization = await Organization.findById(spaceCatId);
    if (!organization) {
      return notFound(`Organization not found: ${spaceCatId}`);
    }

    const accessControl = AccessControlUtil.fromContext(ctx);
    if (!await accessControl.hasAccess(organization)) {
      return forbidden('User does not have access to this organization');
    }

    const { workspaceId } = await resolveBrandWorkspace(ctx, spaceCatId, brandId);
    if (!hasText(workspaceId)) {
      return notFound('Brand has no resolvable Semrush workspace');
    }

    let imsToken;
    try {
      imsToken = await resolveSemrushImsToken(ctx, log, 'query-fanout', requireImsBearer);
    } catch (e) {
      return createResponse(
        { error: e.code ?? 'unauthorized', message: e.message },
        e.status ?? 401,
      );
    }

    const fanoutTransport = createQueryFanoutTransport({ env, imsToken });
    let statusResponse;
    try {
      statusResponse = await fanoutTransport.getRunStatus({ workspaceId, runId });
    } catch (e) {
      if (e instanceof SerenityTransportError) {
        const status = e.status >= 400 && e.status < 600 ? e.status : 502;
        return createResponse({ error: 'upstreamError', message: e.message }, status);
      }
      log.error(`query-fanout: status check failed for run ${runId}: ${e.message}`, e);
      return internalServerError('Failed to check query fan-out run status');
    }

    const { status } = statusResponse ?? {};
    if (status !== 'succeeded') {
      // queued | running | failed | unknown — nothing to read yet.
      return ok({ runId, workspaceId, status: status ?? 'unknown' });
    }

    const elementsTransport = createElementsTransport({ env, imsToken });
    let coverage;
    try {
      coverage = await elementsTransport.fetchElement(workspaceId, FANOUT_COVERAGE_ELEMENT_ID, {
        comparison_data_formatting: 'union',
        filters: {
          simple: {},
          advanced: {
            op: 'and',
            filters: [{ op: 'eq', val: runId, col: 'CBF_workflow_id' }],
          },
        },
      });
    } catch (e) {
      if (e instanceof ElementsTransportError) {
        const httpStatus = e.status >= 400 && e.status < 600 ? e.status : 502;
        return createResponse({ error: 'upstreamError', message: e.message }, httpStatus);
      }
      log.error(`query-fanout: coverage fetch failed for run ${runId}: ${e.message}`, e);
      return internalServerError('Failed to fetch query fan-out coverage data');
    }

    const rows = coverage?.blocks?.data ?? [];
    return ok({
      runId,
      workspaceId,
      status,
      rowCount: rows.length,
      topics: summarizeTopics(rows),
      data: rows,
    });
  };

  return { getQueryFanoutStatus };
}
