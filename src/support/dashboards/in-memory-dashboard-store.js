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

import { randomUUID } from 'crypto';

/**
 * In-memory Dashboard/Tile persistence for the v1 ABV custom-dashboard prototype.
 *
 * Deliberately NOT durable — see the v1 plan: this is here so the UX can be validated
 * before committing to a real `spacecat-shared-data-access` entity + migration. State is
 * a module-level Map, so it resets on process restart/redeploy and is NOT shared across
 * Lambda containers in production; fine for local dev / a single-instance demo, not for
 * a real launch.
 *
 * Every method here is the interface a real persisted-entity implementation would also
 * need to satisfy, so swapping this module out later is a one-file change behind
 * `llmo-dashboards.js` — the controller and API contract don't change.
 */

const dashboardsById = new Map();

function now() {
  return new Date().toISOString();
}

// A dashboard is an org-level, top-level object — not partitioned by brand. It's
// visible regardless of which brand is selected in the UI; `Dashboard.controls` (not
// this scope check) is where a per-dashboard brand filter belongs, the same way it
// already carries date-range/platform/region controls for what a tile queries
// against. Checking `brandId` here was the exact bug the frontend mock deliberately
// avoided (see customDashboardsMockApi.ts's `getScopedStore`): it made a dashboard
// vanish the moment you switched brands, instead of just changing what its tiles
// show. `brandId` is still accepted/stored below (every route path includes it, and
// it's harmless to record which brand context a dashboard was created from) — it's
// just never used to gate access.
function assertOrgScope(dashboard, orgId) {
  return dashboard.orgId === orgId;
}

export function resetStore() {
  dashboardsById.clear();
}

export function listDashboards({
  orgId, ownerId, filter, search,
}) {
  const all = [...dashboardsById.values()]
    .filter((d) => assertOrgScope(d, orgId));

  const visible = all.filter((d) => (
    d.ownerId === ownerId
    || d.visibility === 'org'
    || d.sharedWith.some((share) => share.userId === ownerId)
  ));

  let filtered = visible;
  if (filter === 'mine') {
    filtered = visible.filter((d) => d.ownerId === ownerId);
  } else if (filter === 'shared') {
    filtered = visible.filter((d) => d.ownerId !== ownerId);
  } else if (filter === 'starred') {
    filtered = visible.filter((d) => d.starredBy.includes(ownerId));
  }

  if (search) {
    const needle = search.toLowerCase();
    filtered = filtered.filter((d) => d.name.toLowerCase().includes(needle)
      || d.description?.toLowerCase().includes(needle));
  }

  return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getDashboard({ id, orgId }) {
  const dashboard = dashboardsById.get(id);
  if (!dashboard || !assertOrgScope(dashboard, orgId)) {
    return null;
  }
  return dashboard;
}

export function createDashboard({
  orgId, brandId, ownerId, name, description, visibility, controls,
}) {
  const id = randomUUID();
  const timestamp = now();
  const dashboard = {
    id,
    orgId,
    brandId,
    ownerId,
    name,
    description: description ?? '',
    visibility: visibility ?? 'private',
    sharedWith: [],
    controls: controls ?? [],
    sections: [],
    tiles: [],
    starredBy: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    schemaVersion: 1,
  };
  dashboardsById.set(id, dashboard);
  return dashboard;
}

export function updateDashboard({
  id, orgId, brandId, patch,
}) {
  const dashboard = getDashboard({ id, orgId, brandId });
  if (!dashboard) {
    return null;
  }
  const updated = {
    ...dashboard,
    ...patch,
    id: dashboard.id,
    orgId: dashboard.orgId,
    brandId: dashboard.brandId,
    updatedAt: now(),
  };
  dashboardsById.set(id, updated);
  return updated;
}

export function deleteDashboard({ id, orgId, brandId }) {
  const dashboard = getDashboard({ id, orgId, brandId });
  if (!dashboard) {
    return false;
  }
  dashboardsById.delete(id);
  return true;
}

export function duplicateDashboard({
  id, orgId, brandId, ownerId, name,
}) {
  const source = getDashboard({ id, orgId, brandId });
  if (!source) {
    return null;
  }
  const newId = randomUUID();
  const timestamp = now();
  const copy = {
    ...source,
    id: newId,
    ownerId,
    name: name ?? `${source.name} (copy)`,
    visibility: 'private',
    sharedWith: [],
    starredBy: [],
    tiles: source.tiles.map((tile) => ({ ...tile, id: randomUUID() })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  dashboardsById.set(newId, copy);
  return copy;
}

export function setStarred({
  id, orgId, brandId, userId, starred,
}) {
  const dashboard = getDashboard({ id, orgId, brandId });
  if (!dashboard) {
    return null;
  }
  const starredBy = starred
    ? [...new Set([...dashboard.starredBy, userId])]
    : dashboard.starredBy.filter((u) => u !== userId);
  return updateDashboard({
    id, orgId, brandId, patch: { starredBy },
  });
}

export function addTile({
  id, orgId, brandId, tile,
}) {
  const dashboard = getDashboard({ id, orgId, brandId });
  if (!dashboard) {
    return null;
  }
  const newTile = { ...tile, id: randomUUID() };
  const tiles = [...dashboard.tiles, newTile];
  return {
    dashboard: updateDashboard({
      id, orgId, brandId, patch: { tiles },
    }),
    tile: newTile,
  };
}

export function updateTile({
  id, orgId, brandId, tileId, patch,
}) {
  const dashboard = getDashboard({ id, orgId, brandId });
  if (!dashboard) {
    return null;
  }
  let updatedTile = null;
  const tiles = dashboard.tiles.map((tile) => {
    if (tile.id !== tileId) {
      return tile;
    }
    updatedTile = { ...tile, ...patch, id: tile.id };
    return updatedTile;
  });
  if (!updatedTile) {
    return null;
  }
  return {
    dashboard: updateDashboard({
      id, orgId, brandId, patch: { tiles },
    }),
    tile: updatedTile,
  };
}

export function removeTile({
  id, orgId, brandId, tileId,
}) {
  const dashboard = getDashboard({ id, orgId, brandId });
  if (!dashboard) {
    return null;
  }
  if (!dashboard.tiles.some((tile) => tile.id === tileId)) {
    return null;
  }
  const tiles = dashboard.tiles.filter((tile) => tile.id !== tileId);
  return updateDashboard({
    id, orgId, brandId, patch: { tiles },
  });
}
