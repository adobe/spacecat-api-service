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

import {
  handleListMarkets,
  handleCreateMarket,
  handleDeleteMarket,
  handleListTags,
  handleListModels,
  resolveLocation,
  clearLanguageCache,
  clearTagCache,
} from '../../../../src/support/serenity/handlers/markets.js';
import { SerenityTransportError } from '../../../../src/support/serenity/rest-transport.js';
import { ErrorWithStatusCode } from '../../../../src/support/utils.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKSPACE = 'workspace-1';

function makeProject({
  semrushProjectId, geoTargetId, languageCode, remove,
}) {
  return {
    getSemrushProjectId: () => semrushProjectId,
    getGeoTargetId: () => geoTargetId,
    getLanguageCode: () => languageCode,
    getCreatedAt: () => '2026-05-28T10:00:00Z',
    getUpdatedAt: () => '2026-05-28T10:00:00Z',
    remove: remove || sinon.stub().resolves(),
  };
}

function makeDataAccess(projects) {
  return {
    BrandSemrushProject: {
      allByBrandId: sinon.stub().resolves(projects),
      findBySlice: sinon.stub(),
      create: sinon.stub(),
    },
  };
}

function fakeLog() {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
  };
}

describe('handlers/markets.js — resolveLocation', () => {
  it('maps ISO-2 to (2000 + ISO numeric) for known countries', () => {
    const us = resolveLocation('US');
    expect(us.geoTargetId).to.equal(2840);
    expect(us.locationName).to.equal('United States');
  });

  it('returns null for unknown ISO codes', () => {
    expect(resolveLocation('XX')).to.equal(null);
  });

  it('returns null for empty input', () => {
    expect(resolveLocation('')).to.equal(null);
  });
});

describe('handlers/markets.js — handleListMarkets', () => {
  beforeEach(() => clearLanguageCache());

  it('returns empty when no rows', async () => {
    const transport = { listWorkspaceProjects: sinon.stub() };
    const dataAccess = makeDataAccess([]);
    const result = await handleListMarkets(transport, dataAccess, BRAND, WORKSPACE, fakeLog());
    expect(result).to.deep.equal({ items: [] });
    expect(transport.listWorkspaceProjects).not.to.have.been.called;
  });

  it('emits markets with status and no semrushLocationId / semrushProjectId on the DTO', async () => {
    const row = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([row]);
    const transport = {
      listWorkspaceProjects: sinon.stub().resolves({
        items: [{ id: 'proj-us-en', name: 'Adobe-US-en', publish_status: 'live' }],
      }),
    };

    const result = await handleListMarkets(transport, dataAccess, BRAND, WORKSPACE, fakeLog());

    expect(result.items[0]).to.deep.equal({
      brandId: BRAND,
      geoTargetId: 2840,
      languageCode: 'en',
      name: 'Adobe-US-en',
      status: 'live',
      createdAt: '2026-05-28T10:00:00Z',
      updatedAt: '2026-05-28T10:00:00Z',
    });
    expect(result.items[0]).not.to.have.property('semrushProjectId');
    expect(result.items[0]).not.to.have.property('semrushLocationId');
  });

  it('marks status create_failed and surfaces enrichment failure when upstream throws SerenityTransportError', async () => {
    const row = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([row]);
    const transport = {
      listWorkspaceProjects: sinon.stub().rejects(new SerenityTransportError(502, 'boom')),
    };

    const result = await handleListMarkets(transport, dataAccess, BRAND, WORKSPACE, fakeLog());

    expect(result.enrichment).to.equal('failed');
    expect(result.items[0].status).to.equal('create_failed');
  });
});

