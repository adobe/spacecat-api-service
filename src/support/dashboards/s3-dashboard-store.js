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
 * S3-backed Dashboard/Tile store for ABV custom dashboards.
 *
 * Each dashboard is a single JSON object stored at:
 *   dashboards/{orgId}/{dashboardId}.json
 *
 * Dashboards are org-scoped — `brandId` is stored for context but is never used
 * as an access gate: a dashboard must not vanish when the user switches brands.
 *
 * Every exported function is async and accepts the caller's `context.s3` object
 * (injected by `s3ClientWrapper` in `src/support/s3.js`) plus the bucket name from
 * `context.env.S3_DASHBOARDS_BUCKET`.
 */

function now() {
  return new Date().toISOString();
}

function dashboardKey(orgId, dashboardId) {
  return `dashboards/${orgId}/${dashboardId}.json`;
}

async function s3Get(s3, bucket, orgId, dashboardId) {
  try {
    const cmd = new s3.GetObjectCommand({ Bucket: bucket, Key: dashboardKey(orgId, dashboardId) });
    const res = await s3.s3Client.send(cmd);
    const body = await res.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    if (err.name === 'NoSuchKey') {
      return null;
    }
    throw err;
  }
}

async function s3Put(s3, bucket, dashboard) {
  const cmd = new s3.PutObjectCommand({
    Bucket: bucket,
    Key: dashboardKey(dashboard.orgId, dashboard.id),
    Body: JSON.stringify(dashboard),
    ContentType: 'application/json',
  });
  await s3.s3Client.send(cmd);
  return dashboard;
}

async function s3Delete(s3, bucket, orgId, dashboardId) {
  await s3.s3Client.send(new s3.DeleteObjectCommand({
    Bucket: bucket,
    Key: dashboardKey(orgId, dashboardId),
  }));
}

async function s3ListAll(s3, bucket, orgId) {
  const prefix = `dashboards/${orgId}/`;
  const keys = [];
  let continuationToken;
  do {
    // eslint-disable-next-line no-await-in-loop
    const res = await s3.s3Client.send(new s3.ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }));
    for (const obj of (res.Contents ?? [])) {
      keys.push(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  const dashboards = await Promise.all(
    keys.map((key) => {
      const dashboardId = key.slice(prefix.length, -'.json'.length);
      return s3Get(s3, bucket, orgId, dashboardId);
    }),
  );
  return dashboards.filter(Boolean);
}

export async function listDashboards(s3, bucket, {
  orgId, ownerId, filter, search,
}) {
  const all = await s3ListAll(s3, bucket, orgId);

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

export async function getDashboard(s3, bucket, { id, orgId }) {
  return s3Get(s3, bucket, orgId, id);
}

export async function createDashboard(s3, bucket, {
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
  await s3Put(s3, bucket, dashboard);
  return dashboard;
}

export async function updateDashboard(s3, bucket, { id, orgId, patch }) {
  const dashboard = await getDashboard(s3, bucket, { id, orgId });
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
  await s3Put(s3, bucket, updated);
  return updated;
}

export async function deleteDashboard(s3, bucket, { id, orgId }) {
  const dashboard = await getDashboard(s3, bucket, { id, orgId });
  if (!dashboard) {
    return false;
  }
  await s3Delete(s3, bucket, orgId, id);
  return true;
}

export async function duplicateDashboard(s3, bucket, {
  id, orgId, ownerId, name,
}) {
  const source = await getDashboard(s3, bucket, { id, orgId });
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
  await s3Put(s3, bucket, copy);
  return copy;
}

export async function setStarred(s3, bucket, {
  id, orgId, userId, starred,
}) {
  const dashboard = await getDashboard(s3, bucket, { id, orgId });
  if (!dashboard) {
    return null;
  }
  const starredBy = starred
    ? [...new Set([...dashboard.starredBy, userId])]
    : dashboard.starredBy.filter((u) => u !== userId);
  return updateDashboard(s3, bucket, { id, orgId, patch: { starredBy } });
}

export async function addTile(s3, bucket, { id, orgId, tile }) {
  const dashboard = await getDashboard(s3, bucket, { id, orgId });
  if (!dashboard) {
    return null;
  }
  const newTile = { ...tile, id: randomUUID() };
  const tiles = [...dashboard.tiles, newTile];
  return {
    dashboard: await updateDashboard(s3, bucket, { id, orgId, patch: { tiles } }),
    tile: newTile,
  };
}

export async function updateTile(s3, bucket, {
  id, orgId, tileId, patch,
}) {
  const dashboard = await getDashboard(s3, bucket, { id, orgId });
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
    dashboard: await updateDashboard(s3, bucket, { id, orgId, patch: { tiles } }),
    tile: updatedTile,
  };
}

export async function removeTile(s3, bucket, { id, orgId, tileId }) {
  const dashboard = await getDashboard(s3, bucket, { id, orgId });
  if (!dashboard) {
    return null;
  }
  if (!dashboard.tiles.some((tile) => tile.id === tileId)) {
    return null;
  }
  const tiles = dashboard.tiles.filter((tile) => tile.id !== tileId);
  return updateDashboard(s3, bucket, { id, orgId, patch: { tiles } });
}
