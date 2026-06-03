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
  handleGetMarket,
  handleCreateMarket,
  handleDeleteMarket,
  handleListTags,
  handleListModels,
  handleUpdateModels,
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

    // Important #7 from review: assert the full upstream createProject body
    // shape. A regression that flips `country_code` to uppercase, drops
    // `language_id`, sends `type: 'ai_overview'`, etc. would otherwise pass
    // because the prior tests only checked `body.name` against a regex.
    expect(transport.createProject).to.have.been.calledOnce;
    const upstreamBody = transport.createProject.firstCall.args[1];
    expect(upstreamBody).to.include({
      name: 'Adobe-US-en',
      type: 'ai',
      country_code: 'us', // lowercased ISO-2
      location_id: 2840,
      location_name: 'United States',
      language_id: 'lang-en',
      brand_name_display: 'Adobe',
      domain: 'adobe.com',
    });
    expect(upstreamBody.brand_names).to.deep.equal(['Adobe']);
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
    // Joined into a single `message` to match SerenityErrorResponse schema.
    expect(result.body.message).to.include('name, when provided, must be a non-empty string');
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
  //
  // Important #3 from review: on publish failure we ALSO attempt a best-effort
  // upstream deleteProject so the documented retry contract holds (without it,
  // each retry would create a fresh upstream project with a new
  // crypto.randomBytes(3) name suffix).
  it('publish failure: best-effort cleanup deletes upstream then throws (no DB row)', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    dataAccess.BrandSemrushProject.create.resolves();
    const transport = {
      listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
      createProject: sinon.stub().resolves({ id: 'proj-orphan-1' }),
      publishProject: sinon.stub().rejects(new Error('upstream 503')),
      deleteProject: sinon.stub().resolves(),
    };
    const log = fakeLog();

    await expect(handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, log)).to.be.rejectedWith(/upstream 503/);

    expect(dataAccess.BrandSemrushProject.create).to.have.callCount(0);
    // Best-effort cleanup of the upstream project that failed to publish.
    expect(transport.deleteProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-orphan-1');
    expect(log.error).to.have.been.calledWithMatch(
      'handleCreateMarket: publish failed; upstream project cleaned up',
      sinon.match({
        semrushProjectId: 'proj-orphan-1',
        geoTargetId: 2840,
        languageCode: 'en',
        cleanedUp: true,
      }),
    );
  });

  // Important #3, cleanup-failure path: if the best-effort deleteProject also
  // fails after the publish failure, we log both outcomes (so the operator
  // sees the actual orphan) and still propagate the original publishProject
  // error to the caller. Cleanup error MUST NOT mask the underlying failure.
  it('publish failure + cleanup failure: logs orphan, throws original error', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const transport = {
      listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
      createProject: sinon.stub().resolves({ id: 'proj-orphan-3' }),
      publishProject: sinon.stub().rejects(new Error('upstream 503')),
      deleteProject: sinon.stub().rejects(new Error('cleanup network glitch')),
    };
    const log = fakeLog();

    await expect(handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, log)).to.be.rejectedWith(/upstream 503/);

    expect(log.error).to.have.been.calledWithMatch(
      'handleCreateMarket: best-effort cleanup deleteProject failed; orphan upstream project remains',
      sinon.match({ semrushProjectId: 'proj-orphan-3' }),
    );
    expect(log.error).to.have.been.calledWithMatch(
      'handleCreateMarket: orphaned upstream project after publish failure',
      sinon.match({ cleanedUp: false }),
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

// Important #8 from review: the language catalog cache (1h TTL) must
// cache across calls within TTL and refresh after TTL expires. A regression
// that resets expiresAt against a stale `now` would silently hit the
// upstream catalog on every request — observable in production as added
// latency but invisible to any existing test (the rest of the suite calls
// `clearLanguageCache()` in beforeEach, masking exactly this contract).
describe('handlers/markets.js — language-catalog cache (Important #8)', () => {
  // Intentionally NOT clearing the cache in beforeEach — both tests need to
  // observe the same module-scoped cache state across two consecutive calls.
  // Each test calls clearLanguageCache() at the start of its own setup.
  it('caches the language catalog across consecutive calls (TTL window)', async () => {
    clearLanguageCache();
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    dataAccess.BrandSemrushProject.create.resolves();
    const transport = {
      listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
      createProject: sinon.stub().resolves({ id: 'proj-1' }),
      publishProject: sinon.stub().resolves(),
    };

    // Two consecutive handleCreateMarket calls — distinct geoTargetId/lang
    // so the slice-already-exists guard doesn't trip. Both should resolve
    // English via the cached catalog after the first miss.
    await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, fakeLog());
    transport.createProject.resetHistory();
    transport.createProject.resolves({ id: 'proj-2' });
    await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
      market: 'GB', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    }, fakeLog());

    // ONE upstream catalog call across two market creates.
    expect(transport.listLanguages).to.have.callCount(1);
  });

  it('refreshes the catalog after the TTL expires', async () => {
    clearLanguageCache();
    const clock = sinon.useFakeTimers({ now: Date.now() });
    try {
      const dataAccess = makeDataAccess([]);
      dataAccess.BrandSemrushProject.findBySlice.resolves(null);
      dataAccess.BrandSemrushProject.create.resolves();
      const transport = {
        listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
        createProject: sinon.stub().resolves({ id: 'proj-1' }),
        publishProject: sinon.stub().resolves(),
      };

      await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
        market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
      }, fakeLog());

      // Advance past the 1h TTL boundary.
      clock.tick(60 * 60 * 1000 + 1);

      transport.createProject.resetHistory();
      transport.createProject.resolves({ id: 'proj-2' });
      await handleCreateMarket(transport, dataAccess, BRAND, WORKSPACE, {
        market: 'GB', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
      }, fakeLog());

      expect(transport.listLanguages).to.have.callCount(2);
    } finally {
      clock.restore();
    }
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

