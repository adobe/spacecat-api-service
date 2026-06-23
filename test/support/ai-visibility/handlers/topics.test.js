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

/* eslint-disable max-len, max-statements-per-line, object-curly-newline, no-plusplus -- AI Visibility topics tests */

import { expect } from 'chai';
import sinon from 'sinon';
import { ORDER_DIRECTION_ENUM } from '@quazar/ai-seo-ts/common/types_pb.js';
import { TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import { PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import { BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/brand/enums_pb.js';
import { SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import {
  handleTopicsResearchStats,
  handleTopicsResearch,
  handleTopicsStats,
  handleTopicsResearchPrompts,
  handleTopicsResearchBrands,
  handleTopicsResearchSourceDomains,
  countTopicRowsByTopicsByFtsPaging,
  countDistinctTopicIdsAcrossFtsLlms,
} from '../../../../src/support/ai-visibility/handlers/topics.js';
import { FTS_LLMS, LLM_ENUM, TOPIC_INTENT_ENUM, COUNTRY_ENUM } from '../../../../src/support/ai-visibility/grpc-utils.js';

describe('AI Visibility – topics handlers', () => {
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
        promptsByTopicIDs: sandbox.stub(),
        promptsByTopicIDsTotal: sandbox.stub(),
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
  /*  handleTopicsResearchStats                                          */
  /* ------------------------------------------------------------------ */
  describe('handleTopicsResearchStats', () => {
    it('returns 400 when search_query is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_search_query');
    });

    it('single LLM path with metrics', async () => {
      clients.topicClient.topicsByFTS
        .onFirstCall().resolves({ topics: [{ id: '1' }] })
        .onSecondCall().resolves({ topics: [] });
      clients.topicClient.metricsByFTS.resolves({
        volume: 5000,
        brandsCount: 10,
        sourceDomainsCount: 20,
        intents: [{ intent: TOPIC_INTENT_ENUM.INFORMATIONAL, weight: 5 }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.topicsTotal).to.equal(1);
      expect(res.body.brandsTotal).to.equal(10);
      expect(res.body.sourceDomainsTotal).to.equal(20);
      expect(res.body.relatedTopicsAiVolume).to.equal(5000);
      expect(res.body.intentBreakdown).to.have.length(1);
    });

    it('single LLM fallback when metricsByFTS fails', async () => {
      clients.topicClient.topicsByFTS.resolves({ topics: [] });
      clients.topicClient.metricsByFTS.rejects(new Error('fail'));
      clients.brandClient.brandsByTopicFTSTotals.resolves({ total: 3 });
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 7 });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.brandsTotal).to.equal(3);
      expect(res.body.sourceDomainsTotal).to.equal(7);
      expect(res.body).to.not.have.property('intentBreakdown');
    });

    it('all LLMs path', async () => {
      clients.topicClient.topicsByFTS.callsFake(({ llm: l }) => {
        const ftsIdx = FTS_LLMS.indexOf(l);
        if (ftsIdx >= 0) {
          const key = `_topicsCount_${l}`;
          if (!clients[key]) { clients[key] = 0; }
          clients[key] += 1;
          if (clients[key] === 1) { return Promise.resolve({ topics: [{ id: `t-${l}` }] }); }
        }
        return Promise.resolve({ topics: [] });
      });
      clients.topicClient.metricsByFTSGroupedByLLM.resolves({
        metricsByLlm: [{ volume: 100 }, { volume: 200 }],
      });
      clients.topicClient.metricsByFTS.withArgs(sinon.match({ llm: LLM_ENUM.ALL })).resolves({
        brandsCount: 15,
        sourceDomainsCount: 25,
        intents: [{ intent: TOPIC_INTENT_ENUM.TASK, weight: 3 }],
      });
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.topicsTotal).to.be.a('number');
      expect(res.body.relatedTopicsAiVolume).to.equal(300);
    });

    it('all LLMs path falls back when metricsByFTS ALL fails', async () => {
      clients.topicClient.topicsByFTS.resolves({ topics: [] });
      for (const llm of FTS_LLMS) {
        clients.topicClient.metricsByFTS.withArgs(sinon.match({ llm })).resolves({
          brandsCount: 2,
          sourceDomainsCount: 3,
          intents: [{ intent: TOPIC_INTENT_ENUM.COMMERCIAL, weight: 1 }],
        });
      }
      clients.topicClient.metricsByFTSGroupedByLLM.resolves({ metricsByLlm: [] });
      clients.topicClient.metricsByFTS.withArgs(sinon.match({ llm: LLM_ENUM.ALL })).rejects(new Error('fail'));
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.brandsTotal).to.be.greaterThan(0);
    });

    it('all LLMs fallback returns zeros when all calls fail', async () => {
      clients.topicClient.topicsByFTS.resolves({ topics: [] });
      clients.topicClient.metricsByFTSGroupedByLLM.rejects(new Error('fail'));
      clients.topicClient.metricsByFTS.rejects(new Error('fail'));
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.brandsTotal).to.equal(0);
      expect(res.body.sourceDomainsTotal).to.equal(0);
    });

    it('single LLM with metricsByFTS catching error triggers fallback path', async () => {
      clients.topicClient.topicsByFTS.resolves({ topics: [] });
      clients.topicClient.metricsByFTS.onFirstCall().rejects(new Error('fail'));
      clients.topicClient.metricsByFTS.onSecondCall().resolves({ volume: 42 });
      clients.brandClient.brandsByTopicFTSTotals.resolves({ total: 0 });
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('intentBreakdown omits zero-weight intents', async () => {
      clients.topicClient.topicsByFTS.resolves({ topics: [] });
      clients.topicClient.metricsByFTS.resolves({
        volume: 0,
        brandsCount: 0,
        sourceDomainsCount: 0,
        intents: [{ intent: TOPIC_INTENT_ENUM.TASK, weight: 0 }, { intent: TOPIC_INTENT_ENUM.INFORMATIONAL, weight: 5 }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.body.intentBreakdown).to.have.length(1);
    });

    it('omits intentBreakdown when empty', async () => {
      clients.topicClient.topicsByFTS.resolves({ topics: [] });
      clients.topicClient.metricsByFTS.resolves({
        volume: 0, brandsCount: 0, sourceDomainsCount: 0, intents: [],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.body).to.not.have.property('intentBreakdown');
    });

    it('all LLMs fallback catch block when Promise.all throws', async () => {
      clients.topicClient.topicsByFTS.resolves({ topics: [] });
      clients.topicClient.metricsByFTSGroupedByLLM.callsFake(() => { throw new Error('sync throw'); });
      clients.topicClient.metricsByFTS.withArgs(sinon.match({ llm: LLM_ENUM.ALL })).rejects(new Error('fail'));
      for (const llm of FTS_LLMS) {
        clients.topicClient.metricsByFTS.withArgs(sinon.match({ llm })).callsFake(() => { throw new Error('sync throw in map'); });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.brandsTotal).to.equal(0);
      expect(res.body.sourceDomainsTotal).to.equal(0);
    });

    it('handles paging for countTopicRowsByTopicsByFtsPaging', async () => {
      let callCount = 0;
      clients.topicClient.topicsByFTS.callsFake(() => {
        callCount += 1;
        if (callCount <= 2) { return Promise.resolve({ topics: Array(1000).fill({ id: `t${callCount}` }) }); }
        return Promise.resolve({ topics: [] });
      });
      clients.topicClient.metricsByFTS.resolves({
        volume: 0, brandsCount: 0, sourceDomainsCount: 0, intents: [],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.topicsTotal).to.equal(2000);
    });

    it('all LLMs with metricsByFTSGroupedByLLM returning empty metricsByLlm', async () => {
      clients.topicClient.topicsByFTS.resolves({ topics: [] });
      clients.topicClient.metricsByFTSGroupedByLLM.resolves({});
      clients.topicClient.metricsByFTS.withArgs(sinon.match({ llm: LLM_ENUM.ALL })).resolves({
        brandsCount: 0, sourceDomainsCount: 0, intents: [],
      });
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.relatedTopicsAiVolume).to.equal(0);
    });

    it('fetchRelatedTopicsAiVolumeMetrics with llm catches error', async () => {
      clients.topicClient.topicsByFTS
        .onFirstCall().resolves({ topics: [{ id: '1' }] })
        .onSecondCall().resolves({ topics: [] });
      clients.topicClient.metricsByFTS.onFirstCall().rejects(new Error('fail'));
      clients.topicClient.metricsByFTS.onSecondCall().rejects(new Error('fail'));
      clients.brandClient.brandsByTopicFTSTotals.resolves({ total: 0 });
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchStats(sp, clients);
      expect(res.status).to.equal(200);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleTopicsResearch                                               */
  /* ------------------------------------------------------------------ */
  describe('textFilter (server-side search)', () => {
    it('threads textFilter into topicsByFTS as a topic CONTAINS clause', async () => {
      clients.topicClient.topicsByFTS.resolves({ topics: [] });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt&textFilter=pdf');
      await handleTopicsResearch(sp, clients);
      expect(clients.topicClient.topicsByFTS.calledWith(
        sinon.match({ dimensionFilterQl: 'topic CONTAINS "pdf"' }),
      )).to.equal(true);
    });

    it('threads textFilter into prompts list + totals as a prompt CONTAINS clause', async () => {
      clients.promptClient.promptsByTopicFTS.resolves({ prompts: [] });
      clients.promptClient.promptsByTopicFTSTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt&textFilter=pdf');
      await handleTopicsResearchPrompts(sp, clients);
      expect(clients.promptClient.promptsByTopicFTS.calledWith(
        sinon.match({ dimensionFilterQl: 'prompt CONTAINS "pdf"' }),
      )).to.equal(true);
      expect(clients.promptClient.promptsByTopicFTSTotals.calledWith(
        sinon.match({ dimensionFilterQl: 'prompt CONTAINS "pdf"' }),
      )).to.equal(true);
    });

    it('threads textFilter into brands as a name CONTAINS clause', async () => {
      clients.brandClient.brandsByTopicFTS.resolves({ brands: [] });
      clients.brandClient.brandsByTopicFTSTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt&textFilter=adobe');
      await handleTopicsResearchBrands(sp, clients);
      expect(clients.brandClient.brandsByTopicFTS.calledWith(
        sinon.match({ dimensionFilterQl: 'name CONTAINS "adobe"' }),
      )).to.equal(true);
    });

    it('threads textFilter into source-domains as a domain CONTAINS clause', async () => {
      clients.sourceClient.sourceDomainsByTopicFTS.resolves({ sourceDomains: [] });
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt&textFilter=reddit');
      await handleTopicsResearchSourceDomains(sp, clients);
      expect(clients.sourceClient.sourceDomainsByTopicFTS.calledWith(
        sinon.match({ dimensionFilterQl: 'domain CONTAINS "reddit"' }),
      )).to.equal(true);
    });

    it('omits dimensionFilterQl when textFilter is absent', async () => {
      clients.promptClient.promptsByTopicFTS.resolves({ prompts: [] });
      clients.promptClient.promptsByTopicFTSTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      await handleTopicsResearchPrompts(sp, clients);
      const arg = clients.promptClient.promptsByTopicFTS.lastCall.args[0];
      expect(arg).to.not.have.property('dimensionFilterQl');
    });
  });

  describe('handleTopicsResearch', () => {
    it('returns 400 when search_query is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleTopicsResearch(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('single LLM returns topics', async () => {
      const topicData = {
        topics: [{
          id: '1', name: 'T1', volume: 100, promptsCount: 5,
        }],
      };
      clients.topicClient.topicsByFTS.callsFake(({ range }) => {
        if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
        return Promise.resolve(topicData);
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearch(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].topicId).to.equal('1');
    });

    it('single LLM throws when topicsByFTS list rejects', async () => {
      clients.topicClient.topicsByFTS.callsFake(({ range }) => {
        if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
        return Promise.reject(new Error('topics list down'));
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      try {
        await handleTopicsResearch(sp, clients);
        expect.fail('expected rejection');
      } catch (e) {
        expect(e.message).to.equal('topics list down');
      }
    });

    it('all LLMs fan-out deduplicates by topic id', async () => {
      clients.topicClient.topicsByFTS.callsFake(({ range }) => {
        if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
        return Promise.resolve({
          topics: [{
            id: 'same-id', name: 'Topic', volume: 100, promptsCount: 5,
          }],
        });
      });
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearch(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
    });

    it('all LLMs fan-out handles individual errors', async () => {
      clients.topicClient.topicsByFTS.rejects(new Error('fail'));
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearch(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('sorts merged results by relevance descending', async () => {
      clients.topicClient.topicsByFTS.callsFake(({ llm: l, range }) => {
        if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
        if (l === FTS_LLMS[0]) {
          return Promise.resolve({
            topics: [{
              id: '1', name: 'LowRelevance', volume: 500, promptsCount: 1, relevanceScore: 20,
            }],
          });
        }
        if (l === FTS_LLMS[1]) {
          return Promise.resolve({
            topics: [{
              id: '2', name: 'HighRelevance', volume: 50, promptsCount: 1, relevanceScore: 90,
            }],
          });
        }
        return Promise.resolve({ topics: [] });
      });
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearch(sp, clients);
      expect(res.body.data[0].topicId).to.equal('2');
    });

    it('sorts all-LLM merged topics by name when relevance ties', async () => {
      clients.topicClient.topicsByFTS.callsFake(({ range }) => {
        if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
        return Promise.resolve({
          topics: [
            { id: '1', name: 'Zebra', volume: 100, promptsCount: 1, relevanceScore: 50 },
            { id: '2', name: 'Alpha', volume: 100, promptsCount: 1, relevanceScore: 50 },
          ],
        });
      });
      const sp = new URLSearchParams('searchQuery=test&limit=10');
      const res = await handleTopicsResearch(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].topic).to.equal('Alpha');
      expect(res.body.data[1].topic).to.equal('Zebra');
    });

    it('does not expose internal sort keys in output', async () => {
      clients.topicClient.topicsByFTS.callsFake(({ range }) => {
        if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
        return Promise.resolve({
          topics: [{
            id: '1', name: 'T', volume: 100, promptsCount: 5,
          }],
        });
      });
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearch(sp, clients);
      expect(res.body.data[0]).to.not.have.property('volumeSortKey');
    });

    it('single LLM maps relevanceScore from gRPC field', async () => {
      clients.topicClient.topicsByFTS.callsFake(({ range }) => {
        if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
        return Promise.resolve({
          topics: [{
            id: '1', name: 'T', volume: 100, promptsCount: 5, relevanceScore: 72,
          }],
        });
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearch(sp, clients);
      expect(res.body.data[0].relevanceScore).to.equal(72);
    });

    it('single LLM defaults relevanceScore to 0 when absent', async () => {
      clients.topicClient.topicsByFTS.callsFake(({ range }) => {
        if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
        return Promise.resolve({
          topics: [{
            id: '1', name: 'T', volume: 100, promptsCount: 5,
          }],
        });
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearch(sp, clients);
      expect(res.body.data[0].relevanceScore).to.equal(0);
    });

    it('all LLMs keeps max relevanceScore when same topic_id appears from multiple LLMs', async () => {
      clients.topicClient.topicsByFTS.callsFake(({ llm: l, range }) => {
        if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
        if (l === FTS_LLMS[0]) {
          return Promise.resolve({
            topics: [{ id: 'x', name: 'T', volume: 100, promptsCount: 1, relevanceScore: 40 }],
          });
        }
        if (l === FTS_LLMS[1]) {
          return Promise.resolve({
            topics: [{ id: 'x', name: 'T', volume: 100, promptsCount: 1, relevanceScore: 85 }],
          });
        }
        return Promise.resolve({ topics: [] });
      });
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearch(sp, clients);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].relevanceScore).to.equal(85);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleTopicsStats                                                  */
  /* ------------------------------------------------------------------ */
  describe('handleTopicsStats', () => {
    it('returns 400 when topic_id is missing', async () => {
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleTopicsStats(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_topic_id');
    });

    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('topicId=123');
      const res = await handleTopicsStats(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_domain');
    });

    it('returns topic data when found', async () => {
      clients.topicClient.brandTopics.resolves({
        topics: [{
          id: '123', name: 'Topic', volume: 5000, mentions: 10,
        }],
      });
      const sp = new URLSearchParams('topicId=123&domain=example.com');
      const res = await handleTopicsStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].topicId).to.equal('123');
      expect(res.body.data[0].domain).to.equal('example.com');
    });

    it('returns empty data when topic is not found', async () => {
      clients.topicClient.brandTopics.resolves({
        topics: [{
          id: '999', name: 'Other', volume: 100, mentions: 1,
        }],
      });
      const sp = new URLSearchParams('topicId=123&domain=example.com');
      const res = await handleTopicsStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleTopicsResearchPrompts                                        */
  /* ------------------------------------------------------------------ */
  describe('handleTopicsResearchPrompts', () => {
    it('returns 400 when search_query is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('single LLM returns prompts', async () => {
      clients.promptClient.promptsByTopicFTSTotals.resolves({ total: 1 });
      clients.promptClient.promptsByTopicFTS.resolves({
        prompts: [{
          prompt: 'Q', promptHash: 'h', serpId: 's', topicName: 'T', topicId: '1', llm: 1, mentionedBrandsCount: 2, sourcesCount: 1, topicVolume: 5000,
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].engine).to.equal('chatgpt');
    });

    it('single LLM throws when promptsByTopicFTS rejects', async () => {
      clients.promptClient.promptsByTopicFTSTotals.resolves({ total: 0 });
      clients.promptClient.promptsByTopicFTS.rejects(new Error('fts down'));
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      try {
        await handleTopicsResearchPrompts(sp, clients);
        expect.fail('expected rejection');
      } catch (e) {
        expect(e.message).to.equal('fts down');
      }
    });

    it('single LLM uses total 0 when promptsByTopicFTSTotals rejects', async () => {
      clients.promptClient.promptsByTopicFTSTotals.rejects(new Error('tot down'));
      clients.promptClient.promptsByTopicFTS.resolves({
        prompts: [{
          prompt: 'Q', promptHash: 'h', serpId: 's', topicName: 'T', topicId: '1', llm: 1, mentionedBrandsCount: 2, sourcesCount: 1, topicVolume: 5000,
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(0);
      expect(res.body.data).to.have.length(1);
    });

    it('all LLMs fan-out with dedup/grouping', async () => {
      for (let i = 0; i < FTS_LLMS.length; i++) {
        const llm = FTS_LLMS[i];
        clients.promptClient.promptsByTopicFTSTotals.withArgs(sinon.match({ llm })).resolves({ total: 1 });
        clients.promptClient.promptsByTopicFTS.withArgs(sinon.match({ llm })).resolves({
          prompts: [{
            prompt: 'Same prompt', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', llm, mentionedBrandsCount: 2, sourcesCount: 1, topicVolume: 5000,
          }],
        });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(FTS_LLMS.length);
      res.body.data.forEach((d) => {
        expect(d).to.not.have.property('mentionSortKey');
        expect(d).to.not.have.property('promptNormKey');
      });
    });

    it('all LLMs handles errors gracefully', async () => {
      for (const llm of FTS_LLMS) {
        clients.promptClient.promptsByTopicFTSTotals.withArgs(sinon.match({ llm })).rejects(new Error('fail'));
        clients.promptClient.promptsByTopicFTS.withArgs(sinon.match({ llm })).rejects(new Error('fail'));
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('multi-engine groups exceeding FTS_LLMS length are skipped', async () => {
      const overSizeGroupSize = FTS_LLMS.length + 1;
      const prompts = Array.from({ length: overSizeGroupSize }, (_, i) => ({
        prompt: 'same prompt',
        promptHash: `h${i}`,
        serpId: `s${i}`,
        topicName: 'T',
        topicId: '1',
        llm: FTS_LLMS[0],
        mentionedBrandsCount: 5,
        sourcesCount: 1,
        topicVolume: 5000,
      }));
      clients.promptClient.promptsByTopicFTSTotals
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: overSizeGroupSize });
      clients.promptClient.promptsByTopicFTS
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ prompts });
      for (let i = 1; i < FTS_LLMS.length; i++) {
        clients.promptClient.promptsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.promptClient.promptsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('searchQuery=test&limit=5');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('single-engine groups are picked one row at a time', async () => {
      clients.promptClient.promptsByTopicFTSTotals
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 2 });
      clients.promptClient.promptsByTopicFTS
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
          prompts: [
            {
              prompt: 'A', promptHash: 'ha', serpId: 'sa', topicName: 'T', topicId: '1', llm: FTS_LLMS[0], mentionedBrandsCount: 1, sourcesCount: 1, topicVolume: 100,
            },
            {
              prompt: 'B', promptHash: 'hb', serpId: 'sb', topicName: 'T', topicId: '2', llm: FTS_LLMS[0], mentionedBrandsCount: 1, sourcesCount: 1, topicVolume: 200,
            },
          ],
        });
      for (let i = 1; i < FTS_LLMS.length; i++) {
        clients.promptClient.promptsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.promptClient.promptsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('searchQuery=test&limit=5');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data.length).to.equal(2);
    });

    it('multi-engine groups overflow into overflowCap', async () => {
      const promptData = (llm, engine) => ({
        prompt: 'multi engine prompt',
        promptHash: `h_${engine}`,
        serpId: `s_${engine}`,
        topicName: 'T',
        topicId: '1',
        llm,
        mentionedBrandsCount: 10,
        sourcesCount: 1,
        topicVolume: 9000,
      });
      for (let i = 0; i < FTS_LLMS.length; i++) {
        const llm = FTS_LLMS[i];
        clients.promptClient.promptsByTopicFTSTotals.withArgs(sinon.match({ llm })).resolves({ total: 1 });
        clients.promptClient.promptsByTopicFTS.withArgs(sinon.match({ llm })).resolves({
          prompts: [promptData(llm, `e${i}`)],
        });
      }
      const sp = new URLSearchParams('searchQuery=test&limit=2');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data.length).to.be.greaterThan(0);
    });

    it('handles raw.prompts being undefined in single LLM path', async () => {
      clients.promptClient.promptsByTopicFTSTotals.resolves({ total: 0 });
      clients.promptClient.promptsByTopicFTS.resolves({});
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('handles prompt with missing topicVolume and briefResponse', async () => {
      clients.promptClient.promptsByTopicFTSTotals.resolves({ total: 1 });
      clients.promptClient.promptsByTopicFTS.resolves({
        prompts: [{
          prompt: 'Q', llm: 1, mentionedBrandsCount: 1, sourcesCount: 1,
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.body.data[0]).to.not.have.property('topicVolume');
      expect(res.body.data[0]).to.not.have.property('responseExcerpt');
    });

    it('all LLMs with mixed prompts: some with hash/serpId, some without', async () => {
      clients.promptClient.promptsByTopicFTSTotals
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 2 });
      clients.promptClient.promptsByTopicFTS
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
          prompts: [
            {
              prompt: 'with hash', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', llm: FTS_LLMS[0], mentionedBrandsCount: 1, sourcesCount: 1, topicVolume: 5000,
            },
            {
              prompt: 'no hash', topicName: 'T', topicId: '2', llm: FTS_LLMS[0], mentionedBrandsCount: 1, sourcesCount: 1,
            },
          ],
        });
      for (let i = 1; i < FTS_LLMS.length; i++) {
        clients.promptClient.promptsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.promptClient.promptsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.body.data.length).to.equal(2);
    });

    it('all LLMs uses alternate dedupe key when promptHash set but serpId empty', async () => {
      clients.promptClient.promptsByTopicFTSTotals
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 1 });
      clients.promptClient.promptsByTopicFTS
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
          prompts: [{
            prompt: 'Alt key',
            promptHash: 'h1',
            serpId: '',
            topicName: 'T',
            topicId: '1',
            llm: FTS_LLMS[0],
            mentionedBrandsCount: 1,
            sourcesCount: 1,
            topicVolume: 5000,
          }],
        });
      for (let i = 1; i < FTS_LLMS.length; i++) {
        clients.promptClient.promptsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.promptClient.promptsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data.some((d) => d.prompt === 'Alt key')).to.equal(true);
    });

    it('all LLMs multi-engine group that fits exactly at limit', async () => {
      for (let i = 0; i < FTS_LLMS.length; i++) {
        const llm = FTS_LLMS[i];
        clients.promptClient.promptsByTopicFTSTotals.withArgs(sinon.match({ llm })).resolves({ total: 1 });
        clients.promptClient.promptsByTopicFTS.withArgs(sinon.match({ llm })).resolves({
          prompts: [{
            prompt: 'multi', promptHash: `h${i}`, serpId: `s${i}`, topicName: 'T', topicId: '1', llm, mentionedBrandsCount: 5, sourcesCount: 1, topicVolume: 9000,
          }],
        });
      }
      const sp = new URLSearchParams(`searchQuery=test&limit=${FTS_LLMS.length}`);
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data.length).to.equal(FTS_LLMS.length);
    });

    it('deduplicates by promptNorm key when promptHash is empty', async () => {
      clients.promptClient.promptsByTopicFTSTotals
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 2 });
      clients.promptClient.promptsByTopicFTS
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
          prompts: [
            {
              prompt: 'same', topicName: 'T', topicId: '1', llm: FTS_LLMS[0], mentionedBrandsCount: 1, sourcesCount: 1,
            },
            {
              prompt: 'same', topicName: 'T', topicId: '1', llm: FTS_LLMS[0], mentionedBrandsCount: 1, sourcesCount: 1,
            },
          ],
        });
      for (let i = 1; i < FTS_LLMS.length; i++) {
        clients.promptClient.promptsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.promptClient.promptsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.body.data).to.have.length(1);
    });

    it('multi-LLM same norm group sorts by raw prompt when mentions tie', async () => {
      clients.promptClient.promptsByTopicFTSTotals
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 2 });
      clients.promptClient.promptsByTopicFTS
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
          prompts: [
            {
              prompt: 'BetaCase',
              promptHash: 'hb',
              serpId: 'sb',
              topicName: 'T',
              topicId: '1',
              llm: FTS_LLMS[0],
              mentionedBrandsCount: 5,
              sourcesCount: 1,
              topicVolume: 5000,
            },
            {
              prompt: 'betacase',
              promptHash: 'ha',
              serpId: 'sa',
              topicName: 'T',
              topicId: '2',
              llm: FTS_LLMS[0],
              mentionedBrandsCount: 5,
              sourcesCount: 1,
              topicVolume: 5000,
            },
          ],
        });
      for (let i = 1; i < FTS_LLMS.length; i++) {
        clients.promptClient.promptsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.promptClient.promptsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('searchQuery=test&limit=10');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
    });

    it('multi-LLM groups.sort tie-breaks by norm when maxSort ties', async () => {
      clients.promptClient.promptsByTopicFTSTotals
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 2 });
      clients.promptClient.promptsByTopicFTS
        .withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
          prompts: [
            {
              prompt: null,
              promptHash: 'h1',
              serpId: 's1',
              topicName: 'T',
              topicId: '1',
              llm: FTS_LLMS[0],
              mentionedBrandsCount: 5,
              sourcesCount: 1,
              topicVolume: 5000,
            },
            {
              prompt: undefined,
              promptHash: 'h2',
              serpId: 's2',
              topicName: 'T',
              topicId: '2',
              llm: FTS_LLMS[0],
              mentionedBrandsCount: 5,
              sourcesCount: 1,
              topicVolume: 5000,
            },
          ],
        });
      clients.promptClient.promptsByTopicFTSTotals
        .withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({ total: 1 });
      clients.promptClient.promptsByTopicFTS
        .withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({
          prompts: [{
            prompt: 'ZebraNorm',
            promptHash: 'hz',
            serpId: 'sz',
            topicName: 'T',
            topicId: '3',
            llm: FTS_LLMS[1],
            mentionedBrandsCount: 5,
            sourcesCount: 1,
            topicVolume: 5000,
          }],
        });
      for (let i = 2; i < FTS_LLMS.length; i++) {
        clients.promptClient.promptsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.promptClient.promptsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('searchQuery=test&limit=10');
      const res = await handleTopicsResearchPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data.length).to.be.greaterThan(0);
    });

    /* ---- topicId path: promptsByTopicIDs (no searchQuery required) ---- */
    describe('with topicId (promptsByTopicIDs path)', () => {
      it('single LLM: fetches prompts for the topic without a searchQuery', async () => {
        clients.promptClient.promptsByTopicIDsTotal.resolves({ total: 3 });
        clients.promptClient.promptsByTopicIDs.resolves({
          prompts: [{
            prompt: 'Q', promptHash: 'h', serpId: 's', topicId: '42', llm: 1, mentionedBrandsCount: 2, sourcesCount: 1,
          }],
        });
        const sp = new URLSearchParams('topicId=42&engine=chatgpt');
        const res = await handleTopicsResearchPrompts(sp, clients);
        expect(res.status).to.equal(200);
        expect(res.body.total).to.equal(3);
        expect(res.body.data).to.have.length(1);
        expect(res.body.data[0].engine).to.equal('chatgpt');
        expect(res.body.data[0].topicId).to.equal('42');
        // No FTS call on the topicId path.
        expect(clients.promptClient.promptsByTopicFTS.called).to.equal(false);
        // topic_ids forwarded as bigint to both gRPC calls.
        expect(clients.promptClient.promptsByTopicIDs.firstCall.args[0].topicIds).to.deep.equal([42n]);
        expect(clients.promptClient.promptsByTopicIDsTotal.firstCall.args[0].topicIds).to.deep.equal([42n]);
      });

      it('omits topicName/topicVolume (not present in the ByTopicIDs response)', async () => {
        clients.promptClient.promptsByTopicIDsTotal.resolves({ total: 1 });
        clients.promptClient.promptsByTopicIDs.resolves({
          prompts: [{
            prompt: 'Q', promptHash: 'h', serpId: 's', topicId: '7', llm: 1, mentionedBrandsCount: 4, sourcesCount: 2, briefResponse: 'hi',
          }],
        });
        const sp = new URLSearchParams('topicId=7&engine=chatgpt');
        const res = await handleTopicsResearchPrompts(sp, clients);
        expect(res.body.data[0]).to.not.have.property('topic');
        expect(res.body.data[0]).to.not.have.property('topicVolume');
        expect(res.body.data[0].mentions).to.equal(4);
        expect(res.body.data[0].citedPages).to.equal(2);
        expect(res.body.data[0].responseExcerpt).to.equal('hi');
      });

      it('all engines: one LLM_ENUM.ALL call, server-side total (no per-engine fan-out)', async () => {
        clients.promptClient.promptsByTopicIDsTotal.resolves({ total: 12 });
        clients.promptClient.promptsByTopicIDs.resolves({
          prompts: [
            {
              prompt: 'P', promptHash: 'h1', serpId: 's1', topicId: '1', llm: FTS_LLMS[0], mentionedBrandsCount: 2, sourcesCount: 1,
            },
            {
              prompt: 'P', promptHash: 'h1', serpId: 's2', topicId: '1', llm: FTS_LLMS[1], mentionedBrandsCount: 3, sourcesCount: 0,
            },
          ],
        });
        const sp = new URLSearchParams('topicId=1');
        const res = await handleTopicsResearchPrompts(sp, clients);
        expect(res.status).to.equal(200);
        // A single aggregated call — not one per engine (which would break offset pagination).
        expect(clients.promptClient.promptsByTopicIDs.callCount).to.equal(1);
        expect(clients.promptClient.promptsByTopicIDs.firstCall.args[0].llm).to.equal(LLM_ENUM.ALL);
        expect(clients.promptClient.promptsByTopicIDsTotal.firstCall.args[0].llm).to.equal(LLM_ENUM.ALL);
        // Server-side total is passed through verbatim (not summed across per-LLM calls).
        expect(res.body.total).to.equal(12);
        expect(res.body.data).to.have.length(2);
      });

      it('accepts repeated topicIds and forwards all ids', async () => {
        clients.promptClient.promptsByTopicIDsTotal.resolves({ total: 0 });
        clients.promptClient.promptsByTopicIDs.resolves({ prompts: [] });
        const sp = new URLSearchParams('topicIds=1&topicIds=2&engine=chatgpt');
        const res = await handleTopicsResearchPrompts(sp, clients);
        expect(res.status).to.equal(200);
        expect(clients.promptClient.promptsByTopicIDs.firstCall.args[0].topicIds).to.deep.equal([1n, 2n]);
      });

      it('forwards a non-zero offset to the single backend call (page-2 pagination)', async () => {
        // Regression guard for the bug this fix targets: page 2 must reach the backend with the
        // requested offset on a single aggregated call (not a per-engine fan-out that empties it).
        clients.promptClient.promptsByTopicIDsTotal.resolves({ total: 18 });
        clients.promptClient.promptsByTopicIDs.resolves({ prompts: [] });
        const sp = new URLSearchParams('topicId=1&limit=10&offset=10');
        const res = await handleTopicsResearchPrompts(sp, clients);
        expect(res.status).to.equal(200);
        expect(clients.promptClient.promptsByTopicIDs.callCount).to.equal(1);
        expect(clients.promptClient.promptsByTopicIDs.firstCall.args[0].range).to.deep.equal({ limit: 10, offset: 10 });
        expect(res.body.offset).to.equal(10);
        expect(res.body.total).to.equal(18);
      });

      it('returns 400 for a non-numeric topicId', async () => {
        const sp = new URLSearchParams('topicId=abc');
        const res = await handleTopicsResearchPrompts(sp, clients);
        expect(res.status).to.equal(400);
        expect(res.body.error).to.equal('invalid_topic_ids');
        expect(clients.promptClient.promptsByTopicIDs.called).to.equal(false);
      });

      it('returns 400 invalid_sort_by for RELEVANCE_SCORE (not valid for topicId path)', async () => {
        const sp = new URLSearchParams('topicId=1&sortBy=RELEVANCE_SCORE');
        const res = await handleTopicsResearchPrompts(sp, clients);
        expect(res.status).to.equal(400);
        expect(res.body.error).to.equal('invalid_sort_by');
      });
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleTopicsResearchBrands                                         */
  /* ------------------------------------------------------------------ */
  describe('handleTopicsResearchBrands', () => {
    it('returns 400 when search_query is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('single LLM returns brands', async () => {
      clients.brandClient.brandsByTopicFTSTotals.resolves({ total: 1 });
      clients.brandClient.brandsByTopicFTS.resolves({
        brands: [{
          domain: 'brand.com', name: 'Brand', mentions: 10, sourceDomainsCount: 5, examplePrompt: 'Q?',
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].domain).to.equal('brand.com');
      expect(res.body.data[0].sourceDomainsCount).to.equal(5);
    });

    it('single LLM uses total 0 when brandsByTopicFTSTotals rejects', async () => {
      clients.brandClient.brandsByTopicFTSTotals.rejects(new Error('tot'));
      clients.brandClient.brandsByTopicFTS.resolves({
        brands: [{
          domain: 'brand.com', name: 'Brand', mentions: 10, sourceDomainsCount: 5, examplePrompt: 'Q?',
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(0);
    });

    it('single LLM throws when brandsByTopicFTS rejects', async () => {
      clients.brandClient.brandsByTopicFTSTotals.resolves({ total: 0 });
      clients.brandClient.brandsByTopicFTS.rejects(new Error('brands fts down'));
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      try {
        await handleTopicsResearchBrands(sp, clients);
        expect.fail('expected rejection');
      } catch (e) {
        expect(e.message).to.equal('brands fts down');
      }
    });

    it('all LLMs fan-out with aggregation', async () => {
      for (const llm of FTS_LLMS) {
        clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm })).resolves({ total: 1 });
        clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm })).resolves({
          brands: [{
            domain: 'brand.com', name: 'Brand', mentions: 5, sourceDomainsCount: 2, examplePrompt: 'Q?',
          }],
        });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].mentions).to.equal(5 * FTS_LLMS.length);
    });

    it('all LLMs handles errors gracefully', async () => {
      for (const llm of FTS_LLMS) {
        clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm })).rejects(new Error('fail'));
        clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm })).rejects(new Error('fail'));
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('aggregation fills name from later results if empty', async () => {
      clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 1 });
      clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
        brands: [{
          domain: 'brand.com', name: '', mentions: 5, sourceDomainsCount: 1,
        }],
      });
      clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({ total: 1 });
      clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({
        brands: [{
          domain: 'brand.com', name: 'Brand Name', mentions: 3, sourceDomainsCount: 2,
        }],
      });
      for (let i = 2; i < FTS_LLMS.length; i++) {
        clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ brands: [] });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.body.data[0].name).to.equal('Brand Name');
    });

    it('maps brand with null name', async () => {
      clients.brandClient.brandsByTopicFTSTotals.resolves({ total: 1 });
      clients.brandClient.brandsByTopicFTS.resolves({
        brands: [{
          domain: 'brand.com', name: null, mentions: 5, sourceDomainsCount: 2,
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.body.data[0].name).to.equal('');
    });

    it('handles raw.brands being undefined in single LLM path', async () => {
      clients.brandClient.brandsByTopicFTSTotals.resolves({ total: 0 });
      clients.brandClient.brandsByTopicFTS.resolves({});
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('handles raw.brands being undefined in all LLMs path', async () => {
      for (const llm of FTS_LLMS) {
        clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm })).resolves({ total: 0 });
        clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm })).resolves({});
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('skips brands with empty domain', async () => {
      for (const llm of FTS_LLMS) {
        clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm })).resolves({ total: 1 });
        clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm })).resolves({
          brands: [{
            domain: '', name: 'NoDomain', mentions: 5, sourceDomainsCount: 1,
          }],
        });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.body.data).to.have.length(0);
    });

    it('aggregation fills prompt_example from later results', async () => {
      clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 1 });
      clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
        brands: [{
          domain: 'brand.com', name: 'B', mentions: 1, sourceDomainsCount: 1, examplePrompt: '',
        }],
      });
      clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({ total: 1 });
      clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({
        brands: [{
          domain: 'brand.com', name: 'B', mentions: 1, sourceDomainsCount: 1, examplePrompt: 'Example Q',
        }],
      });
      for (let i = 2; i < FTS_LLMS.length; i++) {
        clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ brands: [] });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.body.data[0].promptExample).to.equal('Example Q');
    });

    it('all LLMs merged brands tie-break mentions by domain name', async () => {
      clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 1 });
      clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
        brands: [{ domain: 'zebra.com', name: 'Z', mentions: 5, sourceDomainsCount: 1 }],
      });
      clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({ total: 1 });
      clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({
        brands: [{ domain: 'alpha.com', name: 'A', mentions: 5, sourceDomainsCount: 1 }],
      });
      for (let i = 2; i < FTS_LLMS.length; i++) {
        clients.brandClient.brandsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.brandClient.brandsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ brands: [] });
      }
      const sp = new URLSearchParams('searchQuery=test&limit=10');
      const res = await handleTopicsResearchBrands(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].domain).to.equal('alpha.com');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleTopicsResearchSourceDomains                                  */
  /* ------------------------------------------------------------------ */
  describe('handleTopicsResearchSourceDomains', () => {
    it('returns 400 when search_query is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('single LLM returns source domains', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.resolves({
        sourceDomains: [{
          domain: 'src.com', sourcesCount: 3, mentions: 10, organicTraffic: 5000, examplePrompt: 'Q?',
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].sourceDomain).to.equal('src.com');
      expect(res.body.data[0].organicTraffic).to.equal(5000);
      expect(res.body.data[0].promptExample).to.equal('Q?');
    });

    it('single LLM uses total 0 when sourceDomainsByTopicFTSTotals rejects', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.rejects(new Error('tot'));
      clients.sourceClient.sourceDomainsByTopicFTS.resolves({
        sourceDomains: [{
          domain: 'src.com', sourcesCount: 3, mentions: 10, organicTraffic: 5000, examplePrompt: 'Q?',
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(0);
    });

    it('single LLM throws when sourceDomainsByTopicFTS rejects', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 0 });
      clients.sourceClient.sourceDomainsByTopicFTS.rejects(new Error('sd fts down'));
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      try {
        await handleTopicsResearchSourceDomains(sp, clients);
        expect.fail('expected rejection');
      } catch (e) {
        expect(e.message).to.equal('sd fts down');
      }
    });

    it('all LLMs fan-out with aggregation', async () => {
      for (const llm of FTS_LLMS) {
        clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm })).resolves({ total: 1 });
        clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm })).resolves({
          sourceDomains: [{
            domain: 'src.com', sourcesCount: 2, mentions: 3, organicTraffic: 100,
          }],
        });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].mentions).to.equal(3 * FTS_LLMS.length);
      expect(res.body.data[0].organicTraffic).to.equal(100 * FTS_LLMS.length);
    });

    it('all LLMs merged list sorts by mentions desc then sourcesCount desc', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 2 });
      clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
        sourceDomains: [
          { domain: 'a.com', sourcesCount: 2, mentions: 5 },
          { domain: 'b.com', sourcesCount: 5, mentions: 5 },
        ],
      });
      for (let i = 1; i < FTS_LLMS.length; i += 1) {
        clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ sourceDomains: [] });
      }
      const sp = new URLSearchParams('searchQuery=test&limit=10');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].sourceDomain).to.equal('b.com');
      expect(res.body.data[1].sourceDomain).to.equal('a.com');
    });

    it('all LLMs merged list tie-breaks by sourceDomain when mentions and sourcesCount tie', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 2 });
      clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
        sourceDomains: [
          { domain: 'z.com', sourcesCount: 1, mentions: 3 },
          { domain: 'a.com', sourcesCount: 1, mentions: 3 },
        ],
      });
      for (let i = 1; i < FTS_LLMS.length; i += 1) {
        clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ sourceDomains: [] });
      }
      const sp = new URLSearchParams('searchQuery=test&limit=10');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].sourceDomain).to.equal('a.com');
      expect(res.body.data[1].sourceDomain).to.equal('z.com');
    });

    it('all LLMs handles errors gracefully', async () => {
      for (const llm of FTS_LLMS) {
        clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm })).rejects(new Error('fail'));
        clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm })).rejects(new Error('fail'));
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('skips domains with empty domain field', async () => {
      for (const llm of FTS_LLMS) {
        clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm })).resolves({ total: 1 });
        clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm })).resolves({
          sourceDomains: [{ domain: '', sourcesCount: 1, mentions: 1 }],
        });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.body.data).to.have.length(0);
    });

    it('aggregation fills prompt_example from later results', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
        sourceDomains: [{ domain: 'src.com', sourcesCount: 1, mentions: 1 }],
      });
      clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({
        sourceDomains: [{
          domain: 'src.com', sourcesCount: 1, mentions: 1, examplePrompt: 'Prompt example',
        }],
      });
      for (let i = 2; i < FTS_LLMS.length; i++) {
        clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ sourceDomains: [] });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.body.data[0].promptExample).to.equal('Prompt example');
    });

    it('handles nested example with only text field', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.resolves({
        sourceDomains: [{
          domain: 'src.com', sourcesCount: 1, mentions: 1, example: { text: 'text prompt' },
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.body.data[0].promptExample).to.equal('text prompt');
    });

    it('handles nested example with examplePrompt field', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.resolves({
        sourceDomains: [{
          domain: 'src.com', sourcesCount: 1, mentions: 1, example: { examplePrompt: 'nested example' },
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.body.data[0].promptExample).to.equal('nested example');
    });

    it('handles nested example with all empty fields', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.resolves({
        sourceDomains: [{
          domain: 'src.com', sourcesCount: 1, mentions: 1, example: { prompt: '', text: '', examplePrompt: '' },
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.body.data[0]).to.not.have.property('promptExample');
    });

    it('handles array-shaped example (skipped)', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.resolves({
        sourceDomains: [{
          domain: 'src.com', sourcesCount: 1, mentions: 1, example: ['not', 'an', 'object'],
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.body.data[0]).to.not.have.property('promptExample');
    });

    it('handles null/non-object extractSourceDomainExamplePrompt', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.resolves({
        sourceDomains: [{ domain: 'src.com', sourcesCount: 1, mentions: 1 }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.body.data[0]).to.not.have.property('promptExample');
    });

    it('handles organic_traffic from nested example.prompt', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.resolves({
        sourceDomains: [{
          domain: 'src.com',
          sourcesCount: 1,
          mentions: 1,
          organicTraffic: null,
          example: { prompt: 'nested prompt' },
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.body.data[0]).to.not.have.property('organicTraffic');
      expect(res.body.data[0].promptExample).to.equal('nested prompt');
    });

    it('handles overallMentions fallback', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.resolves({
        sourceDomains: [{ domain: 'src.com', sourcesCount: 1, overallMentions: 42 }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.body.data[0].mentions).to.equal(42);
    });

    it('extracts promptExample from various proto fields', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.resolves({
        sourceDomains: [{
          domain: 'src.com', sourcesCount: 1, mentions: 1, promptExample: 'promptExample field',
        }],
      });
      const sp = new URLSearchParams('searchQuery=test&engine=chatgpt');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.body.data[0].promptExample).to.equal('promptExample field');
    });

    it('aggregation handles undefined organic_traffic on first and defined on second', async () => {
      clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[0] })).resolves({
        sourceDomains: [{ domain: 'src.com', sourcesCount: 1, mentions: 1 }],
      });
      clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({ total: 1 });
      clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[1] })).resolves({
        sourceDomains: [{
          domain: 'src.com', sourcesCount: 1, mentions: 1, organicTraffic: 500,
        }],
      });
      for (let i = 2; i < FTS_LLMS.length; i++) {
        clients.sourceClient.sourceDomainsByTopicFTSTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.sourceClient.sourceDomainsByTopicFTS.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ sourceDomains: [] });
      }
      const sp = new URLSearchParams('searchQuery=test');
      const res = await handleTopicsResearchSourceDomains(sp, clients);
      expect(res.body.data[0].organicTraffic).to.equal(500);
    });
  });

  describe('FTS topic row / distinct id paging helpers', () => {
    it('countTopicRowsByTopicsByFtsPaging respects maxPages when each page is full', async () => {
      const row = { name: 'n', volume: 1, promptsCount: 0 };
      clients.topicClient.topicsByFTS.resolves({
        topics: Array.from({ length: 1000 }, (_, i) => ({ ...row, id: String(i) })),
      });
      const total = await countTopicRowsByTopicsByFtsPaging(
        COUNTRY_ENUM.US,
        'energy',
        LLM_ENUM.CHAT_GPT,
        clients,
        { maxPages: 1 },
      );
      expect(total).to.equal(1000);
      expect(clients.topicClient.topicsByFTS.callCount).to.equal(1);
    });

    it('countDistinctTopicIdsAcrossFtsLlms returns 0 and skips gRPC when maxPages is 0', async () => {
      const n = await countDistinctTopicIdsAcrossFtsLlms(COUNTRY_ENUM.US, 'q', clients, { maxPages: 0 });
      expect(n).to.equal(0);
      expect(clients.topicClient.topicsByFTS.called).to.equal(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Sort param handling for the 4 FTS topic-research endpoints         */
  /* ------------------------------------------------------------------ */
  describe('FTS topic-research sort params', () => {
    // Captures the most recent `order` argument passed to the list-page call of a stubbed
    // gRPC method. Filters out the topicsByFTS paging helper (which always uses
    // `range.limit === 1000`) so single-engine assertions see the order the handler chose,
    // not the order the pagination probe hard-codes.
    function lastOrder(stub) {
      const call = stub.getCalls().find(
        (c) => c.args[0] && c.args[0].order && c.args[0].range?.limit !== 1000,
      );
      return call ? call.args[0].order : null;
    }

    // ---------------- handleTopicsResearch ----------------
    describe('handleTopicsResearch', () => {
      beforeEach(() => {
        clients.topicClient.topicsByFTS.callsFake(({ range }) => {
          if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
          return Promise.resolve({ topics: [] });
        });
      });

      it('single-engine: forwards default sortBy + DESC when params omitted', async () => {
        const sp = new URLSearchParams('searchQuery=q&engine=chatgpt');
        await handleTopicsResearch(sp, clients);
        const order = lastOrder(clients.topicClient.topicsByFTS);
        expect(order.by).to.equal(TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.RELEVANCE_SCORE);
        expect(order.direction).to.equal(ORDER_DIRECTION_ENUM.DESC);
      });

      it('single-engine: forwards VOLUME + ASC when explicitly requested', async () => {
        const sp = new URLSearchParams('searchQuery=q&engine=chatgpt&sortBy=VOLUME&sortDirection=ASC');
        await handleTopicsResearch(sp, clients);
        const order = lastOrder(clients.topicClient.topicsByFTS);
        expect(order.by).to.equal(TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.VOLUME);
        expect(order.direction).to.equal(ORDER_DIRECTION_ENUM.ASC);
      });

      it('all-engines: forwards order to every per-LLM call', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortBy=VOLUME&sortDirection=DESC');
        await handleTopicsResearch(sp, clients);
        for (const llm of FTS_LLMS) {
          const call = clients.topicClient.topicsByFTS.getCalls()
            .find((c) => c.args[0]?.llm === llm && c.args[0]?.range?.limit !== 1000);
          expect(call, `expected list-page call for llm ${llm}`).to.exist;
          expect(call.args[0].order.by).to.equal(TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.VOLUME);
          expect(call.args[0].order.direction).to.equal(ORDER_DIRECTION_ENUM.DESC);
        }
      });

      it('all-engines: merge comparator honours VOLUME sort', async () => {
        clients.topicClient.topicsByFTS.callsFake(({ range }) => {
          if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
          return Promise.resolve({
            topics: [
              { id: '1', name: 'A', volume: 10, promptsCount: 1, relevanceScore: 99 },
              { id: '2', name: 'B', volume: 500, promptsCount: 1, relevanceScore: 1 },
            ],
          });
        });
        const sp = new URLSearchParams('searchQuery=q&sortBy=VOLUME');
        const res = await handleTopicsResearch(sp, clients);
        expect(res.body.data[0].topicId).to.equal('2');
      });

      it('all-engines: ASC reverses the merge order', async () => {
        clients.topicClient.topicsByFTS.callsFake(({ range }) => {
          if (range?.limit === 1000) { return Promise.resolve({ topics: [] }); }
          return Promise.resolve({
            topics: [
              { id: '1', name: 'A', volume: 10, promptsCount: 1, relevanceScore: 99 },
              { id: '2', name: 'B', volume: 500, promptsCount: 1, relevanceScore: 1 },
            ],
          });
        });
        const sp = new URLSearchParams('searchQuery=q&sortBy=RELEVANCE_SCORE&sortDirection=ASC');
        const res = await handleTopicsResearch(sp, clients);
        expect(res.body.data[0].topicId).to.equal('2');
      });

      it('returns 400 invalid_sort_by for an unknown sortBy value', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortBy=BOGUS');
        const res = await handleTopicsResearch(sp, clients);
        expect(res.status).to.equal(400);
        expect(res.body.error).to.equal('invalid_sort_by');
      });

      it('returns 400 invalid_sort_direction for an unknown sortDirection value', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortDirection=SIDEWAYS');
        const res = await handleTopicsResearch(sp, clients);
        expect(res.status).to.equal(400);
        expect(res.body.error).to.equal('invalid_sort_direction');
      });
    });

    // ---------------- handleTopicsResearchPrompts ----------------
    describe('handleTopicsResearchPrompts', () => {
      beforeEach(() => {
        clients.promptClient.promptsByTopicFTSTotals.resolves({ total: 0 });
        clients.promptClient.promptsByTopicFTS.resolves({ prompts: [] });
      });

      it('single-engine: forwards default sortBy + DESC when params omitted', async () => {
        const sp = new URLSearchParams('searchQuery=q&engine=chatgpt');
        await handleTopicsResearchPrompts(sp, clients);
        const order = lastOrder(clients.promptClient.promptsByTopicFTS);
        expect(order.by).to.equal(PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONED_BRANDS_COUNT);
        expect(order.direction).to.equal(ORDER_DIRECTION_ENUM.DESC);
      });

      it('single-engine: forwards SOURCES_COUNT + ASC when explicitly requested', async () => {
        const sp = new URLSearchParams('searchQuery=q&engine=chatgpt&sortBy=SOURCES_COUNT&sortDirection=ASC');
        await handleTopicsResearchPrompts(sp, clients);
        const order = lastOrder(clients.promptClient.promptsByTopicFTS);
        expect(order.by).to.equal(PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.SOURCES_COUNT);
        expect(order.direction).to.equal(ORDER_DIRECTION_ENUM.ASC);
      });

      it('all-engines: forwards order to every per-LLM list call', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortBy=PROMPT&sortDirection=ASC');
        await handleTopicsResearchPrompts(sp, clients);
        for (const llm of FTS_LLMS) {
          const call = clients.promptClient.promptsByTopicFTS.getCalls()
            .find((c) => c.args[0]?.llm === llm);
          expect(call, `expected list call for llm ${llm}`).to.exist;
          expect(call.args[0].order.by).to.equal(PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.PROMPT);
          expect(call.args[0].order.direction).to.equal(ORDER_DIRECTION_ENUM.ASC);
        }
      });

      // Prompt names are intentionally chosen so the alphabetical tiebreak in the
      // merge-comparator (`cmpStr(a.norm, b.norm)`) DISAGREES with the SOURCES_COUNT
      // ordering: 'aaa low sources' would win alphabetically while 'zzz high sources'
      // must win on SOURCES_COUNT DESC. This way a regression that breaks the sort key
      // accessor (e.g. reading the wrong field name) would fall back to the alphabetical
      // tiebreak and flip the result, failing this test.
      it('all-engines: merge picker honours SOURCES_COUNT sort', async () => {
        clients.promptClient.promptsByTopicFTS.callsFake(({ llm }) => {
          if (llm === FTS_LLMS[0]) {
            return Promise.resolve({
              prompts: [{
                prompt: 'aaa low sources', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', mentionedBrandsCount: 99, sourcesCount: 1,
              }],
            });
          }
          if (llm === FTS_LLMS[1]) {
            return Promise.resolve({
              prompts: [{
                prompt: 'zzz high sources', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: '1', mentionedBrandsCount: 1, sourcesCount: 99,
              }],
            });
          }
          return Promise.resolve({ prompts: [] });
        });
        const sp = new URLSearchParams('searchQuery=q&sortBy=SOURCES_COUNT&limit=10');
        const res = await handleTopicsResearchPrompts(sp, clients);
        expect(res.body.data[0].prompt).to.equal('zzz high sources');
      });

      it('all-engines: PROMPT sort is lexicographic', async () => {
        clients.promptClient.promptsByTopicFTS.callsFake(({ llm }) => {
          if (llm === FTS_LLMS[0]) {
            return Promise.resolve({
              prompts: [{
                prompt: 'zebra question', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', mentionedBrandsCount: 5, sourcesCount: 5,
              }],
            });
          }
          if (llm === FTS_LLMS[1]) {
            return Promise.resolve({
              prompts: [{
                prompt: 'apple question', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: '1', mentionedBrandsCount: 5, sourcesCount: 5,
              }],
            });
          }
          return Promise.resolve({ prompts: [] });
        });
        const sp = new URLSearchParams('searchQuery=q&sortBy=PROMPT&sortDirection=ASC&limit=10');
        const res = await handleTopicsResearchPrompts(sp, clients);
        expect(res.body.data[0].prompt).to.equal('apple question');
      });

      it('all-engines: multi-engine duplicate rows still surface under the new sort', async () => {
        clients.promptClient.promptsByTopicFTS.callsFake(({ llm }) => {
          if (llm === FTS_LLMS[0]) {
            return Promise.resolve({
              prompts: [{
                prompt: 'shared prompt', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', mentionedBrandsCount: 4, sourcesCount: 7,
              }],
            });
          }
          if (llm === FTS_LLMS[1]) {
            return Promise.resolve({
              prompts: [{
                prompt: 'shared prompt', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: '1', mentionedBrandsCount: 6, sourcesCount: 3,
              }],
            });
          }
          return Promise.resolve({ prompts: [] });
        });
        const sp = new URLSearchParams('searchQuery=q&sortBy=SOURCES_COUNT&limit=10');
        const res = await handleTopicsResearchPrompts(sp, clients);
        const engines = res.body.data.filter((r) => r.prompt === 'shared prompt').map((r) => r.engine);
        expect(engines.length).to.be.greaterThan(1);
      });

      it('returns 400 invalid_sort_by for an unknown sortBy value', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortBy=BOGUS');
        const res = await handleTopicsResearchPrompts(sp, clients);
        expect(res.status).to.equal(400);
        expect(res.body.error).to.equal('invalid_sort_by');
      });

      it('returns 400 invalid_sort_direction for an unknown sortDirection value', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortDirection=SIDEWAYS');
        const res = await handleTopicsResearchPrompts(sp, clients);
        expect(res.status).to.equal(400);
        expect(res.body.error).to.equal('invalid_sort_direction');
      });
    });

    // ---------------- handleTopicsResearchBrands ----------------
    describe('handleTopicsResearchBrands', () => {
      beforeEach(() => {
        clients.brandClient.brandsByTopicFTSTotals.resolves({ total: 0 });
        clients.brandClient.brandsByTopicFTS.resolves({ brands: [] });
      });

      it('single-engine: forwards default sortBy + DESC when params omitted', async () => {
        const sp = new URLSearchParams('searchQuery=q&engine=chatgpt');
        await handleTopicsResearchBrands(sp, clients);
        const order = lastOrder(clients.brandClient.brandsByTopicFTS);
        expect(order.by).to.equal(BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONS);
        expect(order.direction).to.equal(ORDER_DIRECTION_ENUM.DESC);
      });

      it('single-engine: forwards NAME + ASC when explicitly requested', async () => {
        const sp = new URLSearchParams('searchQuery=q&engine=chatgpt&sortBy=NAME&sortDirection=ASC');
        await handleTopicsResearchBrands(sp, clients);
        const order = lastOrder(clients.brandClient.brandsByTopicFTS);
        expect(order.by).to.equal(BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.NAME);
        expect(order.direction).to.equal(ORDER_DIRECTION_ENUM.ASC);
      });

      it('all-engines: forwards order to every per-LLM list call', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortBy=SOURCES_COUNT&sortDirection=DESC');
        await handleTopicsResearchBrands(sp, clients);
        for (const llm of FTS_LLMS) {
          const call = clients.brandClient.brandsByTopicFTS.getCalls()
            .find((c) => c.args[0]?.llm === llm);
          expect(call, `expected list call for llm ${llm}`).to.exist;
          expect(call.args[0].order.by).to.equal(BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.SOURCES_COUNT);
          expect(call.args[0].order.direction).to.equal(ORDER_DIRECTION_ENUM.DESC);
        }
      });

      it('all-engines: merge comparator honours NAME sort ASC', async () => {
        clients.brandClient.brandsByTopicFTS.resolves({
          brands: [
            { domain: 'zebra.com', name: 'Zebra', mentions: 5, sourceDomainsCount: 1 },
            { domain: 'alpha.com', name: 'Alpha', mentions: 5, sourceDomainsCount: 1 },
          ],
        });
        const sp = new URLSearchParams('searchQuery=q&sortBy=NAME&sortDirection=ASC');
        const res = await handleTopicsResearchBrands(sp, clients);
        expect(res.body.data[0].name).to.equal('Alpha');
      });

      it('all-engines: SOURCES_COUNT sort ranks by sourceDomainsCount', async () => {
        clients.brandClient.brandsByTopicFTS.callsFake(({ llm }) => {
          if (llm === FTS_LLMS[0]) {
            return Promise.resolve({
              brands: [{ domain: 'a.com', name: 'A', mentions: 99, sourceDomainsCount: 1 }],
            });
          }
          if (llm === FTS_LLMS[1]) {
            return Promise.resolve({
              brands: [{ domain: 'b.com', name: 'B', mentions: 1, sourceDomainsCount: 99 }],
            });
          }
          return Promise.resolve({ brands: [] });
        });
        const sp = new URLSearchParams('searchQuery=q&sortBy=SOURCES_COUNT');
        const res = await handleTopicsResearchBrands(sp, clients);
        expect(res.body.data[0].domain).to.equal('b.com');
      });

      it('returns 400 invalid_sort_by for an unknown sortBy value', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortBy=BOGUS');
        const res = await handleTopicsResearchBrands(sp, clients);
        expect(res.status).to.equal(400);
        expect(res.body.error).to.equal('invalid_sort_by');
      });

      it('returns 400 invalid_sort_direction for an unknown sortDirection value', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortDirection=SIDEWAYS');
        const res = await handleTopicsResearchBrands(sp, clients);
        expect(res.status).to.equal(400);
        expect(res.body.error).to.equal('invalid_sort_direction');
      });
    });

    // ---------------- handleTopicsResearchSourceDomains ----------------
    describe('handleTopicsResearchSourceDomains', () => {
      beforeEach(() => {
        clients.sourceClient.sourceDomainsByTopicFTSTotals.resolves({ total: 0 });
        clients.sourceClient.sourceDomainsByTopicFTS.resolves({ sourceDomains: [] });
      });

      it('single-engine: forwards default sortBy + DESC when params omitted', async () => {
        const sp = new URLSearchParams('searchQuery=q&engine=chatgpt');
        await handleTopicsResearchSourceDomains(sp, clients);
        const order = lastOrder(clients.sourceClient.sourceDomainsByTopicFTS);
        expect(order.by).to.equal(SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONS);
        expect(order.direction).to.equal(ORDER_DIRECTION_ENUM.DESC);
      });

      it('single-engine: forwards ORGANIC_TRAFFIC + ASC when explicitly requested', async () => {
        const sp = new URLSearchParams('searchQuery=q&engine=chatgpt&sortBy=ORGANIC_TRAFFIC&sortDirection=ASC');
        await handleTopicsResearchSourceDomains(sp, clients);
        const order = lastOrder(clients.sourceClient.sourceDomainsByTopicFTS);
        expect(order.by).to.equal(SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.ORGANIC_TRAFFIC);
        expect(order.direction).to.equal(ORDER_DIRECTION_ENUM.ASC);
      });

      it('all-engines: forwards order to every per-LLM list call', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortBy=DOMAIN&sortDirection=ASC');
        await handleTopicsResearchSourceDomains(sp, clients);
        for (const llm of FTS_LLMS) {
          const call = clients.sourceClient.sourceDomainsByTopicFTS.getCalls()
            .find((c) => c.args[0]?.llm === llm);
          expect(call, `expected list call for llm ${llm}`).to.exist;
          expect(call.args[0].order.by).to.equal(SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.DOMAIN);
          expect(call.args[0].order.direction).to.equal(ORDER_DIRECTION_ENUM.ASC);
        }
      });

      it('all-engines: ORGANIC_TRAFFIC sort ranks by organicTraffic', async () => {
        clients.sourceClient.sourceDomainsByTopicFTS.callsFake(({ llm }) => {
          if (llm === FTS_LLMS[0]) {
            return Promise.resolve({
              sourceDomains: [{ domain: 'low.com', sourcesCount: 1, mentions: 1, organicTraffic: 100 }],
            });
          }
          if (llm === FTS_LLMS[1]) {
            return Promise.resolve({
              sourceDomains: [{ domain: 'high.com', sourcesCount: 1, mentions: 1, organicTraffic: 9999 }],
            });
          }
          return Promise.resolve({ sourceDomains: [] });
        });
        const sp = new URLSearchParams('searchQuery=q&sortBy=ORGANIC_TRAFFIC');
        const res = await handleTopicsResearchSourceDomains(sp, clients);
        expect(res.body.data[0].sourceDomain).to.equal('high.com');
      });

      it('all-engines: DOMAIN sort is lexicographic ASC', async () => {
        clients.sourceClient.sourceDomainsByTopicFTS.callsFake(({ llm }) => {
          if (llm === FTS_LLMS[0]) {
            return Promise.resolve({
              sourceDomains: [{ domain: 'zebra.com', sourcesCount: 1, mentions: 1 }],
            });
          }
          if (llm === FTS_LLMS[1]) {
            return Promise.resolve({
              sourceDomains: [{ domain: 'apple.com', sourcesCount: 1, mentions: 1 }],
            });
          }
          return Promise.resolve({ sourceDomains: [] });
        });
        const sp = new URLSearchParams('searchQuery=q&sortBy=DOMAIN&sortDirection=ASC');
        const res = await handleTopicsResearchSourceDomains(sp, clients);
        expect(res.body.data[0].sourceDomain).to.equal('apple.com');
      });

      it('returns 400 invalid_sort_by for an unknown sortBy value', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortBy=BOGUS');
        const res = await handleTopicsResearchSourceDomains(sp, clients);
        expect(res.status).to.equal(400);
        expect(res.body.error).to.equal('invalid_sort_by');
      });

      it('returns 400 invalid_sort_direction for an unknown sortDirection value', async () => {
        const sp = new URLSearchParams('searchQuery=q&sortDirection=SIDEWAYS');
        const res = await handleTopicsResearchSourceDomains(sp, clients);
        expect(res.status).to.equal(400);
        expect(res.body.error).to.equal('invalid_sort_direction');
      });
    });
  });
});
