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

import { finalizeSerenityProjects } from '../../../../src/support/serenity/handlers/finalize.js';
import { ErrorWithStatusCode } from '../../../../src/support/utils.js';
import { ERROR_CODES } from '../../../../src/support/serenity/errors.js';
import { SerenityTransportError } from '../../../../src/support/serenity/rest-transport.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKSPACE = 'workspace-1';

function makeProject({ semrushProjectId, geoTargetId, languageCode }) {
  return {
    getSemrushProjectId: () => semrushProjectId,
    getGeoTargetId: () => geoTargetId,
    getLanguageCode: () => languageCode,
  };
}

function makeDataAccess(projects) {
  return {
    BrandSemrushProject: {
      allByBrandId: sinon.stub().resolves(projects),
      findBySlice: sinon.stub(),
    },
  };
}

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

/**
 * Stateful Serenity transport for finalize tests.
 *
 * Model assignments are backed by a per-project store so `handleUpdateModels`
 * (called by step 2 with `{ publish: false }`) actually reflects an add: the
 * second `listAiModels` read after `addAiModel` returns the newly-added model,
 * so the slice ends with `items.length > 0` and clears the models gate. This
 * mirrors real upstream behaviour and is what makes a slice "publishable".
 *
 * `getProjectStatus` is what promotes an accepted (202) publish to confirmed
 * `published`; omit it (confirm:false) to exercise the publishPending path.
 *
 * @param {object} [opts]
 * @param {Object<string,string[]>} [opts.initialModels] - projectId → catalog
 *   ids already assigned before finalize runs.
 * @param {string} [opts.publishStatus='live'] - publish_status getProjectStatus reports.
 * @param {boolean} [opts.confirm=true] - whether getProjectStatus is present.
 */
function makeTransport({ initialModels = {}, publishStatus = 'live', confirm = true } = {}) {
  const assignment = (id) => ({
    id: `asg-${id}`,
    model: {
      id, key: id, name: id, icon: null,
    },
  });
  const store = new Map(
    Object.entries(initialModels).map(([pid, ids]) => [pid, ids.map(assignment)]),
  );
  const t = {
    createTaggedPrompts: sinon.stub().resolves({ ids: ['p1'] }),
    listAiModels: sinon.stub().callsFake(async (ws, pid) => (
      { items: store.has(pid) ? [...store.get(pid)] : [] }
    )),
    addAiModel: sinon.stub().callsFake(async (ws, pid, modelId) => {
      const arr = store.get(pid) || [];
      arr.push(assignment(modelId));
      store.set(pid, arr);
    }),
    deleteAiModelsByIds: sinon.stub().resolves(),
    publishProject: sinon.stub().resolves(),
  };
  if (confirm) {
    t.getProjectStatus = sinon.stub().resolves({ publish_status: publishStatus });
  }
  return t;
}