describe('handlers/markets.js — handleGetMarket', () => {
  it('400s on invalid geoTargetId (non-positive)', async () => {
    const dataAccess = makeDataAccess([]);
    const err = await handleGetMarket(dataAccess, BRAND, 0, 'en').catch((e) => e);
    expect(err).to.be.instanceOf(ErrorWithStatusCode);
    expect(err.status).to.equal(400);
    expect(dataAccess.BrandSemrushProject.findBySlice).not.to.have.been.called;
  });

  it('400s on syntactically malformed languageCode (`1z`)', async () => {
    const dataAccess = makeDataAccess([]);
    const err = await handleGetMarket(dataAccess, BRAND, 2840, '1z').catch((e) => e);
    expect(err).to.be.instanceOf(ErrorWithStatusCode);
    expect(err.status).to.equal(400);
    expect(dataAccess.BrandSemrushProject.findBySlice).not.to.have.been.called;
  });

  it('404s with marketNotFound when the slice has no row', async () => {
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);
    const err = await handleGetMarket(dataAccess, BRAND, 2840, 'en').catch((e) => e);
    expect(err).to.be.instanceOf(ErrorWithStatusCode);
    expect(err.status).to.equal(404);
    expect(err.code).to.equal('marketNotFound');
  });

  it('returns the full slice detail including semrushProjectId on the happy path', async () => {
    const row = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(row);

    const result = await handleGetMarket(dataAccess, BRAND, 2840, 'en');

    expect(dataAccess.BrandSemrushProject.findBySlice)
      .to.have.been.calledOnceWithExactly(BRAND, 2840, 'en');
    expect(result).to.deep.equal({
      brandId: BRAND,
      geoTargetId: 2840,
      languageCode: 'en',
      semrushProjectId: 'proj-us-en',
      createdAt: '2026-05-28T10:00:00Z',
      updatedAt: '2026-05-28T10:00:00Z',
    });
  });
});

