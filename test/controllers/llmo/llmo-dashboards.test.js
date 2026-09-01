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
import sinon from 'sinon';
import esmock from 'esmock';

/**
 * Minimal in-memory S3 fake for testing the S3 dashboard store.
 * Uses plain constructor functions (not ES6 classes) to stay within max-classes-per-file.
 */
// eslint-disable-next-line prefer-arrow-callback
function makeFakeS3() {
  const objects = new Map();

  /* eslint-disable func-names */
  function GetObjectCommand(params) {
    this.type = 'GET';
    this.params = params;
  }
  function PutObjectCommand(params) {
    this.type = 'PUT';
    this.params = params;
  }
  function DeleteObjectCommand(params) {
    this.type = 'DELETE';
    this.params = params;
  }
  function ListObjectsV2Command(params) {
    this.type = 'LIST';
    this.params = params;
  }
  /* eslint-enable func-names */

  const s3Client = {
    async send(cmd) {
      const { type, params } = cmd;
      if (type === 'PUT') {
        objects.set(params.Key, params.Body);
        return {};
      }
      if (type === 'DELETE') {
        objects.delete(params.Key);
        return {};
      }
      if (type === 'GET') {
        const body = objects.get(params.Key);
        if (body === undefined) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return { Body: { transformToString: async () => body } };
      }
      if (type === 'LIST') {
        const prefix = params.Prefix ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
        return {
          Contents: keys.map((Key) => ({ Key })),
          IsTruncated: false,
          NextContinuationToken: undefined,
        };
      }
      throw new Error(`Unknown S3 command type: ${type}`);
    },
  };

  return {
    s3Client,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
  };
}

