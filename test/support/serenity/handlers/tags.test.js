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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

import { TAG_IDS, dimensionTreeLevels, makeListProjectTagsStub } from '../fixtures/tag-tree.js';
import { SerenityTransportError } from '../../../../src/support/serenity/rest-transport.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = '11111111-2222-3333-4444-555555555555';
const WORKSPACE = '22222222-3333-4444-5555-666666666666';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

// The default transport serves the full dimension-root tree, so the four roots
// already exist and an open-dimension create hangs its value under the
// `category` root without provisioning anything.
function makeTransport(overrides = {}) {
  return {
    createProjectTags: sinon.stub().resolves([
      { id: 'tag-1', name: 'Footwear', parent_id: TAG_IDS.categoryRoot },
    ]),
    updateProjectTag: sinon.stub().resolves({
      id: TAG_IDS.categoryRunningShoes, name: 'Footwear', parent_id: TAG_IDS.categoryRoot,
    }),
    listProjectTags: makeListProjectTagsStub(),
    publishProject: sinon.stub().resolves({}),
    ...overrides,
  };
}

// A transport over a project that has NO tags at all — the shape of a project
// predating the taxonomy. `resolveTagTarget` resolves every id to 'unknown'.
function makeEmptyTreeTransport(overrides = {}) {
  return makeTransport({
    listProjectTags: makeListProjectTagsStub({ '': [] }),
    ...overrides,
  });
}

function makeDataAccess(findBySliceResult) {
  return {
    BrandSemrushProject: {
      findBySlice: sinon.stub().resolves(findBySliceResult),
    },
  };
}

const validBody = {
  type: 'category', name: 'Footwear', geoTargetId: 2840, languageCode: 'en',
};

