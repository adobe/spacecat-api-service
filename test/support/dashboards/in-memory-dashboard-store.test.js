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

import { expect } from 'chai';
import * as store from '../../../src/support/dashboards/in-memory-dashboard-store.js';

describe('in-memory-dashboard-store', () => {
  const orgId = 'org-1';
  const brandId = 'brand-1';
  const ownerId = 'owner@example.com';
  const otherId = 'other@example.com';

  beforeEach(() => {
    store.resetStore();
  });

  it('creates a dashboard with sensible defaults', () => {
    const dashboard = store.createDashboard({
      orgId, brandId, ownerId, name: 'My Dashboard',
    });
    expect(dashboard.id).to.be.a('string');
    expect(dashboard.visibility).to.equal('private');
    expect(dashboard.tiles).to.deep.equal([]);
    expect(dashboard.schemaVersion).to.equal(1);
  });

  it('scopes get/list to the org and brand', () => {
    const dashboard = store.createDashboard({
      orgId, brandId, ownerId, name: 'D1',
    });
    expect(store.getDashboard({ id: dashboard.id, orgId, brandId })).to.not.be.null;
    expect(store.getDashboard({ id: dashboard.id, orgId: 'other-org', brandId })).to.be.null;
    expect(store.getDashboard({ id: dashboard.id, orgId, brandId: 'other-brand' })).to.be.null;
  });

  it('list only returns dashboards visible to the caller (owner, org-visible, or shared)', () => {
    const mine = store.createDashboard({
      orgId, brandId, ownerId, name: 'Mine',
    });
    const orgVisible = store.createDashboard({
      orgId, brandId, ownerId: otherId, name: 'Org', visibility: 'org',
    });
    store.createDashboard({
      orgId, brandId, ownerId: otherId, name: 'PrivateOther',
    });

    const visible = store.listDashboards({ orgId, brandId, ownerId });
    const ids = visible.map((d) => d.id);
    expect(ids).to.include(mine.id);
    expect(ids).to.include(orgVisible.id);
    expect(ids).to.have.lengthOf(2);
  });

  it('filters by mine/shared/starred', () => {
    const mine = store.createDashboard({
      orgId, brandId, ownerId, name: 'Mine',
    });
    const orgVisible = store.createDashboard({
      orgId, brandId, ownerId: otherId, name: 'Org', visibility: 'org',
    });
    store.setStarred({
      id: orgVisible.id, orgId, brandId, userId: ownerId, starred: true,
    });

    expect(store.listDashboards({
      orgId, brandId, ownerId, filter: 'mine',
    }).map((d) => d.id))
      .to.deep.equal([mine.id]);
    expect(store.listDashboards({
      orgId, brandId, ownerId, filter: 'shared',
    }).map((d) => d.id))
      .to.deep.equal([orgVisible.id]);
    expect(store.listDashboards({
      orgId, brandId, ownerId, filter: 'starred',
    }).map((d) => d.id))
      .to.deep.equal([orgVisible.id]);
  });

  it('searches by name/description', () => {
    store.createDashboard({
      orgId, brandId, ownerId, name: 'Visibility overview',
    });
    store.createDashboard({
      orgId, brandId, ownerId, name: 'Something else',
    });
    const results = store.listDashboards({
      orgId, brandId, ownerId, search: 'visibility',
    });
    expect(results).to.have.lengthOf(1);
    expect(results[0].name).to.equal('Visibility overview');
  });

  it('updates a dashboard and bumps updatedAt', async () => {
    const dashboard = store.createDashboard({
      orgId, brandId, ownerId, name: 'D1',
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    const updated = store.updateDashboard({
      id: dashboard.id, orgId, brandId, patch: { name: 'D1 renamed' },
    });
    expect(updated.name).to.equal('D1 renamed');
    expect(updated.updatedAt >= dashboard.updatedAt).to.be.true;
    expect(updated.id).to.equal(dashboard.id);
  });

  it('deletes a dashboard', () => {
    const dashboard = store.createDashboard({
      orgId, brandId, ownerId, name: 'D1',
    });
    expect(store.deleteDashboard({ id: dashboard.id, orgId, brandId })).to.be.true;
    expect(store.getDashboard({ id: dashboard.id, orgId, brandId })).to.be.null;
    expect(store.deleteDashboard({ id: dashboard.id, orgId, brandId })).to.be.false;
  });

  it('duplicates a dashboard with a fresh id, reset sharing, and copied tiles', () => {
    const dashboard = store.createDashboard({
      orgId, brandId, ownerId, name: 'D1', visibility: 'org',
    });
    const { tile } = store.addTile({
      id: dashboard.id,
      orgId,
      brandId,
      tile: {
        title: 'Tile 1', analysis: {}, visualization: {}, layout: {},
      },
    });
    store.setStarred({
      id: dashboard.id, orgId, brandId, userId: otherId, starred: true,
    });

    const copy = store.duplicateDashboard({
      id: dashboard.id, orgId, brandId, ownerId: otherId,
    });
    expect(copy.id).to.not.equal(dashboard.id);
    expect(copy.ownerId).to.equal(otherId);
    expect(copy.name).to.equal('D1 (copy)');
    expect(copy.visibility).to.equal('private');
    expect(copy.starredBy).to.deep.equal([]);
    expect(copy.tiles).to.have.lengthOf(1);
    expect(copy.tiles[0].id).to.not.equal(tile.id);
    expect(copy.tiles[0].title).to.equal('Tile 1');
  });

  it('stars and unstars a dashboard per-user', () => {
    const dashboard = store.createDashboard({
      orgId, brandId, ownerId, name: 'D1',
    });
    const starred = store.setStarred({
      id: dashboard.id, orgId, brandId, userId: otherId, starred: true,
    });
    expect(starred.starredBy).to.deep.equal([otherId]);
    const unstarred = store.setStarred({
      id: dashboard.id, orgId, brandId, userId: otherId, starred: false,
    });
    expect(unstarred.starredBy).to.deep.equal([]);
  });

  describe('tiles', () => {
    let dashboard;

    beforeEach(() => {
      dashboard = store.createDashboard({
        orgId, brandId, ownerId, name: 'D1',
      });
    });

    it('adds a tile with a generated id', () => {
      const { tile, dashboard: updated } = store.addTile({
        id: dashboard.id,
        orgId,
        brandId,
        tile: {
          title: 'Tile 1', analysis: {}, visualization: {}, layout: {},
        },
      });
      expect(tile.id).to.be.a('string');
      expect(updated.tiles).to.have.lengthOf(1);
    });

    it('updates a tile in place', () => {
      const { tile } = store.addTile({
        id: dashboard.id,
        orgId,
        brandId,
        tile: {
          title: 'Tile 1', analysis: {}, visualization: {}, layout: {},
        },
      });
      const result = store.updateTile({
        id: dashboard.id, orgId, brandId, tileId: tile.id, patch: { title: 'Renamed' },
      });
      expect(result.tile.title).to.equal('Renamed');
      expect(result.tile.id).to.equal(tile.id);
    });

    it('returns null when updating a tile that does not exist', () => {
      const result = store.updateTile({
        id: dashboard.id, orgId, brandId, tileId: 'missing', patch: { title: 'x' },
      });
      expect(result).to.be.null;
    });

    it('removes a tile', () => {
      const { tile } = store.addTile({
        id: dashboard.id,
        orgId,
        brandId,
        tile: {
          title: 'Tile 1', analysis: {}, visualization: {}, layout: {},
        },
      });
      const updated = store.removeTile({
        id: dashboard.id, orgId, brandId, tileId: tile.id,
      });
      expect(updated.tiles).to.deep.equal([]);
    });

    it('returns null when removing a tile that does not exist', () => {
      const result = store.removeTile({
        id: dashboard.id, orgId, brandId, tileId: 'missing',
      });
      expect(result).to.be.null;
    });
  });
});