describe('LlmoDashboardsController', () => {
  let sandbox;
  let mockContext;
  let mockOrganization;
  let LlmoDashboardsController;

  const asUser = (email) => ({
    ...mockContext,
    attributes: { authInfo: { getProfile: () => ({ email }) } },
  });

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mockOrganization = { getId: sandbox.stub().returns('org-123') };

    LlmoDashboardsController = (await esmock('../../../src/controllers/llmo/llmo-dashboards.js', {
      '../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({ hasAccess: sandbox.stub().resolves(true) }),
        },
      },
    })).default;

    mockContext = {
      params: { spaceCatId: 'org-123', brandId: 'brand-123' },
      dataAccess: {
        Organization: { findById: sandbox.stub().resolves(mockOrganization) },
      },
      attributes: {
        authInfo: { getProfile: () => ({ email: 'owner@example.com' }) },
      },
      data: {},
      s3: makeFakeS3(),
      env: { S3_DASHBOARDS_BUCKET: 'test-bucket' },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('creates a dashboard owned by the caller', async () => {
    const controller = LlmoDashboardsController(mockContext);
    mockContext.data = { name: 'My Dashboard' };
    const response = await controller.createDashboard(mockContext);
    expect(response.status).to.equal(201);
    const body = await response.json();
    expect(body.name).to.equal('My Dashboard');
    expect(body.ownerId).to.equal('owner@example.com');
  });

  it('includes ownerName from the caller\'s own IMS profile', async () => {
    const namedCtx = {
      ...mockContext,
      attributes: {
        authInfo: {
          getProfile: () => ({ email: 'owner@example.com', first_name: 'Ada', last_name: 'Lovelace' }),
        },
      },
      data: { name: 'My Dashboard' },
    };
    const controller = LlmoDashboardsController(namedCtx);
    const response = await controller.createDashboard(namedCtx);
    const body = await response.json();
    expect(body.ownerName).to.equal('Ada Lovelace');
  });

  it('omits ownerName for a dashboard viewed by someone other than its owner', async () => {
    const controller = LlmoDashboardsController(mockContext);
    const createResponse = await controller.createDashboard({
      ...mockContext, data: { name: 'D1', visibility: 'org' },
    });
    const { id } = await createResponse.json();
    const otherCtx = {
      ...asUser('other@example.com'),
      params: { ...mockContext.params, dashboardId: id },
    };
    otherCtx.attributes = {
      authInfo: {
        getProfile: () => ({ email: 'other@example.com', first_name: 'Grace', last_name: 'Hopper' }),
      },
    };
    const response = await controller.getDashboard(otherCtx);
    const body = await response.json();
    expect(body.ownerName).to.be.undefined;
  });

  it('rejects create without a name', async () => {
    const controller = LlmoDashboardsController(mockContext);
    mockContext.data = {};
    const response = await controller.createDashboard(mockContext);
    expect(response.status).to.equal(400);
  });

  it('lists dashboards visible to the caller', async () => {
    const controller = LlmoDashboardsController(mockContext);
    await controller.createDashboard({ ...mockContext, data: { name: 'D1' } });
    const response = await controller.listDashboards(mockContext);
    const body = await response.json();
    expect(body.dashboards).to.have.lengthOf(1);
    expect(body.dashboards[0].name).to.equal('D1');
  });

  it('keeps a dashboard visible after switching the selected brand (org-scoped, not brand-scoped)', async () => {
    const controller = LlmoDashboardsController(mockContext);
    const createResponse = await controller.createDashboard({
      ...mockContext, params: { ...mockContext.params, brandId: 'brand-a' }, data: { name: 'D1' },
    });
    const { id } = await createResponse.json();

    const otherBrandCtx = { ...mockContext, params: { ...mockContext.params, brandId: 'brand-b' } };

    const listResponse = await controller.listDashboards(otherBrandCtx);
    const listBody = await listResponse.json();
    expect(listBody.dashboards.map((d) => d.id)).to.include(id);

    otherBrandCtx.params = { ...otherBrandCtx.params, dashboardId: id };
    const getResponse = await controller.getDashboard(otherBrandCtx);
    expect(getResponse.status).to.equal(200);
  });

  it('404s getDashboard for an unknown id', async () => {
    const controller = LlmoDashboardsController(mockContext);
    mockContext.params.dashboardId = 'missing';
    const response = await controller.getDashboard(mockContext);
    expect(response.status).to.equal(404);
  });

  it('404s getDashboard for a private dashboard the caller cannot see', async () => {
    const controller = LlmoDashboardsController(mockContext);
    const createResponse = await controller.createDashboard({
      ...mockContext, data: { name: 'D1' },
    });
    const { id } = await createResponse.json();
    const otherCtx = asUser('other@example.com');
    otherCtx.params = { ...mockContext.params, dashboardId: id };
    const response = await controller.getDashboard(otherCtx);
    expect(response.status).to.equal(404);
  });

  it('allows viewing an org-visible dashboard from a different user', async () => {
    const controller = LlmoDashboardsController(mockContext);
    const createResponse = await controller.createDashboard({
      ...mockContext, data: { name: 'D1', visibility: 'org' },
    });
    const { id } = await createResponse.json();
    const otherCtx = asUser('other@example.com');
    otherCtx.params = { ...mockContext.params, dashboardId: id };
    const response = await controller.getDashboard(otherCtx);
    expect(response.status).to.equal(200);
  });

  it('forbids a non-owner/non-editor from updating a dashboard', async () => {
    const controller = LlmoDashboardsController(mockContext);
    const createResponse = await controller.createDashboard({
      ...mockContext, data: { name: 'D1', visibility: 'org' },
    });
    const { id } = await createResponse.json();
    const otherCtx = asUser('other@example.com');
    otherCtx.params = { ...mockContext.params, dashboardId: id };
    otherCtx.data = { name: 'Renamed' };
    const response = await controller.updateDashboard(otherCtx);
    expect(response.status).to.equal(403);
  });

  it('forbids an editor (non-owner) from changing dashboard visibility', async () => {
    const controller = LlmoDashboardsController(mockContext);
    const createResponse = await controller.createDashboard({
      ...mockContext, data: { name: 'D1', visibility: 'private' },
    });
    const { id } = await createResponse.json();
    mockContext.params.dashboardId = id;
    mockContext.data = {
      sharedWith: [{ userId: 'editor@example.com', role: 'editor' }],
    };
    await controller.updateDashboard(mockContext);

    const editorCtx = asUser('editor@example.com');
    editorCtx.params = { ...mockContext.params, dashboardId: id };
    editorCtx.data = { visibility: 'org' };
    const response = await controller.updateDashboard(editorCtx);
    expect(response.status).to.equal(403);
  });

  it('allows the owner to change dashboard visibility', async () => {
    const controller = LlmoDashboardsController(mockContext);
    const createResponse = await controller.createDashboard({
      ...mockContext, data: { name: 'D1', visibility: 'private' },
    });
    const { id } = await createResponse.json();
    mockContext.params.dashboardId = id;
    mockContext.data = { visibility: 'org' };
    const response = await controller.updateDashboard(mockContext);
    expect(response.status).to.equal(200);
    expect((await response.json()).visibility).to.equal('org');
  });

  it('forbids a non-owner from deleting a dashboard', async () => {
    const controller = LlmoDashboardsController(mockContext);
    const createResponse = await controller.createDashboard({
      ...mockContext, data: { name: 'D1', visibility: 'org' },
    });
    const { id } = await createResponse.json();
    const otherCtx = asUser('other@example.com');
    otherCtx.params = { ...mockContext.params, dashboardId: id };
    const response = await controller.deleteDashboard(otherCtx);
    expect(response.status).to.equal(403);
  });

  it('owner can delete their dashboard', async () => {
    const controller = LlmoDashboardsController(mockContext);
    const createResponse = await controller.createDashboard({
      ...mockContext, data: { name: 'D1' },
    });
    const { id } = await createResponse.json();
    mockContext.params.dashboardId = id;
    const response = await controller.deleteDashboard(mockContext);
    expect(response.status).to.equal(204);
  });

  it('duplicates a dashboard for the caller', async () => {
    const controller = LlmoDashboardsController(mockContext);
    const createResponse = await controller.createDashboard({
      ...mockContext, data: { name: 'D1', visibility: 'org' },
    });
    const { id } = await createResponse.json();
    const otherCtx = asUser('other@example.com');
    otherCtx.params = { ...mockContext.params, dashboardId: id };
    const response = await controller.duplicateDashboard(otherCtx);
    expect(response.status).to.equal(201);
    const body = await response.json();
    expect(body.ownerId).to.equal('other@example.com');
    expect(body.id).to.not.equal(id);
  });

  it('stars and unstars a dashboard', async () => {
    const controller = LlmoDashboardsController(mockContext);
    const createResponse = await controller.createDashboard({
      ...mockContext, data: { name: 'D1' },
    });
    const { id } = await createResponse.json();
    mockContext.params.dashboardId = id;
    const starred = await (await controller.starDashboard(mockContext)).json();
    expect(starred.isStarred).to.be.true;
    const unstarred = await (await controller.unstarDashboard(mockContext)).json();
    expect(unstarred.isStarred).to.be.false;
  });

  describe('tiles', () => {
    let dashboardId;
    let controller;

    beforeEach(async () => {
      controller = LlmoDashboardsController(mockContext);
      const createResponse = await controller.createDashboard({
        ...mockContext, data: { name: 'D1' },
      });
      ({ id: dashboardId } = await createResponse.json());
      mockContext.params.dashboardId = dashboardId;
    });

    it('adds a tile', async () => {
      mockContext.data = {
        title: 'Tile 1', analysis: {}, visualization: {}, layout: { size: 'M' },
      };
      const response = await controller.addTile(mockContext);
      expect(response.status).to.equal(201);
      const tile = await response.json();
      expect(tile.title).to.equal('Tile 1');
    });

    it('rejects an incomplete tile', async () => {
      mockContext.data = { title: 'Tile 1' };
      const response = await controller.addTile(mockContext);
      expect(response.status).to.equal(400);
    });

    it('updates and removes a tile', async () => {
      mockContext.data = {
        title: 'Tile 1', analysis: {}, visualization: {}, layout: { size: 'M' },
      };
      const addResponse = await controller.addTile(mockContext);
      const { id: tileId } = await addResponse.json();

      mockContext.params.tileId = tileId;
      mockContext.data = { title: 'Renamed' };
      const updateResponse = await controller.updateTile(mockContext);
      expect((await updateResponse.json()).title).to.equal('Renamed');

      const removeResponse = await controller.removeTile(mockContext);
      expect(removeResponse.status).to.equal(204);
    });

    it('rejects a tile update that would clear analysis/visualization without a snapshot', async () => {
      mockContext.data = {
        title: 'Tile 1', analysis: {}, visualization: {}, layout: { size: 'M' },
      };
      const addResponse = await controller.addTile(mockContext);
      const { id: tileId } = await addResponse.json();

      mockContext.params.tileId = tileId;
      mockContext.data = { analysis: null, visualization: null };
      const response = await controller.updateTile(mockContext);
      expect(response.status).to.equal(400);

      // The invalid patch must not have persisted.
      const getResponse = await controller.getDashboard(mockContext);
      const dashboard = await getResponse.json();
      const tile = dashboard.tiles.find((t) => t.id === tileId);
      expect(tile.analysis).to.deep.equal({});
    });
  });
});
