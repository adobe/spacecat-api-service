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
  collectCompetitorBenchmarks,
  removedCompetitorDomains,
  syncCompetitorBenchmarksForProject,
  syncCompetitorBenchmarksAcrossMarkets,
} from '../../../src/support/serenity/competitor-benchmarks.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

use(chaiAsPromised);
use(sinonChai);

const WS = 'ws-1';
const PID = 'proj-1';

describe('competitor-benchmarks helpers', () => {
  const sandbox = sinon.createSandbox();
  afterEach(() => sandbox.restore());

  describe('collectCompetitorBenchmarks', () => {
    it('region-filters, extracts domains, defaults name to domain, de-dupes, skips url-less', () => {
      const competitors = [
        { name: 'Bing', url: 'https://www.bing.com', regions: ['us'] },
        { name: 'DE only', url: 'https://de.com', regions: ['de'] }, // filtered out for us
        { url: 'https://www.bing.com/x', regions: [] }, // dup of bing.com
        { name: 'No URL', regions: [] }, // skipped (no url)
        { url: 'https://named-by-domain.com' }, // region-less, no name → name = domain
      ];
      expect(collectCompetitorBenchmarks(competitors, 'us')).to.deep.equal([
        { name: 'Bing', domain: 'bing.com' },
        { name: 'named-by-domain.com', domain: 'named-by-domain.com' },
      ]);
    });

    it('returns [] for empty / non-array input', () => {
      expect(collectCompetitorBenchmarks(null, 'us')).to.deep.equal([]);
      expect(collectCompetitorBenchmarks([], 'us')).to.deep.equal([]);
    });
  });

  describe('removedCompetitorDomains', () => {
    it('returns domains present in old but not new (region-agnostic)', () => {
      const oldC = [
        { url: 'https://a.com', regions: ['us'] },
        { url: 'https://b.com', regions: ['de'] },
      ];
      const newC = [{ url: 'https://a.com', regions: ['us'] }];
      expect(removedCompetitorDomains(oldC, newC)).to.deep.equal(['b.com']);
    });

    it('returns [] when nothing was removed', () => {
      const c = [{ url: 'https://a.com' }];
      expect(removedCompetitorDomains(c, c)).to.deep.equal([]);
      expect(removedCompetitorDomains([], [{ url: 'https://a.com' }])).to.deep.equal([]);
    });
  });

  describe('syncCompetitorBenchmarksForProject', () => {
    function makeTransport(benchmarks) {
      return {
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: benchmarks }),
        createBenchmarks: sandbox.stub().resolves({ ids: ['new'], existing_count: 0 }),
        deleteBenchmarks: sandbox.stub().resolves(null),
      };
    }

    it('creates benchmarks for new competitors, skipping ones already present', async () => {
      const transport = makeTransport([
        { id: 'own', main_brand: true, domain: 'acme.com' },
        { id: 'bing', main_brand: false, domain: 'bing.com' }, // already a benchmark
      ]);
      const competitors = [
        { name: 'Bing', url: 'https://bing.com', regions: ['us'] }, // present → skip
        { name: 'Duck', url: 'https://duckduckgo.com', regions: ['us'] }, // new → create
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Duck', domain: 'duckduckgo.com' },
      ]);
      expect(transport.deleteBenchmarks).to.not.have.been.called;
      expect(result).to.deep.equal({ created: 1, deleted: 0, changed: true });
    });

    it('deletes the benchmark of a removed competitor (never the main brand)', async () => {
      const transport = makeTransport([
        { id: 'own', main_brand: true, domain: 'acme.com' },
        { id: 'gone-id', main_brand: false, domain: 'gone.com' },
      ]);
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, [], ['gone.com', 'acme.com'], 'us', undefined);
      // gone.com deleted by its id; acme.com is main_brand → never deletable.
      expect(transport.deleteBenchmarks).to.have.been.calledOnceWith(WS, PID, ['gone-id']);
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(result).to.deep.equal({ created: 0, deleted: 1, changed: true });
    });

    it('is a no-op (changed:false) when nothing to add or remove', async () => {
      const transport = makeTransport([{ id: 'bing', domain: 'bing.com' }]);
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, [{ name: 'Bing', url: 'https://bing.com' }], [], 'us', undefined);
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(transport.deleteBenchmarks).to.not.have.been.called;
      expect(result.changed).to.equal(false);
    });

    it('propagates a create failure', async () => {
      const transport = makeTransport([]);
      transport.createBenchmarks.rejects(new SerenityTransportError(500, 'boom'));
      await expect(syncCompetitorBenchmarksForProject(transport, WS, PID, [{ name: 'Duck', url: 'https://duckduckgo.com' }], [], 'us', undefined)).to.be.rejectedWith('boom');
    });
  });

  describe('syncCompetitorBenchmarksAcrossMarkets', () => {
    function projectWith(id, country) {
      return { id, settings: { ai: { country: { code: country } } } };
    }

    it('region-filters per market, creates benchmarks, and republishes changed projects', async () => {
      const competitors = [
        { name: 'US rival', url: 'https://us-rival.com', regions: ['us'] },
        { name: 'DE rival', url: 'https://de-rival.com', regions: ['de'] },
      ];
      const transport = {
        listProjects: sandbox.stub().resolves({
          items: [projectWith('p-us', 'us'), projectWith('p-de', 'de')],
        }),
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub().resolves({ ids: ['x'], existing_count: 0 }),
        deleteBenchmarks: sandbox.stub().resolves(null),
        publishProject: sandbox.stub().resolves({}),
      };
      const result = await syncCompetitorBenchmarksAcrossMarkets(
        transport,
        competitors,
        [],
        WS,
        undefined,
      );
      expect(transport.createBenchmarks).to.have.been.calledWith(WS, 'p-us', [
        { brand_name: 'US rival', domain: 'us-rival.com' },
      ]);
      expect(transport.createBenchmarks).to.have.been.calledWith(WS, 'p-de', [
        { brand_name: 'DE rival', domain: 'de-rival.com' },
      ]);
      expect(transport.publishProject).to.have.been.calledTwice;
      expect(result).to.deep.equal({ markets: 2, created: 2, deleted: 0 });
    });

    it('skips republish for an unchanged project and skips region-less projects', async () => {
      const transport = {
        listProjects: sandbox.stub().resolves({
          items: [projectWith('p-us', 'us'), { id: 'p-x', settings: { ai: {} } }],
        }),
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [{ id: 'r', domain: 'rival.com' }] }),
        createBenchmarks: sandbox.stub().resolves({}),
        deleteBenchmarks: sandbox.stub().resolves(null),
        publishProject: sandbox.stub().resolves({}),
      };
      const result = await syncCompetitorBenchmarksAcrossMarkets(transport, [{ name: 'Rival', url: 'https://rival.com' }], [], WS, undefined);
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(transport.publishProject).to.not.have.been.called;
      expect(result).to.deep.equal({ markets: 1, created: 0, deleted: 0 });
    });
  });
});
