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

import { expect } from 'chai';
import sinon from 'sinon';
import { fetchOwnedUrlsTraffic, mergeOwnedUrlsTraffic } from '../../../src/support/elements/owned-urls-traffic.js';

describe('owned-urls-traffic', () => {
  describe('fetchOwnedUrlsTraffic', () => {
    const baseOpts = {
      siteId: 'site-123',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      urls: ['https://example.com/a'],
    };

    it('returns an empty Map when postgrestService has no rpc function', async () => {
      const result = await fetchOwnedUrlsTraffic({}, baseOpts);
      expect(result).to.be.instanceOf(Map);
      expect(result.size).to.equal(0);
    });

    it('returns an empty Map when siteId is missing', async () => {
      const rpc = sinon.stub();
      const result = await fetchOwnedUrlsTraffic({ rpc }, { ...baseOpts, siteId: undefined });
      expect(result.size).to.equal(0);
      expect(rpc).to.not.have.been.called;
    });

    it('returns an empty Map when urls is empty', async () => {
      const rpc = sinon.stub();
      const result = await fetchOwnedUrlsTraffic({ rpc }, { ...baseOpts, urls: [] });
      expect(result.size).to.equal(0);
      expect(rpc).to.not.have.been.called;
    });

    it('omits p_agent_types when agentTypes is not supplied', async () => {
      const rpc = sinon.stub().resolves({ data: [], error: null });
      await fetchOwnedUrlsTraffic({ rpc }, baseOpts);

      const rpcParams = rpc.firstCall.args[1];
      expect(rpcParams).to.not.have.property('p_agent_types');
    });

    it('forwards agentTypes as p_agent_types when supplied', async () => {
      const rpc = sinon.stub().resolves({ data: [], error: null });
      await fetchOwnedUrlsTraffic({ rpc }, { ...baseOpts, agentTypes: ['Chatbots', 'Research'] });

      const rpcParams = rpc.firstCall.args[1];
      expect(rpcParams.p_agent_types).to.deep.equal(['Chatbots', 'Research']);
    });

    it('omits p_region when region is not supplied, forwards it when it is', async () => {
      const rpc = sinon.stub().resolves({ data: [], error: null });
      await fetchOwnedUrlsTraffic({ rpc }, baseOpts);
      expect(rpc.firstCall.args[1]).to.not.have.property('p_region');

      await fetchOwnedUrlsTraffic({ rpc }, { ...baseOpts, region: 'US' });
      expect(rpc.secondCall.args[1].p_region).to.equal('US');
    });

    it('forwards a recognized referralSource, drops an unrecognized one', async () => {
      const rpc = sinon.stub().resolves({ data: [], error: null });
      await fetchOwnedUrlsTraffic({ rpc }, { ...baseOpts, referralSource: 'cja' });
      expect(rpc.firstCall.args[1].p_referral_source).to.equal('cja');

      await fetchOwnedUrlsTraffic({ rpc }, { ...baseOpts, referralSource: 'not-a-source' });
      expect(rpc.secondCall.args[1]).to.not.have.property('p_referral_source');
    });

    it('calls the traffic RPC with site/date/url params and maps rows keyed by url', async () => {
      const rpc = sinon.stub().resolves({
        data: [
          {
            url: 'https://example.com/a',
            agentic_hits: 42,
            agentic_hits_trend: [{ week_start: '2026-01-01', value: 10 }],
            referral_hits: 7,
            referral_hits_trend: [{ week_start: '2026-01-01', value: 3 }],
          },
        ],
        error: null,
      });

      const result = await fetchOwnedUrlsTraffic({ rpc }, baseOpts);

      expect(rpc).to.have.been.calledWith('rpc_url_inspector_owned_urls_traffic', {
        p_site_id: baseOpts.siteId,
        p_start_date: baseOpts.startDate,
        p_end_date: baseOpts.endDate,
        p_urls: baseOpts.urls,
      });
      expect(result.get('https://example.com/a')).to.deep.equal({
        agenticHits: 42,
        agenticHitsTrend: [{ weekStart: '2026-01-01', value: 10 }],
        referralHits: 7,
        referralHitsTrend: [{ weekStart: '2026-01-01', value: 3 }],
      });
    });

    it('defaults missing/null numeric and trend fields to 0/[]', async () => {
      const rpc = sinon.stub().resolves({
        data: [{ url: 'https://example.com/a' }],
        error: null,
      });

      const result = await fetchOwnedUrlsTraffic({ rpc }, baseOpts);
      expect(result.get('https://example.com/a')).to.deep.equal({
        agenticHits: 0,
        agenticHitsTrend: [],
        referralHits: 0,
        referralHitsTrend: [],
      });
    });

    it('returns an empty Map (not a throw) on an RPC error', async () => {
      const rpc = sinon.stub().resolves({ data: null, error: { message: 'boom' } });
      const log = { error: sinon.stub() };

      const result = await fetchOwnedUrlsTraffic({ rpc }, { ...baseOpts, log });
      expect(result.size).to.equal(0);
      expect(log.error).to.have.been.calledWith(sinon.match(/boom/));
    });
  });

  describe('mergeOwnedUrlsTraffic', () => {
    it('returns the original urls untouched when trafficMap is empty', () => {
      const urls = [{ url: 'https://example.com/a', citations: 1 }];
      expect(mergeOwnedUrlsTraffic(urls, new Map())).to.equal(urls);
    });

    it('returns the original urls untouched when trafficMap is not a Map', () => {
      const urls = [{ url: 'https://example.com/a', citations: 1 }];
      expect(mergeOwnedUrlsTraffic(urls, undefined)).to.equal(urls);
    });

    it('overlays matched rows and leaves unmatched rows with their existing defaults', () => {
      const urls = [
        { url: 'https://example.com/a', citations: 1, agenticHits: 0 },
        { url: 'https://example.com/b', citations: 2, agenticHits: 0 },
      ];
      const trafficMap = new Map([
        ['https://example.com/a', {
          agenticHits: 42, agenticHitsTrend: [], referralHits: 0, referralHitsTrend: [],
        }],
      ]);

      const result = mergeOwnedUrlsTraffic(urls, trafficMap);
      expect(result[0]).to.deep.equal({
        url: 'https://example.com/a', citations: 1, agenticHits: 42, agenticHitsTrend: [], referralHits: 0, referralHitsTrend: [],
      });
      expect(result[1]).to.deep.equal(urls[1]);
    });
  });
});
