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
  BRAND_URL_TYPE,
  regionApplies,
  collectBrandUrlEntries,
  normalizeBenchmarkDomain,
  ensureOwnBrandBenchmark,
  attachBrandUrlsToProject,
  syncBrandUrlsAcrossMarkets,
} from '../../../src/support/serenity/brand-urls.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

use(chaiAsPromised);
use(sinonChai);

const WS = 'ws-1';
const PID = 'proj-1';
const BID = 'bench-1';

describe('brand-urls helpers', () => {
  const sandbox = sinon.createSandbox();
  const benchOk = () => ({ aio_benchmarks: [{ id: BID, main_brand: true }] });
  afterEach(() => sandbox.restore());

  describe('regionApplies', () => {
    it('applies when there are no regions (region-less)', () => {
      expect(regionApplies([], 'us')).to.equal(true);
      expect(regionApplies(null, 'us')).to.equal(true);
      expect(regionApplies(undefined, 'de')).to.equal(true);
    });

    it('applies when the market is listed (case-insensitive)', () => {
      expect(regionApplies(['US'], 'us')).to.equal(true);
      expect(regionApplies(['de', 'fr'], 'FR')).to.equal(true);
    });

    it('applies when marked worldwide', () => {
      expect(regionApplies(['ww'], 'us')).to.equal(true);
      expect(regionApplies(['WW'], 'jp')).to.equal(true);
    });

    it('does not apply when the market is not listed', () => {
      expect(regionApplies(['de'], 'us')).to.equal(false);
      expect(regionApplies(['fr', 'it'], 'us')).to.equal(false);
    });
  });

  describe('collectBrandUrlEntries', () => {
    it('maps brand urls → website (region-less), social → social, earned → earned', () => {
      const sources = {
        urls: ['https://acme.com', { value: 'https://blog.acme.com' }],
        socialAccounts: [{ url: 'https://x.com/acme', regions: ['us'] }],
        earnedContent: [{ url: 'https://news.example/acme', regions: [] }],
      };
      expect(collectBrandUrlEntries(sources, 'us')).to.deep.equal([
        { url: 'https://acme.com', type: BRAND_URL_TYPE.WEBSITE },
        { url: 'https://blog.acme.com', type: BRAND_URL_TYPE.WEBSITE },
        { url: 'https://x.com/acme', type: BRAND_URL_TYPE.SOCIAL },
        { url: 'https://news.example/acme', type: BRAND_URL_TYPE.EARNED },
      ]);
    });

    it('region-filters social and earned to the market (brand urls always included)', () => {
      const sources = {
        urls: ['https://acme.com'],
        socialAccounts: [
          { url: 'https://x.com/us', regions: ['us'] },
          { url: 'https://x.com/de', regions: ['de'] },
        ],
        earnedContent: [{ url: 'https://news.de/acme', regions: ['de'] }],
      };
      expect(collectBrandUrlEntries(sources, 'us')).to.deep.equal([
        { url: 'https://acme.com', type: BRAND_URL_TYPE.WEBSITE },
        { url: 'https://x.com/us', type: BRAND_URL_TYPE.SOCIAL },
      ]);
    });

    it('drops non-https URLs', () => {
      const sources = {
        urls: ['http://insecure.com', 'https://secure.com', 'ftp://nope.com', ''],
        socialAccounts: [{ url: 'http://x.com/acme', regions: [] }],
      };
      expect(collectBrandUrlEntries(sources, 'us')).to.deep.equal([
        { url: 'https://secure.com', type: BRAND_URL_TYPE.WEBSITE },
      ]);
    });

    it('de-duplicates by URL, first-seen type wins', () => {
      const sources = {
        urls: ['https://acme.com'],
        socialAccounts: [{ url: 'https://acme.com', regions: [] }],
      };
      expect(collectBrandUrlEntries(sources, 'us')).to.deep.equal([
        { url: 'https://acme.com', type: BRAND_URL_TYPE.WEBSITE },
      ]);
    });

    it('trims surrounding whitespace and tolerates null/undefined sources', () => {
      expect(collectBrandUrlEntries(null, 'us')).to.deep.equal([]);
      expect(collectBrandUrlEntries({ urls: ['  https://acme.com  '] }, 'us')).to.deep.equal([
        { url: 'https://acme.com', type: BRAND_URL_TYPE.WEBSITE },
      ]);
    });
  });

  describe('normalizeBenchmarkDomain', () => {
    it('strips scheme, www., and path to the bare host', () => {
      expect(normalizeBenchmarkDomain('https://www.Acme.com/path?q=1')).to.equal('acme.com');
      expect(normalizeBenchmarkDomain('acme.com')).to.equal('acme.com');
    });

    it('returns null for empty / non-string input', () => {
      expect(normalizeBenchmarkDomain('')).to.equal(null);
      expect(normalizeBenchmarkDomain('   ')).to.equal(null);
      expect(normalizeBenchmarkDomain(undefined)).to.equal(null);
      expect(normalizeBenchmarkDomain(42)).to.equal(null);
    });

    it('returns null when the value cannot be parsed as a URL', () => {
      // Contains '://' so it is NOT prefixed with https://, and is unparseable —
      // exercises the catch path.
      expect(normalizeBenchmarkDomain('https://')).to.equal(null);
      expect(normalizeBenchmarkDomain('ht!tp://[bad')).to.equal(null);
    });
  });

  describe('ensureOwnBrandBenchmark', () => {
    const BRAND = { name: 'Acme', domain: 'https://acme.com', aliases: ['acme inc'] };

    it('logs the created benchmark id when a logger is supplied', async () => {
      const info = sandbox.stub();
      const transport = {
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub().resolves({ ids: ['new-9'], existing_count: 0 }),
      };
      const id = await ensureOwnBrandBenchmark(transport, WS, PID, BRAND, { info });
      expect(id).to.equal('new-9');
      expect(info).to.have.been.calledWithMatch(
        'brand-urls: created own-brand benchmark',
        sinon.match({ benchmarkId: 'new-9' }),
      );
    });

    it('returns the existing main_brand benchmark without creating', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves({
          aio_benchmarks: [
            { id: 'comp-1', main_brand: false, domain: 'x.com' },
            { id: 'main-1', main_brand: true },
          ],
        }),
        createBenchmarks: sandbox.stub(),
      };
      expect(await ensureOwnBrandBenchmark(transport, WS, PID, BRAND, undefined)).to.equal('main-1');
      expect(transport.createBenchmarks).to.not.have.been.called;
    });

    it('reuses an existing benchmark matched by the brand domain (idempotent)', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves({
          aio_benchmarks: [{ id: 'own-1', main_brand: false, domain: 'https://www.acme.com/x' }],
        }),
        createBenchmarks: sandbox.stub(),
      };
      expect(await ensureOwnBrandBenchmark(transport, WS, PID, BRAND, undefined)).to.equal('own-1');
      expect(transport.createBenchmarks).to.not.have.been.called;
    });

    it('creates the own-brand benchmark when the project has none', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub().resolves({ ids: ['new-1'], existing_count: 0 }),
      };
      expect(await ensureOwnBrandBenchmark(transport, WS, PID, BRAND, undefined)).to.equal('new-1');
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Acme', domain: 'https://acme.com', brand_aliases: ['acme inc'] },
      ]);
    });

    it('re-lists and matches by domain when create returns no id (already existed)', async () => {
      const transport = {
        listBenchmarks: sandbox.stub(),
        createBenchmarks: sandbox.stub().resolves({ ids: [], existing_count: 1 }),
      };
      transport.listBenchmarks.onFirstCall().resolves({ aio_benchmarks: [] });
      transport.listBenchmarks.onSecondCall().resolves({
        aio_benchmarks: [{ id: 'own-2', domain: 'acme.com' }],
      });
      expect(await ensureOwnBrandBenchmark(transport, WS, PID, BRAND, undefined)).to.equal('own-2');
    });

    it('recovers from a 409 (duplicate) by re-listing and matching by domain', async () => {
      const transport = {
        listBenchmarks: sandbox.stub(),
        createBenchmarks: sandbox.stub().rejects(new SerenityTransportError(409, 'duplicate')),
      };
      transport.listBenchmarks.onFirstCall().resolves({ aio_benchmarks: [] });
      transport.listBenchmarks.onSecondCall().resolves({
        aio_benchmarks: [{ id: 'own-3', domain: 'acme.com' }],
      });
      expect(await ensureOwnBrandBenchmark(transport, WS, PID, BRAND, undefined)).to.equal('own-3');
    });

    it('returns null when there is no benchmark and no usable domain', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub(),
      };
      const r = await ensureOwnBrandBenchmark(transport, WS, PID, { name: 'Acme', domain: '' }, undefined);
      expect(r).to.equal(null);
      expect(transport.createBenchmarks).to.not.have.been.called;
    });

    it('propagates a non-409 create error', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub().rejects(new SerenityTransportError(500, 'boom')),
      };
      await expect(ensureOwnBrandBenchmark(transport, WS, PID, BRAND, undefined))
        .to.be.rejectedWith('boom');
    });
  });

  describe('attachBrandUrlsToProject', () => {
    const BRAND = { name: 'Acme', domain: 'https://acme.com' };

    it('is a no-op when there are no entries', async () => {
      const transport = { listBenchmarks: sandbox.stub(), createBrandUrls: sandbox.stub() };
      const result = await attachBrandUrlsToProject(transport, WS, PID, [], BRAND, undefined);
      expect(result).to.deep.equal({ created: 0 });
      expect(transport.listBenchmarks).to.not.have.been.called;
      expect(transport.createBrandUrls).to.not.have.been.called;
    });

    it('ensures the benchmark and creates the URLs', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves(benchOk()),
        createBenchmarks: sandbox.stub(),
        createBrandUrls: sandbox.stub().resolves({ ids: ['a'], existing_count: 0 }),
      };
      const entries = [{ url: 'https://acme.com', type: 'website' }];
      const result = await attachBrandUrlsToProject(transport, WS, PID, entries, BRAND, undefined);
      expect(result).to.deep.equal({ created: 1 });
      expect(transport.createBrandUrls).to.have.been.calledOnceWith(WS, PID, BID, entries);
    });

    it('creates the benchmark first when the project has none, then attaches', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub().resolves({ ids: ['new-1'], existing_count: 0 }),
        createBrandUrls: sandbox.stub().resolves({ ids: ['a'], existing_count: 0 }),
      };
      const entries = [{ url: 'https://acme.com', type: 'website' }];
      const result = await attachBrandUrlsToProject(transport, WS, PID, entries, BRAND, undefined);
      expect(result).to.deep.equal({ created: 1 });
      expect(transport.createBenchmarks).to.have.been.calledOnce;
      expect(transport.createBrandUrls).to.have.been.calledOnceWith(WS, PID, 'new-1', entries);
    });

    it('skips (no throw) when no benchmark can be resolved or created', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub(),
        createBrandUrls: sandbox.stub(),
      };
      const entries = [{ url: 'https://acme.com', type: 'website' }];
      const result = await attachBrandUrlsToProject(transport, WS, PID, entries, { name: 'Acme', domain: '' }, undefined);
      expect(result).to.deep.equal({ created: 0, skipped: true });
      expect(transport.createBrandUrls).to.not.have.been.called;
    });

    it('warns when skipping a benchmark-less attach and a logger is supplied', async () => {
      const warn = sandbox.stub();
      const transport = {
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub(),
        createBrandUrls: sandbox.stub(),
      };
      const entries = [{ url: 'https://acme.com', type: 'website' }];
      const result = await attachBrandUrlsToProject(
        transport,
        WS,
        PID,
        entries,
        { name: 'Acme', domain: '' },
        { warn, info: () => {} },
      );
      expect(result).to.deep.equal({ created: 0, skipped: true });
      expect(warn).to.have.been.calledWithMatch(
        'brand-urls: no benchmark available — skipping URL attach',
        sinon.match({ count: 1 }),
      );
    });

    it('propagates a create-URL failure', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves(benchOk()),
        createBrandUrls: sandbox.stub().rejects(new SerenityTransportError(400, 'bad url')),
      };
      await expect(
        attachBrandUrlsToProject(transport, WS, PID, [{ url: 'https://x', type: 'website' }], BRAND, undefined),
      ).to.be.rejectedWith('bad url');
    });
  });

  describe('syncBrandUrlsAcrossMarkets', () => {
    function projectWith(id, country) {
      return { id, settings: { ai: { country: { code: country } } } };
    }

    it('creates additions, deletes removals, and republishes per changed market', async () => {
      const sources = {
        urls: ['https://acme.com'],
        socialAccounts: [{ url: 'https://x.com/us', regions: ['us'] }],
      };
      const transport = {
        listProjects: sandbox.stub().resolves({ items: [projectWith('p-us', 'us')] }),
        listBenchmarks: sandbox.stub().resolves(benchOk()),
        listBrandUrls: sandbox.stub().resolves({
          brand_urls: [
            { id: 'keep', url: 'https://acme.com' }, // stays
            { id: 'stale', url: 'https://old.com' }, // removed
          ],
        }),
        createBrandUrls: sandbox.stub().resolves({}),
        deleteBrandUrls: sandbox.stub().resolves({}),
        publishProject: sandbox.stub().resolves({}),
      };

      const result = await syncBrandUrlsAcrossMarkets(transport, sources, WS, undefined);

      expect(transport.createBrandUrls).to.have.been.calledOnceWith(WS, 'p-us', BID, [
        { url: 'https://x.com/us', type: BRAND_URL_TYPE.SOCIAL },
      ]);
      expect(transport.deleteBrandUrls).to.have.been.calledOnceWith(WS, 'p-us', BID, ['stale']);
      expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'p-us');
      expect(result).to.deep.equal({ markets: 1, created: 1, deleted: 1 });
    });

    it('skips republish when nothing changed', async () => {
      const sources = { urls: ['https://acme.com'] };
      const transport = {
        listProjects: sandbox.stub().resolves({ items: [projectWith('p-us', 'us')] }),
        listBenchmarks: sandbox.stub().resolves(benchOk()),
        listBrandUrls: sandbox.stub().resolves({ brand_urls: [{ id: 'keep', url: 'https://acme.com' }] }),
        createBrandUrls: sandbox.stub().resolves({}),
        deleteBrandUrls: sandbox.stub().resolves({}),
        publishProject: sandbox.stub().resolves({}),
      };
      const result = await syncBrandUrlsAcrossMarkets(transport, sources, WS, undefined);
      expect(transport.createBrandUrls).to.not.have.been.called;
      expect(transport.deleteBrandUrls).to.not.have.been.called;
      expect(transport.publishProject).to.not.have.been.called;
      expect(result).to.deep.equal({ markets: 1, created: 0, deleted: 0 });
    });

    it('skips (warns, decrements market count) when a project has no resolvable benchmark', async () => {
      const warn = sandbox.stub();
      // Project has a country (so it is region-addressable) but no domain and no
      // existing benchmark → ensureOwnBrandBenchmark returns null → skip.
      const transport = {
        listProjects: sandbox.stub().resolves({ items: [projectWith('p-us', 'us')] }),
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub(),
        listBrandUrls: sandbox.stub(),
        createBrandUrls: sandbox.stub(),
        deleteBrandUrls: sandbox.stub(),
        publishProject: sandbox.stub(),
      };
      const result = await syncBrandUrlsAcrossMarkets(
        transport,
        { urls: ['https://acme.com'] },
        WS,
        { warn, info: () => {} },
      );
      expect(transport.listBrandUrls).to.not.have.been.called;
      expect(warn).to.have.been.calledWithMatch('brand-urls: no benchmark available — skipping market');
      expect(result).to.deep.equal({ markets: 0, created: 0, deleted: 0 });
    });

    it('skips projects with no resolvable market country', async () => {
      const transport = {
        listProjects: sandbox.stub().resolves({
          items: [{ id: 'p-x', settings: { ai: {} } }, { settings: { ai: { country: { code: 'us' } } } }],
        }),
        listBenchmarks: sandbox.stub(),
        listBrandUrls: sandbox.stub(),
        createBrandUrls: sandbox.stub(),
        deleteBrandUrls: sandbox.stub(),
        publishProject: sandbox.stub(),
      };
      const result = await syncBrandUrlsAcrossMarkets(transport, { urls: [] }, WS, undefined);
      expect(transport.listBenchmarks).to.not.have.been.called;
      expect(result).to.deep.equal({ markets: 0, created: 0, deleted: 0 });
    });

    it('tolerates a quota 405 on republish (best-effort)', async () => {
      const sources = { urls: ['https://acme.com'] };
      const warn = sandbox.stub();
      const transport = {
        listProjects: sandbox.stub().resolves({ items: [projectWith('p-us', 'us')] }),
        listBenchmarks: sandbox.stub().resolves(benchOk()),
        listBrandUrls: sandbox.stub().resolves({ brand_urls: [] }),
        createBrandUrls: sandbox.stub().resolves({}),
        deleteBrandUrls: sandbox.stub().resolves({}),
        publishProject: sandbox.stub().rejects(new SerenityTransportError(405, 'quota')),
      };
      const logger = { warn, info: () => {} };
      const result = await syncBrandUrlsAcrossMarkets(transport, sources, WS, logger);
      expect(result).to.deep.equal({ markets: 1, created: 1, deleted: 0 });
      expect(warn).to.have.been.called;
    });

    it('propagates a non-405 republish failure (hard-fail)', async () => {
      const sources = { urls: ['https://acme.com'] };
      const transport = {
        listProjects: sandbox.stub().resolves({ items: [projectWith('p-us', 'us')] }),
        listBenchmarks: sandbox.stub().resolves(benchOk()),
        listBrandUrls: sandbox.stub().resolves({ brand_urls: [] }),
        createBrandUrls: sandbox.stub().resolves({}),
        deleteBrandUrls: sandbox.stub().resolves({}),
        publishProject: sandbox.stub().rejects(new SerenityTransportError(500, 'boom')),
      };
      await expect(syncBrandUrlsAcrossMarkets(transport, sources, WS, undefined))
        .to.be.rejectedWith('boom');
    });
  });
});
