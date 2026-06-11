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

  it('pushes prompts (publish deferred), sets models, then publishes once per project', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const frFr = makeProject({ semrushProjectId: 'proj-fr-fr', geoTargetId: 2250, languageCode: 'fr' });
    const dataAccess = makeDataAccess([usEn, frFr]);
    dataAccess.BrandSemrushProject.findBySlice
      .withArgs(BRAND, 2840, 'en').resolves(usEn)
      .withArgs(BRAND, 2250, 'fr').resolves(frFr);

    const transport = {
      createTaggedPrompts: sinon.stub().resolves({ ids: ['p1'] }),
      // handleUpdateModels: empty current → add the one desired model.
      listAiModels: sinon.stub().resolves({ items: [] }),
      addAiModel: sinon.stub().resolves(),
      deleteAiModelsByIds: sinon.stub().resolves(),
      publishProject: sinon.stub().resolves(),
    };

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

    // Models set per slice.
    expect(transport.addAiModel).to.have.been.calledTwice;
    expect(result.models).to.have.lengthOf(2);
    expect(result.models.every((m) => m.status === 200)).to.be.true;

    // Publish once per distinct project — the single authoritative publish.
    expect(transport.publishProject).to.have.been.calledTwice;
    expect(transport.publishProject).to.have.been.calledWithExactly(WORKSPACE, 'proj-us-en');
    expect(transport.publishProject).to.have.been.calledWithExactly(WORKSPACE, 'proj-fr-fr');
    expect(result.published).to.have.members(['proj-us-en', 'proj-fr-fr']);
    expect(result.publishFailed).to.have.lengthOf(0);
  });

  it('dedupes publish so a project shared by two slices is published once', async () => {
    // Two rows pointing at the same upstream project id (defensive dedupe).
    const a = makeProject({ semrushProjectId: 'proj-shared', geoTargetId: 2840, languageCode: 'en' });
    const b = makeProject({ semrushProjectId: 'proj-shared', geoTargetId: 2250, languageCode: 'fr' });
    const dataAccess = makeDataAccess([a, b]);
    const transport = { publishProject: sinon.stub().resolves() };

    const result = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      {},
      fakeLog(),
    );

    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-shared');
    expect(result.published).to.deep.equal(['proj-shared']);
  });

  it('publishes the brand drafts even with no prompts and no models in the body', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    const transport = { publishProject: sinon.stub().resolves() };

    const result = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      {},
      fakeLog(),
    );

    expect(result.prompts.created).to.have.lengthOf(0);
    expect(result.models).to.have.lengthOf(0);
    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
    expect(result.published).to.deep.equal(['proj-us-en']);
  });

  it('records a per-slice model failure without aborting prompts or publish', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    // No row for the model slice → handleUpdateModels throws 404.
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const transport = {
      createTaggedPrompts: sinon.stub().resolves({ ids: ['p1'] }),
      publishProject: sinon.stub().resolves(),
    };

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'q1', geoTargetId: 2840, languageCode: 'en', tags: [],
      }],
      models: [{ geoTargetId: 9999, languageCode: 'zz', modelIds: ['m1'] }],
    }, fakeLog());

    expect(result.prompts.created).to.have.lengthOf(1);
    expect(result.models).to.have.lengthOf(1);
    expect(result.models[0].status).to.equal(404);
    expect(result.models[0]).to.include({ geoTargetId: 9999, languageCode: 'zz' });
    // Publish still runs for the brand's draft project.
    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
    expect(result.published).to.deep.equal(['proj-us-en']);
  });

  it('records a per-project publish failure and still publishes the others', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const frFr = makeProject({ semrushProjectId: 'proj-fr-fr', geoTargetId: 2250, languageCode: 'fr' });
    const dataAccess = makeDataAccess([usEn, frFr]);
    const transport = {
      publishProject: sinon.stub().resolves(),
    };
    transport.publishProject.withArgs(WORKSPACE, 'proj-fr-fr').rejects(new Error('publish boom'));

    const result = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      {},
      fakeLog(),
    );

    expect(result.published).to.deep.equal(['proj-us-en']);
    expect(result.publishFailed).to.have.lengthOf(1);
    expect(result.publishFailed[0]).to.include({ projectId: 'proj-fr-fr', error: 'publish boom' });
  });

  it('publishes nothing when the brand has no projects', async () => {
    const dataAccess = makeDataAccess([]);
    const transport = { publishProject: sinon.stub().resolves() };

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
    expect(result.publishFailed).to.have.lengthOf(0);
  });

  it('tolerates allByBrandId returning null (no rows → no publish)', async () => {
    const dataAccess = makeDataAccess(null);
    const transport = { publishProject: sinon.stub().resolves() };

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

  it('skips publish when prompts were requested but every push failed (no empty publish)', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    const transport = {
      createTaggedPrompts: sinon.stub().rejects(new Error('upstream 500')),
      publishProject: sinon.stub().resolves(),
    };

    const result = await finalizeSerenityProjects(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'q1', geoTargetId: 2840, languageCode: 'en', tags: [],
      }],
    }, fakeLog());

    expect(result.prompts.created).to.have.lengthOf(0);
    expect(result.prompts.failed).to.have.lengthOf(1);
    // The whole point: do not publish an empty/unpopulated project.
    expect(transport.publishProject).to.have.callCount(0);
    expect(result.published).to.have.lengthOf(0);
  });

  it('still publishes on a partial prompt push (at least one created)', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    const transport = {
      // First prompt succeeds, second rejects → created=1, failed=1.
      createTaggedPrompts: sinon.stub(),
      publishProject: sinon.stub().resolves(),
    };
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
    }, fakeLog());

    expect(result.prompts.created).to.have.lengthOf(1);
    expect(result.prompts.failed).to.have.lengthOf(1);
    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
    expect(result.published).to.deep.equal(['proj-us-en']);
  });

  // --- AC3: bounded publish-status confirm (opt-in via getProjectStatus) ----

  it('confirms publish via publish_status=live → published', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    const transport = {
      publishProject: sinon.stub().resolves(),
      getProjectStatus: sinon.stub().resolves({ publish_status: 'live' }),
    };

    const result = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      {},
      fakeLog(),
    );

    expect(transport.getProjectStatus).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
    expect(result.published).to.deep.equal(['proj-us-en']);
    expect(result.publishFailed).to.have.lengthOf(0);
  });

  it('moves a project to publishFailed when upstream confirms initial_publish_failed', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    const transport = {
      publishProject: sinon.stub().resolves(),
      getProjectStatus: sinon.stub().resolves({
        publish_status: 'initial_publish_failed',
        publishing_failed_reason: 'bad location',
      }),
    };

    const result = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      {},
      fakeLog(),
    );

    expect(result.published).to.have.lengthOf(0);
    expect(result.publishFailed).to.have.lengthOf(1);
    expect(result.publishFailed[0]).to.include({
      projectId: 'proj-us-en',
      error: 'bad location',
      publishStatus: 'initial_publish_failed',
    });
  });

  it('keeps an async-in-progress publish (still publishing within budget) in published — worker reconciles', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    const transport = {
      publishProject: sinon.stub().resolves(),
      getProjectStatus: sinon.stub().resolves({ publish_status: 'publishing' }),
    };

    const result = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      {},
      fakeLog(),
      { confirmAttempts: 2, confirmIntervalMs: 0 },
    );

    expect(transport.getProjectStatus).to.have.been.calledTwice; // bounded poll
    expect(result.published).to.deep.equal(['proj-us-en']);
    expect(result.publishFailed).to.have.lengthOf(0);
  });

  it('falls back to accepted=published when the status read errors (best-effort confirm)', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const dataAccess = makeDataAccess([usEn]);
    const transport = {
      publishProject: sinon.stub().resolves(),
      getProjectStatus: sinon.stub().rejects(new Error('status 500')),
    };

    const result = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      {},
      fakeLog(),
    );

    expect(result.published).to.deep.equal(['proj-us-en']);
    expect(result.publishFailed).to.have.lengthOf(0);
  });

  it('mixes confirm outcomes across projects: live → published, initial_publish_failed → publishFailed', async () => {
    const usEn = makeProject({ semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en' });
    const frFr = makeProject({ semrushProjectId: 'proj-fr-fr', geoTargetId: 2250, languageCode: 'fr' });
    const dataAccess = makeDataAccess([usEn, frFr]);
    const transport = {
      publishProject: sinon.stub().resolves(),
      getProjectStatus: sinon.stub(),
    };
    transport.getProjectStatus.withArgs(WORKSPACE, 'proj-us-en').resolves({ publish_status: 'live' });
    transport.getProjectStatus.withArgs(WORKSPACE, 'proj-fr-fr').resolves({ publish_status: 'initial_publish_failed' });

    const result = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      {},
      fakeLog(),
    );

    expect(transport.publishProject).to.have.been.calledTwice;
    expect(result.published).to.deep.equal(['proj-us-en']);
    expect(result.publishFailed).to.have.lengthOf(1);
    expect(result.publishFailed[0]).to.include({ projectId: 'proj-fr-fr' });
  });
});
