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
import * as store from '../../support/dashboards/in-memory-dashboard-store.js';

const VISIBILITIES = ['private', 'org'];

/**
 * Controller for ABV custom-dashboard CRUD + star/search
 * (`.../dashboards/*`). v1 persists via `in-memory-dashboard-store.js` — see that
 * module's header for why (no migrations for an unproven feature) and how to swap it
 * for a real persisted entity later without changing this controller's contract.
 */
function LlmoDashboardsController(context) {
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
   * share list — the same rule `in-memory-dashboard-store.js#listDashboards` applies for
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
    const { spaceCatId, brandId } = ctx.params;
    const { filter, search } = ctx.data ?? {};
    const dashboards = store.listDashboards({
      orgId: spaceCatId, brandId, ownerId: callerId, filter, search,
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
    const { spaceCatId, brandId, dashboardId } = ctx.params;
    const dashboard = store.getDashboard({ id: dashboardId, orgId: spaceCatId, brandId });
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
    const dashboard = store.createDashboard({
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
    const { spaceCatId, brandId, dashboardId } = ctx.params;
    const existing = store.getDashboard({ id: dashboardId, orgId: spaceCatId, brandId });
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
    const updated = store.updateDashboard({
      id: dashboardId, orgId: spaceCatId, brandId, patch,
    });
    return ok(DashboardDto.toJSON(updated, callerId, getCallerDisplayName(ctx)));
  };

  const deleteDashboard = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const { spaceCatId, brandId, dashboardId } = ctx.params;
    const existing = store.getDashboard({ id: dashboardId, orgId: spaceCatId, brandId });
    if (!existing || !canView(existing, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    if (existing.ownerId !== callerId) {
      return forbidden('Only the owner can delete this dashboard');
    }
    store.deleteDashboard({ id: dashboardId, orgId: spaceCatId, brandId });
    return createResponse({}, 204);
  };

  const duplicateDashboard = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const { spaceCatId, brandId, dashboardId } = ctx.params;
    const existing = store.getDashboard({ id: dashboardId, orgId: spaceCatId, brandId });
    if (!existing || !canView(existing, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    const { name } = ctx.data ?? {};
    const copy = store.duplicateDashboard({
      id: dashboardId, orgId: spaceCatId, brandId, ownerId: callerId, name,
    });
    return createResponse(DashboardDto.toJSON(copy, callerId, getCallerDisplayName(ctx)), 201);
  };

  const setStarred = (starred) => async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const { spaceCatId, brandId, dashboardId } = ctx.params;
    const existing = store.getDashboard({ id: dashboardId, orgId: spaceCatId, brandId });
    if (!existing || !canView(existing, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    const updated = store.setStarred({
      id: dashboardId, orgId: spaceCatId, brandId, userId: callerId, starred,
    });
    return ok(DashboardDto.toJSON(updated, callerId, getCallerDisplayName(ctx)));
  };

  const addTile = async (ctx) => {
    const { error } = await getOrgAndValidateAccess(ctx);
    if (error) {
      return error;
    }
    const callerId = getCallerId(ctx);
    const { spaceCatId, brandId, dashboardId } = ctx.params;
    const existing = store.getDashboard({ id: dashboardId, orgId: spaceCatId, brandId });
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
    const result = store.addTile({
      id: dashboardId,
      orgId: spaceCatId,
      brandId,
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
      spaceCatId, brandId, dashboardId, tileId,
    } = ctx.params;
    const existing = store.getDashboard({ id: dashboardId, orgId: spaceCatId, brandId });
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
    const result = store.updateTile({
      id: dashboardId, orgId: spaceCatId, brandId, tileId, patch,
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
      spaceCatId, brandId, dashboardId, tileId,
    } = ctx.params;
    const existing = store.getDashboard({ id: dashboardId, orgId: spaceCatId, brandId });
    if (!existing || !canView(existing, callerId)) {
      return notFound(`Dashboard not found: ${dashboardId}`);
    }
    if (!canEdit(existing, callerId)) {
      return forbidden('Only the owner or an editor can remove tiles');
    }
    const updated = store.removeTile({
      id: dashboardId, orgId: spaceCatId, brandId, tileId,
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
