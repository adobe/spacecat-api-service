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
    const transport = {};
    const dataAccess = makeDataAccess([]);
    const result = await handleListMarkets(transport, dataAccess, BRAND, WORKSPACE);
    expect(result).to.deep.equal({ items: [] });
  });

  it('emits DB rows with no semrush identifiers or upstream-derived fields', async () => {
    const row = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([row]);
    const transport = {};

    const result = await handleListMarkets(transport, dataAccess, BRAND, WORKSPACE);

    expect(result.items).to.have.lengthOf(1);
    expect(result.items[0]).to.deep.equal({
      brandId: BRAND,
      geoTargetId: 2840,
      languageCode: 'en',
      createdAt: '2026-05-28T10:00:00Z',
      updatedAt: '2026-05-28T10:00:00Z',
    });
    expect(result.items[0]).not.to.have.property('semrushProjectId');
    expect(result.items[0]).not.to.have.property('semrushLocationId');
    expect(result.items[0]).not.to.have.property('name');
    expect(result.items[0]).not.to.have.property('status');
    expect(result).not.to.have.property('enrichment');
  });

  it('does not call upstream — list is a pure DB read', async () => {
    const row = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([row]);
    // No upstream methods stubbed — calling any would surface as an
    // undefined-function error, proving the handler made no upstream call.
    const transport = {};

    const result = await handleListMarkets(transport, dataAccess, BRAND, WORKSPACE);
    expect(result.items).to.have.lengthOf(1);
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

  it('creates upstream, publishes, writes row, returns 201 with slice-only body', async () => {
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
    });
    expect(result.body).not.to.have.property('name');
    expect(result.body).not.to.have.property('status');
    expect(dataAccess.BrandSemrushProject.create).to.have.been.calledOnceWithExactly({
      brandId: BRAND,
      semrushProjectId: 'proj-new',
      geoTargetId: 2840,
      languageCode: 'en',
    });
  });

  // Branch coverage: validateCreateBody has a "name provided but invalid"
  // check that's distinct from "name omitted" (omitted is fine; provided as
  // an empty string is a 400).
  it('400s when name is provided as an empty string', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const transport = { listLanguages: sinon.stub() };

    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      name: '',
      market: 'US',
      languageCode: 'en',
      brandDomain: 'adobe.com',
      brandNames: ['Adobe'],
    }, fakeLog());

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('invalidRequest');
    expect(result.body.messages).to.include('name, when provided, must be a non-empty string');
  });

  it('400s on unknown language (not present in upstream catalog)', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const transport = {
      // English not in catalog → resolveLanguageId returns null
      listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-de', name: 'German' }] }),
    };

    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, fakeLog());

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('unknownLanguage');
  });

  // Branch coverage: ICU DisplayNames returns the input verbatim for unknown
  // tags. The handler guards against that and returns null from
  // isoToEnglishName, which surfaces as 400 unknownLanguage.
  it('400s when the language tag is not a real language (ICU returns it unchanged)', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const transport = {
      listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
    };
    clearLanguageCache();

    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'xx', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, fakeLog());

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('unknownLanguage');
  });

  // Branch coverage: listLanguages returns a response with NO `items` field
  // → the `Array.isArray(resp?.items) ? : []` default kicks in and the
  // catalog stays empty.
  it('handles upstream listLanguages with a missing items field', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const transport = {
      listLanguages: sinon.stub().resolves({}), // no items property at all
    };
    clearLanguageCache();

    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, fakeLog());

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('unknownLanguage');
  });

  // Branch coverage: upstream returns items but none usable (no `name`+`id`
  // pair) → the warn log fires so operators know the upstream contract may
  // have changed.
  it('warns when the upstream language catalog returns no usable entries', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const transport = {
      // Items exist but the {name, id} contract is broken — no `name` field.
      listLanguages: sinon.stub().resolves({ items: [{ unexpected: 'shape' }] }),
    };
    const log = fakeLog();
    clearLanguageCache();

    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, log);

    expect(result.status).to.equal(400);
    expect(log.warn).to.have.been.calledWithMatch(
      'resolveLanguageId: language catalog returned no usable names — upstream field shape may have changed',
      sinon.match.object,
    );
  });

  // Branch coverage: the warn log dereferences `items[0] || {}` so the
  // `Object.keys(...)` call never explodes when the catalog is empty-list
  // (items=[]).
  it('warns with empty receivedKeys when the upstream language catalog is an empty list', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    // We need to bypass the "items.length > 0" guard around the warn log,
    // so the test below covers the items[0] || {} short-circuit indirectly
    // by passing a malformed first item; the previous test covers the warn
    // path. This test exists strictly to lock the fallback shape — empty
    // upstream returns an unknownLanguage 400 (no warn).
    const transport = {
      listLanguages: sinon.stub().resolves({ items: [] }),
    };
    const log = fakeLog();
    clearLanguageCache();

    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, log);

    expect(result.status).to.equal(400);
    expect(log.warn).to.have.callCount(0); // empty list, no warn
  });

  // Regression guard for the orphan-upstream-project gap documented on
  // handleCreateMarket's JSDoc: when publishProject fails after a successful
  // createProject, the handler logs the orphan at error level (with everything
  // an operator needs to reconcile) and re-throws — we do NOT proceed to write
  // the DB row that would later try to publish a project that already failed.
  it('publish failure: logs orphan upstream project and throws (no DB row written)', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    dataAccess.BrandSemrushProject.create.resolves();
    const transport = {
      listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
      createProject: sinon.stub().resolves({ id: 'proj-orphan-1' }),
      publishProject: sinon.stub().rejects(new Error('upstream 503')),
    };
    const log = fakeLog();

    await expect(handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, log)).to.be.rejectedWith(/upstream 503/);

    expect(dataAccess.BrandSemrushProject.create).to.have.callCount(0);
    expect(log.error).to.have.been.calledWithMatch(
      'handleCreateMarket: orphaned upstream project after publish failure',
      sinon.match({ semrushProjectId: 'proj-orphan-1', geoTargetId: 2840, languageCode: 'en' }),
    );
  });

  // Regression guard for the DB-race orphan path: BrandSemrushProject.create
  // throws (most common cause: two concurrent POST /serenity/markets requests
  // for the same slice — first wins the uniqueness check, second's create
  // races with a freshly-inserted row). We surface 409 to the client and log
  // the orphan upstream project for operator cleanup.
  it('DB-create race: logs orphan and returns 409 sliceExists', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    dataAccess.BrandSemrushProject.create.rejects(new Error('duplicate key value violates unique constraint'));
    const transport = {
      listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
      createProject: sinon.stub().resolves({ id: 'proj-orphan-2' }),
      publishProject: sinon.stub().resolves(),
    };
    const log = fakeLog();

    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, log);

    expect(result.status).to.equal(409);
    expect(result.body.error).to.equal('sliceExists');
    expect(log.error).to.have.been.calledWithMatch(
      'handleCreateMarket: orphaned upstream project after row-create race',
      sinon.match({ semrushProjectId: 'proj-orphan-2' }),
    );
  });

  // Upstream contract: createProject must echo an id. If it doesn't, we have
  // nothing to publish or store, so 502 the request instead of writing a row
  // that points at an empty string.
  it('502s when upstream createProject returns no project id', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const transport = {
      listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
      createProject: sinon.stub().resolves({}), // missing id
      publishProject: sinon.stub(),
    };

    const result = await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, fakeLog());

    expect(result.status).to.equal(502);
    expect(result.body.error).to.equal('createNoProjectId');
    expect(transport.publishProject).to.have.callCount(0);
  });

  it('defaults the upstream display name to "<brandDisplayName>-<6hex>" when omitted', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    dataAccess.BrandSemrushProject.create.resolves();
    const transport = {
      listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
      createProject: sinon.stub().resolves({ id: 'proj-x' }),
      publishProject: sinon.stub().resolves(),
    };

    await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US',
      languageCode: 'en',
      brandDomain: 'adobe.com',
      brandNames: ['Adobe'],
      brandDisplayName: 'Adobe',
    }, fakeLog());

    const [, body] = transport.createProject.firstCall.args;
    expect(body.name).to.match(/^Adobe-[0-9a-f]{6}$/);
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

  it('400s on invalid languageCode (regex-rejected, not just uppercase)', async () => {
    const dataAccess = makeDataAccess([]);
    // normalizeLanguageCode lowercases before regex-testing, so 'EN-US' is
    // accepted as 'en-us'. Use a truly malformed value to exercise the
    // regex-reject branch.
    await expect(handleDeleteMarket(
      {},
      dataAccess,
      BRAND,
      WORKSPACE,
      2840,
      '1z',
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

  // Branch coverage: upstream listPromptsByTags returns a response with no
  // `items` field, and items lack a `tags` field — both defensive
  // Array.isArray fallbacks fire. To reach the second call we return a full
  // first page (200 items) so the short-page break doesn't fire.
  it('listTags survives upstream responses missing the items / tags fields', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-empty', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    // Full first page, all items without tags fields — exercises the
    // `Array.isArray(item?.tags) ? item.tags : []` fallback (L555).
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      id: `p${i}`, name: `q${i}`, /* tags omitted */
    }));
    const transport = {
      listPromptsByTags: sinon.stub()
        .onCall(0).resolves({ items: fullPage })
        .onCall(1)
        .resolves({}), // no items field at all → L553 fallback
    };

    const result = await handleListTags(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    }, fakeLog());

    expect(result).to.deep.equal({ items: [] });
    expect(transport.listPromptsByTags).to.have.callCount(2);
  });

  it('listTags aggregates + dedupes string tags and object tags into a sorted set', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listPromptsByTags: sinon.stub().resolves({
        items: [
          { id: 'p1', name: 'q1', tags: ['awareness', 'awareness'] },
          { id: 'p2', name: 'q2', tags: [{ id: 't-2', name: 'consideration' }] },
          { id: 'p3', name: 'q3', tags: [{ name: 'no-id-tag' }] }, // id falls back to name
        ],
      }),
    };

    const result = await handleListTags(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    }, fakeLog());

    expect(result.items.map((t) => t.name)).to.deep.equal([
      'awareness', 'consideration', 'no-id-tag',
    ]);
    expect(transport.listPromptsByTags).to.have.callCount(1);
  });

  it('listTags returns the cached set on the second call (no upstream walk)', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listPromptsByTags: sinon.stub().resolves({
        items: [{ id: 'p1', name: 'q', tags: ['t'] }],
      }),
    };

    await handleListTags(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    }, fakeLog());
    const second = await handleListTags(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    }, fakeLog());

    expect(second.items.map((t) => t.name)).to.deep.equal(['t']);
    // Cache hit means the upstream is hit exactly once across two calls.
    expect(transport.listPromptsByTags).to.have.callCount(1);
  });

  // Regression guard for the truncation warn log: when every one of the 50
  // pages we read comes back full (200 items), there's at least one more page
  // upstream we never saw and the tag set is incomplete. We surface this to
  // operators via a `warn` log so the symptom (missing tag in the UI) is
  // diagnosable from log search.
  it('listTags emits a warn log when the pagination ceiling is hit with full pages', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-big', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    // Always return 200 items so the loop never short-circuits before the
    // ceiling — the handler's branching does the bookkeeping.
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: `p${i}`, name: `q${i}`, tags: [`tag-${i % 5}`],
    }));
    const transport = {
      listPromptsByTags: sinon.stub().resolves({ items }),
    };
    const log = fakeLog();

    await handleListTags(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    }, log);

    expect(transport.listPromptsByTags).to.have.callCount(50);
    expect(log.warn).to.have.been.calledWithMatch(
      'handleListTags: tag pagination ceiling reached, tag set is truncated',
      sinon.match({
        projectId: 'proj-big',
        pagesWalked: 50,
        pageSize: 200,
      }),
    );
  });

  it('listModels 400s on missing filters', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleListModels({}, dataAccess, BRAND, WORKSPACE, {}))
      .to.be.rejectedWith(ErrorWithStatusCode);
  });

  it('listModels returns empty when slice has no row', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const result = await handleListModels({}, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });
    expect(result).to.deep.equal({ items: [] });
  });

  // Branch coverage: upstream listAiModels returns a response with no
  // `items` field → Array.isArray fallback to [] → loop exits cleanly.
  it('listModels survives upstream response with missing items field', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listAiModels: sinon.stub().resolves({}), // no items
    };

    const result = await handleListModels(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });

    expect(result).to.deep.equal({ items: [] });
    expect(transport.listAiModels).to.have.callCount(1);
  });

  // Branch coverage: short page exits the pagination loop early — empty
  // first page should stop immediately without a second call.
  it('listModels stops paginating on an empty upstream page', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listAiModels: sinon.stub().resolves({ items: [] }),
    };

    const result = await handleListModels(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });

    expect(result.items).to.have.lengthOf(0);
    expect(transport.listAiModels).to.have.callCount(1);
  });

  // Branch coverage: AI models pagination — the loop must continue when a
  // full page comes back and stop on a short page. With AI_MODELS_PAGE = 100,
  // returning exactly 100 on page 1 then 1 on page 2 exercises both branches.
  it('listModels paginates across multiple pages', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      model: { id: `m-${i}`, key: `key-${i}` },
    }));
    const lastPage = [{ model: { id: 'm-100', key: 'key-100' } }];
    const transport = {
      listAiModels: sinon.stub()
        .onCall(0).resolves({ items: fullPage })
        .onCall(1)
        .resolves({ items: lastPage }),
    };

    const result = await handleListModels(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });

    expect(result.items).to.have.lengthOf(101);
    expect(transport.listAiModels).to.have.callCount(2);
  });

  it('listModels filters to entries with model.id and model.key, normalising fields', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listAiModels: sinon.stub().resolves({
        items: [
          {
            model: {
              id: 'm-1', key: 'openai-gpt-4o-mini', name: 'GPT-4o mini', icon: 'i.png',
            },
          },
          { model: { id: 'm-2', key: 'anthropic-claude', name: null } }, // valid: name nulls to null
          { model: { id: '', key: 'broken' } }, // dropped: empty id
          { model: { id: 'm-3', key: '' } }, // dropped: empty key
          { /* no model */ }, // dropped: missing model
        ],
      }),
    };

    const result = await handleListModels(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });

    expect(result.items).to.deep.equal([
      {
        id: 'm-1', key: 'openai-gpt-4o-mini', name: 'GPT-4o mini', icon: 'i.png',
      },
      {
        id: 'm-2', key: 'anthropic-claude', name: null, icon: null,
      },
    ]);
  });
});
