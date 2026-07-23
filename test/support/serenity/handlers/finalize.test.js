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

import { ErrorWithStatusCode } from '../../../../src/support/utils.js';
import { SerenityTransportError } from '../../../../src/support/serenity/rest-transport.js';
import { ERROR_CODES } from '../../../../src/support/serenity/errors.js';

use(chaiAsPromised);
use(sinonChai);

const PROMPTS_PATH = '../../../../src/support/serenity/handlers/prompts.js';
const MARKETS_PATH = '../../../../src/support/serenity/handlers/markets.js';
const FINALIZE_PATH = '../../../../src/support/serenity/handlers/finalize.js';

// A BrandSemrushProject-shaped row.
const row = (semrushProjectId, geoTargetId, languageCode) => ({
  getSemrushProjectId: () => semrushProjectId,
  getGeoTargetId: () => geoTargetId,
  getLanguageCode: () => languageCode,
});

const noopLog = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

describe('finalizeSerenityProjects (publish-after-populate)', () => {
  let sandbox;
  let handleCreatePrompts;
  let handleUpdateModels;
  let finalizeSerenityProjects;
  let transport;
  let dataAccess;

  const WS = 'ws-1';
  const BRAND = 'brand-uuid-1';

  const load = async () => {
    ({ finalizeSerenityProjects } = await esmock(FINALIZE_PATH, {
      [PROMPTS_PATH]: { handleCreatePrompts },
      [MARKETS_PATH]: { handleUpdateModels },
    }));
  };

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    handleCreatePrompts = sandbox.stub().resolves({ created: [{ semrushPromptId: 'p1' }], skipped: [], failed: [] });
    handleUpdateModels = sandbox.stub().resolves({ items: [{ id: 'm1' }] });
    transport = {
      publishProject: sandbox.stub().resolves(),
      getProjectStatus: sandbox.stub().resolves({ publish_status: 'live' }),
    };
    dataAccess = {
      BrandSemrushProject: {
        allByBrandId: sandbox.stub().resolves([row('proj-1', 2840, 'en')]),
      },
    };
    await load();
  });

  afterEach(() => sandbox.restore());

  it('throws 400 when brandId is missing', async () => {
    await expect(
      finalizeSerenityProjects(transport, dataAccess, '', WS, {}, noopLog),
    ).to.be.rejectedWith(ErrorWithStatusCode, 'brandId is required');
  });

  it('throws 400 when semrushWorkspaceId is missing', async () => {
    await expect(
      finalizeSerenityProjects(transport, dataAccess, BRAND, '', {}, noopLog),
    ).to.be.rejectedWith(ErrorWithStatusCode, 'semrushWorkspaceId is required');
  });

  it('populates then publishes and confirms live → published', async () => {
    const classify = sandbox.stub();
    const body = {
      prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }],
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    };
    const out = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WS,
      body,
      noopLog,
      classify,
    );

    // prompts pushed with publish deferred + classifier threaded through
    expect(handleCreatePrompts).to.have.been.calledOnce;
    const pArgs = handleCreatePrompts.firstCall.args;
    expect(pArgs[6]).to.equal(classify);
    expect(pArgs[7]).to.deep.equal({ publish: false });
    // models set with publish deferred
    expect(handleUpdateModels.firstCall.args[6]).to.deep.equal({ publish: false });
    // single publish + confirm
    expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'proj-1');
    expect(out.published).to.deep.equal(['proj-1']);
    expect(out.publishPending).to.be.empty;
    expect(out.publishFailed).to.be.empty;
    expect(out.publishSkipped).to.be.empty;
  });

  it('skips publish for ALL projects when prompts were requested but every push failed (noPrompts)', async () => {
    handleCreatePrompts.resolves({ created: [], skipped: [], failed: [{ text: 'q' }] });
    const body = {
      prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }],
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    };
    const out = await finalizeSerenityProjects(transport, dataAccess, BRAND, WS, body, noopLog);
    expect(transport.publishProject).to.not.have.been.called;
    expect(out.publishSkipped).to.deep.equal([{ projectId: 'proj-1', reason: 'noPrompts' }]);
    expect(out.published).to.be.empty;
  });

  it('skips publish for a project with no models set (noModels)', async () => {
    // prompts ok, but no models supplied at all
    const body = { prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }] };
    const out = await finalizeSerenityProjects(transport, dataAccess, BRAND, WS, body, noopLog);
    expect(transport.publishProject).to.not.have.been.called;
    expect(out.publishSkipped).to.deep.equal([{ projectId: 'proj-1', reason: 'noModels' }]);
  });

  it('records a per-slice model failure without aborting the run', async () => {
    handleUpdateModels.rejects(new ErrorWithStatusCode('boom', 500));
    const body = {
      prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }],
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    };
    const out = await finalizeSerenityProjects(transport, dataAccess, BRAND, WS, body, noopLog);
    expect(out.models[0].status).to.equal(500);
    // slice had no successful models → project not publishable
    expect(out.publishSkipped).to.deep.equal([{ projectId: 'proj-1', reason: 'noModels' }]);
    expect(transport.publishProject).to.not.have.been.called;
  });

  it('classifies a metered-quota publish rejection (405 + text body) as permanent publishFailed', async () => {
    transport.publishProject.rejects(new SerenityTransportError(405, 'nope', '<html>method not allowed</html>'));
    const body = {
      prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }],
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    };
    const out = await finalizeSerenityProjects(transport, dataAccess, BRAND, WS, body, noopLog);
    expect(out.published).to.be.empty;
    expect(out.publishFailed).to.have.lengthOf(1);
    expect(out.publishFailed[0]).to.include({
      projectId: 'proj-1',
      code: ERROR_CODES.PUBLISH_QUOTA_EXHAUSTED,
      permanent: true,
    });
  });

  it('records a generic publish error as (transient) publishFailed', async () => {
    transport.publishProject.rejects(new Error('network flake'));
    const body = {
      prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }],
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    };
    const out = await finalizeSerenityProjects(transport, dataAccess, BRAND, WS, body, noopLog);
    expect(out.publishFailed).to.have.lengthOf(1);
    expect(out.publishFailed[0].error).to.equal('network flake');
    expect(out.publishFailed[0].permanent).to.be.undefined;
  });

  it('reports publishPending when the publish is accepted but not confirmed live in budget', async () => {
    transport.getProjectStatus.resolves({ publish_status: 'publishing' });
    const body = {
      prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }],
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    };
    const out = await finalizeSerenityProjects(transport, dataAccess, BRAND, WS, body, noopLog);
    expect(out.published).to.be.empty;
    expect(out.publishPending).to.deep.equal([{ projectId: 'proj-1', status: 'publishing' }]);
  });

  it('reports publishFailed when upstream confirms initial_publish_failed', async () => {
    transport.getProjectStatus.resolves({ publish_status: 'initial_publish_failed', publishing_failed_reason: 'nginx 500' });
    const body = {
      prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }],
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    };
    const out = await finalizeSerenityProjects(transport, dataAccess, BRAND, WS, body, noopLog);
    expect(out.publishFailed).to.have.lengthOf(1);
    expect(out.publishFailed[0]).to.include({ projectId: 'proj-1', error: 'nginx 500' });
  });

  it('reports publishPending when the transport cannot confirm (no getProjectStatus)', async () => {
    delete transport.getProjectStatus;
    const body = {
      prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }],
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    };
    const out = await finalizeSerenityProjects(transport, dataAccess, BRAND, WS, body, noopLog);
    expect(out.publishPending).to.deep.equal([{ projectId: 'proj-1', status: null }]);
  });

  it('skips the prompt push when none supplied (models-only publishes)', async () => {
    const body = { models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }] };
    const out = await finalizeSerenityProjects(transport, dataAccess, BRAND, WS, body, noopLog);
    expect(handleCreatePrompts).to.not.have.been.called;
    expect(out.published).to.deep.equal(['proj-1']);
  });

  it('skips a brand project row with a blank semrushProjectId', async () => {
    dataAccess.BrandSemrushProject.allByBrandId.resolves([
      row('', 2724, 'es'), // blank id — must be skipped, never published
      row('proj-1', 2840, 'en'),
    ]);
    const body = {
      prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }],
      models: [
        { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] },
        { geoTargetId: 2724, languageCode: 'es', modelIds: ['m1'] },
      ],
    };
    const out = await finalizeSerenityProjects(transport, dataAccess, BRAND, WS, body, noopLog);
    // Only the real project is acted on; the blank-id row is dropped entirely.
    expect(out.published).to.deep.equal(['proj-1']);
    expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'proj-1');
  });

  it('defers remaining publishes to the reconcile when the wall-time budget is exhausted', async () => {
    dataAccess.BrandSemrushProject.allByBrandId.resolves([
      row('proj-1', 2840, 'en'),
      row('proj-2', 2724, 'es'),
    ]);
    const body = {
      prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }],
      models: [
        { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] },
        { geoTargetId: 2724, languageCode: 'es', modelIds: ['m1'] },
      ],
    };
    // deadline already passed → the guard fires before the first publish.
    const out = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WS,
      body,
      noopLog,
      undefined,
      { deadlineMs: Date.now() - 1 },
    );
    expect(transport.publishProject).to.not.have.been.called;
    expect(out.published).to.be.empty;
    expect(out.publishPending).to.have.lengthOf(2);
    expect(out.publishPending.every((p) => p.reason === 'deadline')).to.be.true;
  });

  it('caps the per-project confirm poll at 3 reads regardless of confirmAttempts', async () => {
    // never reports live → the poll would run for the full attempt budget.
    transport.getProjectStatus.resolves({ publish_status: 'publishing' });
    const body = {
      prompts: [{ text: 'q', geoTargetId: 2840, languageCode: 'en' }],
      models: [{ geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] }],
    };
    const out = await finalizeSerenityProjects(
      transport,
      dataAccess,
      BRAND,
      WS,
      body,
      noopLog,
      undefined,
      { confirmAttempts: 10, confirmIntervalMs: 0 },
    );
    // one publishable project; poll hard-capped at 3 reads (not 10).
    expect(transport.getProjectStatus.callCount).to.equal(3);
    expect(out.publishPending).to.deep.equal([{ projectId: 'proj-1', status: 'publishing' }]);
  });
});
