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
  collectAliasNames,
  syncBrandAliasesAcrossMarkets,
} from '../../../src/support/serenity/brand-aliases.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

use(chaiAsPromised);
use(sinonChai);

const WS = 'ws-1';

describe('brand-aliases helpers', () => {
  const sandbox = sinon.createSandbox();
  afterEach(() => sandbox.restore());

  describe('collectAliasNames', () => {
    it('region-filters to the market and trims/de-dupes (region-less + ww apply everywhere)', () => {
      const aliases = [
        { name: 'Global', regions: [] }, // region-less → all markets
        { name: 'WW', regions: ['ww'] }, // worldwide → all markets
        { name: 'US only', regions: ['us'] },
        { name: 'DE only', regions: ['de'] }, // filtered out for us
        { name: ' Global ', regions: ['us'] }, // dup of Global (trim + case)
      ];
      expect(collectAliasNames(aliases, 'us')).to.deep.equal(['Global', 'WW', 'US only']);
      expect(collectAliasNames(aliases, 'de')).to.deep.equal(['Global', 'WW', 'DE only']);
    });

    it('treats bare string aliases as region-less (apply to every market)', () => {
      expect(collectAliasNames(['Acme', ' Acme ', 'DDG'], 'us')).to.deep.equal(['Acme', 'DDG']);
    });

    it('returns [] for non-array input', () => {
      expect(collectAliasNames(null, 'us')).to.deep.equal([]);
    });
  });

  describe('syncBrandAliasesAcrossMarkets', () => {
    function projectWith(id, country, { domain = 'brand.com', brandNames = ['Brand'] } = {}) {
      return {
        id,
        domain,
        settings: { ai: { country: { code: country }, brand_names: brandNames, brand_name_display: 'Brand' } },
      };
    }

    function makeTransport(projects, benchmarksByProject) {
      return {
        listProjects: sandbox.stub().resolves({ items: projects }),
        updateProject: sandbox.stub().resolves({}),
        listBenchmarks: sandbox.stub().callsFake((ws, pid) => Promise.resolve({
          aio_benchmarks: benchmarksByProject[pid] || [],
        })),
        updateBenchmark: sandbox.stub().resolves(null),
        publishProject: sandbox.stub().resolves({}),
      };
    }

    it('PATCHes brand_names and PUTs benchmark brand_aliases when drifted, then republishes', async () => {
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand'] })],
        {
          'p-us': [{
            id: 'own', main_brand: true, domain: 'brand.com', brand_aliases: [],
          }],
        },
      );
      const aliases = [{ name: 'Acme', regions: [] }, { name: 'Acme Inc', regions: ['us'] }];

      const result = await syncBrandAliasesAcrossMarkets(transport, aliases, 'Brand', WS, undefined);

      expect(transport.updateProject).to.have.been.calledOnceWith(WS, 'p-us', {
        type: 'ai',
        brand_name_display: 'Brand',
        brand_names: ['Brand', 'Acme', 'Acme Inc'],
      });
      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, 'p-us', 'own', {
        brand_name: 'Brand',
        domain: 'brand.com',
        brand_aliases: ['Acme', 'Acme Inc'],
      });
      expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'p-us');
      expect(result).to.deep.equal({
        markets: 1, projectsUpdated: 1, benchmarksUpdated: 1, rejected: [],
      });
    });

    it('falls back to the project brand_name_display when no display name is passed, and logs a summary', async () => {
      const info = sandbox.stub();
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand'] })],
        {
          'p-us': [{
            id: 'own', main_brand: true, domain: 'brand.com', brand_aliases: [],
          }],
        },
      );
      // projectWith sets brand_name_display: 'Brand'; pass display = null so the
      // sync falls back to it.
      const result = await syncBrandAliasesAcrossMarkets(
        transport,
        [{ name: 'Acme', regions: [] }],
        null,
        WS,
        { info, warn: () => {} },
      );

      expect(transport.updateProject).to.have.been.calledOnceWith(WS, 'p-us', {
        type: 'ai',
        brand_name_display: 'Brand',
        brand_names: ['Brand', 'Acme'],
      });
      expect(info).to.have.been.calledWithMatch(
        'brand-aliases: re-synced across markets',
        sinon.match({ workspaceId: WS, markets: 1 }),
      );
      expect(result.projectsUpdated).to.equal(1);
    });

    it('region-clamps aliases per market (a DE-only alias never lands on the US project)', async () => {
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand'] })],
        {
          'p-us': [{
            id: 'own', main_brand: true, domain: 'brand.com', brand_aliases: [],
          }],
        },
      );
      const aliases = [{ name: 'DE Marke', regions: ['de'] }];

      const result = await syncBrandAliasesAcrossMarkets(transport, aliases, 'Brand', WS, undefined);

      // Desired US aliases is empty → brand_names already [Brand] → no PATCH/PUT.
      expect(transport.updateProject).to.not.have.been.called;
      expect(transport.updateBenchmark).to.not.have.been.called;
      expect(result.projectsUpdated).to.equal(0);
      expect(result.benchmarksUpdated).to.equal(0);
    });

    it('is a no-op when neither brand_names nor benchmark aliases drift', async () => {
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand', 'Acme'] })],
        {
          'p-us': [{
            id: 'own', main_brand: true, domain: 'brand.com', brand_aliases: ['Acme'],
          }],
        },
      );
      const aliases = [{ name: 'acme', regions: [] }]; // same set (case-insensitive)

      const result = await syncBrandAliasesAcrossMarkets(transport, aliases, 'Brand', WS, undefined);

      expect(transport.updateProject).to.not.have.been.called;
      expect(transport.updateBenchmark).to.not.have.been.called;
      expect(transport.publishProject).to.not.have.been.called;
      expect(result).to.deep.equal({
        markets: 1, projectsUpdated: 0, benchmarksUpdated: 0, rejected: [],
      });
    });

    it('captures rejected_brand_aliases from the own-brand benchmark', async () => {
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand'] })],
        {
          'p-us': [{
            id: 'own', main_brand: true, domain: 'brand.com', brand_aliases: [],
          }],
        },
      );
      // After the PUT, the re-read surfaces the rejected alias.
      transport.listBenchmarks.onSecondCall().resolves({
        aio_benchmarks: [{
          id: 'own', main_brand: true, domain: 'brand.com', rejected_brand_aliases: ['bogus'],
        }],
      });
      const aliases = [{ name: 'Acme', regions: [] }, { name: 'bogus', regions: [] }];

      const result = await syncBrandAliasesAcrossMarkets(transport, aliases, 'Brand', WS, undefined);

      expect(result.rejected).to.deep.equal([
        {
          projectId: 'p-us', market: 'us', domain: 'brand.com', aliases: ['bogus'],
        },
      ]);
    });

    it('matches the own-brand benchmark by domain when no main_brand flag is set', async () => {
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand'] })],
        {
          'p-us': [{
            id: 'bench-x', main_brand: false, domain: 'www.brand.com', brand_aliases: [],
          }],
        },
      );
      const aliases = [{ name: 'Acme', regions: [] }];

      await syncBrandAliasesAcrossMarkets(transport, aliases, 'Brand', WS, undefined);

      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, 'p-us', 'bench-x');
    });

    it('omits brand_name_display and skips the benchmark when there is no display and no own benchmark', async () => {
      const transport = makeTransport(
        // Raw project: no brand_names, no brand_name_display, no benchmarks.
        [{ id: 'p-us', domain: 'brand.com', settings: { ai: { country: { code: 'us' } } } }],
        { 'p-us': [] },
      );

      const result = await syncBrandAliasesAcrossMarkets(
        transport,
        [{ name: 'Acme', regions: [] }],
        null,
        WS,
        undefined,
      );

      expect(transport.updateProject).to.have.been.calledOnceWith(WS, 'p-us', {
        type: 'ai',
        brand_names: ['Acme'], // no brand_name_display key
      });
      expect(transport.updateBenchmark).to.not.have.been.called;
      expect(result).to.deep.equal({
        markets: 1, projectsUpdated: 1, benchmarksUpdated: 0, rejected: [],
      });
    });

    it('clears benchmark aliases (and skips the rejected re-read) when the desired set is empty', async () => {
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand', 'Old'] })],
        {
          'p-us': [{
            id: 'own', main_brand: true, domain: 'brand.com', brand_aliases: ['Old'],
          }],
        },
      );

      const result = await syncBrandAliasesAcrossMarkets(transport, [], 'Brand', WS, undefined);

      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, 'p-us', 'own', {
        brand_name: 'Brand', domain: 'brand.com', brand_aliases: [],
      });
      // desired aliases empty → no rejected re-read (listBenchmarks called once).
      expect(transport.listBenchmarks).to.have.been.calledOnce;
      expect(result.benchmarksUpdated).to.equal(1);
    });

    it('keeps the benchmark own brand_name + domain when present', async () => {
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand'] })],
        {
          'p-us': [{
            id: 'own', main_brand: true, brand_name: 'Existing Brand', domain: 'existing.com', brand_aliases: [],
          }],
        },
      );

      await syncBrandAliasesAcrossMarkets(transport, [{ name: 'Acme', regions: [] }], 'Brand', WS, undefined);

      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, 'p-us', 'own', {
        brand_name: 'Existing Brand',
        domain: 'existing.com',
        brand_aliases: ['Acme'],
      });
    });

    it('falls back to display + project domain when the benchmark lacks brand_name/domain', async () => {
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand'] })],
        { 'p-us': [{ id: 'own', main_brand: true }] }, // no brand_name, no domain
      );

      await syncBrandAliasesAcrossMarkets(transport, [{ name: 'Acme', regions: [] }], 'Brand', WS, undefined);

      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, 'p-us', 'own', {
        brand_name: 'Brand',
        domain: 'brand.com',
        brand_aliases: ['Acme'],
      });
    });

    it('skips region-less and id-less projects', async () => {
      const transport = makeTransport(
        [
          { id: 'p-x', settings: { ai: {} } }, // no country → skipped
          { settings: { ai: { country: { code: 'us' } } } }, // no id → skipped
        ],
        {},
      );
      const result = await syncBrandAliasesAcrossMarkets(transport, [{ name: 'A' }], 'Brand', WS, undefined);
      expect(result.markets).to.equal(0);
      expect(transport.listBenchmarks).to.not.have.been.called;
    });

    it('logs the failing market and rethrows (hard-fail) when a project update throws', async () => {
      const error = sandbox.stub();
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand'] })],
        {
          'p-us': [{
            id: 'own', main_brand: true, domain: 'brand.com', brand_aliases: [],
          }],
        },
      );
      transport.updateProject.rejects(new SerenityTransportError(502, 'boom'));

      await expect(syncBrandAliasesAcrossMarkets(
        transport,
        [{ name: 'Acme', regions: [] }],
        'Brand',
        WS,
        { error, info: () => {}, warn: () => {} },
      )).to.be.rejectedWith('boom');
      expect(error).to.have.been.calledWithMatch('brand-aliases: market sync failed', {
        workspaceId: WS, projectId: 'p-us', market: 'us', status: 502,
      });
    });

    it('PUTs the benchmark when ONLY the alias set drifts (brand_names unchanged), then republishes', async () => {
      // brand_names already match the desired set (display + 'Acme'), so no PATCH;
      // the own-brand benchmark's brand_aliases are empty, so the PUT must still
      // fire on its own. Exercises the benchmark-only drift path in isolation.
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand', 'Acme'] })],
        {
          'p-us': [{
            id: 'own', main_brand: true, domain: 'brand.com', brand_aliases: [],
          }],
        },
      );

      const result = await syncBrandAliasesAcrossMarkets(
        transport,
        [{ name: 'Acme', regions: [] }],
        'Brand',
        WS,
        undefined,
      );

      expect(transport.updateProject).to.not.have.been.called;
      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, 'p-us', 'own', {
        brand_name: 'Brand',
        domain: 'brand.com',
        brand_aliases: ['Acme'],
      });
      expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'p-us');
      expect(result).to.deep.equal({
        markets: 1, projectsUpdated: 0, benchmarksUpdated: 1, rejected: [],
      });
    });

    it('logs the failing market and rethrows (hard-fail) when the benchmark PUT throws', async () => {
      const error = sandbox.stub();
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand'] })],
        {
          'p-us': [{
            id: 'own', main_brand: true, domain: 'brand.com', brand_aliases: [],
          }],
        },
      );
      // The PATCH succeeds; the benchmark PUT throws — the catch must still name
      // the market and rethrow so the brand edit hard-fails.
      transport.updateBenchmark.rejects(new SerenityTransportError(409, 'benchmark conflict'));

      await expect(syncBrandAliasesAcrossMarkets(
        transport,
        [{ name: 'Acme', regions: [] }],
        'Brand',
        WS,
        { error, info: () => {}, warn: () => {} },
      )).to.be.rejectedWith('benchmark conflict');
      expect(transport.updateProject).to.have.been.calledOnce;
      expect(error).to.have.been.calledWithMatch('brand-aliases: market sync failed', {
        workspaceId: WS, projectId: 'p-us', market: 'us', status: 409,
      });
    });

    it('reuses a pre-fetched project listing instead of calling listProjects', async () => {
      const transport = makeTransport(
        [], // listProjects would return no projects if called
        {
          'p-us': [{
            id: 'own', main_brand: true, domain: 'brand.com', brand_aliases: [],
          }],
        },
      );
      const prefetched = [projectWith('p-us', 'us', { brandNames: ['Brand'] })];

      const result = await syncBrandAliasesAcrossMarkets(
        transport,
        [{ name: 'Acme', regions: [] }],
        'Brand',
        WS,
        undefined,
        prefetched,
      );

      expect(transport.listProjects).to.not.have.been.called;
      expect(result.markets).to.equal(1);
      expect(transport.updateProject).to.have.been.calledOnce;
    });

    it('treats a non-array listBenchmarks response as no benchmarks (skips the PUT)', async () => {
      // brand_names drift forces the PATCH; the benchmark listing comes back in a
      // non-array shape, so the own-brand lookup sees [] and the PUT never fires.
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand'] })],
        {},
      );
      transport.listBenchmarks.resolves({ aio_benchmarks: null });

      const result = await syncBrandAliasesAcrossMarkets(
        transport,
        [{ name: 'Acme', regions: [] }],
        'Brand',
        WS,
        undefined,
      );

      expect(transport.updateProject).to.have.been.calledOnce;
      expect(transport.updateBenchmark).to.not.have.been.called;
      expect(result).to.deep.equal({
        markets: 1, projectsUpdated: 1, benchmarksUpdated: 0, rejected: [],
      });
    });

    it('uses brand_name = "" when the benchmark, display, and project domain are all absent', async () => {
      // No display passed and no ai.brand_name_display → display stays null. The
      // own benchmark (main_brand, no domain) lacks brand_name, and the project
      // carries no domain → the brand_name fallback chain bottoms out at ''.
      const transport = makeTransport(
        [{ id: 'p-us', settings: { ai: { country: { code: 'us' } } } }], // no domain
        { 'p-us': [{ id: 'own', main_brand: true, brand_aliases: [] }] },
      );

      await syncBrandAliasesAcrossMarkets(
        transport,
        [{ name: 'Acme', regions: [] }],
        null,
        WS,
        undefined,
      );

      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, 'p-us', 'own', {
        brand_name: '',
        domain: undefined,
        brand_aliases: ['Acme'],
      });
    });

    it('treats a non-array re-read after the PUT as no benchmarks (no rejected captured)', async () => {
      const transport = makeTransport(
        [projectWith('p-us', 'us', { brandNames: ['Brand'] })],
        {
          'p-us': [{
            id: 'own', main_brand: true, domain: 'brand.com', brand_aliases: [],
          }],
        },
      );
      // The post-PUT re-read surfaces a non-array body → list falls back to [].
      transport.listBenchmarks.onSecondCall().resolves({ aio_benchmarks: 'oops' });
      const aliases = [{ name: 'Acme', regions: [] }];

      const result = await syncBrandAliasesAcrossMarkets(transport, aliases, 'Brand', WS, undefined);

      expect(transport.listBenchmarks).to.have.been.calledTwice;
      expect(result.benchmarksUpdated).to.equal(1);
      expect(result.rejected).to.deep.equal([]);
    });

    it('treats a non-array listProjects response as no projects', async () => {
      const transport = {
        listProjects: sandbox.stub().resolves({}),
        updateProject: sandbox.stub(),
        listBenchmarks: sandbox.stub(),
        updateBenchmark: sandbox.stub(),
        publishProject: sandbox.stub(),
      };
      const result = await syncBrandAliasesAcrossMarkets(transport, [{ name: 'A' }], 'Brand', WS, undefined);
      expect(result).to.deep.equal({
        markets: 0, projectsUpdated: 0, benchmarksUpdated: 0, rejected: [],
      });
    });
  });
});
