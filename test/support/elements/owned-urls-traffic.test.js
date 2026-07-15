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

/*
 * Contract/shape tests for the owned-urls traffic hybrid helper (LLMO-6086).
 *
 * These are the "Tier 1" contract tests from TEST-COVERAGE-FINDINGS.md: feed a
 * realistic PostgREST RPC payload (snake_case rows) through the real helper and
 * assert the exact reshaped shape the URL Inspector owned-urls view consumes.
 * The downstream is stubbed (no network); the assertions pin the contract, not
 * the implementation.
 */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  fetchOwnedUrlsTraffic,
  mergeOwnedUrlsTraffic,
} from '../../../src/support/elements/owned-urls-traffic.js';

use(chaiAsPromised);
use(sinonChai);

const RPC_NAME = 'rpc_url_inspector_owned_urls_traffic';

// A realistic RPC row as PostgREST returns it: snake_case, string-ish numbers,
// snake_case trend points. Mirrors what mysticat's rpc returns.
const rpcRow = (overrides = {}) => ({
  url: 'https://example.com/pricing',
  agentic_hits: 42,
  agentic_hits_trend: [
    { week_start: '2026-06-01', value: 10 },
    { week_start: '2026-06-08', value: 32 },
  ],
  referral_hits: 7,
  referral_hits_trend: [{ week_start: '2026-06-01', value: 7 }],
  ...overrides,
});

