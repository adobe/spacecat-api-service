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
  resolveMainBenchmarkId,
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

  describe('resolveMainBenchmarkId', () => {
    it('returns the main_brand benchmark id', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves({
          aio_benchmarks: [
            { id: 'comp-1', main_brand: false },
            { id: 'main-1', main_brand: true },
          ],
        }),
      };
      expect(await resolveMainBenchmarkId(transport, WS, PID)).to.equal('main-1');
    });

    it('falls back to the first benchmark when none is flagged main', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves({
          aio_benchmarks: [{ id: 'first' }, { id: 'second' }],
        }),
      };
      expect(await resolveMainBenchmarkId(transport, WS, PID)).to.equal('first');
    });

    it('throws 502 when the project has no benchmarks', async () => {
      const transport = { listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }) };
      await expect(resolveMainBenchmarkId(transport, WS, PID))
        .to.be.rejectedWith('No main-brand benchmark');
    });
  });

  describe('attachBrandUrlsToProject', () => {
    it('is a no-op when there are no entries', async () => {
      const transport = { listBenchmarks: sandbox.stub(), createBrandUrls: sandbox.stub() };
      const result = await attachBrandUrlsToProject(transport, WS, PID, [], undefined);
      expect(result).to.deep.equal({ created: 0 });
      expect(transport.listBenchmarks).to.not.have.been.called;
      expect(transport.createBrandUrls).to.not.have.been.called;
    });

    it('resolves the main benchmark and creates the URLs', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves(benchOk()),
        createBrandUrls: sandbox.stub().resolves({ ids: ['a'], existing_count: 0 }),
      };
      const entries = [{ url: 'https://acme.com', type: 'website' }];
      const result = await attachBrandUrlsToProject(transport, WS, PID, entries, undefined);
      expect(result).to.deep.equal({ created: 1 });
      expect(transport.createBrandUrls).to.have.been.calledOnceWith(WS, PID, BID, entries);
    });

    it('propagates a create failure (hard-fail)', async () => {
      const transport = {
        listBenchmarks: sandbox.stub().resolves(benchOk()),
        createBrandUrls: sandbox.stub().rejects(new SerenityTransportError(400, 'bad url')),
      };
      await expect(
        attachBrandUrlsToProject(transport, WS, PID, [{ url: 'https://x', type: 'website' }]),
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