describe('handlers/finalize.js — finalizeSerenityProjects (LLMO-5492)', () => {
  afterEach(() => sinon.restore());

  it('400s when brandId is missing', async () => {
    await expect(
      finalizeSerenityProjects({}, makeDataAccess([]), '', WORKSPACE, {}, fakeLog()),
    ).to.be.rejectedWith(ErrorWithStatusCode, /brandId is required/);
  });

  it('400s when semrushWorkspaceId is missing', async () => {
    await expect(
      finalizeSerenityProjects({}, makeDataAccess([]), BRAND, '', {}, fakeLog()),
    ).to.be.rejectedWith(ErrorWithStatusCode, /semrushWorkspaceId is required/);
  });

  it('pushes prompts (publish deferred), sets models, then publishes & confirms once per project', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const frFr = makeProject({ semrushProjectId: 'proj-fr-fr', geoTargetId: 2250, languageCode: 'fr' });
    const dataAccess = makeDataAccess([usEn, frFr]);
    dataAccess.BrandSemrushProject.findBySlice
      .withArgs(BRAND, 2840, 'en').resolves(usEn)
      .withArgs(BRAND, 2250, 'fr').resolves(frFr);

    const transport = makeTransport();

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [
        {
          text: 'q1', geoTargetId: 2840, languageCode: 'en', tags: ['t'],
        },
        {
          text: 'q2', geoTargetId: 2250, languageCode: 'fr', tags: ['t'],
        },
      ],
      models: [
        { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] },
        { geoTargetId: 2250, languageCode: 'fr', modelIds: ['m1'] },
      ],
    }, fakeLog());

    // Prompts pushed but NOT published by handleCreatePrompts.
    expect(transport.createTaggedPrompts).to.have.been.calledTwice;
    expect(result.prompts.created).to.have.lengthOf(2);

    // Models set per slice (each ends with >=1 model → clears the models gate).
    expect(transport.addAiModel).to.have.been.calledTwice;
    expect(result.models).to.have.lengthOf(2);
    expect(result.models.every((m) => m.status === 200 && m.items.length > 0)).to.be.true;

    // Publish once per distinct project — the single authoritative publish.
    expect(transport.publishProject).to.have.been.calledTwice;
    expect(transport.publishProject).to.have.been.calledWithExactly(WORKSPACE, 'proj-us-en');
    expect(transport.publishProject).to.have.been.calledWithExactly(WORKSPACE, 'proj-fr-fr');
    // Confirmed live → published (not merely pending).
    expect(result.published).to.have.members(['proj-us-en', 'proj-fr-fr']);
    expect(result.publishPending).to.have.lengthOf(0);
    expect(result.publishSkipped).to.have.lengthOf(0);
    expect(result.publishFailed).to.have.lengthOf(0);
  });

  it('dedupes publish so a project shared by two slices is published once', async () => {
    // Two rows pointing at the same upstream project id (defensive dedupe). Only
    // the en slice carries models — one publishable slice is enough.
    const a = makeProject({ semrushProjectId: 'proj-shared', geoTargetId: 2840, languageCode: 'en' });
    const b = makeProject({ semrushProjectId: 'proj-shared', geoTargetId: 2250, languageCode: 'fr' });
    const dataAccess = makeDataAccess([a, b]);
    dataAccess.BrandSemrushProject.findBySlice.withArgs(BRAND, 2840, 'en').resolves(a);
    const transport = makeTransport();

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    }, fakeLog());

    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-shared');
    expect(result.published).to.deep.equal(['proj-shared']);
  });

  it('skips publish (publishSkipped/noModels) when a project has no models — never invents a default', async () => {
    // Empty body: no prompts, no models. The trigger contract owns models; an
    // unpopulated project must not be published with an arbitrary default set.
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    const transport = makeTransport();

    const result = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      {},
      fakeLog(),
    );

    expect(result.models).to.have.lengthOf(0);
    expect(transport.publishProject).to.have.callCount(0);
    expect(result.published).to.have.lengthOf(0);
    expect(result.publishSkipped).to.deep.equal([{ projectId: 'proj-us-en', reason: 'noModels' }]);
  });

  it('records a per-slice model failure but still publishes the project whose slice has models', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    dataAccess.BrandSemrushProject.findBySlice
      .withArgs(BRAND, 2840, 'en').resolves(usEn)
      // No row for the bogus model slice → handleUpdateModels throws 404.
      .withArgs(BRAND, 9999, 'zz').resolves(null);
    const transport = makeTransport();

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'q1', geoTargetId: 2840, languageCode: 'en', tags: [],
      }],
      models: [
        { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] },
        { geoTargetId: 9999, languageCode: 'zz', modelIds: ['m1'] },
      ],
    }, fakeLog());

    expect(result.prompts.created).to.have.lengthOf(1);
    expect(result.models).to.have.lengthOf(2);
    const failedSlice = result.models.find((m) => m.geoTargetId === 9999);
    expect(failedSlice.status).to.equal(404);
    // The good slice's project still publishes.
    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
    expect(result.published).to.deep.equal(['proj-us-en']);
    expect(result.publishSkipped).to.have.lengthOf(0);
  });

  it('records a per-project publish failure (transient) and still publishes the others', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const frFr = makeProject({ semrushProjectId: 'proj-fr-fr', geoTargetId: 2250, languageCode: 'fr' });
    const dataAccess = makeDataAccess([usEn, frFr]);
    dataAccess.BrandSemrushProject.findBySlice
      .withArgs(BRAND, 2840, 'en').resolves(usEn)
      .withArgs(BRAND, 2250, 'fr').resolves(frFr);
    const transport = makeTransport();
    transport.publishProject.withArgs(WORKSPACE, 'proj-fr-fr').rejects(new Error('publish boom'));

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      models: [
        { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] },
        { geoTargetId: 2250, languageCode: 'fr', modelIds: ['m1'] },
      ],
    }, fakeLog());

    expect(result.published).to.deep.equal(['proj-us-en']);
    expect(result.publishFailed).to.have.lengthOf(1);
    expect(result.publishFailed[0]).to.include({ projectId: 'proj-fr-fr', error: 'publish boom' });
    // A transient failure carries no permanent marker.
    expect(result.publishFailed[0].permanent).to.be.undefined;
    expect(result.publishFailed[0].code).to.be.undefined;
  });

  it('classifies a zero-quota 405 (text/html) as a PERMANENT publishFailed (alert, no retry)', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    dataAccess.BrandSemrushProject.findBySlice.withArgs(BRAND, 2840, 'en').resolves(usEn);
    const transport = makeTransport();
    transport.publishProject.rejects(
      new SerenityTransportError(405, 'Semrush POST .../publish failed: 405', '<html>405</html>', 'text/html'),
    );

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    }, fakeLog());

    expect(result.published).to.have.lengthOf(0);
    expect(result.publishPending).to.have.lengthOf(0);
    expect(result.publishFailed).to.have.lengthOf(1);
    expect(result.publishFailed[0]).to.include({
      projectId: 'proj-us-en',
      code: ERROR_CODES.PUBLISH_QUOTA_EXHAUSTED,
      permanent: true,
    });
    // We do NOT re-read status on a hard publish rejection.
    expect(transport.getProjectStatus).to.have.callCount(0);
  });

  it('publishes nothing when the brand has no projects', async () => {
    const dataAccess = makeDataAccess([]);
    const transport = makeTransport();

    const result = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      {},
      fakeLog(),
    );

    expect(transport.publishProject).to.have.callCount(0);
    expect(result.published).to.have.lengthOf(0);
    expect(result.publishPending).to.have.lengthOf(0);
    expect(result.publishSkipped).to.have.lengthOf(0);
    expect(result.publishFailed).to.have.lengthOf(0);
  });

  it('tolerates allByBrandId returning null (no rows → no publish)', async () => {
    const dataAccess = makeDataAccess(null);
    const transport = makeTransport();

    const result = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      {},
      fakeLog(),
    );

    expect(transport.publishProject).to.have.callCount(0);
    expect(result.published).to.have.lengthOf(0);
  });

  it('skips publish (publishSkipped/noPrompts) when prompts were requested but every push failed', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    dataAccess.BrandSemrushProject.findBySlice.withArgs(BRAND, 2840, 'en').resolves(usEn);
    const transport = makeTransport();
    transport.createTaggedPrompts.rejects(new Error('upstream 500'));

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'q1', geoTargetId: 2840, languageCode: 'en', tags: [],
      }],
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    }, fakeLog());

    expect(result.prompts.created).to.have.lengthOf(0);
    expect(result.prompts.failed).to.have.lengthOf(1);
    // The whole point: do not publish an empty/unpopulated project.
    expect(transport.publishProject).to.have.callCount(0);
    expect(result.published).to.have.lengthOf(0);
    expect(result.publishSkipped).to.deep.equal([{ projectId: 'proj-us-en', reason: 'noPrompts' }]);
  });

  it('still publishes on a partial prompt push (>=1 created) when the project has models', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    dataAccess.BrandSemrushProject.findBySlice.withArgs(BRAND, 2840, 'en').resolves(usEn);
    const transport = makeTransport();
    // First prompt succeeds, second rejects → created=1, failed=1.
    transport.createTaggedPrompts.onCall(0).resolves({ ids: ['p1'] });
    transport.createTaggedPrompts.onCall(1).rejects(new Error('upstream 500'));

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [
        {
          text: 'q1', geoTargetId: 2840, languageCode: 'en', tags: [],
        },
        {
          text: 'q2', geoTargetId: 2840, languageCode: 'en', tags: [],
        },
      ],
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    }, fakeLog());

    expect(result.prompts.created).to.have.lengthOf(1);
    expect(result.prompts.failed).to.have.lengthOf(1);
    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
    expect(result.published).to.deep.equal(['proj-us-en']);
  });

  // --- AC3/AC4: bounded publish-status confirm; published == confirmed live ---

  it('confirms publish via publish_status=live → published', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    dataAccess.BrandSemrushProject.findBySlice.withArgs(BRAND, 2840, 'en').resolves(usEn);
    const transport = makeTransport({ publishStatus: 'live' });

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    }, fakeLog());

    expect(transport.getProjectStatus).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
    expect(result.published).to.deep.equal(['proj-us-en']);
    expect(result.publishPending).to.have.lengthOf(0);
    expect(result.publishFailed).to.have.lengthOf(0);
  });

  it('moves a project to publishFailed when upstream confirms initial_publish_failed', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    dataAccess.BrandSemrushProject.findBySlice.withArgs(BRAND, 2840, 'en').resolves(usEn);
    const transport = makeTransport({ confirm: false });
    transport.getProjectStatus = sinon.stub().resolves({
      publish_status: 'initial_publish_failed',
      publishing_failed_reason: 'bad location',
    });

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    }, fakeLog());

    expect(result.published).to.have.lengthOf(0);
    expect(result.publishPending).to.have.lengthOf(0);
    expect(result.publishFailed).to.have.lengthOf(1);
    expect(result.publishFailed[0]).to.include({
      projectId: 'proj-us-en',
      error: 'bad location',
      publishStatus: 'initial_publish_failed',
    });
  });

  it('moves an async-in-progress publish (still publishing within budget) to publishPending — NOT published', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    dataAccess.BrandSemrushProject.findBySlice.withArgs(BRAND, 2840, 'en').resolves(usEn);
    const transport = makeTransport({ publishStatus: 'publishing' });

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    }, fakeLog(), { confirmAttempts: 2, confirmIntervalMs: 0 });

    expect(transport.getProjectStatus).to.have.been.calledTwice; // bounded poll
    expect(result.published).to.have.lengthOf(0);
    expect(result.publishPending).to.deep.equal([{ projectId: 'proj-us-en', status: 'publishing' }]);
    expect(result.publishFailed).to.have.lengthOf(0);
  });

  it('moves a 202 to publishPending when the status read errors (unconfirmed, not live)', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    dataAccess.BrandSemrushProject.findBySlice.withArgs(BRAND, 2840, 'en').resolves(usEn);
    const transport = makeTransport();
    transport.getProjectStatus = sinon.stub().rejects(new Error('status 500'));

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    }, fakeLog());

    expect(result.published).to.have.lengthOf(0);
    expect(result.publishPending).to.deep.equal([{ projectId: 'proj-us-en', status: null }]);
    expect(result.publishFailed).to.have.lengthOf(0);
  });

  it('moves a 202 to publishPending when the transport cannot confirm (no getProjectStatus)', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    dataAccess.BrandSemrushProject.findBySlice.withArgs(BRAND, 2840, 'en').resolves(usEn);
    const transport = makeTransport({ confirm: false });

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    }, fakeLog());

    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
    expect(result.published).to.have.lengthOf(0);
    expect(result.publishPending).to.deep.equal([{ projectId: 'proj-us-en', status: null }]);
  });

  it('mixes confirm outcomes across projects: live → published, initial_publish_failed → publishFailed', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const frFr = makeProject({ semrushProjectId: 'proj-fr-fr', geoTargetId: 2250, languageCode: 'fr' });
    const dataAccess = makeDataAccess([usEn, frFr]);
    dataAccess.BrandSemrushProject.findBySlice
      .withArgs(BRAND, 2840, 'en').resolves(usEn)
      .withArgs(BRAND, 2250, 'fr').resolves(frFr);
    const transport = makeTransport();
    transport.getProjectStatus = sinon.stub();
    transport.getProjectStatus.withArgs(WORKSPACE, 'proj-us-en').resolves({ publish_status: 'live' });
    transport.getProjectStatus.withArgs(WORKSPACE, 'proj-fr-fr').resolves({ publish_status: 'initial_publish_failed' });

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      models: [
        { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] },
        { geoTargetId: 2250, languageCode: 'fr', modelIds: ['m1'] },
      ],
    }, fakeLog());

    expect(transport.publishProject).to.have.been.calledTwice;
    expect(result.published).to.deep.equal(['proj-us-en']);
    expect(result.publishFailed).to.have.lengthOf(1);
    expect(result.publishFailed[0]).to.include({ projectId: 'proj-fr-fr' });
  });
});
