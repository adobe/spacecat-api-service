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

/* eslint-disable prefer-promise-reject-errors -- AI Visibility competitors tests */

import { expect } from 'chai';
import sinon from 'sinon';
import { ConnectError, Code } from '@connectrpc/connect';
import {
  handleCompetitorsMetrics,
  handleCompetitorsGapTopics,
  handleCompetitorsGapSourceDomains,
  handleCompetitorsGapPrompts,
} from '../../../../src/support/ai-visibility/handlers/competitors.js';

describe('AI Visibility – competitors handlers', () => {
  let sandbox;
  let clients;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clients = {
      brandClient: {
        statsByLLM: sandbox.stub(),
        statsByCountry: sandbox.stub(),
        topBrandsByDomain: sandbox.stub(),
        brandsByTopicFTS: sandbox.stub(),
        brandsByTopicFTSTotals: sandbox.stub(),
      },
      topicClient: {
        brandTopics: sandbox.stub(),
        brandTopicsTotals: sandbox.stub(),
        gapTopics: sandbox.stub(),
        gapTopicsTotals: sandbox.stub(),
        topicsByFTS: sandbox.stub(),
        metricsByFTS: sandbox.stub(),
        metricsByFTSGroupedByLLM: sandbox.stub(),
      },
      promptClient: {
        prompts: sandbox.stub(),
        promptsTotals: sandbox.stub(),
        gapPrompts: sandbox.stub(),
        gapPromptsTotals: sandbox.stub(),
        promptsByTopicFTS: sandbox.stub(),
        promptsByTopicFTSTotals: sandbox.stub(),
      },
      sourceClient: {
        sources: sandbox.stub(),
        sourceDomains: sandbox.stub(),
        gapSourceDomains: sandbox.stub(),
        gapSourceDomainsTotals: sandbox.stub(),
        sourceDomainsByTopicFTS: sandbox.stub(),
        sourceDomainsByTopicFTSTotals: sandbox.stub(),
      },
      competitorClient: { brandCompetitors: sandbox.stub() },
      crMetricsClient: { stats: sandbox.stub() },
      crMetaClient: { meta: sandbox.stub() },
      voSourcesClient: { sourcesTotals: sandbox.stub(), domainsTotals: sandbox.stub() },
      prRelationsClient: { prompt: sandbox.stub() },
    };
  });

  afterEach(() => sandbox.restore());

  /* ------------------------------------------------------------------ */
  /*  handleCompetitorsMetrics                                           */
  /* ------------------------------------------------------------------ */
  describe('handleCompetitorsMetrics', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_domain');
    });

    it('returns 400 when competitors are missing', async () => {
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_competitors');
    });

    it('returns 200 with competitor metrics', async () => {
      clients.crMetricsClient.stats.resolves({
        byBrand: [
          {
            brand: { domain: 'comp.com', name: 'Comp' },
            byDate: [{
              date: '2026-03', visibility: 50, mentions: 10, audience: 100, ownedSources: 5,
            }],
          },
        ],
      });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.byBrand).to.have.length(1);
      expect(res.body.byBrand[0].brand.domain).to.equal('comp.com');
      expect(res.body.byBrand[0].byDate[0].visibility).to.equal(50);
    });

    it('returns empty by_brand on ConnectError NotFound', async () => {
      clients.crMetricsClient.stats.rejects(new ConnectError('not found', Code.NotFound));
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.byBrand).to.deep.equal([]);
    });

    it('returns empty by_brand on message-pattern NotFound', async () => {
      clients.crMetricsClient.stats.rejects(new Error('Code: NotFound - no data'));
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.byBrand).to.deep.equal([]);
    });

    it('rethrows non-NotFound errors', async () => {
      clients.crMetricsClient.stats.rejects(new Error('internal'));
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsMetrics(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e.message).to.equal('internal');
      }
    });

    it('passes engine filter and snapshot date', async () => {
      clients.crMetricsClient.stats.resolves({ byBrand: [] });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com&engine=chatgpt&gapSnapshotDate=2026-03-15');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      const call = clients.crMetricsClient.stats.firstCall.args[0];
      expect(call).to.have.property('llm');
      expect(call).to.have.property('dateRange');
    });

    it('passes metrics_snapshot_date when gap_snapshot_date is absent', async () => {
      clients.crMetricsClient.stats.resolves({ byBrand: [] });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com&metricsSnapshotDate=2026-04-01');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      const call = clients.crMetricsClient.stats.firstCall.args[0];
      expect(call).to.have.property('dateRange');
    });

    it('maps brand with missing name (falls back to domain)', async () => {
      clients.crMetricsClient.stats.resolves({
        byBrand: [{
          brand: { domain: 'comp.com' },
          byDate: [{
            date: '2026-03', visibility: 1, mentions: 1, audience: 1, ownedSources: 0,
          }],
        }],
      });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.body.byBrand[0].brand.name).to.equal('comp.com');
    });

    it('maps brand with missing brand object', async () => {
      clients.crMetricsClient.stats.resolves({
        byBrand: [{ byDate: [] }],
      });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.body.byBrand[0].brand.domain).to.equal('');
      expect(res.body.byBrand[0].brand.name).to.equal('');
    });

    it('maps brand with missing byDate', async () => {
      clients.crMetricsClient.stats.resolves({
        byBrand: [{ brand: { domain: 'd.com', name: 'D' } }],
      });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.body.byBrand[0].byDate).to.deep.equal([]);
    });

    it('handles error with no message property', async () => {
      const err = 'plain string error';
      clients.crMetricsClient.stats.rejects(err);
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsMetrics(sp, clients);
        expect.fail('should throw');
      } catch { /* expected */ }
    });

    it('handles no snapshot date', async () => {
      clients.crMetricsClient.stats.resolves({ byBrand: [] });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('handles raw.byBrand being undefined', async () => {
      clients.crMetricsClient.stats.resolves({});
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.body.byBrand).to.deep.equal([]);
    });

    it('handles repeated competitor= params', async () => {
      clients.crMetricsClient.stats.resolves({ byBrand: [] });
      const sp = new URLSearchParams('domain=example.com&competitor=a.com&competitor=b.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      expect(clients.crMetricsClient.stats.firstCall.args[0].competitors).to.have.length(2);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleCompetitorsGapTopics                                         */
  /* ------------------------------------------------------------------ */
  describe('handleCompetitorsGapTopics', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when competitors are missing', async () => {
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 200 with gap topics and gap_mentions', async () => {
      clients.topicClient.gapTopics.resolves({
        topics: [{
          hash: '123',
          name: 'Topic1',
          volume: 5000,
          visibility: 80,
          mentions: 10,
          difficulty: 3,
          gapMentions: [{ brand: { domain: 'comp.com', name: 'Comp' }, mentions: 5 }],
        }],
      });
      clients.topicClient.gapTopicsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].gapMentions).to.have.length(1);
      expect(res.body.data[0].topicId).to.equal('123');
    });

    it('NotFound error returns empty results', async () => {
      clients.topicClient.gapTopics.rejects(new ConnectError('not found', Code.NotFound));
      clients.topicClient.gapTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('rethrows non-NotFound errors', async () => {
      clients.topicClient.gapTopics.rejects(new Error('internal'));
      clients.topicClient.gapTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsGapTopics(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e.message).to.equal('internal');
      }
    });

    it('handles hasMore slicing correctly', async () => {
      const topics = Array.from({ length: 11 }, (_, i) => ({
        hash: String(i), name: `T${i}`, volume: 100, visibility: 10, mentions: 1, difficulty: 1, gapMentions: [],
      }));
      clients.topicClient.gapTopics.resolves({ topics });
      clients.topicClient.gapTopicsTotals.resolves({ total: 50 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com&limit=10');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.body.data).to.have.length(10);
      expect(res.body.total).to.equal(50);
    });

    it('totals rejection falls back to floor', async () => {
      clients.topicClient.gapTopics.resolves({
        topics: [{
          hash: '1', name: 'T', volume: 100, visibility: 10, mentions: 1, difficulty: 1, gapMentions: [],
        }],
      });
      clients.topicClient.gapTopicsTotals.rejects(new Error('fail'));
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(1);
    });

    it('passes gap_snapshot_date when provided', async () => {
      clients.topicClient.gapTopics.resolves({ topics: [] });
      clients.topicClient.gapTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com&gapSnapshotDate=2026-05-01');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('detects NotFound via message pattern', async () => {
      clients.topicClient.gapTopics.rejects(new Error('NotFound: no data'));
      clients.topicClient.gapTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('handles gap topics error without message property (NotFound in reason string)', async () => {
      const reason = 'NotFound: no such data';
      clients.topicClient.gapTopics.rejects(reason);
      clients.topicClient.gapTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('detects NotFound via Code: NotFound regex in gap topics', async () => {
      clients.topicClient.gapTopics.rejects(new Error('Code: NotFound'));
      clients.topicClient.gapTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('handles gap topics with gapMentions undefined', async () => {
      clients.topicClient.gapTopics.resolves({
        topics: [{
          hash: '1', name: 'T', volume: 100, visibility: 10, mentions: 1, difficulty: 1,
        }],
      });
      clients.topicClient.gapTopicsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.body.data[0].gapMentions).to.deep.equal([]);
    });

    it('handles rejection with reason object lacking message property', async () => {
      const reason = { code: 'SOME_CODE' };
      clients.topicClient.gapTopics.returns(Promise.reject(reason));
      clients.topicClient.gapTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsGapTopics(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e).to.equal(reason);
      }
    });

    it('handles null rejection reason in gap topics', async () => {
      clients.topicClient.gapTopics.returns(Promise.reject(null));
      clients.topicClient.gapTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsGapTopics(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e).to.be.null;
      }
    });

    it('handles raw.topics being undefined', async () => {
      clients.topicClient.gapTopics.resolves({});
      clients.topicClient.gapTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('maps gap topic with missing fields', async () => {
      clients.topicClient.gapTopics.resolves({
        topics: [{
          gapMentions: [{ brand: { domain: 'c.com' } }, { brand: {} }, { mentions: 3 }],
        }],
      });
      clients.topicClient.gapTopicsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapTopics(sp, clients);
      expect(res.body.data[0].topicId).to.equal('');
      expect(res.body.data[0].topic).to.equal('');
      expect(res.body.data[0].gapMentions).to.have.length(3);
      expect(res.body.data[0].gapMentions[0].name).to.equal('c.com');
      expect(res.body.data[0].gapMentions[1].domain).to.equal('');
      expect(res.body.data[0].gapMentions[2].domain).to.equal('');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleCompetitorsGapSourceDomains                                  */
  /* ------------------------------------------------------------------ */
  describe('handleCompetitorsGapSourceDomains', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when competitors are missing', async () => {
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 200 with gap source domains', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: 'www.gap.com', sourcesCount: 3, promptsCount: 5, targetMentions: 2, organicTraffic: 1000,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 10 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].sourceDomain).to.equal('gap.com');
      expect(res.body.data[0].organicTraffic).to.equal(1000);
    });

    it('NotFound error returns empty', async () => {
      clients.sourceClient.gapSourceDomains.rejects(new ConnectError('nf', Code.NotFound));
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('rethrows non-NotFound errors', async () => {
      clients.sourceClient.gapSourceDomains.rejects(new Error('boom'));
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsGapSourceDomains(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e.message).to.equal('boom');
      }
    });

    it('totals rejection falls back to floor', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: 'a.com', sourcesCount: 1, promptsCount: 1, targetMentions: 1,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.rejects(new Error('fail'));
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.total).to.equal(1);
    });

    it('includes country from source domain field', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: 'a.com', sourcesCount: 1, promptsCount: 1, mentions: 1, country: 15,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.data[0]).to.have.property('country');
    });

    it('filters empty source_domain entries', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: '', sourcesCount: 1, promptsCount: 1, mentions: 1,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.data).to.have.length(0);
    });

    it('passes gap_snapshot_date', async () => {
      clients.sourceClient.gapSourceDomains.resolves({ domains: [] });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com&gapSnapshotDate=2026-01-15');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('excludes organic_traffic when non-finite', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: 'a.com', sourcesCount: 1, promptsCount: 1, mentions: 1, organicTraffic: Infinity,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.data[0]).to.not.have.property('organicTraffic');
    });

    it('detects NotFound via message pattern', async () => {
      clients.sourceClient.gapSourceDomains.rejects(new Error('Code: NotFound'));
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('falls back to hostname when domain is missing', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          hostname: 'host.com', sourcesCount: 1, promptsCount: 1, mentions: 1,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.data[0].sourceDomain).to.equal('host.com');
    });

    it('falls back to host when domain and hostname missing', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          host: 'h.com', sourcesCount: 1, promptsCount: 1, targetMentions: 2,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.data[0].sourceDomain).to.equal('h.com');
      expect(res.body.data[0].mentions).to.equal(2);
    });

    it('falls back to mentions when targetMentions is missing', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: 'a.com', sourcesCount: 1, promptsCount: 1, mentions: 7,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.data[0].mentions).to.equal(7);
    });

    it('handles empty organic_traffic string', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: 'a.com', sourcesCount: 1, promptsCount: 1, mentions: 1, organicTraffic: '',
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.data[0]).to.not.have.property('organicTraffic');
    });

    it('detects NotFound via \\bNotFound\\b regex in gap source domains', async () => {
      clients.sourceClient.gapSourceDomains.rejects(new Error('NotFound'));
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('handles gap source domains error without message property', async () => {
      const reason = 'NotFound';
      clients.sourceClient.gapSourceDomains.rejects(reason);
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('uses mentions fallback when targetMentions is null', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: 'a.com', sourcesCount: 1, promptsCount: 1, targetMentions: null, mentions: null,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.data[0].mentions).to.equal(0);
    });

    it('handles rejection with reason object lacking message in gap source domains', async () => {
      const reason = { code: 'SOME_CODE' };
      clients.sourceClient.gapSourceDomains.returns(Promise.reject(reason));
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsGapSourceDomains(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e).to.equal(reason);
      }
    });

    it('handles null rejection reason in gap source domains', async () => {
      clients.sourceClient.gapSourceDomains.returns(Promise.reject(null));
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsGapSourceDomains(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e).to.be.null;
      }
    });

    it('handles raw.domains being undefined', async () => {
      clients.sourceClient.gapSourceDomains.resolves({});
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('handles null organic_traffic', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: 'a.com', sourcesCount: 1, promptsCount: 1, mentions: 1, organicTraffic: null,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.data[0]).to.not.have.property('organicTraffic');
    });

    it('handles all domain/hostname/host being null', async () => {
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{ sourcesCount: 1, promptsCount: 1, mentions: 1 }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapSourceDomains(sp, clients);
      expect(res.body.data).to.have.length(0);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleCompetitorsGapPrompts                                        */
  /* ------------------------------------------------------------------ */
  describe('handleCompetitorsGapPrompts', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when competitors are missing', async () => {
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 200 with gap prompts', async () => {
      clients.promptClient.gapPrompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicName: 'T',
          topicId: '1',
          topicVolume: 5000,
          mentionedBrandsCount: 3,
          sourcesCount: 2,
          llm: 1,
          gapMentions: [{ brand: { domain: 'comp.com', name: 'Comp' }, mentions: 2 }],
        }],
      });
      clients.promptClient.gapPromptsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].prompt).to.equal('Q');
      expect(res.body.data[0].mentioned).to.equal(1);
    });

    it('NotFound error returns empty', async () => {
      clients.promptClient.gapPrompts.rejects(new ConnectError('nf', Code.NotFound));
      clients.promptClient.gapPromptsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('rethrows non-NotFound errors', async () => {
      clients.promptClient.gapPrompts.rejects(new Error('boom'));
      clients.promptClient.gapPromptsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsGapPrompts(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e.message).to.equal('boom');
      }
    });

    it('handles hasMore slicing correctly', async () => {
      const prompts = Array.from({ length: 11 }, (_, i) => ({
        prompt: `P${i}`,
        promptHash: `h${i}`,
        serpId: `s${i}`,
        topicName: 'T',
        topicId: '1',
        topicVolume: 100,
        mentionedBrandsCount: 1,
        sourcesCount: 1,
        llm: 1,
        gapMentions: [],
      }));
      clients.promptClient.gapPrompts.resolves({ prompts });
      clients.promptClient.gapPromptsTotals.resolves({ total: 50 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com&limit=10');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.body.data).to.have.length(10);
      expect(res.body.total).to.equal(50);
    });

    it('totals rejection falls back to floor', async () => {
      clients.promptClient.gapPrompts.resolves({
        prompts: [{
          prompt: 'Q', promptHash: 'h', serpId: 's', topicName: 'T', topicId: '1', topicVolume: 100, mentionedBrandsCount: 1, sourcesCount: 1, llm: 1, gapMentions: [],
        }],
      });
      clients.promptClient.gapPromptsTotals.rejects(new Error('fail'));
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.body.total).to.equal(1);
    });

    it('passes gap_snapshot_date', async () => {
      clients.promptClient.gapPrompts.resolves({ prompts: [] });
      clients.promptClient.gapPromptsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com&gapSnapshotDate=2026-02-10');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('counts gap_mentions excluding focal domain', async () => {
      clients.promptClient.gapPrompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicName: 'T',
          topicId: '1',
          topicVolume: 100,
          mentionedBrandsCount: 5,
          sourcesCount: 1,
          llm: 1,
          gapMentions: [
            { brand: { domain: 'example.com' }, mentions: 3 },
            { brand: { domain: 'other.com', name: 'Other' }, mentions: 2 },
            { brand: { domain: 'www.example.com' }, mentions: 1 },
          ],
        }],
      });
      clients.promptClient.gapPromptsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.body.data[0].mentioned).to.equal(1);
    });

    it('handles empty promptHash/serpId in id field', async () => {
      clients.promptClient.gapPrompts.resolves({
        prompts: [{
          prompt: 'Q', promptHash: 'h', topicName: 'T', topicId: '1', topicVolume: 100, mentionedBrandsCount: 1, sourcesCount: 1, llm: 1, gapMentions: [],
        }],
      });
      clients.promptClient.gapPromptsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.body.data[0].id).to.include('h-');
    });

    it('detects NotFound via message pattern', async () => {
      clients.promptClient.gapPrompts.rejects(new Error('NotFound'));
      clients.promptClient.gapPromptsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('maps gap prompt with missing optional fields', async () => {
      clients.promptClient.gapPrompts.resolves({
        prompts: [{
          prompt: 'Q',
          llm: 1,
          gapMentions: [{ brand: {} }],
        }],
      });
      clients.promptClient.gapPromptsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.body.data[0].promptHash).to.equal('');
      expect(res.body.data[0].serpId).to.equal('');
      expect(res.body.data[0].topicId).to.equal('');
      expect(res.body.data[0].mentioned).to.equal(0);
    });

    it('maps gap prompt with null promptHash and null serpId', async () => {
      clients.promptClient.gapPrompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: null,
          serpId: null,
          topicId: null,
          topicName: 'T',
          topicVolume: 100,
          mentionedBrandsCount: 1,
          sourcesCount: 1,
          llm: 1,
          gapMentions: [],
        }],
      });
      clients.promptClient.gapPromptsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.body.data[0].promptHash).to.equal('');
      expect(res.body.data[0].serpId).to.equal('');
    });

    it('maps gap prompt with empty string promptHash', async () => {
      clients.promptClient.gapPrompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: '',
          serpId: '',
          topicId: '',
          topicName: 'T',
          topicVolume: 100,
          mentionedBrandsCount: 1,
          sourcesCount: 1,
          llm: 1,
          gapMentions: [],
        }],
      });
      clients.promptClient.gapPromptsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.body.data[0].promptHash).to.equal('');
      expect(res.body.data[0].serpId).to.equal('');
    });

    it('detects NotFound via Code: NotFound regex in gap prompts', async () => {
      clients.promptClient.gapPrompts.rejects(new Error('Code: NotFound'));
      clients.promptClient.gapPromptsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('handles gap prompts error without message property', async () => {
      const reason = 'NotFound';
      clients.promptClient.gapPrompts.rejects(reason);
      clients.promptClient.gapPromptsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('handles gap prompt with gapMentions undefined', async () => {
      clients.promptClient.gapPrompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicName: 'T',
          topicId: '1',
          topicVolume: 100,
          mentionedBrandsCount: 1,
          sourcesCount: 1,
          llm: 1,
        }],
      });
      clients.promptClient.gapPromptsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.body.data[0].mentioned).to.equal(0);
    });

    it('handles rejection with reason object lacking message in gap prompts', async () => {
      const reason = { code: 'SOME_CODE' };
      clients.promptClient.gapPrompts.returns(Promise.reject(reason));
      clients.promptClient.gapPromptsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsGapPrompts(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e).to.equal(reason);
      }
    });

    it('handles null rejection reason in gap prompts', async () => {
      clients.promptClient.gapPrompts.returns(Promise.reject(null));
      clients.promptClient.gapPromptsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsGapPrompts(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e).to.be.null;
      }
    });

    it('handles raw.prompts being undefined', async () => {
      clients.promptClient.gapPrompts.resolves({});
      clients.promptClient.gapPromptsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('gap mentions brand with missing domain counts as mentioned', async () => {
      clients.promptClient.gapPrompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicName: 'T',
          topicId: '1',
          topicVolume: 100,
          mentionedBrandsCount: 1,
          sourcesCount: 1,
          llm: 1,
          gapMentions: [{ brand: { domain: '' } }],
        }],
      });
      clients.promptClient.gapPromptsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsGapPrompts(sp, clients);
      expect(res.body.data[0].mentioned).to.equal(0);
    });
  });
});