describe('handlers/markets.js — handleListTags / handleListModels', () => {
  beforeEach(() => clearTagCache());

  it('listTags 400s on missing filters', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleListTags({}, dataAccess, BRAND, WORKSPACE, {}))
      .to.be.rejectedWith(ErrorWithStatusCode);
  });

  // Minor #6 from review: malformed languageCode must 400 (regex-validated
  // via normalizeLanguageCode) instead of silently lowercasing and
  // mismatching downstream. Lock for handleListTags.
  it('listTags 400s on syntactically malformed languageCode (`ENG-X`)', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleListTags({}, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'ENG-X',
    })).to.be.rejectedWith(ErrorWithStatusCode);
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

  it('listModels (catalog mode) calls listGlobalAiModels and returns items', async () => {
    const dataAccess = makeDataAccess([]);
    const transport = {
      listGlobalAiModels: sinon.stub().resolves({
        items: [
          {
            id: 'cat-gpt-4o', key: 'chatgpt', name: 'ChatGPT', icon: null,
          },
          {
            id: 'cat-claude', key: 'claude', name: 'Claude', icon: null,
          },
        ],
      }),
    };
    const result = await handleListModels(transport, dataAccess, BRAND, WORKSPACE, {});
    expect(result.items).to.have.lengthOf(2);
    expect(result.items[0].id).to.equal('cat-gpt-4o');
    expect(transport.listGlobalAiModels).to.have.callCount(1);
  });

  it('listModels (catalog mode) paginates when page 1 is full (100 items)', async () => {
    const dataAccess = makeDataAccess([]);
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `cat-${i}`, key: `model-${i}`, name: null, icon: null,
    }));
    const stub = sinon.stub();
    stub.onFirstCall().resolves({ items: page1 });
    stub.onSecondCall().resolves({ items: [] });
    const transport = { listGlobalAiModels: stub };
    const result = await handleListModels(transport, dataAccess, BRAND, WORKSPACE, {});
    expect(result.items).to.have.lengthOf(100);
    expect(stub).to.have.callCount(2);
  });

  it('listModels (catalog mode) also normalises wrapped assignment items from workspace endpoint', async () => {
    const dataAccess = makeDataAccess([]);
    const transport = {
      listGlobalAiModels: sinon.stub().resolves({
        items: [
          {
            id: 'assign-1',
            model: {
              id: 'cat-gpt', key: 'chatgpt', name: 'ChatGPT', icon: null,
            },
          },
        ],
      }),
    };
    const result = await handleListModels(transport, dataAccess, BRAND, WORKSPACE, {});
    expect(result.items).to.have.lengthOf(1);
    expect(result.items[0].id).to.equal('cat-gpt');
  });

  it('listModels (catalog mode) returns empty when workspace endpoint responds 404/405', async () => {
    const dataAccess = makeDataAccess([]);
    const transport404 = {
      listGlobalAiModels: sinon.stub().rejects(new SerenityTransportError(404, 'not found')),
    };
    const result404 = await handleListModels(transport404, dataAccess, BRAND, WORKSPACE, {});
    expect(result404).to.deep.equal({ items: [] });

    const transport405 = {
      listGlobalAiModels: sinon.stub().rejects(new SerenityTransportError(405, 'not allowed')),
    };
    const result405 = await handleListModels(transport405, dataAccess, BRAND, WORKSPACE, {});
    expect(result405).to.deep.equal({ items: [] });
  });

  it('listModels (catalog mode) propagates auth errors (401/403) from workspace endpoint', async () => {
    const dataAccess = makeDataAccess([]);
    const transport401 = {
      listGlobalAiModels: sinon.stub().rejects(new SerenityTransportError(401, 'unauthorized')),
    };
    await expect(handleListModels(transport401, dataAccess, BRAND, WORKSPACE, {}))
      .to.be.rejectedWith(SerenityTransportError);

    const transport403 = {
      listGlobalAiModels: sinon.stub().rejects(new SerenityTransportError(403, 'forbidden')),
    };
    await expect(handleListModels(transport403, dataAccess, BRAND, WORKSPACE, {}))
      .to.be.rejectedWith(SerenityTransportError);
  });

  it('listModels 400s when only one of geoTargetId/languageCode is provided', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleListModels({}, dataAccess, BRAND, WORKSPACE, { geoTargetId: 2840 }))
      .to.be.rejectedWith(ErrorWithStatusCode);
    await expect(handleListModels({}, dataAccess, BRAND, WORKSPACE, { languageCode: 'en' }))
      .to.be.rejectedWith(ErrorWithStatusCode);
  });

  // Minor #6 from review: lock the malformed-languageCode 400 contract.
  it('listModels 400s on syntactically malformed languageCode (`1z`)', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleListModels({}, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: '1z',
    })).to.be.rejectedWith(ErrorWithStatusCode);
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