describe('owned-urls-traffic', () => {
  describe('fetchOwnedUrlsTraffic — guard clauses (best-effort → empty Map)', () => {
    const baseOpts = {
      siteId: 'site-1', startDate: '2026-06-01', endDate: '2026-06-30', urls: ['https://example.com/a'],
    };

    it('returns an empty Map when the client is missing', async () => {
      const result = await fetchOwnedUrlsTraffic(undefined, baseOpts);
      expect(result).to.be.instanceOf(Map);
      expect(result.size).to.equal(0);
    });

    it('returns an empty Map when the client has no rpc function', async () => {
      const result = await fetchOwnedUrlsTraffic({ rpc: 'not-a-fn' }, baseOpts);
      expect(result.size).to.equal(0);
    });

    it('returns an empty Map when siteId is missing', async () => {
      const rpc = sinon.stub();
      const result = await fetchOwnedUrlsTraffic({ rpc }, { ...baseOpts, siteId: undefined });
      expect(result.size).to.equal(0);
      expect(rpc).to.not.have.been.called;
    });

    it('returns an empty Map when urls is not an array', async () => {
      const rpc = sinon.stub();
      const result = await fetchOwnedUrlsTraffic({ rpc }, { ...baseOpts, urls: 'nope' });
      expect(result.size).to.equal(0);
      expect(rpc).to.not.have.been.called;
    });

    it('returns an empty Map when urls is empty', async () => {
      const rpc = sinon.stub();
      const result = await fetchOwnedUrlsTraffic({ rpc }, { ...baseOpts, urls: [] });
      expect(result.size).to.equal(0);
      expect(rpc).to.not.have.been.called;
    });
  });

  describe('fetchOwnedUrlsTraffic — RPC parameter contract', () => {
    let rpc;
    const opts = {
      siteId: 'site-1',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      urls: ['https://example.com/a', 'https://example.com/b'],
    };

    beforeEach(() => {
      rpc = sinon.stub().resolves({ data: [], error: null });
    });

    it('passes the required params and omits optional ones when not provided', async () => {
      await fetchOwnedUrlsTraffic({ rpc }, opts);
      expect(rpc).to.have.been.calledOnce;
      const [name, params] = rpc.firstCall.args;
      expect(name).to.equal(RPC_NAME);
      expect(params).to.deep.equal({
        p_site_id: 'site-1',
        p_start_date: '2026-06-01',
        p_end_date: '2026-06-30',
        p_urls: ['https://example.com/a', 'https://example.com/b'],
      });
      expect(params).to.not.have.any.keys('p_region', 'p_agent_types', 'p_referral_source');
    });

    it('scopes by region only when a region is provided', async () => {
      await fetchOwnedUrlsTraffic({ rpc }, { ...opts, region: 'us' });
      expect(rpc.firstCall.args[1]).to.include({ p_region: 'us' });
    });

    it('passes agent types when provided', async () => {
      await fetchOwnedUrlsTraffic({ rpc }, { ...opts, agentTypes: ['GPTBot', 'ClaudeBot'] });
      expect(rpc.firstCall.args[1].p_agent_types).to.deep.equal(['GPTBot', 'ClaudeBot']);
    });

    it('passes a valid referral source through', async () => {
      await fetchOwnedUrlsTraffic({ rpc }, { ...opts, referralSource: 'cja' });
      expect(rpc.firstCall.args[1]).to.include({ p_referral_source: 'cja' });
    });

    it('drops an unrecognized referral source so the RPC applies its default', async () => {
      await fetchOwnedUrlsTraffic({ rpc }, { ...opts, referralSource: 'bogus-source' });
      expect(rpc.firstCall.args[1]).to.not.have.property('p_referral_source');
    });
  });

  describe('fetchOwnedUrlsTraffic — response reshaping contract', () => {
    it('maps snake_case RPC rows to the camelCase shape the UI consumes', async () => {
      const rpc = sinon.stub().resolves({ data: [rpcRow()], error: null });
      const result = await fetchOwnedUrlsTraffic({ rpc }, {
        siteId: 'site-1', startDate: '2026-06-01', endDate: '2026-06-30', urls: ['https://example.com/pricing'],
      });

      expect(result.size).to.equal(1);
      expect(result.get('https://example.com/pricing')).to.deep.equal({
        agenticHits: 42,
        agenticHitsTrend: [
          { weekStart: '2026-06-01', value: 10 },
          { weekStart: '2026-06-08', value: 32 },
        ],
        referralHits: 7,
        referralHitsTrend: [{ weekStart: '2026-06-01', value: 7 }],
      });
    });

    it('keys the Map by the row url and keeps multiple rows', async () => {
      const rpc = sinon.stub().resolves({
        data: [
          rpcRow({ url: 'https://example.com/a' }),
          rpcRow({ url: 'https://example.com/b', agentic_hits: 1 }),
        ],
        error: null,
      });
      const result = await fetchOwnedUrlsTraffic({ rpc }, {
        siteId: 'site-1', startDate: '2026-06-01', endDate: '2026-06-30', urls: ['x'],
      });
      expect([...result.keys()]).to.deep.equal(['https://example.com/a', 'https://example.com/b']);
      expect(result.get('https://example.com/b').agenticHits).to.equal(1);
    });

    it('coerces non-numeric / missing hit counts to 0', async () => {
      const rpc = sinon.stub().resolves({
        data: [rpcRow({ agentic_hits: null, referral_hits: 'not-a-number' })],
        error: null,
      });
      const result = await fetchOwnedUrlsTraffic({ rpc }, {
        siteId: 'site-1', startDate: '2026-06-01', endDate: '2026-06-30', urls: ['x'],
      });
      const entry = result.get('https://example.com/pricing');
      expect(entry.agenticHits).to.equal(0);
      expect(entry.referralHits).to.equal(0);
    });

    it('defaults a missing / non-array trend to [] and coerces trend point values', async () => {
      const rpc = sinon.stub().resolves({
        data: [rpcRow({
          agentic_hits_trend: null,
          referral_hits_trend: [{ week_start: undefined, value: 'x' }],
        })],
        error: null,
      });
      const result = await fetchOwnedUrlsTraffic({ rpc }, {
        siteId: 'site-1', startDate: '2026-06-01', endDate: '2026-06-30', urls: ['x'],
      });
      const entry = result.get('https://example.com/pricing');
      expect(entry.agenticHitsTrend).to.deep.equal([]);
      expect(entry.referralHitsTrend).to.deep.equal([{ weekStart: null, value: 0 }]);
    });

    it('returns an empty Map when the RPC returns null data (no throw)', async () => {
      const rpc = sinon.stub().resolves({ data: null, error: null });
      const result = await fetchOwnedUrlsTraffic({ rpc }, {
        siteId: 'site-1', startDate: '2026-06-01', endDate: '2026-06-30', urls: ['x'],
      });
      expect(result.size).to.equal(0);
    });
  });

  describe('fetchOwnedUrlsTraffic — error handling (best-effort)', () => {
    it('logs and returns an empty Map on an RPC error', async () => {
      const rpc = sinon.stub().resolves({ data: null, error: { message: 'boom' } });
      const log = { error: sinon.stub() };
      const result = await fetchOwnedUrlsTraffic({ rpc }, {
        siteId: 'site-1', startDate: '2026-06-01', endDate: '2026-06-30', urls: ['x'], log,
      });
      expect(result.size).to.equal(0);
      expect(log.error).to.have.been.calledOnce;
      expect(log.error.firstCall.args[0]).to.include('boom');
    });

    it('does not throw on an RPC error when no logger is supplied', async () => {
      const rpc = sinon.stub().resolves({ data: null, error: { message: 'boom' } });
      const result = await fetchOwnedUrlsTraffic({ rpc }, {
        siteId: 'site-1', startDate: '2026-06-01', endDate: '2026-06-30', urls: ['x'],
      });
      expect(result.size).to.equal(0);
    });
  });

  describe('mergeOwnedUrlsTraffic', () => {
    const urls = [
      { url: 'https://example.com/a', agenticHits: 0, referralHits: 0 },
      { url: 'https://example.com/b', agenticHits: 0, referralHits: 0 },
    ];

    it('returns the urls unchanged when trafficMap is not a Map', () => {
      expect(mergeOwnedUrlsTraffic(urls, null)).to.equal(urls);
      expect(mergeOwnedUrlsTraffic(urls, {})).to.equal(urls);
    });

    it('returns the urls unchanged when trafficMap is empty', () => {
      expect(mergeOwnedUrlsTraffic(urls, new Map())).to.equal(urls);
    });

    it('overlays traffic onto matching rows and leaves unmatched rows at their defaults', () => {
      const trafficMap = new Map([
        ['https://example.com/a', {
          agenticHits: 5, agenticHitsTrend: [], referralHits: 2, referralHitsTrend: [],
        }],
      ]);
      const merged = mergeOwnedUrlsTraffic(urls, trafficMap);
      expect(merged[0]).to.include({ url: 'https://example.com/a', agenticHits: 5, referralHits: 2 });
      // unmatched row keeps its 0/[] defaults
      expect(merged[1]).to.deep.equal({ url: 'https://example.com/b', agenticHits: 0, referralHits: 0 });
    });

    it('does not mutate the input rows', () => {
      const trafficMap = new Map([['https://example.com/a', { agenticHits: 5 }]]);
      const snapshot = JSON.parse(JSON.stringify(urls));
      mergeOwnedUrlsTraffic(urls, trafficMap);
      expect(urls).to.deep.equal(snapshot);
    });
  });
});