describe('handlers/markets.js — handleCreateMarket', () => {
  beforeEach(() => clearLanguageCache());

  it('400s on missing required fields', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);
    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {}, fakeLog());
    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('invalidRequest');
  });

  it('400s on unknown market', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);
    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'XX', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, fakeLog());
    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('unknownMarket');
  });

  it('409s when a market already exists for this slice', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves({
      getSemrushProjectId: () => 'proj-existing',
    });
    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, fakeLog());
    expect(result.status).to.equal(409);
    expect(result.body.error).to.equal('sliceExists');
  });

  it('creates upstream, publishes, writes row, returns 201 with status=pending', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    dataAccess.BrandSemrushProject.create.resolves();
    const transport = {
      listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
      createProject: sinon.stub().resolves({ id: 'proj-new' }),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      name: 'Adobe-US-en',
      market: 'US',
      languageCode: 'en',
      brandDomain: 'adobe.com',
      brandNames: ['Adobe'],
    }, fakeLog());

    expect(result.status).to.equal(201);
    expect(result.body).to.deep.equal({
      brandId: BRAND,
      geoTargetId: 2840,
      languageCode: 'en',
      name: 'Adobe-US-en',
      // 'live' (not 'pending') because publishProject was awaited synchronously
      // above and resolved without error.
      status: 'live',
    });
    expect(dataAccess.BrandSemrushProject.create).to.have.been.calledOnceWithExactly({
      brandId: BRAND,
      semrushProjectId: 'proj-new',
      geoTargetId: 2840,
      languageCode: 'en',
    });
  });
});

describe('handlers/markets.js — handleDeleteMarket', () => {
  it('400s on invalid geoTargetId', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleDeleteMarket(
      {},
      dataAccess,
      BRAND,
      WORKSPACE,
      0,
      'en',
      fakeLog(),
    )).to.be.rejectedWith(ErrorWithStatusCode);
  });

  it('400s on invalid languageCode', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleDeleteMarket(
      {},
      dataAccess,
      BRAND,
      WORKSPACE,
      2840,
      'EN-US',
      fakeLog(),
    )).to.be.rejectedWith(ErrorWithStatusCode);
  });

  it('returns 204 (idempotent) when no row exists for the slice', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const transport = { deleteProject: sinon.stub() };
    const result = await handleDeleteMarket(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      2840,
      'en',
      fakeLog(),
    );
    expect(result.status).to.equal(204);
    expect(transport.deleteProject).not.to.have.been.called;
  });

  it('happy path: upstream DELETE → row.remove → 204', async () => {
    const remove = sinon.stub().resolves();
    const row = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en', remove,
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(row);
    const transport = { deleteProject: sinon.stub().resolves() };

    const result = await handleDeleteMarket(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      2840,
      'en',
      fakeLog(),
    );

    expect(result.status).to.equal(204);
    expect(transport.deleteProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
    expect(remove).to.have.been.calledOnce;
  });

  it('treats upstream 404 as already-gone success', async () => {
    const remove = sinon.stub().resolves();
    const row = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en', remove,
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(row);
    const transport = {
      deleteProject: sinon.stub().rejects(new SerenityTransportError(404, 'not found')),
    };

    const result = await handleDeleteMarket(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      2840,
      'en',
      fakeLog(),
    );

    expect(result.status).to.equal(204);
    expect(remove).to.have.been.calledOnce;
  });

  it('propagates non-404 upstream failures and does NOT remove the row', async () => {
    const remove = sinon.stub().resolves();
    const row = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en', remove,
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(row);
    const transport = {
      deleteProject: sinon.stub().rejects(new SerenityTransportError(503, 'upstream down')),
    };

    await expect(handleDeleteMarket(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      2840,
      'en',
      fakeLog(),
    )).to.be.rejectedWith(SerenityTransportError);
    expect(remove).not.to.have.been.called;
  });

  it('half-delete state (upstream 204, DB remove fails) surfaces as 500', async () => {
    const remove = sinon.stub().rejects(new Error('db down'));
    const row = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en', remove,
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(row);
    const transport = { deleteProject: sinon.stub().resolves() };

    await expect(handleDeleteMarket(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      2840,
      'en',
      fakeLog(),
    )).to.be.rejectedWith(ErrorWithStatusCode, /retry/);
  });
});

describe('handlers/markets.js — handleListTags / handleListModels', () => {
  beforeEach(() => clearTagCache());

  it('listTags 400s on missing filters', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleListTags({}, dataAccess, BRAND, WORKSPACE, {}))
      .to.be.rejectedWith(ErrorWithStatusCode);
  });

  it('listTags returns empty when slice has no row', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const result = await handleListTags({}, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });
    expect(result).to.deep.equal({ items: [] });
  });

  it('listModels 400s on missing filters', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleListModels({}, dataAccess, BRAND, WORKSPACE, {}))
      .to.be.rejectedWith(ErrorWithStatusCode);
  });
});
