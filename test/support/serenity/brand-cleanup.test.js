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

import { ErrorWithStatusCode } from '../../../src/support/utils.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SPACECAT_ID = '11111111-2222-3333-4444-555555555555';

function makeRow({ geoTargetId, languageCode }) {
  return {
    getGeoTargetId: () => geoTargetId,
    getLanguageCode: () => languageCode,
  };
}

describe('cleanupBrandSemrushProjects', () => {
  let cleanupBrandSemrushProjects;
  let resolveWorkspaceIdStub;
  let extractImsBearerStub;
  let createSerenityTransportStub;
  let handleDeleteMarketStub;
  let log;
  let transport;

  async function load() {
    const mod = await esmock('../../../src/support/serenity/brand-cleanup.js', {
      '../../../src/support/serenity/workspace-resolver.js': {
        resolveWorkspaceId: resolveWorkspaceIdStub,
      },
      '../../../src/support/serenity/ims-bearer.js': {
        extractImsBearer: extractImsBearerStub,
      },
      '../../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: createSerenityTransportStub,
      },
      '../../../src/support/serenity/handlers/markets.js': {
        handleDeleteMarket: handleDeleteMarketStub,
      },
    });
    ({ cleanupBrandSemrushProjects } = mod);
  }

  function makeContext(projects) {
    return {
      env: { SERENITY_BASE_URL: 'https://serenity.example' },
      dataAccess: {
        BrandSemrushProject: projects === null ? undefined : {
          allByBrandId: sinon.stub().resolves(projects),
        },
      },
    };
  }

  beforeEach(async () => {
    transport = { deleteProject: sinon.stub().resolves() };
    resolveWorkspaceIdStub = sinon.stub().resolves('workspace-1');
    extractImsBearerStub = sinon.stub().returns('ims-token');
    createSerenityTransportStub = sinon.stub().returns(transport);
    handleDeleteMarketStub = sinon.stub().resolves({ status: 204 });
    log = {
      info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
    };
    await load();
  });

  afterEach(() => sinon.restore());

  it('is a no-op when the data layer has no BrandSemrushProject model', async () => {
    const result = await cleanupBrandSemrushProjects(makeContext(null), SPACECAT_ID, BRAND, log);
    expect(result).to.deep.equal({ deleted: 0 });
    expect(handleDeleteMarketStub).to.not.have.been.called;
    expect(resolveWorkspaceIdStub).to.not.have.been.called;
  });

  it('is a no-op when the brand owns no Semrush projects', async () => {
    const result = await cleanupBrandSemrushProjects(makeContext([]), SPACECAT_ID, BRAND, log);
    expect(result).to.deep.equal({ deleted: 0 });
    expect(handleDeleteMarketStub).to.not.have.been.called;
  });

  it('deletes every project and returns the count', async () => {
    const rows = [
      makeRow({ geoTargetId: 2840, languageCode: 'en' }),
      makeRow({ geoTargetId: 2250, languageCode: 'fr' }),
    ];
    const context = makeContext(rows);
    const result = await cleanupBrandSemrushProjects(context, SPACECAT_ID, BRAND, log);

    expect(result).to.deep.equal({ deleted: 2 });
    expect(createSerenityTransportStub).to.have.been.calledOnceWithExactly({
      env: context.env, imsToken: 'ims-token',
    });
    expect(handleDeleteMarketStub).to.have.been.calledTwice;
    expect(handleDeleteMarketStub.firstCall).to.have.been.calledWith(transport, context.dataAccess, BRAND, 'workspace-1', 2840, 'en', log);
    expect(handleDeleteMarketStub.secondCall).to.have.been.calledWith(transport, context.dataAccess, BRAND, 'workspace-1', 2250, 'fr', log);
  });

  it('throws 409 when the org has no Semrush workspace id', async () => {
    resolveWorkspaceIdStub.resolves(null);
    const rows = [makeRow({ geoTargetId: 2840, languageCode: 'en' })];

    await expect(cleanupBrandSemrushProjects(makeContext(rows), SPACECAT_ID, BRAND, log))
      .to.be.rejectedWith(ErrorWithStatusCode, /no semrush_workspace_id/);
    expect(handleDeleteMarketStub).to.not.have.been.called;
    try {
      await cleanupBrandSemrushProjects(makeContext(rows), SPACECAT_ID, BRAND, log);
    } catch (e) {
      expect(e.status).to.equal(409);
    }
  });

  it('throws 401 when there is no IMS bearer token', async () => {
    extractImsBearerStub.returns(null);
    const rows = [makeRow({ geoTargetId: 2840, languageCode: 'en' })];

    let caught;
    try {
      await cleanupBrandSemrushProjects(makeContext(rows), SPACECAT_ID, BRAND, log);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(ErrorWithStatusCode);
    expect(caught.status).to.equal(401);
    expect(createSerenityTransportStub).to.not.have.been.called;
    expect(handleDeleteMarketStub).to.not.have.been.called;
  });

  it('propagates an upstream delete failure (fail-closed) and stops further deletes', async () => {
    const rows = [
      makeRow({ geoTargetId: 2840, languageCode: 'en' }),
      makeRow({ geoTargetId: 2250, languageCode: 'fr' }),
    ];
    const upstream = new ErrorWithStatusCode('upstream 502', 502);
    handleDeleteMarketStub.onFirstCall().rejects(upstream);

    let caught;
    try {
      await cleanupBrandSemrushProjects(makeContext(rows), SPACECAT_ID, BRAND, log);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.equal(upstream);
    // fail-closed: aborts before attempting the second slice
    expect(handleDeleteMarketStub).to.have.been.calledOnce;
  });
});
