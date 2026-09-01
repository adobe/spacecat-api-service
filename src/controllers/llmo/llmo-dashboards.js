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
  badRequest, forbidden, notFound, ok, createResponse,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../../support/access-control-util.js';
import { DashboardDto } from '../../dto/dashboard.js';
import * as store from '../../support/dashboards/s3-dashboard-store.js';

const VISIBILITIES = ['private', 'org'];

/**
 * Controller for ABV custom-dashboard CRUD + star/search (`.../dashboards/*`).
 * Dashboards are persisted as JSON objects in S3 under dashboards/{orgId}/{id}.json,
 * accessed via `context.s3` (injected by `s3ClientWrapper`) and `S3_DASHBOARDS_BUCKET`.
 */
function LlmoDashboardsController(context) {
  const { s3 } = context;
  const bucket = context.env?.S3_DASHBOARDS_BUCKET;
  const accessControlUtil = AccessControlUtil.fromContext(context);
  const hasLlmoOrganizationAccess = (organization) => accessControlUtil
    .hasAccess(organization, '', 'LLMO');

  const getOrgAndValidateAccess = async (ctx) => {
    const { spaceCatId } = ctx.params;
    const { Organization } = ctx.dataAccess;
    const organization = await Organization.findById(spaceCatId);
    if (!organization) {
      return { error: notFound(`Organization not found: ${spaceCatId}`) };
    }
    if (!await hasLlmoOrganizationAccess(organization)) {
      return { error: notFound(`Organization not found: ${spaceCatId}`) };
    }
    return { organization };
  };

  const getCallerId = (ctx) => {
    const profile = ctx.attributes?.authInfo?.getProfile?.();
    return profile?.email;
  };

  /** Display name for the DTO's `ownerName` — same first/last-name field fallbacks
   * `user-details.js` uses for the IMS profile. `undefined` (not a placeholder string)
   * when neither is present, so `DashboardDto.toJSON` cleanly omits the field. */
  const getCallerDisplayName = (ctx) => {
    const profile = ctx.attributes?.authInfo?.getProfile?.();
    const first = profile?.first_name || profile?.given_name;
    const last = profile?.last_name || profile?.family_name;
    const name = [first, last].filter(Boolean).join(' ').trim();
    return name || undefined;
  };

  /** A caller may see a dashboard when they own it, it's org-visible, or they're on the
   * share list — the same rule `s3-dashboard-store.js#listDashboards` applies for
   * listing, restated here for single-dashboard reads. */
  const canView = (dashboard, callerId) => dashboard.ownerId === callerId
    || dashboard.visibility === 'org'
    || dashboard.sharedWith.some((share) => share.userId === callerId);

  const canEdit = (dashboard, callerId) => dashboard.ownerId === callerId
    || dashboard.sharedWith.some((share) => share.userId === callerId && share.role === 'editor');

  const listDashboards = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    if (!hasText(callerId)) {
      return forbidden('Unable to resolve caller identity');
    }
    const callerDisplayName = getCallerDisplayName(ctx);
    const { spaceCatId } = ctx.params;
    const { filter, search } = ctx.data ?? {};
    const dashboards = await store.listDashboards(s3, bucket, {
      orgId: spaceCatId, ownerId: callerId, filter, search,
    });
    return ok({
      dashboards: dashboards.map((d) => DashboardDto.toJSON(d, callerId, callerDisplayName)),
    });
  };

  const getDashboard = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const { spaceCatId, dashboardId } = ctx.params;
    const dashboard = await store.getDashboard(s3, bucket, { id: dashboardId, orgId: spaceCatId });
    if (!dashboard || !canView(dashboard, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    return ok(DashboardDto.toJSON(dashboard, callerId, getCallerDisplayName(ctx)));
  };

  const createDashboard = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    if (!hasText(callerId)) {
      return forbidden('Unable to resolve caller identity');
    }
    const { spaceCatId, brandId } = ctx.params;
    const {
      name, description, visibility, controls,
    } = ctx.data ?? {};
    if (!hasText(name)) {
      return badRequest('name is required');
    }
    if (visibility !== undefined && !VISIBILITIES.includes(visibility)) {
      return badRequest(`visibility must be one of: ${VISIBILITIES.join(', ')}`);
    }
    const dashboard = await store.createDashboard(s3, bucket, {
      orgId: spaceCatId, brandId, ownerId: callerId, name, description, visibility, controls,
    });
    return createResponse(DashboardDto.toJSON(dashboard, callerId, getCallerDisplayName(ctx)), 201);
  };

  const updateDashboard = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const { spaceCatId, dashboardId } = ctx.params;
    const existing = await store.getDashboard(s3, bucket, { id: dashboardId, orgId: spaceCatId });
    if (!existing || !canView(existing, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    if (!canEdit(existing, callerId)) {
      return forbidden('Only the owner or an editor can update this dashboard');
    }
    const {
      name, description, visibility, controls, sections, sharedWith,
    } = ctx.data ?? {};
    if (sharedWith !== undefined && existing.ownerId !== callerId) {
      return forbidden('Only the owner can modify sharing settings');
    }
    // Visibility is a coarser access-control lever than a single named share — it can
    // expose a private dashboard to the entire org — so it gets the same owner-only
    // guard as sharedWith above, not the lower canEdit() bar the rest of this patch uses.
    if (visibility !== undefined && existing.ownerId !== callerId) {
      return forbidden('Only the owner can change dashboard visibility');
    }
    if (visibility !== undefined && !VISIBILITIES.includes(visibility)) {
      return badRequest(`visibility must be one of: ${VISIBILITIES.join(', ')}`);
    }
    const patch = {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(visibility !== undefined && { visibility }),
      ...(controls !== undefined && { controls }),
      ...(sections !== undefined && { sections }),
      ...(sharedWith !== undefined && { sharedWith }),
    };
    const updated = await store.updateDashboard(s3, bucket, {
      id: dashboardId, orgId: spaceCatId, patch,
    });
    return ok(DashboardDto.toJSON(updated, callerId, getCallerDisplayName(ctx)));
  };

  const deleteDashboard = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const { spaceCatId, dashboardId } = ctx.params;
    const existing = await store.getDashboard(s3, bucket, { id: dashboardId, orgId: spaceCatId });
    if (!existing || !canView(existing, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    if (existing.ownerId !== callerId) {
      return forbidden('Only the owner can delete this dashboard');
    }
    await store.deleteDashboard(s3, bucket, { id: dashboardId, orgId: spaceCatId });
    return createResponse({}, 204);
  };

  const duplicateDashboard = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const { spaceCatId, dashboardId } = ctx.params;
    const existing = await store.getDashboard(s3, bucket, { id: dashboardId, orgId: spaceCatId });
    if (!existing || !canView(existing, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    const { name } = ctx.data ?? {};
    const copy = await store.duplicateDashboard(s3, bucket, {
      id: dashboardId, orgId: spaceCatId, ownerId: callerId, name,
    });
    return createResponse(DashboardDto.toJSON(copy, callerId, getCallerDisplayName(ctx)), 201);
  };

  const setStarred = (starred) => async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const { spaceCatId, dashboardId } = ctx.params;
    const existing = await store.getDashboard(s3, bucket, { id: dashboardId, orgId: spaceCatId });
    if (!existing || !canView(existing, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    const updated = await store.setStarred(s3, bucket, {
      id: dashboardId, orgId: spaceCatId, userId: callerId, starred,
    });
    return ok(DashboardDto.toJSON(updated, callerId, getCallerDisplayName(ctx)));
  };

  const addTile = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const { spaceCatId, dashboardId } = ctx.params;
    const existing = await store.getDashboard(s3, bucket, { id: dashboardId, orgId: spaceCatId });
    if (!existing || !canView(existing, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    if (!canEdit(existing, callerId)) {
      return forbidden('Only the owner or an editor can add tiles');
    }
    const {
      title, description, tileType, analysis, visualization, snapshot, layout,
      localOverrides, applyGlobalFilters,
    } = ctx.data ?? {};
    if (!hasText(title) || !layout) {
      return badRequest('title and layout are required');
    }
    if (!snapshot && (!analysis || !visualization)) {
      return badRequest('governed tiles require analysis and visualization; snapshot tiles require snapshot');
    }
    const result = await store.addTile(s3, bucket, {
      id: dashboardId,
      orgId: spaceCatId,
      tile: {
        title,
        ...(description !== undefined && { description }),
        ...(tileType !== undefined && { tileType }),
        ...(analysis !== undefined && { analysis }),
        ...(visualization !== undefined && { visualization }),
        ...(snapshot !== undefined && { snapshot }),
        layout,
        localOverrides: localOverrides ?? [],
        ...(applyGlobalFilters !== undefined && { applyGlobalFilters }),
      },
    });
    if (!result) {
      return notFound('Dashboard was deleted concurrently');
    }
    return createResponse(result.tile, 201);
  };

  const updateTile = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const {
      spaceCatId, dashboardId, tileId,
    } = ctx.params;
    const existing = await store.getDashboard(s3, bucket, { id: dashboardId, orgId: spaceCatId });
    if (!existing || !canView(existing, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    if (!canEdit(existing, callerId)) {
      return forbidden('Only the owner or an editor can update tiles');
    }
    const {
      title, description, tileType, analysis, visualization, snapshot, layout,
      localOverrides, applyGlobalFilters,
    } = ctx.data ?? {};
    const patch = {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(tileType !== undefined && { tileType }),
      ...(analysis !== undefined && { analysis }),
      ...(visualization !== undefined && { visualization }),
      ...(snapshot !== undefined && { snapshot }),
      ...(layout !== undefined && { layout }),
      ...(localOverrides !== undefined && { localOverrides }),
      ...(applyGlobalFilters !== undefined && { applyGlobalFilters }),
    };
    const existingTile = existing.tiles.find((tile) => tile.id === tileId);
    if (!existingTile) {
      return notFound(`Tile not found: ${tileId}`);
    }
    // Same governed-tile invariant addTile enforces: apply the patch on top of the
    // existing tile first, so a patch clearing analysis/visualization without a
    // snapshot (or vice versa) is caught here rather than persisting a tile with no
    // valid render path.
    const merged = { ...existingTile, ...patch };
    if (!merged.snapshot && (!merged.analysis || !merged.visualization)) {
      return badRequest('governed tiles require analysis and visualization; snapshot tiles require snapshot');
    }
    const result = await store.updateTile(s3, bucket, {
      id: dashboardId, orgId: spaceCatId, tileId, patch,
    });
    if (!result) {
      return notFound(`Tile not found: ${tileId}`);
    }
    return ok(result.tile);
  };

  const removeTile = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const {
      spaceCatId, dashboardId, tileId,
    } = ctx.params;
    const existing = await store.getDashboard(s3, bucket, { id: dashboardId, orgId: spaceCatId });
    if (!existing || !canView(existing, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    if (!canEdit(existing, callerId)) {
      return forbidden('Only the owner or an editor can remove tiles');
    }
    const updated = await store.removeTile(s3, bucket, {
      id: dashboardId, orgId: spaceCatId, tileId,
    });
    if (!updated) {
      return notFound(`Tile not found: ${tileId}`);
    }
    return createResponse({}, 204);
  };

  return {
    listDashboards,
    getDashboard,
    createDashboard,
    updateDashboard,
    deleteDashboard,
    duplicateDashboard,
    starDashboard: setStarred(true),
    unstarDashboard: setStarred(false),
    addTile,
    updateTile,
    removeTile,
  };
}

export default LlmoDashboardsController;