describe('serenity tags handler (POST /serenity/tags)', () => {
  afterEach(() => sinon.restore());

  describe('handleCreateTag (flat mode)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('hangs a bare-named category under the category root and returns 201', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        validBody,
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body).to.include({
        brandId: BRAND,
        geoTargetId: 2840,
        languageCode: 'en',
        type: 'category',
        name: 'Footwear',
        parentId: TAG_IDS.categoryRoot,
      });
      // An omitted parentId means "directly under the dimension root", never
      // "at the root level" — the root level is reserved for the four roots.
      expect(transport.createProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', ['Footwear'], { parentId: TAG_IDS.categoryRoot });
      // A create leaves the project in `live_with_unpublished_updates`; the
      // handler republishes so the new tag is live, not a stranded draft.
      expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1');
    });

    it('still returns 201 when the post-create republish 405s on quota (left as draft)', async () => {
      const transport = makeTransport({
        publishProject: sinon.stub().rejects(new SerenityTransportError(405, 'quota')),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        validBody,
        fakeLog(),
      );
      // The quota-405 disguise is swallowed by republishBestEffort — the create
      // itself must not fail just because the follow-up publish was rejected.
      expect(res.status).to.equal(201);
      expect(transport.publishProject).to.have.been.calledOnce;
    });

    it('propagates a non-405 republish failure (create hard-fails)', async () => {
      const transport = makeTransport({
        publishProject: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        validBody,
        fakeLog(),
      )).to.be.rejectedWith('boom');
    });

    it('provisions the four dimension roots on a project that predates the taxonomy', async () => {
      const createProjectTags = sinon.stub();
      createProjectTags.onFirstCall().resolves([
        { id: 'r-category', name: 'category' },
        { id: 'r-tag', name: 'tag' },
        { id: 'r-intent', name: 'intent' },
        { id: 'r-origin', name: 'origin' },
        { id: 'r-type', name: 'type' },
      ]);
      createProjectTags.onSecondCall().resolves([
        { id: 'new-cat', name: 'Footwear', parent_id: 'r-category' },
      ]);
      const transport = makeEmptyTreeTransport({ createProjectTags });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });

      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        validBody,
        fakeLog(),
      );

      expect(res.status).to.equal(201);
      expect(createProjectTags.firstCall.args[2]).to.deep.equal(['category', 'tag', 'intent', 'origin', 'type']);
      expect(createProjectTags.secondCall.args[2]).to.deep.equal(['Footwear']);
      expect(createProjectTags.secondCall.args[3]).to.deep.equal({ parentId: 'r-category' });
      expect(res.body).to.include({ id: 'new-cat', parentId: 'r-category' });
    });

    // Upstream tag writes land in the project's DRAFT layer while a default read
    // serves the LIVE view, so a root create can answer 201, echo nothing, and
    // leave the re-read of the root level exactly as empty as it was. The open
    // dimension then has no root to hang the new category under. Hanging it at
    // the root level instead would mint a fifth root that looks like a customer
    // category, so this fails the request rather than guessing a parent.
    it('502s when the open dimension root cannot be resolved after provisioning', async () => {
      const transport = makeEmptyTreeTransport({
        createProjectTags: sinon.stub().resolves([]),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });

      const err = await handler
        .handleCreateTag(transport, dataAccess, BRAND, WORKSPACE, validBody, fakeLog())
        .then(() => null, (e) => e);

      expect(err, 'the handler must reject').to.not.equal(null);
      expect(err.status).to.equal(502);
      expect(err.message).to.match(/did not persist the tag\(s\)/);
      // The roots were attempted; the category itself never was.
      expect(transport.createProjectTags).to.have.been.calledOnce;
      expect(transport.createProjectTags.firstCall.args[2])
        .to.deep.equal(['category', 'tag', 'intent', 'origin', 'type']);
    });

    it('502s when the upstream create response carries no usable id', async () => {
      // A 201 whose body names no id would otherwise ship as `201 { id: undefined }`:
      // the client is told its tag exists and given nothing to attach a prompt to.
      const transport = makeTransport({ createProjectTags: sinon.stub().resolves([{}]) });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const err = await handler
        .handleCreateTag(transport, dataAccess, BRAND, WORKSPACE, validBody, fakeLog())
        .then(() => null, (e) => e);

      expect(err, 'the handler must reject').to.not.equal(null);
      expect(err.status).to.equal(502);
      expect(err.message).to.match(/echoed no id/);
    });

    // `topic` was a dimension under the prefix model; the dimension-root model
    // has exactly four roots and `topic` is not one of them.
    it('400s the retired topic dimension', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, type: 'topic', name: 'Running Shoes' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    // A value may not shadow a dimension root's name: at the level that matters
    // a reader could not tell the two apart.
    it('400s a name that shadows a reserved dimension root', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      for (const name of ['category', 'tag', 'intent', 'origin', 'type']) {
        // eslint-disable-next-line no-await-in-loop
        await expect(handler.handleCreateTag(
          transport,
          dataAccess,
          BRAND,
          WORKSPACE,
          { ...validBody, name },
          fakeLog(),
        )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s the legacy `source` name too while the origin rename is in flight', async () => {
      // Migration-window guard: until WP-O6, `source` is reserved alongside the four
      // roots so a customer cannot mint a tag that collides with the legacy authorship
      // root the tolerant resolver still adopts.
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, name: 'source' },
        fakeLog(),
      )).to.be.rejected.then((err) => {
        expect(err.status).to.equal(400);
        // The domain guard, not a generic schema rejection.
        expect(err.message).to.match(/reserved dimension root name/);
      });
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('404s (marketNotFound) when no project backs the slice', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess(null);
      await expect(
        handler.handleCreateTag(transport, dataAccess, BRAND, WORKSPACE, validBody, fakeLog()),
      ).to.be.rejected.then((err) => {
        expect(err.status).to.equal(404);
        expect(err.code).to.equal('marketNotFound');
      });
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s when type is not a recognized open or closed dimension', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      for (const type of ['bogus', '', undefined]) {
        // eslint-disable-next-line no-await-in-loop
        await expect(handler.handleCreateTag(
          transport,
          dataAccess,
          BRAND,
          WORKSPACE,
          { ...validBody, type },
          fakeLog(),
        )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s when name is missing, too long, contains a colon, or has control characters', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const bad = [
        { ...validBody, name: undefined },
        { ...validBody, name: '   ' },
        { ...validBody, name: 'x'.repeat(101) },
        { ...validBody, name: 'category:smuggled' },
        { ...validBody, name: 'bad\u0000name' },
        { ...validBody, name: 'tab\there' },
      ];
      for (const body of bad) {
        // eslint-disable-next-line no-await-in-loop
        await expect(
          handler.handleCreateTag(transport, dataAccess, BRAND, WORKSPACE, body, fakeLog()),
        ).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s on a non-positive geoTargetId or malformed languageCode', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const bad = [
        { ...validBody, geoTargetId: 0 },
        { ...validBody, geoTargetId: 'abc' },
        { ...validBody, languageCode: 'EN_US!' },
        { ...validBody, languageCode: '' },
      ];
      for (const body of bad) {
        // eslint-disable-next-line no-await-in-loop
        await expect(
          handler.handleCreateTag(transport, dataAccess, BRAND, WORKSPACE, body, fakeLog()),
        ).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
    });
  });

  describe('handleCreateTag — closed dimensions (source/intent/type)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('creates a closed-dimension value under its root when absent (200, created:true)', async () => {
      // The `source` root exists but is empty, so `ai` must be minted beneath it.
      const levels = dimensionTreeLevels();
      levels[TAG_IDS.originRoot] = [];
      const transport = makeTransport({
        listProjectTags: makeListProjectTagsStub(levels),
        createProjectTags: sinon.stub().resolves([
          { id: 'tag-source-ai', name: 'ai', parent_id: TAG_IDS.originRoot },
        ]),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        {
          type: 'origin', name: 'ai', geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({
        type: 'origin', name: 'ai', id: 'tag-source-ai', parentId: TAG_IDS.originRoot, created: true,
      });
      // A closed value is a CHILD of its dimension root, never a root itself.
      expect(transport.createProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', ['ai'], { parentId: TAG_IDS.originRoot });
    });

    it('resolves an EXISTING closed-dimension value without creating a duplicate (200, created:false)', async () => {
      // Upstream 500s on a duplicate (parent, name), so this must never re-create.
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        {
          type: 'intent', name: 'Informational', geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({
        type: 'intent',
        name: 'Informational',
        id: TAG_IDS.intentInformational,
        parentId: TAG_IDS.intentRoot,
        created: false,
      });
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('resolves Navigational — the intent value real projects carry', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        {
          type: 'intent', name: 'Navigational', geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({ id: TAG_IDS.intentNavigational, created: false });
    });

    it('400s a closed-dimension value not in the fixed enum', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        {
          type: 'type', name: 'bogus-value', geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s a closed-dimension create that carries a parentId', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        {
          type: 'origin', name: 'ai', geoTargetId: 2840, languageCode: 'en', parentId: 'root-1',
        },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.createProjectTags).to.not.have.been.called;
    });
  });

  describe('handleCreateTagSubworkspace', () => {
    it('resolves the project from the live listing and registers the tag', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      const res = await handler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        validBody,
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body).to.include({
        type: 'category', name: 'Footwear', parentId: TAG_IDS.categoryRoot,
      });
      expect(res.body).to.not.have.property('brandId');
      expect(resolveProjectStub).to.have.been.calledOnceWithExactly(
        transport,
        WORKSPACE,
        2840,
        'en',
        sinon.match.any,
      );
      expect(transport.createProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-sub-1', ['Footwear'], { parentId: TAG_IDS.categoryRoot });
    });

    it('404s (marketNotFound) when the slice has no live project', async () => {
      const resolveProjectStub = sinon.stub().resolves(null);
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      await expect(handler.handleCreateTagSubworkspace(transport, WORKSPACE, validBody, fakeLog()))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(404);
          expect(err.code).to.equal('marketNotFound');
        });
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s on a bad body before resolving any project', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      await expect(handler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        { ...validBody, type: 'bogus' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(resolveProjectStub).to.not.have.been.called;
    });

    it('nests a sub-category under the supplied parentId (twin of the flat-mode fix)', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport({
        createProjectTags: sinon.stub().resolves([
          { id: 'child-1', name: 'Sneakers', parent_id: TAG_IDS.categoryRunningShoes },
        ]),
      });
      const res = await handler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        {
          type: 'category',
          name: 'Sneakers',
          geoTargetId: 2840,
          languageCode: 'en',
          parentId: TAG_IDS.categoryRunningShoes,
        },
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body).to.include({
        name: 'Sneakers', id: 'child-1', parentId: TAG_IDS.categoryRunningShoes,
      });
      expect(transport.createProjectTags).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-sub-1',
        ['Sneakers'],
        { parentId: TAG_IDS.categoryRunningShoes },
      );
    });

    it('resolves a closed-dimension tag (twin of the flat-mode fix)', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      const res = await handler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        {
          type: 'type', name: 'branded', geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({
        type: 'type',
        name: 'branded',
        id: TAG_IDS.typeBranded,
        parentId: TAG_IDS.typeRoot,
        created: false,
      });
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('mints an absent closed-dimension value and republishes (200, created:true)', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      // The `source` root exists but is empty, so `ai` must be minted beneath it,
      // and a newly minted value must be published so it is live rather than draft.
      const levels = dimensionTreeLevels();
      levels[TAG_IDS.originRoot] = [];
      const transport = makeTransport({
        listProjectTags: makeListProjectTagsStub(levels),
        createProjectTags: sinon.stub().resolves([
          { id: 'tag-source-ai', name: 'ai', parent_id: TAG_IDS.originRoot },
        ]),
      });
      const res = await handler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        {
          type: 'origin', name: 'ai', geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({
        type: 'origin', name: 'ai', id: 'tag-source-ai', parentId: TAG_IDS.originRoot, created: true,
      });
      expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-sub-1');
    });
  });

  describe('handleCreateTag — nested (parentId)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('threads parentId to the transport, creating a sub-category under a category', async () => {
      const transport = makeTransport({
        createProjectTags: sinon.stub().resolves([
          { id: 'child-1', name: 'Sneakers', parent_id: TAG_IDS.categoryRunningShoes },
        ]),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        {
          type: 'category',
          name: 'Sneakers',
          geoTargetId: 2840,
          languageCode: 'en',
          parentId: TAG_IDS.categoryRunningShoes,
        },
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body).to.include({
        name: 'Sneakers', id: 'child-1', parentId: TAG_IDS.categoryRunningShoes,
      });
      expect(transport.createProjectTags).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        ['Sneakers'],
        { parentId: TAG_IDS.categoryRunningShoes },
      );
    });

    it('normalizes an empty parentId to the dimension root, never to the root level', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: '' },
        fakeLog(),
      );
      expect(transport.createProjectTags.firstCall.args[3])
        .to.deep.equal({ parentId: TAG_IDS.categoryRoot });
    });

    it('400s on a non-string parentId', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: 123 },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s on a parentId with whitespace/control chars', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: 'has space' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
    });

    it('nests under a parentId that resolves inside the category dimension', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: TAG_IDS.categoryRunningShoes },
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(transport.createProjectTags.firstCall.args[3])
        .to.deep.equal({ parentId: TAG_IDS.categoryRunningShoes });
    });

    it('400s a parentId that does not resolve on this market', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const err = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: '6f383e4e-d8e1-47bb-888e-1f93e8575567' },
        fakeLog(),
      ).then(() => null, (e) => e);

      expect(err.status).to.equal(400);
      expect(err.message).to.match(/does not resolve to a tag on this market/);
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    // `type` picks the validation branch, not the parent. Declaring the OPEN
    // dimension while pointing `parentId` at a CLOSED root would file a
    // customer-authored value under `intent` — the very thing the closed
    // vocabularies exist to prevent.
    it('400s a category create whose parentId is a closed dimension ROOT', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const err = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, name: 'ai', parentId: TAG_IDS.intentRoot },
        fakeLog(),
      ).then(() => null, (e) => e);

      expect(err.status).to.equal(400);
      expect(err.message).to.match(/must be the "category" dimension root or one of its descendants/);
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    // Comparing parentId against the three closed ROOT ids would pass this one:
    // the parent is a level deeper. Membership has to be decided by ancestry.
    it('400s a category create whose parentId is a value UNDER a closed root', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const err = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: TAG_IDS.originHuman },
        fakeLog(),
      ).then(() => null, (e) => e);

      expect(err.status).to.equal(400);
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s the subworkspace twin on the same cross-dimension parent', async () => {
      const subHandler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: sinon.stub().resolves({ id: 'proj-sub-1' }),
        },
      });
      const transport = makeTransport();
      const err = await subHandler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        { ...validBody, parentId: TAG_IDS.intentRoot },
        fakeLog(),
      ).then(() => null, (e) => e);

      expect(err.status).to.equal(400);
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('normalizes a whitespace-only parentId to the dimension root (trims to empty)', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: '   ' },
        fakeLog(),
      );
      expect(transport.createProjectTags.firstCall.args[3])
        .to.deep.equal({ parentId: TAG_IDS.categoryRoot });
    });

    it('400s on a parentId over the length ceiling', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: 'x'.repeat(201) },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.createProjectTags).to.not.have.been.called;
    });
  });

  describe('handleUpdateTag (flat mode) — PATCH /serenity/tags/:tagId', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    // The PATCH target is a real category in the tree, so it resolves as a
    // descendant. Bare name, explicit parent.
    const TARGET = TAG_IDS.categoryRunningShoes;
    const updateBody = {
      name: 'Footwear', parentId: TAG_IDS.categoryRoot, geoTargetId: 2840, languageCode: 'en',
    };

    it('re-parents/renames via the transport and returns 200', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TARGET,
        updateBody,
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({
        brandId: BRAND, tagId: TARGET, name: 'Footwear', parentId: TAG_IDS.categoryRoot,
      });
      expect(transport.updateProjectTag)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', TARGET, { name: 'Footwear', parentId: TAG_IDS.categoryRoot });
    });

    // The load-bearing guard: an upstream PATCH that omits `parent_id` PROMOTES
    // the tag to a root (verified live). A rename-only request therefore has to
    // re-send the target's CURRENT parent, not omit the field.
    it('re-sends the current parent when only renaming (never omits parent_id)', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TARGET,
        { name: 'Renamed', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(transport.updateProjectTag.firstCall.args[3])
        .to.deep.equal({ name: 'Renamed', parentId: TAG_IDS.categoryRoot });
    });

    it('400s on a missing tagId', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, '', updateBody, fakeLog())).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s on a missing/blank name', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      for (const name of [undefined, '   ']) {
        // eslint-disable-next-line no-await-in-loop
        await expect(handler.handleUpdateTag(
          transport,
          dataAccess,
          BRAND,
          WORKSPACE,
          TARGET,
          { ...updateBody, name },
          fakeLog(),
        )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s on a name carrying a colon — names are bare, the dimension is the root', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TARGET,
        { ...updateBody, name: 'category:Footwear' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s on a rename to a reserved dimension root name', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      for (const name of ['category', 'tag', 'intent', 'origin', 'type']) {
        // eslint-disable-next-line no-await-in-loop
        await expect(handler.handleUpdateTag(
          transport,
          dataAccess,
          BRAND,
          WORKSPACE,
          TARGET,
          { ...updateBody, name },
          fakeLog(),
        )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s on a rename to the legacy `source` name during the migration window', async () => {
      // Mirrors the create-path guard: `source` is reserved until WP-O6, so a tag
      // cannot be renamed onto it any more than a fresh one can be minted with it.
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TARGET,
        { ...updateBody, name: 'source' },
        fakeLog(),
      )).to.be.rejected.then((err) => {
        expect(err.status).to.equal(400);
        expect(err.message).to.match(/reserved dimension root name/);
      });
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s on a name that is too long or carries control characters', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const bad = [
        { ...updateBody, name: 'x'.repeat(101) },
        { ...updateBody, name: 'bad\u0000name' },
      ];
      for (const body of bad) {
        // eslint-disable-next-line no-await-in-loop
        await expect(
          handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, TARGET, body, fakeLog()),
        ).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s on a non-positive geoTargetId or malformed languageCode', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const bad = [
        { ...updateBody, geoTargetId: 0 },
        { ...updateBody, languageCode: 'EN_US!' },
      ];
      for (const body of bad) {
        // eslint-disable-next-line no-await-in-loop
        await expect(
          handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, TARGET, body, fakeLog()),
        ).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
    });

    it('400s a non-string parentId', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TARGET,
        { ...updateBody, parentId: 123 },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    // Promote-to-root is never a legal request: the root level is reserved for
    // the four dimension roots, so a promoted tag would have no dimension.
    it('400s an explicit null parentId rather than promoting the tag to a root', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TARGET,
        { ...updateBody, parentId: null },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('treats a whitespace-only parentId as omission, re-sending the current parent', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, TARGET, { ...updateBody, parentId: '   ' }, fakeLog());
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', TARGET, { name: 'Footwear', parentId: TAG_IDS.categoryRoot });
    });

    it('404s (marketNotFound) when no project backs the slice', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess(null);
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TARGET,
        updateBody,
        fakeLog(),
      )).to.be.rejected.then((err) => {
        expect(err.status).to.equal(404);
        expect(err.code).to.equal('marketNotFound');
      });
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    // Without the target's current parent there is no body that preserves it,
    // and guessing would promote the tag — so an unresolvable id is refused
    // rather than forwarded.
    it('404s tagNotFound for an id absent from the tree, without calling upstream', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, 'ghost', updateBody, fakeLog()))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(404);
          expect(err.code).to.equal('tagNotFound');
        });
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s a PATCH targeting a dimension root', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      for (const rootId of [TAG_IDS.categoryRoot, TAG_IDS.typeRoot]) {
        // eslint-disable-next-line no-await-in-loop
        await expect(handler.handleUpdateTag(
          transport,
          dataAccess,
          BRAND,
          WORKSPACE,
          rootId,
          { name: 'Renamed', geoTargetId: 2840, languageCode: 'en' },
          fakeLog(),
        )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('propagates an upstream failure from the update call', async () => {
      const boom = Object.assign(new Error('upstream 502'), { status: 502 });
      const transport = makeTransport({ updateProjectTag: sinon.stub().rejects(boom) });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, TARGET, updateBody, fakeLog())).to.be.rejectedWith('upstream 502');
    });
  });

  describe('handleUpdateTag — descendant target (serenity-docs#24 §3.1 gate 5)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('resolves a DEPTH-3 sub-category and re-sends its category parent, not the dimension root', async () => {
      // `subCategoryHuman` sits two levels below the root, so a single
      // children-of-root lookup would never find it.
      const transport = makeTransport({
        updateProjectTag: sinon.stub().resolves({
          id: TAG_IDS.subCategoryHuman, name: 'Renamed', parent_id: TAG_IDS.categoryRunningShoes,
        }),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TAG_IDS.subCategoryHuman,
        { name: 'Renamed', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({ name: 'Renamed', parentId: TAG_IDS.categoryRunningShoes });
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        TAG_IDS.subCategoryHuman,
        { name: 'Renamed', parentId: TAG_IDS.categoryRunningShoes },
      );
    });

    it('falls back to the node it was found under when the upstream listing omits parent_id', async () => {
      const levels = dimensionTreeLevels();
      levels[TAG_IDS.categoryRoot] = [{
        id: TAG_IDS.categoryRunningShoes,
        name: 'Running Shoes',
        parent_id: TAG_IDS.categoryRoot,
        children_count: 1,
        path: [{ id: TAG_IDS.categoryRoot, name: 'category' }],
      }];
      // The child comes back with no parent_id at all (defensive upstream shape).
      levels[TAG_IDS.categoryRunningShoes] = [{
        id: 'child-1', name: 'Sneakers', children_count: 0,
      }];
      const transport = makeTransport({
        listProjectTags: makeListProjectTagsStub(levels),
        updateProjectTag: sinon.stub().resolves({
          id: 'child-1', name: 'SneakersRenamed', parent_id: TAG_IDS.categoryRunningShoes,
        }),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'child-1',
        { name: 'SneakersRenamed', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        'child-1',
        { name: 'SneakersRenamed', parentId: TAG_IDS.categoryRunningShoes },
      );
    });

    it('uses the CALLER-supplied parentId (not the current one) when explicitly re-parenting', async () => {
      const transport = makeTransport({
        updateProjectTag: sinon.stub().resolves({
          id: TAG_IDS.subCategoryHuman, name: 'human', parent_id: TAG_IDS.categoryRoot,
        }),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TAG_IDS.subCategoryHuman,
        {
          name: 'human', parentId: TAG_IDS.categoryRoot, geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        TAG_IDS.subCategoryHuman,
        { name: 'human', parentId: TAG_IDS.categoryRoot },
      );
    });

    // A closed-dimension value is a descendant too, so it is renameable through
    // the same path — the dimension root above it is what is protected.
    // The vocabulary is fixed. Every resolve-or-create keys on the bare name under
    // the root, so renaming `human` would make the next write mint a SECOND `human`
    // and silently orphan every prompt still carrying the first.
    it('400s a rename of a closed-dimension value', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const err = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TAG_IDS.originHuman,
        { name: 'manual', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      ).then(() => null, (e) => e);

      expect(err.status).to.equal(400);
      expect(err.message).to.match(/closed "origin" dimension cannot be renamed or re-parented/);
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s a re-parent that would move a category into another dimension', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const err = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TAG_IDS.categoryRunningShoes,
        {
          name: 'Running Shoes',
          parentId: TAG_IDS.originRoot,
          geoTargetId: 2840,
          languageCode: 'en',
        },
        fakeLog(),
      ).then(() => null, (e) => e);

      expect(err.status).to.equal(400);
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s a re-parent onto the tag itself', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const err = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TAG_IDS.categoryRunningShoes,
        {
          name: 'Running Shoes',
          parentId: TAG_IDS.categoryRunningShoes,
          geoTargetId: 2840,
          languageCode: 'en',
        },
        fakeLog(),
      ).then(() => null, (e) => e);

      expect(err.status).to.equal(400);
      expect(err.message).to.match(/must not be the tag itself/);
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    // The self-parent guard above is the depth-0 case of this one. Upstream stores
    // a parent pointer, not a tree, so it accepts `A.parent = B` when B already
    // descends from A. Both nodes then hang off nothing: every walk starts at the
    // roots, so neither is reachable, every later PATCH 404s, and no request can
    // undo the edge. The proxy is the only component that walks the tree.
    it('400s a re-parent onto one of the tag\'s own descendants', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const err = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        // `subcategory-human` is the child of `category-running-shoes`.
        TAG_IDS.categoryRunningShoes,
        {
          name: 'Running Shoes',
          parentId: TAG_IDS.subCategoryHuman,
          geoTargetId: 2840,
          languageCode: 'en',
        },
        fakeLog(),
      ).then(() => null, (e) => e);

      expect(err.status).to.equal(400);
      expect(err.message).to.match(/must not be a descendant of the tag/);
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    // The target and the prospective parent are placed by ONE traversal, against
    // one snapshot. Two walks would double the sequential upstream reads and could
    // observe the parent at two different positions.
    it('resolves the target and the new parent in a single tree walk', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TAG_IDS.categoryRunningShoes,
        {
          name: 'Footwear',
          parentId: TAG_IDS.categoryRoot,
          geoTargetId: 2840,
          languageCode: 'en',
        },
        fakeLog(),
      );
      // One root-level read (which places the `category` root) plus one read of
      // that root's children (which places the target). Never a second walk.
      expect(transport.listProjectTags).to.have.been.calledTwice;
    });

    it('re-parents a sub-category onto another category within the dimension', async () => {
      const transport = makeTransport({
        updateProjectTag: sinon.stub().resolves({
          id: TAG_IDS.subCategoryHuman, name: 'human', parent_id: TAG_IDS.categoryRoot,
        }),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TAG_IDS.subCategoryHuman,
        {
          name: 'human',
          parentId: TAG_IDS.categoryRoot,
          geoTargetId: 2840,
          languageCode: 'en',
        },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        TAG_IDS.subCategoryHuman,
        { name: 'human', parentId: TAG_IDS.categoryRoot },
      );
    });
  });

  describe('handleUpdateTag — tagId validation (MysticatBot review, PR 2737)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('400s a tagId over the length ceiling', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'x'.repeat(201),
        { name: 'Footwear', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.listProjectTags).to.not.have.been.called;
    });

    it('400s a tagId containing whitespace', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'tag one',
        { name: 'Footwear', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.listProjectTags).to.not.have.been.called;
    });

    it('400s a tagId containing a control character', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        `tag-${String.fromCharCode(7)}`,
        { name: 'Footwear', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.listProjectTags).to.not.have.been.called;
    });
  });

  describe('tag-tree walk bounds', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('skips a childless root without fetching its children', async () => {
      const transport = makeTransport({
        listProjectTags: makeListProjectTagsStub({
          '': [{
            id: 'root-empty', name: 'category', parent_id: null, children_count: 0, path: null,
          }],
        }),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'no-such-tag',
        { name: 'Whatever', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(404));
      // Only the roots-level call — the childless root is never drilled.
      expect(transport.listProjectTags).to.have.been.calledOnce;
    });

    // A per-level width cap would drop the tail of the level and report an
    // existing tag as absent. The walk visits every node instead, and is bounded
    // by total reads.
    function makeWideTreeTransport(rootCount, targetUnderRootIndex) {
      const roots = Array.from({ length: rootCount }, (unused, i) => ({
        id: `root-${i}`, name: `R${i}`, children_count: 1,
      }));
      const listProjectTags = sinon.stub().callsFake((ws, pid, opts) => {
        if (opts.parentId === '') {
          // Real pagination: 100 items/page (matches listProjectTagTree's LIMIT).
          const start = (opts.page - 1) * opts.limit;
          return Promise.resolve({
            page: opts.page, total: rootCount, items: roots.slice(start, start + opts.limit),
          });
        }
        if (opts.parentId === `root-${targetUnderRootIndex}`) {
          return Promise.resolve({
            page: 1,
            total: 1,
            items: [{
              id: 'deep-tag',
              name: 'Deep',
              parent_id: `root-${targetUnderRootIndex}`,
              children_count: 0,
              path: [{ id: `root-${targetUnderRootIndex}`, name: `R${targetUnderRootIndex}` }],
            }],
          });
        }
        return Promise.resolve({ page: 1, total: 0, items: [] });
      });
      return makeTransport({
        listProjectTags,
        updateProjectTag: sinon.stub().resolves({
          id: 'deep-tag', name: 'Renamed', parent_id: `root-${targetUnderRootIndex}`,
        }),
      });
    }

    it('finds a tag under the 101st root instead of 404ing it', async () => {
      const transport = makeWideTreeTransport(150, 100);
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'deep-tag',
        { name: 'Renamed', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        'deep-tag',
        { name: 'Renamed', parentId: 'root-100' },
      );
    });

    it('502s rather than walk a tree past the read budget', async () => {
      const transport = makeWideTreeTransport(250, 249);
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const err = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'no-such-tag',
        { name: 'Whatever', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      ).then(() => null, (e) => e);

      expect(err.status).to.equal(502);
      expect(err.message).to.match(/tag tree too large to resolve/);
    });
  });

  describe('handleUpdateTagSubworkspace', () => {
    const TARGET = TAG_IDS.categoryRunningShoes;
    const updateBody = {
      name: 'Footwear', parentId: TAG_IDS.categoryRoot, geoTargetId: 2840, languageCode: 'en',
    };

    async function loadHandler(resolveProjectStub) {
      return esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
    }

    it('resolves the project live and updates the tag (200)', async () => {
      const handler = await loadHandler(sinon.stub().resolves({ id: 'proj-sub-1' }));
      const transport = makeTransport();
      const res = await handler.handleUpdateTagSubworkspace(
        transport,
        WORKSPACE,
        TARGET,
        updateBody,
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({
        tagId: TARGET, name: 'Footwear', parentId: TAG_IDS.categoryRoot,
      });
      expect(res.body).to.not.have.property('brandId');
      expect(transport.updateProjectTag)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-sub-1', TARGET, { name: 'Footwear', parentId: TAG_IDS.categoryRoot });
    });

    // The subworkspace twin shares buildUpdatePayload and the placement guard, so
    // the cycle is refused here too rather than only on the flat-mode route.
    it('400s a re-parent onto one of the tag\'s own descendants', async () => {
      const handler = await loadHandler(sinon.stub().resolves({ id: 'proj-sub-1' }));
      const transport = makeTransport();
      const err = await handler.handleUpdateTagSubworkspace(
        transport,
        WORKSPACE,
        TAG_IDS.categoryRunningShoes,
        {
          name: 'Running Shoes',
          parentId: TAG_IDS.subCategoryHuman,
          geoTargetId: 2840,
          languageCode: 'en',
        },
        fakeLog(),
      ).then(() => null, (e) => e);

      expect(err.status).to.equal(400);
      expect(err.message).to.match(/must not be a descendant of the tag/);
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('404s (marketNotFound) when the slice has no live project', async () => {
      const handler = await loadHandler(sinon.stub().resolves(null));
      const transport = makeTransport();
      await expect(handler.handleUpdateTagSubworkspace(
        transport,
        WORKSPACE,
        TARGET,
        updateBody,
        fakeLog(),
      )).to.be.rejected.then((err) => {
        expect(err.status).to.equal(404);
        expect(err.code).to.equal('marketNotFound');
      });
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('re-sends the current parent on a rename-only PATCH (twin of the flat-mode fix)', async () => {
      const handler = await loadHandler(sinon.stub().resolves({ id: 'proj-sub-1' }));
      const transport = makeTransport({
        updateProjectTag: sinon.stub().resolves({
          id: TAG_IDS.subCategoryHuman, name: 'Renamed', parent_id: TAG_IDS.categoryRunningShoes,
        }),
      });
      const res = await handler.handleUpdateTagSubworkspace(
        transport,
        WORKSPACE,
        TAG_IDS.subCategoryHuman,
        { name: 'Renamed', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({ name: 'Renamed', parentId: TAG_IDS.categoryRunningShoes });
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-sub-1',
        TAG_IDS.subCategoryHuman,
        { name: 'Renamed', parentId: TAG_IDS.categoryRunningShoes },
      );
    });

    it('400s an explicit null parentId (twin of the flat-mode promote-to-root refusal)', async () => {
      const handler = await loadHandler(sinon.stub().resolves({ id: 'proj-sub-1' }));
      const transport = makeTransport();
      await expect(handler.handleUpdateTagSubworkspace(
        transport,
        WORKSPACE,
        TARGET,
        { ...updateBody, parentId: null },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s a PATCH targeting a dimension root', async () => {
      const handler = await loadHandler(sinon.stub().resolves({ id: 'proj-sub-1' }));
      const transport = makeTransport();
      await expect(handler.handleUpdateTagSubworkspace(
        transport,
        WORKSPACE,
        TAG_IDS.categoryRoot,
        { name: 'Renamed', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('404s tagNotFound for an id absent from the tree', async () => {
      const handler = await loadHandler(sinon.stub().resolves({ id: 'proj-sub-1' }));
      const transport = makeTransport();
      await expect(handler.handleUpdateTagSubworkspace(transport, WORKSPACE, 'ghost', updateBody, fakeLog()))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(404);
          expect(err.code).to.equal('tagNotFound');
        });
      expect(transport.updateProjectTag).to.not.have.been.called;
    });
  });

  // A tag: root, and optionally one bare-named child under it, backed by the
  // shared TAG_IDS.tagRoot fixture id — used by the delete-endpoint tests below.
  function makeTagTreeTransport(childId, overrides = {}) {
    const extraLevels = {};
    if (childId) {
      extraLevels[TAG_IDS.tagRoot] = [{
        id: childId,
        name: 'High',
        parent_id: TAG_IDS.tagRoot,
        children_count: 0,
        path: [{ id: TAG_IDS.tagRoot, name: 'tag' }],
      }];
    }
    const levels = dimensionTreeLevels(extraLevels);
    if (childId) {
      // The root now has one child.
      levels[''] = levels[''].map((t) => (
        t.id === TAG_IDS.tagRoot ? { ...t, children_count: 1 } : t
      ));
    }
    return makeTransport({ listProjectTags: makeListProjectTagsStub(levels), ...overrides });
  }

  describe('handleDeleteTag (flat mode) — DELETE /serenity/tags/:tagId', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    const query = { geoTargetId: 2840, languageCode: 'en' };

    it('deletes a tag-dimension leaf and returns 204', async () => {
      const transport = makeTagTreeTransport('tag-child-1', {
        deleteProjectTags: sinon.stub().resolves(undefined),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleDeleteTag(transport, dataAccess, BRAND, WORKSPACE, 'tag-child-1', query, fakeLog());
      expect(res.status).to.equal(204);
      expect(transport.deleteProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', ['tag-child-1']);
    });

    it('deletes a childless tag-dimension root and returns 204', async () => {
      const transport = makeTagTreeTransport(undefined, {
        deleteProjectTags: sinon.stub().resolves(undefined),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleDeleteTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TAG_IDS.tagRoot,
        query,
        fakeLog(),
      );
      expect(res.status).to.equal(204);
      expect(transport.deleteProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', [TAG_IDS.tagRoot]);
    });

    it('409s (tagHasChildren) deleting a populated tag-dimension root and NEVER calls the delete transport', async () => {
      const transport = makeTagTreeTransport('tag-child-1', {
        deleteProjectTags: sinon.stub().resolves(undefined),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleDeleteTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TAG_IDS.tagRoot,
        query,
        fakeLog(),
      ))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(409);
          expect(err.code).to.equal('tagHasChildren');
        });
      // The children guard fires BEFORE any upstream delete.
      expect(transport.deleteProjectTags).to.not.have.been.called;
    });

    it('404s (tagNotResolved) when the tag id cannot be located in the tree', async () => {
      // Empty tree → any id resolves to 'unknown'. This must be a 404, not a
      // misleading 400 categoryDeleteNotYetSupported.
      const transport = makeEmptyTreeTransport({
        deleteProjectTags: sinon.stub().resolves(undefined),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleDeleteTag(transport, dataAccess, BRAND, WORKSPACE, 'ghost', query, fakeLog()))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(404);
          expect(err.code).to.equal('tagNotResolved');
        });
      expect(transport.deleteProjectTags).to.not.have.been.called;
    });

    it('400s (categoryDeleteNotYetSupported) deleting a non-tag-dimension tag', async () => {
      // The `category` root — category delete is deliberately out of scope.
      const transport = makeTransport({ deleteProjectTags: sinon.stub().resolves(undefined) });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleDeleteTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TAG_IDS.categoryRoot,
        query,
        fakeLog(),
      ))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(400);
          expect(err.code).to.equal('categoryDeleteNotYetSupported');
        });
      expect(transport.deleteProjectTags).to.not.have.been.called;
    });

    it('400s (categoryDeleteNotYetSupported) deleting a customer category (open dimension, but not tag)', async () => {
      const transport = makeTransport({ deleteProjectTags: sinon.stub().resolves(undefined) });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleDeleteTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        TAG_IDS.categoryRunningShoes,
        query,
        fakeLog(),
      ))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(400);
          expect(err.code).to.equal('categoryDeleteNotYetSupported');
        });
      expect(transport.deleteProjectTags).to.not.have.been.called;
    });

    it('404s (marketNotFound) when no project backs the slice', async () => {
      const transport = makeTagTreeTransport('tag-child-1');
      const dataAccess = makeDataAccess(null);
      await expect(handler.handleDeleteTag(transport, dataAccess, BRAND, WORKSPACE, 'tag-child-1', query, fakeLog()))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(404);
          expect(err.code).to.equal('marketNotFound');
        });
    });

    it('400s missing slice filters (geoTargetId/languageCode)', async () => {
      const transport = makeTagTreeTransport('tag-child-1');
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleDeleteTag(transport, dataAccess, BRAND, WORKSPACE, 'tag-child-1', {}, fakeLog()))
        .to.be.rejected.then((err) => expect(err.status).to.equal(400));
    });

    it('400s a malformed tagId before resolving anything', async () => {
      const transport = makeTagTreeTransport('tag-child-1');
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleDeleteTag(transport, dataAccess, BRAND, WORKSPACE, 'tag one', query, fakeLog()))
        .to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.listProjectTags).to.not.have.been.called;
    });
  });

  describe('handleDeleteTagSubworkspace', () => {
    const query = { geoTargetId: 2840, languageCode: 'en' };

    it('resolves the project live and deletes a tag-dimension leaf (204)', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTagTreeTransport('tag-child-1', {
        deleteProjectTags: sinon.stub().resolves(undefined),
      });
      const res = await handler.handleDeleteTagSubworkspace(
        transport,
        WORKSPACE,
        'tag-child-1',
        query,
        fakeLog(),
      );
      expect(res.status).to.equal(204);
      expect(transport.deleteProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-sub-1', ['tag-child-1']);
    });

    it('404s (marketNotFound) when the slice has no live project', async () => {
      const resolveProjectStub = sinon.stub().resolves(null);
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTagTreeTransport(undefined);
      await expect(handler.handleDeleteTagSubworkspace(
        transport,
        WORKSPACE,
        TAG_IDS.tagRoot,
        query,
        fakeLog(),
      ))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(404);
          expect(err.code).to.equal('marketNotFound');
        });
    });
  });
});