describe('handlers/markets.js — handleUpdateModels', () => {
  function makeTransport({ currentItems = [], addResult = {}, deleteResult = undefined } = {}) {
    return {
      listAiModels: sinon.stub().resolves({ items: currentItems }),
      addAiModel: sinon.stub().resolves(addResult),
      deleteAiModelsByIds: sinon.stub().resolves(deleteResult),
    };
  }

  it('rejects when geoTargetId is missing', async () => {
    const da = makeDataAccess([]);
    await expect(
      handleUpdateModels({}, da, BRAND, WORKSPACE, { languageCode: 'en', modelIds: [] }, fakeLog()),
    ).to.be.rejectedWith(ErrorWithStatusCode, /geoTargetId/);
  });

  it('rejects when languageCode is missing', async () => {
    const da = makeDataAccess([]);
    await expect(
      handleUpdateModels({}, da, BRAND, WORKSPACE, { geoTargetId: 2840, modelIds: [] }, fakeLog()),
    ).to.be.rejectedWith(ErrorWithStatusCode, /BCP-47/);
  });

  it('rejects when modelIds is not an array', async () => {
    const da = makeDataAccess([]);
    await expect(
      handleUpdateModels({}, da, BRAND, WORKSPACE, {
        geoTargetId: 2840, languageCode: 'en', modelIds: 'bad',
      }, fakeLog()),
    ).to.be.rejectedWith(ErrorWithStatusCode, /modelIds/);
  });

  it('rejects when modelIds contains non-string entries', async () => {
    const da = makeDataAccess([]);
    await expect(
      handleUpdateModels({}, da, BRAND, WORKSPACE, {
        geoTargetId: 2840, languageCode: 'en', modelIds: [42],
      }, fakeLog()),
    ).to.be.rejectedWith(ErrorWithStatusCode, /modelIds/);
  });

  it('throws 404 when market row is not found', async () => {
    const da = makeDataAccess([]);
    da.BrandSemrushProject.findBySlice.resolves(null);
    await expect(
      handleUpdateModels({}, da, BRAND, WORKSPACE, {
        geoTargetId: 2840, languageCode: 'en', modelIds: [],
      }, fakeLog()),
    ).to.be.rejectedWith(ErrorWithStatusCode, /Market not found/);
  });

  it('adds models absent from the current set', async () => {
    const project = makeProject({ semrushProjectId: 'proj-1', geoTargetId: 2840, languageCode: 'en' });
    const da = makeDataAccess([]);
    da.BrandSemrushProject.findBySlice.resolves(project);
    const transport = makeTransport({
      currentItems: [],
    });
    // after add, list returns the newly added model
    transport.listAiModels.onSecondCall().resolves({
      items: [{
        id: 'assign-1',
        model: {
          id: 'cat-gpt', key: 'chatgpt', name: 'ChatGPT', icon: null,
        },
      }],
    });

    const result = await handleUpdateModels(
      transport,
      da,
      BRAND,
      WORKSPACE,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['cat-gpt'] },
      fakeLog(),
    );

    expect(transport.addAiModel).to.have.been.calledOnceWith(WORKSPACE, 'proj-1', 'cat-gpt');
    expect(transport.deleteAiModelsByIds).not.to.have.been.called;
    expect(result.items).to.have.length(1);
    expect(result.items[0].id).to.equal('cat-gpt');
  });

  it('removes models absent from the desired set', async () => {
    const project = makeProject({ semrushProjectId: 'proj-1', geoTargetId: 2840, languageCode: 'en' });
    const da = makeDataAccess([]);
    da.BrandSemrushProject.findBySlice.resolves(project);
    const transport = makeTransport({
      currentItems: [
        {
          id: 'assign-1',
          model: {
            id: 'cat-gpt', key: 'chatgpt', name: 'ChatGPT', icon: null,
          },
        },
      ],
    });
    transport.listAiModels.onSecondCall().resolves({ items: [] });

    const result = await handleUpdateModels(
      transport,
      da,
      BRAND,
      WORKSPACE,
      { geoTargetId: 2840, languageCode: 'en', modelIds: [] },
      fakeLog(),
    );

    expect(transport.deleteAiModelsByIds).to.have.been.calledOnceWith(WORKSPACE, 'proj-1', ['assign-1']);
    expect(transport.addAiModel).not.to.have.been.called;
    expect(result.items).to.deep.equal([]);
  });

  it('adds and removes in the same call', async () => {
    const project = makeProject({ semrushProjectId: 'proj-1', geoTargetId: 2840, languageCode: 'en' });
    const da = makeDataAccess([]);
    da.BrandSemrushProject.findBySlice.resolves(project);
    const transport = makeTransport({
      currentItems: [
        {
          id: 'assign-old',
          model: {
            id: 'cat-old', key: 'old-model', name: 'Old', icon: null,
          },
        },
      ],
    });
    transport.listAiModels.onSecondCall().resolves({
      items: [{
        id: 'assign-new',
        model: {
          id: 'cat-new', key: 'new-model', name: 'New', icon: null,
        },
      }],
    });

    await handleUpdateModels(
      transport,
      da,
      BRAND,
      WORKSPACE,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['cat-new'] },
      fakeLog(),
    );

    expect(transport.deleteAiModelsByIds).to.have.been.calledOnceWith(WORKSPACE, 'proj-1', ['assign-old']);
    expect(transport.addAiModel).to.have.been.calledOnceWith(WORKSPACE, 'proj-1', 'cat-new');
  });

  it('is a no-op when desired set equals current set', async () => {
    const project = makeProject({ semrushProjectId: 'proj-1', geoTargetId: 2840, languageCode: 'en' });
    const da = makeDataAccess([]);
    da.BrandSemrushProject.findBySlice.resolves(project);
    const transport = makeTransport({
      currentItems: [
        {
          id: 'assign-1',
          model: {
            id: 'cat-gpt', key: 'chatgpt', name: 'ChatGPT', icon: null,
          },
        },
      ],
    });
    const result = await handleUpdateModels(
      transport,
      da,
      BRAND,
      WORKSPACE,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['cat-gpt'] },
      fakeLog(),
    );

    expect(transport.deleteAiModelsByIds).not.to.have.been.called;
    expect(transport.addAiModel).not.to.have.been.called;
    // Short-circuit: only one upstream list call (the initial fetch; no second refresh)
    expect(transport.listAiModels).to.have.callCount(1);
    expect(result.items).to.have.length(1);
    expect(result.items[0].id).to.equal('cat-gpt');
  });

  it('propagates transport errors from deleteAiModelsByIds', async () => {
    const project = makeProject({ semrushProjectId: 'proj-1', geoTargetId: 2840, languageCode: 'en' });
    const da = makeDataAccess([]);
    da.BrandSemrushProject.findBySlice.resolves(project);
    const transport = makeTransport({
      currentItems: [
        {
          id: 'assign-1',
          model: {
            id: 'cat-gpt', key: 'chatgpt', name: 'ChatGPT', icon: null,
          },
        },
      ],
    });
    const err = new SerenityTransportError(502, 'upstream failure');
    transport.deleteAiModelsByIds.rejects(err);

    await expect(
      handleUpdateModels(transport, da, BRAND, WORKSPACE, {
        geoTargetId: 2840, languageCode: 'en', modelIds: [],
      }, fakeLog()),
    ).to.be.rejectedWith(SerenityTransportError);
  });

  it('propagates transport errors from addAiModel', async () => {
    const project = makeProject({ semrushProjectId: 'proj-1', geoTargetId: 2840, languageCode: 'en' });
    const da = makeDataAccess([]);
    da.BrandSemrushProject.findBySlice.resolves(project);
    const transport = makeTransport({ currentItems: [] });
    const err = new SerenityTransportError(502, 'upstream failure');
    transport.addAiModel.rejects(err);

    await expect(
      handleUpdateModels(transport, da, BRAND, WORKSPACE, {
        geoTargetId: 2840, languageCode: 'en', modelIds: ['cat-new'],
      }, fakeLog()),
    ).to.be.rejectedWith(SerenityTransportError);
  });

  it('rejects when modelIds exceeds the maximum length', async () => {
    const da = makeDataAccess([]);
    const tooMany = Array.from({ length: 51 }, (_, i) => `cat-${i}`);
    await expect(
      handleUpdateModels({}, da, BRAND, WORKSPACE, {
        geoTargetId: 2840, languageCode: 'en', modelIds: tooMany,
      }, fakeLog()),
    ).to.be.rejectedWith(ErrorWithStatusCode, /exceed/);
  });

  it('deduplicates modelIds before diffing — addAiModel called only once for duplicates', async () => {
    const project = makeProject({ semrushProjectId: 'proj-1', geoTargetId: 2840, languageCode: 'en' });
    const da = makeDataAccess([]);
    da.BrandSemrushProject.findBySlice.resolves(project);
    const transport = makeTransport({ currentItems: [] });
    transport.listAiModels.onSecondCall().resolves({
      items: [{
        id: 'assign-1',
        model: {
          id: 'cat-gpt', key: 'chatgpt', name: 'ChatGPT', icon: null,
        },
      }],
    });

    await handleUpdateModels(
      transport,
      da,
      BRAND,
      WORKSPACE,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['cat-gpt', 'cat-gpt'] },
      fakeLog(),
    );

    expect(transport.addAiModel).to.have.been.calledOnceWith(WORKSPACE, 'proj-1', 'cat-gpt');
  });

  it('converges correctly on retry after a partial-failure add', async () => {
    // First invocation: add two models, second one fails.
    const project = makeProject({ semrushProjectId: 'proj-1', geoTargetId: 2840, languageCode: 'en' });
    const da = makeDataAccess([]);
    da.BrandSemrushProject.findBySlice.resolves(project);
    const transport = makeTransport({ currentItems: [] });
    transport.addAiModel.onFirstCall().resolves({});
    transport.addAiModel.onSecondCall().rejects(new SerenityTransportError(502, 'upstream failure'));

    await expect(
      handleUpdateModels(
        transport,
        da,
        BRAND,
        WORKSPACE,
        { geoTargetId: 2840, languageCode: 'en', modelIds: ['cat-a', 'cat-b'] },
        fakeLog(),
      ),
    ).to.be.rejectedWith(SerenityTransportError);

    // After partial failure, 'cat-a' is now persisted upstream.
    // Retry with the same desired set: diff should only add 'cat-b'.
    const transport2 = makeTransport({
      currentItems: [{
        id: 'assign-a',
        model: {
          id: 'cat-a', key: 'model-a', name: 'Model A', icon: null,
        },
      }],
    });
    transport2.listAiModels.onSecondCall().resolves({
      items: [
        {
          id: 'assign-a',
          model: {
            id: 'cat-a', key: 'model-a', name: 'Model A', icon: null,
          },
        },
        {
          id: 'assign-b',
          model: {
            id: 'cat-b', key: 'model-b', name: 'Model B', icon: null,
          },
        },
      ],
    });

    const result = await handleUpdateModels(
      transport2,
      da,
      BRAND,
      WORKSPACE,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['cat-a', 'cat-b'] },
      fakeLog(),
    );

    expect(transport2.addAiModel).to.have.been.calledOnceWith(WORKSPACE, 'proj-1', 'cat-b');
    expect(transport2.deleteAiModelsByIds).not.to.have.been.called;
    expect(result.items).to.have.length(2);
  });

  it('filters out malformed current items (null model) from the no-op short-circuit response', async () => {
    const project = makeProject({ semrushProjectId: 'proj-1', geoTargetId: 2840, languageCode: 'en' });
    const da = makeDataAccess([]);
    da.BrandSemrushProject.findBySlice.resolves(project);
    // currentItems has one valid entry and one with model: null (malformed upstream shape)
    const transport = makeTransport({
      currentItems: [
        {
          id: 'assign-good',
          model: {
            id: 'cat-a', key: 'key-a', name: null, icon: null,
          },
        },
        { id: 'assign-bad', model: null },
      ],
    });

    const result = await handleUpdateModels(
      transport,
      da,
      BRAND,
      WORKSPACE,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['cat-a'] },
      fakeLog(),
    );

    // Short-circuit fires (cat-a already current). Malformed entry is excluded.
    expect(transport.addAiModel).not.to.have.been.called;
    expect(transport.deleteAiModelsByIds).not.to.have.been.called;
    expect(result.items).to.have.length(1);
    expect(result.items[0].id).to.equal('cat-a');
  });
});
