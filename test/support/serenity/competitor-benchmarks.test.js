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
  buildReservedIdentities,
  collectCompetitorBenchmarks,
  dropReservedCompetitors,
  removedCompetitors,
  resolveBenchmarksByCompetitor,
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

  // A declaration, not a fake: every stub is created inside the `it` that calls
  // this, on the per-suite sandbox, so nothing is shared across tests.
  function makeTransport(benchmarks) {
    return {
      listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: benchmarks }),
      createBenchmarks: sandbox.stub().resolves({ ids: ['new'], existing_count: 0 }),
      updateBenchmark: sandbox.stub().resolves(null),
      deleteBenchmarks: sandbox.stub().resolves(null),
    };
  }

  describe('collectCompetitorBenchmarks', () => {
    it('region-filters, extracts domains, defaults name to domain, de-dupes by name, skips url-less', () => {
      const competitors = [
        { name: 'Bing', url: 'https://www.bing.com', regions: ['us'] },
        { name: 'DE only', url: 'https://de.com', regions: ['de'] }, // filtered out for us
        { name: 'BING', url: 'https://www.bing.com/x', regions: [] }, // dup NAME of Bing
        { name: 'No URL', regions: [] }, // skipped (no url)
        { url: 'https://named-by-domain.com' }, // region-less, no name → name = domain
      ];
      expect(collectCompetitorBenchmarks(competitors, 'us')).to.deep.equal([
        {
          name: 'Bing', key: 'bing', domain: 'bing.com', identity: 'bing.com', aliases: [],
        },
        {
          name: 'named-by-domain.com',
          key: 'named-by-domain.com',
          domain: 'named-by-domain.com',
          identity: 'named-by-domain.com',
          aliases: [],
        },
      ]);
    });

    it('keeps two distinct competitors that share a host', () => {
      // A Semrush project holds several benchmarks on one domain, discriminated by
      // brand_name — de-duping on domain kept one sibling and discarded the rest.
      const competitors = [
        { name: 'Phoenix Suns', url: 'https://www.nba.com/suns', regions: ['us'] },
        { name: 'Golden State Warriors', url: 'https://www.nba.com/warriors', regions: ['us'] },
      ];
      expect(collectCompetitorBenchmarks(competitors, 'us').map((c) => c.name)).to.deep.equal([
        'Phoenix Suns', 'Golden State Warriors',
      ]);
    });

    it('returns [] for empty / non-array input', () => {
      expect(collectCompetitorBenchmarks(null, 'us')).to.deep.equal([]);
      expect(collectCompetitorBenchmarks([], 'us')).to.deep.equal([]);
    });

    it('drops competitors whose site identity is one of the brand\'s own', () => {
      const competitors = [
        { name: 'Self primary', url: 'https://www.brand.com', regions: ['us'] },
        { name: 'Self DE market', url: 'https://brand.de', regions: ['us'] },
        { name: 'Self website url', url: 'https://shop.brand.io', regions: ['us'] },
        // Same host as the brand's own subpath site, different path — a different
        // site, and the shape a folded-host comparison discarded.
        { name: 'Sibling site', url: 'https://brand.de/other', regions: ['us'] },
        { name: 'Real competitor', url: 'https://rival.com', regions: ['us'] },
      ];
      const reserved = buildReservedIdentities(
        ['brand.com', 'brand.de'],
        ['https://shop.brand.io'],
      );
      expect(collectCompetitorBenchmarks(competitors, 'us', reserved).map((c) => c.name))
        .to.deep.equal(['Sibling site', 'Real competitor']);
    });
  });

  describe('buildReservedIdentities', () => {
    it('normalizes + dedupes domains and brand URLs (string or { value })', () => {
      const reserved = buildReservedIdentities(
        ['https://www.brand.com', 'brand.com', 'brand.de'],
        [{ value: 'https://shop.brand.io' }, 'https://www.brand.de'],
      );
      expect([...reserved].sort()).to.deep.equal(['brand.com', 'brand.de', 'shop.brand.io']);
    });

    it('keeps the path, and folds www so a www spelling cannot evade the guard', () => {
      const reserved = buildReservedIdentities(['nba.com'], ['https://www.nba.com/kings']);
      expect([...reserved].sort()).to.deep.equal(['nba.com', 'nba.com/kings']);
    });

    it('tolerates non-array / empty / unparseable inputs', () => {
      expect([...buildReservedIdentities()].length).to.equal(0);
      expect([...buildReservedIdentities(null, undefined)].length).to.equal(0);
      expect([...buildReservedIdentities([''], [null, { value: '' }])].length).to.equal(0);
    });

    it('treats a non-array urls argument as no brand URLs', () => {
      // urls passed as a string (not an array) → the `Array.isArray(urls) ? urls : []`
      // else arm short-circuits the URL loop; only the domains fold in.
      const reserved = buildReservedIdentities(['https://www.brand.com'], 'https://shop.brand.io');
      expect([...reserved]).to.deep.equal(['brand.com']);
    });
  });

  describe('dropReservedCompetitors', () => {
    it('partitions self-referential competitors out of the kept list', () => {
      const competitors = [
        { name: 'Self', url: 'https://www.brand.com', regions: ['us'] },
        { name: 'Rival', url: 'https://rival.com', regions: ['us'] },
        { name: 'No URL', regions: ['us'] }, // unparseable identity → kept (not reserved)
      ];
      const reserved = buildReservedIdentities(['brand.com'], []);
      const { kept, dropped } = dropReservedCompetitors(competitors, reserved);
      expect(kept.map((c) => c.name)).to.deep.equal(['Rival', 'No URL']);
      expect(dropped.map((c) => c.name)).to.deep.equal(['Self']);
    });

    it('keeps a competitor on a sibling path of the brand\'s own host', () => {
      // The Sacramento Kings shape: brand tracked on nba.com/kings, competitors on
      // nba.com/suns and nba.com/warriors. Folded to hosts, all three read as
      // nba.com and every competitor was rejected as self-referential — which, on
      // the update path, rejected the whole brand edit with a 400.
      const competitors = [
        { name: 'Phoenix Suns', url: 'https://www.nba.com/suns' },
        { name: 'Golden State Warriors', url: 'https://www.nba.com/warriors' },
        { name: 'Sacramento Kings', url: 'https://www.nba.com/kings' }, // genuinely us
      ];
      const reserved = buildReservedIdentities(['nba.com'], ['https://nba.com/kings']);
      const { kept, dropped } = dropReservedCompetitors(competitors, reserved);
      expect(kept.map((c) => c.name)).to.deep.equal(['Phoenix Suns', 'Golden State Warriors']);
      expect(dropped.map((c) => c.name)).to.deep.equal(['Sacramento Kings']);
    });

    it('returns everything kept when nothing is reserved / non-array input', () => {
      const competitors = [{ name: 'Rival', url: 'https://rival.com' }];
      expect(dropReservedCompetitors(competitors, new Set())).to.deep.equal({
        kept: competitors, dropped: [],
      });
      expect(dropReservedCompetitors(null, new Set())).to.deep.equal({ kept: [], dropped: [] });
    });
  });

  describe('removedCompetitors', () => {
    it('returns competitors present in old but not new (region-agnostic)', () => {
      const oldC = [
        { name: 'A', url: 'https://a.com', regions: ['us'] },
        { name: 'B', url: 'https://b.com', regions: ['de'] },
      ];
      const newC = [{ name: 'A', url: 'https://a.com', regions: ['us'] }];
      expect(removedCompetitors(oldC, newC)).to.deep.equal([
        { name: 'B', key: 'b', domain: 'b.com' },
      ]);
    });

    it('sees the removal of one of two competitors sharing a host', () => {
      // Diffed on domain this was invisible: the surviving sibling kept the host
      // present in the new set, so the removal produced nothing to delete.
      const oldC = [
        { name: 'Phoenix Suns', url: 'https://www.nba.com/suns' },
        { name: 'Los Angeles Lakers', url: 'https://www.nba.com/lakers' },
      ];
      const newC = [{ name: 'Phoenix Suns', url: 'https://www.nba.com/suns' }];
      expect(removedCompetitors(oldC, newC)).to.deep.equal([
        { name: 'Los Angeles Lakers', key: 'los angeles lakers', domain: 'nba.com' },
      ]);
    });

    it('returns [] when nothing was removed', () => {
      const c = [{ name: 'A', url: 'https://a.com' }];
      expect(removedCompetitors(c, c)).to.deep.equal([]);
      expect(removedCompetitors([], [{ name: 'A', url: 'https://a.com' }])).to.deep.equal([]);
    });

    it('treats a renamed competitor as still present, not removed and re-added', () => {
      // Its benchmark must be renamed in place. Deleting and recreating would lose
      // the aliases Semrush's own resolution added, which survive only by being
      // carried forward from the live list.
      const oldC = [{ name: 'Rival', url: 'https://rival.com' }];
      const newC = [{ name: 'Rival Inc', url: 'https://rival.com' }];
      expect(removedCompetitors(oldC, newC)).to.deep.equal([]);
    });

    it('still removes a renamed sibling\'s neighbour on the same host', () => {
      // Identity, not host: renaming the Suns must not shelter the Lakers.
      const oldC = [
        { name: 'Suns', url: 'https://www.nba.com/suns' },
        { name: 'Los Angeles Lakers', url: 'https://www.nba.com/lakers' },
      ];
      const newC = [{ name: 'Phoenix Suns', url: 'https://www.nba.com/suns' }];
      expect(removedCompetitors(oldC, newC)).to.deep.equal([
        { name: 'Los Angeles Lakers', key: 'los angeles lakers', domain: 'nba.com' },
      ]);
    });
  });

  describe('syncCompetitorBenchmarksForProject', () => {
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
      // A competitor with no aliases still carries the lowercase form of its name.
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Duck', domain: 'duckduckgo.com', brand_aliases: ['duck'] },
      ]);
      // The diff reads the DRAFT view — the writes below act on the draft.
      expect(transport.listBenchmarks).to.have.been.calledWith(WS, PID, { draft: true });
      expect(transport.deleteBenchmarks).to.not.have.been.called;
      // Bing's benchmark is already present but carries no aliases, so it is updated
      // to add the lowercase form of its name.
      expect(result).to.deep.equal({
        created: 1, updated: 1, deleted: 0, changed: true, rejected: [],
      });
    });

    it('drops a derived alias a sibling benchmark owns, so the batch cannot 409', async () => {
      // Live-verified 2026-08-13: alias uniqueness is project-wide and case-folded,
      // and the 409 fails the WHOLE create — in a batch, the innocent members too.
      // A competitor's own lowercase name is exactly what can collide.
      const transport = makeTransport([
        { id: 'own', main_brand: true, domain: 'acme.com' },
        {
          id: 'held',
          main_brand: false,
          domain: 'held.com',
          brand_name: 'Holder',
          brand_aliases: ['ddg'],
        },
      ]);
      const competitors = [
        // 'ddg' is already held by the 'Holder' benchmark above.
        {
          name: 'Duck', url: 'https://duckduckgo.com', aliases: ['DDG'], regions: ['us'],
        },
        { name: 'Clean', url: 'https://clean.com', regions: ['us'] },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Duck', domain: 'duckduckgo.com', brand_aliases: ['duck'] },
        { brand_name: 'Clean', domain: 'clean.com', brand_aliases: ['clean'] },
      ]);
      expect(result.created).to.equal(2);
    });

    it('deletes the benchmark of a removed competitor (never the main brand)', async () => {
      const transport = makeTransport([
        { id: 'own', main_brand: true, domain: 'acme.com' },
        { id: 'gone-id', main_brand: false, domain: 'gone.com' },
      ]);
      const removed = [
        { name: 'Gone', key: 'gone', domain: 'gone.com' },
        { name: 'Acme', key: 'acme', domain: 'acme.com' },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, [], removed, 'us', undefined);
      // Gone is matched to its benchmark and deleted by id; Acme resolves only to
      // the main-brand benchmark, which is never a candidate.
      expect(transport.deleteBenchmarks).to.have.been.calledOnceWith(WS, PID, ['gone-id']);
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(result).to.deep.equal({
        created: 0, updated: 0, deleted: 1, changed: true, rejected: [],
      });
    });

    it('is a no-op (changed:false) when nothing to add or remove', async () => {
      // Already carries the lowercase form of its name, so there is nothing to add.
      const transport = makeTransport([{ id: 'bing', domain: 'bing.com', brand_aliases: ['bing'] }]);
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

    it('creates a competitor benchmark with its brand_aliases', async () => {
      const transport = makeTransport([]);
      const competitors = [
        {
          name: 'Duck', url: 'https://duckduckgo.com', aliases: ['DDG', 'Duck Duck Go'], regions: ['us'],
        },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        {
          brand_name: 'Duck',
          domain: 'duckduckgo.com',
          brand_aliases: ['ddg', 'duck duck go', 'duck'],
        },
      ]);
      expect(result.created).to.equal(1);
    });

    it('updates an existing competitor benchmark in place when its alias set drifts', async () => {
      const transport = makeTransport([
        {
          id: 'bing', main_brand: false, domain: 'bing.com', brand_aliases: ['MSN'],
        },
      ]);
      // Re-read after the update returns the new alias set (no rejections).
      transport.listBenchmarks.onSecondCall().resolves({
        aio_benchmarks: [{
          id: 'bing', main_brand: false, domain: 'bing.com', brand_aliases: ['Microsoft Bing'],
        }],
      });
      const competitors = [
        {
          name: 'Bing', url: 'https://bing.com', aliases: ['Microsoft Bing'], regions: ['us'],
        },
      ];
      // 'MSN' was this competitor's alias before the edit and is gone from it now,
      // so it leaves the benchmark; everything else there is carried forward.
      const previous = [
        {
          name: 'Bing', url: 'https://bing.com', aliases: ['MSN'], regions: ['us'],
        },
      ];
      const result = await syncCompetitorBenchmarksForProject(
        transport,
        WS,
        PID,
        competitors,
        [],
        'us',
        undefined,
        new Set(),
        previous,
      );
      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, PID, 'bing', {
        brand_name: 'Bing',
        domain: 'bing.com',
        brand_aliases: ['microsoft bing', 'bing'],
      });
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(result).to.deep.equal({
        created: 0, updated: 1, deleted: 0, changed: true, rejected: [],
      });
    });

    it('updates an existing competitor benchmark when only its name drifts (same domain)', async () => {
      // Renaming a competitor while keeping its URL (e.g. test1234 → test12345 on
      // test1234.de) must re-sync the upstream brand_name — it is keyed by domain.
      const transport = makeTransport([
        {
          id: 'rival', main_brand: false, domain: 'test1234.de', brand_name: 'test1234',
        },
      ]);
      const competitors = [
        { name: 'test12345', url: 'https://www.test1234.de', regions: ['us'] },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, PID, 'rival', {
        brand_name: 'test12345', domain: 'test1234.de', brand_aliases: ['test12345'],
      });
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(result).to.deep.equal({
        created: 0, updated: 1, deleted: 0, changed: true, rejected: [],
      });
    });

    it('does NOT re-sync when the upstream brand_name is empty, even if the desired name differs', async () => {
      // An absent upstream name is left alone rather than backfilled — a benchmark
      // we did not name is never touched, so an operator's direct upstream rename
      // is not clobbered by a drifting desired name.
      const transport = makeTransport([
        {
          id: 'rival',
          main_brand: false,
          domain: 'test1234.de',
          brand_name: '',
          // Already carries the derived form, so the name is the only difference.
          brand_aliases: ['test12345'],
        },
      ]);
      const competitors = [
        { name: 'test12345', url: 'https://www.test1234.de', regions: ['us'] },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.updateBenchmark).to.not.have.been.called;
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(result.changed).to.equal(false);
      expect(result.updated).to.equal(0);
    });

    it('does NOT update when the name and alias set are unchanged', async () => {
      const transport = makeTransport([
        {
          id: 'rival',
          main_brand: false,
          domain: 'test1234.de',
          brand_name: 'test1234',
          brand_aliases: ['test1234'],
        },
      ]);
      const competitors = [
        { name: 'test1234', url: 'https://www.test1234.de', regions: ['us'] },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.updateBenchmark).to.not.have.been.called;
      expect(result.changed).to.equal(false);
    });

    it('does NOT update when only the SPELLING of a live alias differs', async () => {
      // Upstream keeps the spelling an alias was created with, so a PUT cannot
      // re-case one. Treating a case difference as drift would rewrite and republish
      // the project on every single sync.
      const transport = makeTransport([
        {
          id: 'bing',
          main_brand: false,
          domain: 'bing.com',
          brand_name: 'Bing',
          brand_aliases: ['MSN', 'Microsoft Bing', 'bing'],
        },
      ]);
      const competitors = [
        {
          name: 'Bing', url: 'https://bing.com', aliases: ['microsoft bing', 'MSN'], regions: ['us'],
        },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.updateBenchmark).to.not.have.been.called;
      expect(result.changed).to.equal(false);
    });

    it('carries a competitor benchmark\'s vendor-added aliases through a rename', async () => {
      // The rename path used to omit brand_aliases entirely, which CLEARS the list
      // upstream — so renaming a competitor wiped whatever Semrush had added to it.
      const transport = makeTransport([
        {
          id: 'gm',
          main_brand: false,
          domain: 'gm.com',
          brand_name: 'General Motors',
          brand_aliases: ['gm'],
        },
      ]);
      const competitors = [
        { name: 'GM Company', url: 'https://gm.com', regions: ['us'] },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, PID, 'gm', {
        brand_name: 'GM Company',
        domain: 'gm.com',
        brand_aliases: ['gm', 'gm company'],
      });
      expect(result.updated).to.equal(1);
    });

    it('treats a non-array re-read after an alias write as no benchmarks (no rejections)', async () => {
      // An alias-bearing create sets wroteAliases → the re-read fires, but the
      // body is non-array, so `Array.isArray(after?.aio_benchmarks) ? ... : []`
      // (line 265) falls to [] and nothing is flagged rejected.
      const transport = makeTransport([]);
      transport.listBenchmarks.onSecondCall().resolves({ aio_benchmarks: null });
      const competitors = [
        {
          name: 'Duck', url: 'https://duckduckgo.com', aliases: ['DDG'], regions: ['us'],
        },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.listBenchmarks).to.have.been.calledTwice;
      expect(result.created).to.equal(1);
      expect(result.rejected).to.deep.equal([]);
    });

    it('captures rejected_brand_aliases Semrush dropped on a competitor benchmark', async () => {
      const transport = makeTransport([]);
      // Re-read after the create surfaces the rejected alias. Includes the
      // main-brand benchmark + a null-domain row so the capture predicate's
      // main_brand / unparseable-domain branches are exercised and excluded.
      transport.listBenchmarks.onSecondCall().resolves({
        aio_benchmarks: [
          {
            id: 'own',
            main_brand: true,
            domain: 'acme.com',
            brand_name: 'Acme',
            rejected_brand_aliases: ['ignored'],
          },
          {
            id: 'other',
            main_brand: false,
            domain: 'duckduckgo.com',
            brand_name: 'Some sibling',
            rejected_brand_aliases: ['ignored'],
          },
          {
            id: 'duck',
            main_brand: false,
            domain: 'duckduckgo.com',
            brand_name: 'Duck',
            rejected_brand_aliases: ['bogus'],
          },
        ],
      });
      const competitors = [
        {
          name: 'Duck', url: 'https://duckduckgo.com', aliases: ['DDG', 'bogus'], regions: ['us'],
        },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      // Selected by NAME: the sibling benchmark on the SAME domain is not ours to
      // report, and a domain-keyed capture would have attributed its rejections to
      // the competitor we wrote.
      expect(result.rejected).to.deep.equal([
        { name: 'Duck', domain: 'duckduckgo.com', aliases: ['bogus'] },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Sibling competitors on one host — the shape the domain keying could not hold
  // ---------------------------------------------------------------------------

  describe('syncCompetitorBenchmarksForProject — competitors sharing a host', () => {
    it('creates a benchmark for each of two distinct competitors on one host', async () => {
      const transport = makeTransport([
        {
          id: 'own', main_brand: true, domain: 'nba.com', brand_name: 'Sacramento Kings',
        },
      ]);
      const competitors = [
        { name: 'Phoenix Suns', url: 'https://www.nba.com/suns', regions: ['us'] },
        { name: 'Golden State Warriors', url: 'https://www.nba.com/warriors', regions: ['us'] },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Phoenix Suns', domain: 'nba.com', brand_aliases: ['phoenix suns'] },
        {
          brand_name: 'Golden State Warriors',
          domain: 'nba.com',
          brand_aliases: ['golden state warriors'],
        },
      ]);
      expect(result.created).to.equal(2);
    });

    it('renames one sibling in place and leaves the other untouched', async () => {
      // Keyed on domain, both siblings collapsed into one Map entry and the rename
      // was written onto whichever benchmark happened to be set last.
      const transport = makeTransport([
        {
          id: 'own', main_brand: true, domain: 'nba.com', brand_name: 'Sacramento Kings',
        },
        {
          id: 'suns',
          main_brand: false,
          domain: 'nba.com',
          brand_name: 'Suns',
          brand_aliases: ['suns'],
        },
        {
          id: 'warriors',
          main_brand: false,
          domain: 'nba.com',
          brand_name: 'Golden State Warriors',
          brand_aliases: ['golden state warriors'],
        },
      ]);
      const competitors = [
        { name: 'Suns', url: 'https://www.nba.com/suns', regions: ['us'] },
        { name: 'Warriors', url: 'https://www.nba.com/warriors', regions: ['us'] },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, PID, 'warriors', {
        brand_name: 'Warriors',
        domain: 'nba.com',
        brand_aliases: ['golden state warriors', 'warriors'],
      });
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(result.updated).to.equal(1);
    });

    it('deletes exactly the removed sibling, not an arbitrary one on the host', async () => {
      const transport = makeTransport([
        {
          id: 'own', main_brand: true, domain: 'nba.com', brand_name: 'Sacramento Kings',
        },
        {
          id: 'suns',
          main_brand: false,
          domain: 'nba.com',
          brand_name: 'Phoenix Suns',
          brand_aliases: ['phoenix suns'],
        },
        {
          id: 'warriors',
          main_brand: false,
          domain: 'nba.com',
          brand_name: 'Golden State Warriors',
          brand_aliases: ['golden state warriors'],
        },
      ]);
      const kept = [{ name: 'Phoenix Suns', url: 'https://www.nba.com/suns', regions: ['us'] }];
      const removed = removedCompetitors(
        [...kept, { name: 'Golden State Warriors', url: 'https://www.nba.com/warriors' }],
        kept,
      );
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, kept, removed, 'us', undefined);
      expect(transport.deleteBenchmarks).to.have.been.calledOnceWith(WS, PID, ['warriors']);
      expect(result.deleted).to.equal(1);
    });

    it('moves a tracked competitor to a new domain in place rather than orphaning it', async () => {
      const transport = makeTransport([
        {
          id: 'rival',
          main_brand: false,
          domain: 'old-rival.com',
          brand_name: 'Rival',
          brand_aliases: ['rival'],
        },
      ]);
      const competitors = [{ name: 'Rival', url: 'https://new-rival.com', regions: ['us'] }];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, PID, 'rival', {
        brand_name: 'Rival', domain: 'new-rival.com', brand_aliases: ['rival'],
      });
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(result).to.deep.equal({
        created: 0, updated: 1, deleted: 0, changed: true, rejected: [],
      });
    });

    it('skips a create whose name another benchmark already holds', async () => {
      // Upstream refuses a duplicate brand_name with a 409 that fails the WHOLE
      // create — so offering one would take the rest of the batch down with it.
      const warn = sandbox.stub();
      // 'Blocked' is not this benchmark's NAME, so the competitor does not resolve
      // to it — but the benchmark holds it as an alias, so upstream owns the value.
      const transport = makeTransport([
        {
          id: 'holder',
          main_brand: false,
          domain: 'holder.com',
          brand_name: 'Holder',
          brand_aliases: ['blocked'],
        },
      ]);
      const competitors = [
        { name: 'Blocked', url: 'https://blocked.com', regions: ['us'] },
        { name: 'Clean', url: 'https://clean.com', regions: ['us'] },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', { info: () => {}, warn });
      // The batch goes out carrying only the competitor upstream can accept.
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Clean', domain: 'clean.com', brand_aliases: ['clean'] },
      ]);
      expect(result.created).to.equal(1);
      expect(warn).to.have.been.calledWithMatch(
        'competitor-benchmarks: skipped, name already used in project',
        sinon.match({ competitor: 'Blocked' }),
      );
    });

    it('keeps a batched create clean against itself, not just against the project', async () => {
      // Uniqueness spans the union of every benchmark's name and aliases, so two
      // NEW siblings can collide with each other before either exists upstream.
      const transport = makeTransport([]);
      const competitors = [
        { name: 'Rival', url: 'https://rival.com', regions: ['us'] },
        // Claims 'rival' as an alias, which the first entry above takes as its name.
        {
          name: 'Sibling', url: 'https://rival.com', aliases: ['Rival'], regions: ['us'],
        },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Rival', domain: 'rival.com', brand_aliases: ['rival'] },
        { brand_name: 'Sibling', domain: 'rival.com', brand_aliases: ['sibling'] },
      ]);
      expect(result.created).to.equal(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Reconciling benchmarks written before names were the key
  // ---------------------------------------------------------------------------

  describe('resolveBenchmarksByCompetitor', () => {
    it('matches on name, case-insensitively, and ignores the main brand', () => {
      const resolved = resolveBenchmarksByCompetitor(
        [
          {
            id: 'own', main_brand: true, domain: 'acme.com', brand_name: 'Acme',
          },
          {
            id: 'r', main_brand: false, domain: 'rival.com', brand_name: 'Rival',
          },
        ],
        [{ key: 'rival', name: 'Rival', domain: 'rival.com' }, { key: 'acme', name: 'Acme', domain: 'acme.com' }],
      );
      expect(resolved.get('rival')?.id).to.equal('r');
      expect(resolved.has('acme')).to.equal(false);
    });

    it('adopts a domain-keyed benchmark when the host holds exactly one of each', () => {
      const info = sandbox.stub();
      const resolved = resolveBenchmarksByCompetitor(
        [{
          id: 'legacy', main_brand: false, domain: 'rival.com', brand_name: 'Stale Name',
        }],
        [{ key: 'rival', name: 'Rival', domain: 'rival.com' }],
        new Set(),
        { info, warn: () => {} },
        { projectId: PID },
      );
      expect(resolved.get('rival')?.id).to.equal('legacy');
      expect(info).to.have.been.calledWithMatch(
        'competitor-benchmarks: adopted domain-keyed benchmark',
        sinon.match({ domain: 'rival.com', benchmarkId: 'legacy', competitor: 'Rival' }),
      );
    });

    it('refuses to adopt when two competitors contend for one benchmark on a host', () => {
      // Guessing here would write one competitor's name and aliases onto another's
      // benchmark, which no later sync can detect. A duplicate benchmark is the
      // recoverable failure, so both are left to create.
      const warn = sandbox.stub();
      const resolved = resolveBenchmarksByCompetitor(
        [{
          id: 'legacy', main_brand: false, domain: 'nba.com', brand_name: 'Stale',
        }],
        [
          { key: 'phoenix suns', name: 'Phoenix Suns', domain: 'nba.com' },
          { key: 'golden state warriors', name: 'Golden State Warriors', domain: 'nba.com' },
        ],
        new Set(),
        { info: () => {}, warn },
      );
      expect(resolved.size).to.equal(0);
      expect(warn).to.have.been.calledWithMatch(
        'competitor-benchmarks: benchmark could not be matched by name or domain',
        sinon.match({ domain: 'nba.com' }),
      );
    });

    it('refuses to adopt when a host holds more unclaimed benchmarks than claimants', () => {
      const warn = sandbox.stub();
      const resolved = resolveBenchmarksByCompetitor(
        [
          {
            id: 'a', main_brand: false, domain: 'nba.com', brand_name: 'Stale A',
          },
          {
            id: 'b', main_brand: false, domain: 'nba.com', brand_name: 'Stale B',
          },
        ],
        [{ key: 'phoenix suns', name: 'Phoenix Suns', domain: 'nba.com' }],
        new Set(),
        { info: () => {}, warn },
      );
      expect(resolved.size).to.equal(0);
      expect(warn).to.have.been.called;
    });

    it('never hands one benchmark to both a name match and an adoption', () => {
      // 'Rival' matches by name; the sibling must not then adopt the same row.
      const resolved = resolveBenchmarksByCompetitor(
        [{
          id: 'r', main_brand: false, domain: 'rival.com', brand_name: 'Rival',
        }],
        [
          { key: 'rival', name: 'Rival', domain: 'rival.com' },
          { key: 'newcomer', name: 'Newcomer', domain: 'rival.com' },
        ],
        new Set(),
        { info: () => {}, warn: () => {} },
      );
      expect(resolved.get('rival')?.id).to.equal('r');
      expect(resolved.has('newcomer')).to.equal(false);
    });

    it('ignores benchmarks with no id, and tolerates non-array inputs', () => {
      expect(resolveBenchmarksByCompetitor(null, null).size).to.equal(0);
      const resolved = resolveBenchmarksByCompetitor(
        [{ main_brand: false, domain: 'rival.com', brand_name: 'Rival' }],
        [{ key: 'rival', name: 'Rival', domain: 'rival.com' }],
      );
      expect(resolved.size).to.equal(0);
    });

    it('leaves a target with no domain unmatched rather than guessing', () => {
      const resolved = resolveBenchmarksByCompetitor(
        [{
          id: 'legacy', main_brand: false, domain: 'rival.com', brand_name: 'Stale',
        }],
        [{ key: 'rival', name: 'Rival', domain: null }],
      );
      expect(resolved.size).to.equal(0);
    });
  });

  describe('syncCompetitorBenchmarksForProject — upstream uniqueness is project-wide', () => {
    it('never lets a competitor adopt the brand\'s own benchmark', async () => {
      // ensureOwnBrandBenchmark creates the own-brand benchmark with main_brand
      // UNSET — the create API cannot set that flag — so main_brand does not
      // identify it. It carries the project domain, which is exactly the host a
      // subpath brand's competitors resolve to, so it was an adoption candidate for
      // the very competitors this change stopped rejecting. Adopting it renames the
      // brand's own benchmark after a competitor, with the brand's own URLs still
      // attached, and nothing later detects it.
      const transport = makeTransport([{
        id: 'own',
        main_brand: false,
        domain: 'nba.com',
        brand_name: 'Sacramento Kings',
        brand_aliases: ['sacramento kings'],
      }]);
      const reserved = buildReservedIdentities(['nba.com'], ['https://nba.com/kings']);
      const competitors = [{ name: 'Phoenix Suns', url: 'https://www.nba.com/suns', regions: ['us'] }];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined, reserved);
      expect(transport.updateBenchmark).to.not.have.been.called;
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Phoenix Suns', domain: 'nba.com', brand_aliases: ['phoenix suns'] },
      ]);
      expect(result.created).to.equal(1);
    });

    it('still matches a competitor to its own benchmark on the reserved host', async () => {
      // The other half of the rule: a competitor at nba.com/suns sends the bare
      // nba.com as its benchmark domain — the reserved value — so excluding reserved
      // hosts from NAME matching would re-create it on every sync.
      const transport = makeTransport([
        {
          id: 'own', main_brand: true, domain: 'nba.com', brand_name: 'Sacramento Kings',
        },
        {
          id: 'suns',
          main_brand: false,
          domain: 'nba.com',
          brand_name: 'Phoenix Suns',
          brand_aliases: ['phoenix suns'],
        },
      ]);
      const reserved = buildReservedIdentities(['nba.com'], ['https://nba.com/kings']);
      const competitors = [{ name: 'Phoenix Suns', url: 'https://www.nba.com/suns', regions: ['us'] }];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined, reserved);
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(transport.updateBenchmark).to.not.have.been.called;
      expect(result.changed).to.equal(false);
    });

    it('lets a required name win over another competitor\'s optional alias', async () => {
      // Claiming names and aliases in one pass made this order-dependent: the first
      // competitor's OPTIONAL alias consumed the second's MANDATORY name, and the
      // second was skipped entirely — permanently, since every later sync repeats it.
      const transport = makeTransport([]);
      const competitors = [
        {
          name: 'Alphabet', url: 'https://abc.xyz', aliases: ['Google'], regions: ['us'],
        },
        { name: 'Google', url: 'https://google.com', regions: ['us'] },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Alphabet', domain: 'abc.xyz', brand_aliases: ['alphabet'] },
        { brand_name: 'Google', domain: 'google.com', brand_aliases: ['google'] },
      ]);
      expect(result.created).to.equal(2);
    });

    it('is order-independent: the same two competitors reversed give the same result', async () => {
      const transport = makeTransport([]);
      const competitors = [
        { name: 'Google', url: 'https://google.com', regions: ['us'] },
        {
          name: 'Alphabet', url: 'https://abc.xyz', aliases: ['Google'], regions: ['us'],
        },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Google', domain: 'google.com', brand_aliases: ['google'] },
        { brand_name: 'Alphabet', domain: 'abc.xyz', brand_aliases: ['alphabet'] },
      ]);
      expect(result.created).to.equal(2);
    });

    it('does not offer an update an alias the create batch is about to take', async () => {
      // The create batch and the update PUTs write into ONE upstream namespace.
      // Guarded separately against the pre-write listing, each stays clean against
      // what is already there while colliding with the other — and since creates go
      // first, the update is what 409s, leaving the market half-written.
      const transport = makeTransport([{
        id: 'b1',
        main_brand: false,
        domain: 'alpha.com',
        brand_name: 'Alpha',
        brand_aliases: ['alpha'],
      }]);
      const competitors = [
        {
          name: 'Alpha', url: 'https://alpha.com', aliases: ['Acme'], regions: ['us'],
        },
        { name: 'Acme', url: 'https://acme.com', regions: ['us'] },
      ];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      // 'acme' belongs to the benchmark being created, so Alpha does not claim it.
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Acme', domain: 'acme.com', brand_aliases: ['acme'] },
      ]);
      expect(transport.updateBenchmark).to.not.have.been.called;
      expect(result).to.deep.equal({
        created: 1, updated: 0, deleted: 0, changed: true, rejected: [],
      });
    });

    it('does not offer two updates the same new alias', async () => {
      const transport = makeTransport([
        {
          id: 'b1', main_brand: false, domain: 'alpha.com', brand_name: 'Alpha', brand_aliases: ['alpha'],
        },
        {
          id: 'b2', main_brand: false, domain: 'beta.com', brand_name: 'Beta', brand_aliases: ['beta'],
        },
      ]);
      transport.listBenchmarks.onSecondCall().resolves({ aio_benchmarks: [] });
      const competitors = [
        {
          name: 'Alpha', url: 'https://alpha.com', aliases: ['Shared'], regions: ['us'],
        },
        {
          name: 'Beta', url: 'https://beta.com', aliases: ['Shared'], regions: ['us'],
        },
      ];
      await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      // Exactly one of the two carries 'shared'; neither PUT can 409 the other.
      const sent = transport.updateBenchmark.getCalls()
        .flatMap((call) => call.args[3].brand_aliases)
        .filter((a) => a === 'shared');
      expect(sent).to.have.lengthOf(1);
    });

    it('removes an alias the edit dropped even when the competitor was renamed', async () => {
      // The dropped-alias lookup is keyed by name; a rename made it miss, so the
      // removed alias was carried forward from the live list — and never removed
      // again, because the next edit's `previous` no longer contains it.
      const transport = makeTransport([{
        id: 'foo',
        main_brand: false,
        domain: 'foo.com',
        brand_name: 'Foo',
        brand_aliases: ['foo', 'fooey'],
      }]);
      transport.listBenchmarks.onSecondCall().resolves({ aio_benchmarks: [] });
      const previous = [{
        name: 'Foo', url: 'https://foo.com', aliases: ['fooey'], regions: ['us'],
      }];
      const competitors = [{
        name: 'Foo Inc', url: 'https://foo.com', aliases: [], regions: ['us'],
      }];
      await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined, new Set(), previous);
      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, PID, 'foo', {
        brand_name: 'Foo Inc',
        domain: 'foo.com',
        brand_aliases: ['foo', 'foo inc'],
      });
    });
  });

  describe('syncCompetitorBenchmarksForProject — reconciliation', () => {
    it('adopts a benchmark created under the domain key instead of duplicating it', async () => {
      // The first sync after the re-key meets benchmarks whose brand_name matches
      // no current competitor. Creating alongside them would double-count.
      const transport = makeTransport([{
        id: 'legacy',
        main_brand: false,
        domain: 'rival.com',
        brand_name: 'rival.com',
        brand_aliases: [],
      }]);
      transport.listBenchmarks.onSecondCall().resolves({
        aio_benchmarks: [{
          id: 'legacy', main_brand: false, domain: 'rival.com', brand_name: 'Rival',
        }],
      });
      const competitors = [{ name: 'Rival', url: 'https://rival.com', regions: ['us'] }];
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, competitors, [], 'us', undefined);
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, PID, 'legacy', {
        brand_name: 'Rival', domain: 'rival.com', brand_aliases: ['rival'],
      });
      expect(result).to.deep.equal({
        created: 0, updated: 1, deleted: 0, changed: true, rejected: [],
      });
    });

    it('deletes a removed competitor whose benchmark predates the name key', async () => {
      const transport = makeTransport([{
        id: 'legacy', main_brand: false, domain: 'gone.com', brand_name: 'gone.com',
      }]);
      const removed = removedCompetitors([{ name: 'Gone Inc', url: 'https://gone.com' }], []);
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, [], removed, 'us', undefined);
      expect(transport.deleteBenchmarks).to.have.been.calledOnceWith(WS, PID, ['legacy']);
      expect(result.deleted).to.equal(1);
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
        { brand_name: 'US rival', domain: 'us-rival.com', brand_aliases: ['us rival'] },
      ]);
      expect(transport.createBenchmarks).to.have.been.calledWith(WS, 'p-de', [
        { brand_name: 'DE rival', domain: 'de-rival.com', brand_aliases: ['de rival'] },
      ]);
      expect(transport.publishProject).to.have.been.calledTwice;
      expect(result).to.deep.equal({
        markets: 2, created: 2, updated: 0, deleted: 0, rejected: [],
      });
    });

    it('reuses a pre-fetched project listing instead of calling listProjects', async () => {
      const transport = {
        listProjects: sandbox.stub().resolves({ items: [] }), // would be empty if called
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub().resolves({ ids: ['x'], existing_count: 0 }),
        deleteBenchmarks: sandbox.stub().resolves(null),
        publishProject: sandbox.stub().resolves({}),
      };
      const result = await syncCompetitorBenchmarksAcrossMarkets(
        transport,
        [{ name: 'US rival', url: 'https://us-rival.com', regions: ['us'] }],
        [],
        WS,
        undefined,
        [],
        [projectWith('p-us', 'us')],
      );
      expect(transport.listProjects).to.not.have.been.called;
      expect(result.markets).to.equal(1);
      expect(result.created).to.equal(1);
    });

    it('drops self-referential competitors (own primary, other market domains, brand URLs)', async () => {
      const competitors = [
        { name: 'US rival', url: 'https://rival.com', regions: ['us'] },
        { name: 'Self primary', url: 'https://www.brand.com', regions: ['us'] },
        { name: 'Self DE market', url: 'https://brand.de', regions: ['us'] },
        { name: 'Self website', url: 'https://shop.brand.io', regions: ['us'] },
      ];
      const transport = {
        listProjects: sandbox.stub().resolves({
          items: [
            { id: 'p-us', domain: 'brand.com', settings: { ai: { country: { code: 'us' } } } },
            { id: 'p-de', domain: 'brand.de', settings: { ai: { country: { code: 'de' } } } },
          ],
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
        ['https://shop.brand.io'], // brand's own website URL → reserved
      );
      // Only the real rival survives for p-us; the three self-references (own
      // primary brand.com, other-market brand.de, own website shop.brand.io) drop.
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, 'p-us', [
        { brand_name: 'US rival', domain: 'rival.com', brand_aliases: ['us rival'] },
      ]);
      expect(result).to.deep.equal({
        markets: 2, created: 1, updated: 0, deleted: 0, rejected: [],
      });
    });

    it('logs the failing project/market (status only) and rethrows when a market sync throws mid-fan-out', async () => {
      const error = sandbox.stub();
      // The upstream error text carries the gateway URL — only the status +
      // project/market identity is recorded before rethrow.
      const boom = new SerenityTransportError(502, 'Semrush POST https://gw.internal/x failed: 502');
      const transport = {
        listProjects: sandbox.stub().resolves({ items: [projectWith('p-us', 'us')] }),
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub().rejects(boom),
        deleteBenchmarks: sandbox.stub().resolves(null),
        publishProject: sandbox.stub().resolves({}),
      };
      await expect(syncCompetitorBenchmarksAcrossMarkets(
        transport,
        [{ name: 'US rival', url: 'https://us-rival.com', regions: ['us'] }],
        [],
        WS,
        { error, info: () => {}, warn: () => {} },
      )).to.be.rejectedWith('failed: 502');
      expect(error).to.have.been.calledWithMatch('competitor-benchmarks: market sync failed', {
        workspaceId: WS, projectId: 'p-us', market: 'us', status: 502,
      });
    });

    it('logs a per-sync summary when a logger is supplied', async () => {
      const info = sandbox.stub();
      const transport = {
        listProjects: sandbox.stub().resolves({ items: [projectWith('p-us', 'us')] }),
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub().resolves({ ids: ['x'], existing_count: 0 }),
        deleteBenchmarks: sandbox.stub().resolves(null),
        publishProject: sandbox.stub().resolves({}),
      };
      const result = await syncCompetitorBenchmarksAcrossMarkets(
        transport,
        [{ name: 'US rival', url: 'https://us-rival.com', regions: ['us'] }],
        [],
        WS,
        { info, warn: () => {} },
      );
      expect(result).to.deep.equal({
        markets: 1, created: 1, updated: 0, deleted: 0, rejected: [],
      });
      expect(info).to.have.been.calledWithMatch(
        'competitor-benchmarks: re-synced across markets',
        sinon.match({ workspaceId: WS, markets: 1, created: 1 }),
      );
    });

    it('skips republish for an unchanged project and skips region-less projects', async () => {
      const transport = {
        listProjects: sandbox.stub().resolves({
          items: [projectWith('p-us', 'us'), { id: 'p-x', settings: { ai: {} } }],
        }),
        // Carries the derived form already, so the benchmark needs no write.
        listBenchmarks: sandbox.stub().resolves({
          aio_benchmarks: [{ id: 'r', domain: 'rival.com', brand_aliases: ['rival'] }],
        }),
        createBenchmarks: sandbox.stub().resolves({}),
        updateBenchmark: sandbox.stub().resolves(null),
        deleteBenchmarks: sandbox.stub().resolves(null),
        publishProject: sandbox.stub().resolves({}),
      };
      const result = await syncCompetitorBenchmarksAcrossMarkets(transport, [{ name: 'Rival', url: 'https://rival.com' }], [], WS, undefined);
      expect(transport.updateBenchmark).to.not.have.been.called;
      expect(transport.createBenchmarks).to.not.have.been.called;
      expect(transport.publishProject).to.not.have.been.called;
      expect(result).to.deep.equal({
        markets: 1, created: 0, updated: 0, deleted: 0, rejected: [],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Defensive branch coverage — falsy-path and missing-property variants
  // ---------------------------------------------------------------------------

  describe('removedCompetitors — non-array inputs', () => {
    it('treats null oldCompetitors as an empty list', () => {
      // No old entries -> nothing removed.
      expect(removedCompetitors(null, [{ name: 'A', url: 'https://a.com' }])).to.deep.equal([]);
    });

    it('treats null newCompetitors as an empty list', () => {
      // No new entries -> everything in old is considered removed.
      expect(removedCompetitors([{ name: 'A', url: 'https://a.com' }], null)).to.deep.equal([
        { name: 'A', key: 'a', domain: 'a.com' },
      ]);
    });

    it('treats undefined oldCompetitors as an empty list', () => {
      expect(removedCompetitors(undefined, [{ name: 'B', url: 'https://b.com' }]))
        .to.deep.equal([]);
    });

    it('treats undefined newCompetitors as an empty list', () => {
      const old = [{ name: 'A', url: 'https://a.com' }, { name: 'B', url: 'https://b.com' }];
      expect(removedCompetitors(old, undefined).map((r) => r.key)).to.have.members(['a', 'b']);
    });

    it('falls back to the domain as the name, so an unnamed competitor still diffs', () => {
      expect(removedCompetitors([{ url: 'https://a.com' }], [])).to.deep.equal([
        { name: 'a.com', key: 'a.com', domain: 'a.com' },
      ]);
    });
  });

  describe('syncCompetitorBenchmarksForProject — defensive branch coverage', () => {
    it('returns early (no benchmark read) when both desired and removed sets are empty', async () => {
      // No competitors and nothing removed -> skip listBenchmarks entirely.
      const transport = {
        listBenchmarks: sandbox.stub(),
        createBenchmarks: sandbox.stub(),
        deleteBenchmarks: sandbox.stub(),
      };
      const result = await syncCompetitorBenchmarksForProject(transport, WS, PID, [], [], 'us', undefined);
      expect(result).to.deep.equal({
        created: 0, updated: 0, deleted: 0, changed: false, rejected: [],
      });
      expect(transport.listBenchmarks).to.not.have.been.called;
    });

    it('treats a non-array removed list as empty', async () => {
      // With null `removed`, removedList is empty; desired is non-empty so
      // listBenchmarks IS called (no early return).
      const transport = {
        listBenchmarks: sandbox.stub().resolves({ aio_benchmarks: [] }),
        createBenchmarks: sandbox.stub().resolves({ ids: ['new'], existing_count: 0 }),
        deleteBenchmarks: sandbox.stub().resolves(null),
      };
      const result = await syncCompetitorBenchmarksForProject(
        transport,
        WS,
        PID,
        [{ name: 'Duck', url: 'https://duckduckgo.com', regions: ['us'] }],
        null,
        'us',
        undefined,
      );
      expect(result.created).to.equal(1);
      expect(transport.deleteBenchmarks).to.not.have.been.called;
    });

    it('treats a non-array listBenchmarks response as an empty benchmark list', async () => {
      // listBenchmarks resolves {} (no aio_benchmarks property).
      const transport = {
        listBenchmarks: sandbox.stub().resolves({}),
        createBenchmarks: sandbox.stub().resolves({ ids: ['new'], existing_count: 0 }),
        deleteBenchmarks: sandbox.stub().resolves(null),
      };
      const result = await syncCompetitorBenchmarksForProject(
        transport,
        WS,
        PID,
        [{ name: 'Duck', url: 'https://duckduckgo.com', regions: ['us'] }],
        [],
        'us',
        undefined,
      );
      // benchmarks=[] -> Duck not present -> created.
      expect(result.created).to.equal(1);
      expect(transport.createBenchmarks).to.have.been.calledOnce;
    });

    it('skips benchmarks with no name and an unparseable domain', async () => {
      // Such a benchmark can be reached by neither key, so it is not a candidate
      // for any competitor and is left alone.
      const transport = {
        listBenchmarks: sandbox.stub().resolves({
          aio_benchmarks: [
            { id: 'bad', main_brand: false, domain: '' }, // no name, no domain -> skip
            // Carries the derived form, so being present is all this asserts.
            {
              id: 'good', main_brand: false, domain: 'bing.com', brand_aliases: ['bing'],
            },
          ],
        }),
        createBenchmarks: sandbox.stub().resolves({ ids: ['x'], existing_count: 0 }),
        updateBenchmark: sandbox.stub().resolves(null),
        deleteBenchmarks: sandbox.stub().resolves(null),
      };
      const result = await syncCompetitorBenchmarksForProject(
        transport,
        WS,
        PID,
        [
          { name: 'Bing', url: 'https://bing.com', regions: ['us'] }, // already present
          { name: 'Duck', url: 'https://duckduckgo.com', regions: ['us'] }, // new
        ],
        [],
        'us',
        undefined,
      );
      // Bing adopts the unnamed benchmark on its host -> not created. Duck -> created.
      expect(result.created).to.equal(1);
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(WS, PID, [
        { brand_name: 'Duck', domain: 'duckduckgo.com', brand_aliases: ['duck'] },
      ]);
    });
  });

  describe('syncCompetitorBenchmarksAcrossMarkets — defensive branch coverage', () => {
    it('treats a non-array listProjects response as an empty project list', async () => {
      // Exercises `Array.isArray(listing?.items) ? ... : []` at line 172
      // when listProjects resolves {} (no items property).
      const transport = {
        listProjects: sandbox.stub().resolves({}),
        listBenchmarks: sandbox.stub(),
        createBenchmarks: sandbox.stub(),
        deleteBenchmarks: sandbox.stub(),
        publishProject: sandbox.stub(),
      };
      const result = await syncCompetitorBenchmarksAcrossMarkets(transport, [], [], WS, undefined);
      expect(result).to.deep.equal({
        markets: 0, created: 0, updated: 0, deleted: 0, rejected: [],
      });
      expect(transport.listBenchmarks).to.not.have.been.called;
    });

    it('skips a project whose id is missing (projectId null -> continue at line 181)', async () => {
      // Exercises `hasText(project?.id) ? String(project.id) : null` else branch at line 179:
      // when a project has no id, projectId is null and the project is skipped.
      const transport = {
        listProjects: sandbox.stub().resolves({
          items: [
            { settings: { ai: { country: { code: 'us' } } } }, // no id -> skipped
          ],
        }),
        listBenchmarks: sandbox.stub(),
        createBenchmarks: sandbox.stub(),
        deleteBenchmarks: sandbox.stub(),
        publishProject: sandbox.stub(),
      };
      const result = await syncCompetitorBenchmarksAcrossMarkets(
        transport,
        [{ name: 'Duck', url: 'https://duckduckgo.com', regions: ['us'] }],
        [],
        WS,
        undefined,
      );
      expect(result).to.deep.equal({
        markets: 0, created: 0, updated: 0, deleted: 0, rejected: [],
      });
      expect(transport.listBenchmarks).to.not.have.been.called;
    });
  });
});
