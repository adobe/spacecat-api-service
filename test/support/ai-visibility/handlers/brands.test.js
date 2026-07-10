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

/* eslint-disable max-len, max-statements-per-line, object-curly-newline, no-plusplus, prefer-promise-reject-errors -- AI Visibility brands tests */

import { expect } from 'chai';
import sinon from 'sinon';
import { ConnectError, Code } from '@connectrpc/connect';
import { SOURCES_REQUEST_ORDER_BY_ENUM, DOMAINS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import { ORDER_DIRECTION_ENUM } from '@quazar/ai-seo-ts/common/types_pb.js';
import {
  handleBrandStats,
  handleBrandTopics,
  handleBrandPrompts,
  handleBrandCitedPages,
  handleBrandTopicOpportunities,
  handleBrandTopBrands,
  handleBrandCitedSources,
  handleBrandSourceOpportunities,
  handleBrandCompetitors,
  mapStatsByLLM,
  mapGrpcPromptToBrandPromptRow,
  citedPagesOwnedCountFromStatsByLlmForMonth,
} from '../../../../src/support/ai-visibility/handlers/brands.js';
import { FTS_LLMS, LLM_ENUM, COUNTRY_ENUM, brandTarget } from '../../../../src/support/ai-visibility/grpc-utils.js';

describe('AI Visibility – brands handlers', () => {
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
  /*  mapStatsByLLM (exported helper)                                    */
  /* ------------------------------------------------------------------ */
  describe('mapStatsByLLM', () => {
    it('returns empty top-level when data is empty', () => {
      const result = mapStatsByLLM({ llm: [] });
      expect(result.visibility).to.equal(0);
      expect(result.byDate).to.deep.equal([]);
    });

    it('maps LLM breakdown rows with dateRange', () => {
      const data = {
        llm: [
          {
            date: { year: 2026, month: 3 }, mentions: 10, ownedSources: 2, aiVisibility: 50, audience: 100, llm: undefined,
          },
          {
            date: { year: 2026, month: 3 }, mentions: 5, ownedSources: 1, aiVisibility: 25, audience: 50, llm: LLM_ENUM.CHAT_GPT,
          },
        ],
      };
      const dateRange = { from: { year: 2026, month: 3, day: 1 }, till: { year: 2026, month: 3, day: 1 } };
      const result = mapStatsByLLM(data, dateRange);
      expect(result.byDate).to.have.length(1);
      expect(result.visibility).to.equal(50);
      expect(result.mentions.chatgpt).to.equal(5);
    });

    it('maps LLM breakdown rows without dateRange (sorted by YM)', () => {
      const data = {
        llm: [
          {
            date: { year: 2026, month: 2 }, mentions: 3, ownedSources: 1, aiVisibility: 20, audience: 10,
          },
          {
            date: { year: 2026, month: 1 }, mentions: 1, ownedSources: 0, aiVisibility: 10, audience: 5,
          },
        ],
      };
      const result = mapStatsByLLM(data);
      expect(result.byDate).to.have.length(2);
      expect(result.byDate[0].month).to.equal(1);
      expect(result.byDate[1].month).to.equal(2);
    });

    it('skips rows with zero YM', () => {
      const data = { llm: [{ date: { year: 0, month: 0 } }] };
      const result = mapStatsByLLM(data);
      expect(result.byDate).to.have.length(0);
    });

    it('handles data.llm being undefined', () => {
      const result = mapStatsByLLM({});
      expect(result.byDate).to.deep.equal([]);
    });

    it('handles dateRange crossing year boundary', () => {
      const dateRange = { from: { year: 2025, month: 11, day: 1 }, till: { year: 2026, month: 2, day: 1 } };
      const result = mapStatsByLLM({ llm: [] }, dateRange);
      expect(result.byDate).to.have.length(4);
      expect(result.byDate[0].month).to.equal(11);
      expect(result.byDate[3].month).to.equal(2);
    });

    it('uses first slice entry when no aggregate row', () => {
      const data = {
        llm: [
          {
            date: { year: 2026, month: 5 }, mentions: 7, ownedSources: 2, aiVisibility: 30, audience: 15, llm: LLM_ENUM.GEMINI,
          },
        ],
      };
      const result = mapStatsByLLM(data);
      expect(result.byDate[0].aiVisibility).to.equal(30);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  mapGrpcPromptToBrandPromptRow (exported helper)                    */
  /* ------------------------------------------------------------------ */
  describe('mapGrpcPromptToBrandPromptRow', () => {
    it('maps all fields', () => {
      const p = {
        prompt: 'Test prompt',
        promptHash: '123',
        serpId: '456',
        topicName: 'Topic',
        topicId: '789',
        llm: LLM_ENUM.CHAT_GPT,
        mentionedBrandsCount: 3,
        sourcesCount: 5,
        topicVolume: 10000,
        briefResponse: 'excerpt...',
      };
      const row = mapGrpcPromptToBrandPromptRow(p, 'chatgpt', undefined);
      expect(row.prompt).to.equal('Test prompt');
      expect(row.promptHash).to.equal('123');
      expect(row.serpId).to.equal('456');
      expect(row.engine).to.equal('chatgpt');
      expect(row.topicVolume).to.equal(10000);
      expect(row.responseExcerpt).to.equal('excerpt...');
      expect(row.topicVolumeSortKey).to.equal(10000);
    });

    it('handles missing optional fields', () => {
      const p = { prompt: 'Q', llm: LLM_ENUM.GEMINI };
      const row = mapGrpcPromptToBrandPromptRow(p, null, undefined);
      expect(row.promptHash).to.equal('');
      expect(row.serpId).to.equal('');
      expect(row.engine).to.equal('gemini');
      expect(row).to.not.have.property('topicVolume');
      expect(row).to.not.have.property('responseExcerpt');
      expect(row.topicVolumeSortKey).to.equal(-1);
    });

    it('omits country when no country info available', () => {
      const p = { prompt: 'Q' };
      const row = mapGrpcPromptToBrandPromptRow(p, 'chatgpt', undefined);
      expect(row).to.not.have.property('country');
    });

    it('includes country when requestCountryGrpc is set', () => {
      const p = { prompt: 'Q' };
      const row = mapGrpcPromptToBrandPromptRow(p, 'chatgpt', 15);
      expect(row.country).to.equal('US');
    });

    it('uses mentionedBrands list length when larger than mentionedBrandsCount', () => {
      const p = { prompt: 'Q', mentionedBrandsCount: 1, mentionedBrands: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] };
      const row = mapGrpcPromptToBrandPromptRow(p, 'chatgpt', undefined);
      expect(row.mentions).to.equal(3);
    });

    it('handles topicVolume of empty string', () => {
      const p = { prompt: 'Q', topicVolume: '' };
      const row = mapGrpcPromptToBrandPromptRow(p, 'chatgpt', undefined);
      expect(row).to.not.have.property('topicVolume');
      expect(row.topicVolumeSortKey).to.equal(-1);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleBrandStats                                                   */
  /* ------------------------------------------------------------------ */
  describe('handleBrandStats', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleBrandStats(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_domain');
    });

    it('returns 200 with LLM data and by_country', async () => {
      clients.brandClient.statsByLLM.resolves({
        llm: [{
          date: { year: 2026, month: 5 }, mentions: 10, ownedSources: 2, aiVisibility: 50, audience: 100,
        }],
      });
      clients.brandClient.statsByCountry.resolves({
        byCountry: [
          {
            country: 15, mentions: 5, audience: 10, ownedSources: 1,
          },
          {
            country: 14, mentions: 0, audience: 0, ownedSources: 0,
          },
        ],
      });
      const sp = new URLSearchParams('domain=example.com&windowMonths=2');
      const res = await handleBrandStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.byCountry).to.have.length(1);
      expect(res.body.byDate).to.be.an('array');
    });

    it('uses explicit month param for date range', async () => {
      clients.brandClient.statsByLLM.resolves({ llm: [] });
      clients.brandClient.statsByCountry.resolves({ byCountry: [] });
      const sp = new URLSearchParams('domain=example.com&month=2026-03');
      const res = await handleBrandStats(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('clamps window_months between 1 and 6', async () => {
      clients.brandClient.statsByLLM.resolves({ llm: [] });
      clients.brandClient.statsByCountry.resolves({ byCountry: [] });
      const sp = new URLSearchParams('domain=example.com&windowMonths=99');
      const res = await handleBrandStats(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('handles byCountry being undefined', async () => {
      clients.brandClient.statsByLLM.resolves({ llm: [] });
      clients.brandClient.statsByCountry.resolves({});
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandStats(sp, clients);
      expect(res.body.byCountry).to.deep.equal([]);
    });

    it('falls back through country mapping chain to String(country)', async () => {
      clients.brandClient.statsByLLM.resolves({ llm: [] });
      clients.brandClient.statsByCountry.resolves({
        byCountry: [{
          country: 99999, mentions: 1, audience: 0, ownedSources: 0,
        }],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandStats(sp, clients);
      expect(res.body.byCountry[0].country).to.equal('99999');
    });

    it('uses empty byCountry when statsByCountry rejects', async () => {
      clients.brandClient.statsByLLM.resolves({ llm: [] });
      clients.brandClient.statsByCountry.rejects(new Error('down'));
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandStats(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.byCountry).to.deep.equal([]);
    });

    it('throws when statsByLLM rejects', async () => {
      clients.brandClient.statsByLLM.rejects(new Error('llm down'));
      clients.brandClient.statsByCountry.resolves({ byCountry: [] });
      const sp = new URLSearchParams('domain=example.com');
      try {
        await handleBrandStats(sp, clients);
        expect.fail('expected rejection');
      } catch (e) {
        expect(e.message).to.equal('llm down');
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleBrandTopics                                                  */
  /* ------------------------------------------------------------------ */
  describe('handleBrandTopics', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleBrandTopics(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 200 with topics list', async () => {
      clients.topicClient.brandTopics.resolves({
        topics: [{
          name: 'AI SEO', id: '1', volume: 5000, mentions: 10,
        }],
      });
      clients.topicClient.brandTopicsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].engine).to.equal('all');
      expect(res.body.total).to.equal(1);
    });

    it('passes engine filter when provided', async () => {
      clients.topicClient.brandTopics.resolves({ topics: [] });
      clients.topicClient.brandTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopics(sp, clients);
      expect(res.status).to.equal(200);
      expect(clients.topicClient.brandTopics.firstCall.args[0]).to.have.property('llm');
    });

    it('handles raw.topics being undefined', async () => {
      clients.topicClient.brandTopics.resolves({});
      clients.topicClient.brandTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopics(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('maps engine slug when engine is provided with data', async () => {
      clients.topicClient.brandTopics.resolves({
        topics: [{ name: 'T', id: '1', volume: 100, mentions: 5 }],
      });
      clients.topicClient.brandTopicsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopics(sp, clients);
      expect(res.body.data[0].engine).to.equal('chatgpt');
    });

    it('uses total 0 when brandTopicsTotals rejects', async () => {
      clients.topicClient.brandTopics.resolves({ topics: [{ name: 'T', id: '1', volume: 100, mentions: 5 }] });
      clients.topicClient.brandTopicsTotals.rejects(new Error('totals down'));
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(0);
    });

    it('throws when brandTopics rejects', async () => {
      clients.topicClient.brandTopics.rejects(new Error('topics down'));
      clients.topicClient.brandTopicsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com');
      try {
        await handleBrandTopics(sp, clients);
        expect.fail('expected rejection');
      } catch (e) {
        expect(e.message).to.equal('topics down');
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleBrandPrompts                                                 */
  /* ------------------------------------------------------------------ */
  describe('handleBrandPrompts', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 400 for invalid topicIds', async () => {
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt&topicIds=0%20OR%201%3D1');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('invalid_topic_ids');
      expect(clients.promptClient.prompts.called).to.be.false;
    });

    it('returns 400 when topicIds exceed cap', async () => {
      const params = new URLSearchParams('domain=example.com&engine=chatgpt');
      for (let i = 0; i <= 50; i += 1) {
        params.append('topicIds', String(i));
      }
      const res = await handleBrandPrompts(params, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('topic_ids_limit_exceeded');
    });

    it('single LLM path returns data', async () => {
      clients.promptClient.promptsTotals.resolves({ total: 1 });
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q', promptHash: 'h', serpId: 's', topicName: 'T', topicId: '1', mentionedBrandsCount: 2, sourcesCount: 1, topicVolume: 100,
        }],
      });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0]).to.not.have.property('topicVolumeSortKey');
    });

    it('throws when single-LLM prompts call rejects', async () => {
      clients.promptClient.promptsTotals.resolves({ total: 1 });
      clients.promptClient.prompts.rejects(new Error('prompts fail'));
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      try {
        await handleBrandPrompts(sp, clients);
        expect.fail('expected rejection');
      } catch (e) {
        expect(e.message).to.equal('prompts fail');
      }
    });

    it('single LLM path passes topic_ids filter', async () => {
      clients.promptClient.promptsTotals.resolves({ total: 0 });
      clients.promptClient.prompts.resolves({ prompts: [] });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt&topicIds=111&topicIds=222');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(200);
      const call = clients.promptClient.prompts.firstCall.args[0];
      expect(call.dimensionFilterQl).to.include('topic_hash = 111');
      expect(call.dimensionFilterQl).to.include('OR');
    });

    it('single LLM path passes single topic_ids filter', async () => {
      clients.promptClient.promptsTotals.resolves({ total: 0 });
      clients.promptClient.prompts.resolves({ prompts: [] });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt&topicIds=111');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(200);
      const call = clients.promptClient.prompts.firstCall.args[0];
      expect(call.dimensionFilterQl).to.equal('topic_hash = 111');
    });

    it('all-LLM fan-out path with dedup/merge', async () => {
      for (const llm of FTS_LLMS) {
        clients.promptClient.promptsTotals.withArgs(sinon.match({ llm })).resolves({ total: 1 });
        clients.promptClient.prompts.withArgs(sinon.match({ llm })).resolves({
          prompts: [{
            prompt: 'Same prompt', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', mentionedBrandsCount: 1, sourcesCount: 1, topicVolume: 5000, llm,
          }],
        });
      }
      const sp = new URLSearchParams('domain=example.com&limit=10');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(FTS_LLMS.length);
      expect(res.body.data.length).to.be.greaterThan(0);
      res.body.data.forEach((d) => expect(d).to.not.have.property('topicVolumeSortKey'));
    });

    it('all-LLM fan-out handles gRPC errors gracefully', async () => {
      for (const llm of FTS_LLMS) {
        clients.promptClient.promptsTotals.withArgs(sinon.match({ llm })).rejects(new Error('gRPC fail'));
        clients.promptClient.prompts.withArgs(sinon.match({ llm })).rejects(new Error('gRPC fail'));
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('all-LLM fan-out passes topic_ids filter', async () => {
      for (const llm of FTS_LLMS) {
        clients.promptClient.promptsTotals.withArgs(sinon.match({ llm })).resolves({ total: 0 });
        clients.promptClient.prompts.withArgs(sinon.match({ llm })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('domain=example.com&topicIds=111');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('single LLM handles raw.prompts undefined', async () => {
      clients.promptClient.promptsTotals.resolves({ total: 0 });
      clients.promptClient.prompts.resolves({});
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('all-LLM dedup uses prompt norm key when no hash/serpId', async () => {
      for (const llm of FTS_LLMS) {
        clients.promptClient.promptsTotals.withArgs(sinon.match({ llm })).resolves({ total: 1 });
        clients.promptClient.prompts.withArgs(sinon.match({ llm })).resolves({
          prompts: [{
            prompt: 'Same prompt', topicName: 'T', topicId: '1', mentionedBrandsCount: 1, sourcesCount: 1, topicVolume: 100, llm,
          }],
        });
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data.length).to.be.greaterThan(0);
    });

    it('all-LLM with listResults[i].prompts undefined', async () => {
      for (const llm of FTS_LLMS) {
        clients.promptClient.promptsTotals.withArgs(sinon.match({ llm })).resolves({ total: 0 });
        clients.promptClient.prompts.withArgs(sinon.match({ llm })).resolves({});
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('all-LLM sort tiebreaker by prompt then engine', async () => {
      const llm = FTS_LLMS[0];
      clients.promptClient.promptsTotals.resolves({ total: 2 });
      clients.promptClient.prompts.resolves({
        prompts: [
          {
            prompt: 'B', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', mentionedBrandsCount: 1, sourcesCount: 1, topicVolume: 100, llm,
          },
          {
            prompt: 'A', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: '2', mentionedBrandsCount: 1, sourcesCount: 1, topicVolume: 100, llm,
          },
        ],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].prompt).to.equal('A');
    });

    it('all-LLM handles prompt with null fields', async () => {
      const llm = FTS_LLMS[0];
      clients.promptClient.promptsTotals.resolves({ total: 1 });
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: null, promptHash: null, serpId: null, topicName: 'T', topicId: null, mentionedBrandsCount: 0, sourcesCount: 0, topicVolume: null, llm,
        }],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('all-LLM sort tiebreaker: same _tv, different prompt text', async () => {
      const llm0 = FTS_LLMS[0];
      const llm1 = FTS_LLMS[1];
      clients.promptClient.promptsTotals.resolves({ total: 2 });
      clients.promptClient.prompts.withArgs(sinon.match({ llm: llm0 })).resolves({
        prompts: [{ prompt: 'B prompt', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', mentionedBrandsCount: 1, sourcesCount: 1, topicVolume: 100, llm: llm0 }],
      });
      clients.promptClient.prompts.withArgs(sinon.match({ llm: llm1 })).resolves({
        prompts: [{ prompt: 'A prompt', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: '2', mentionedBrandsCount: 1, sourcesCount: 1, topicVolume: 100, llm: llm1 }],
      });
      for (let i = 2; i < FTS_LLMS.length; i++) {
        clients.promptClient.promptsTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.promptClient.prompts.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.body.data[0].prompt).to.equal('A prompt');
    });

    it('all-LLM sort final tiebreaker by engine', async () => {
      const llm0 = FTS_LLMS[0];
      const llm1 = FTS_LLMS[1];
      clients.promptClient.promptsTotals.resolves({ total: 2 });
      clients.promptClient.prompts.withArgs(sinon.match({ llm: llm0 })).resolves({
        prompts: [{ prompt: 'Same', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', mentionedBrandsCount: 1, sourcesCount: 1, topicVolume: 100, llm: llm0 }],
      });
      clients.promptClient.prompts.withArgs(sinon.match({ llm: llm1 })).resolves({
        prompts: [{ prompt: 'Same', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: '2', mentionedBrandsCount: 1, sourcesCount: 1, topicVolume: 100, llm: llm1 }],
      });
      for (let i = 2; i < FTS_LLMS.length; i++) {
        clients.promptClient.promptsTotals.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ total: 0 });
        clients.promptClient.prompts.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandPrompts(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(2);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleBrandCitedPages                                              */
  /* ------------------------------------------------------------------ */
  describe('handleBrandCitedPages', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 200 with cited pages', async () => {
      clients.sourceClient.sources.resolves({ source: [{ url: 'https://example.com/page', promptsCount: 3 }] });
      clients.voSourcesClient.sourcesTotals.resolves({ totals: [{ category: 1, count: 10 }] });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].pageUrl).to.equal('https://example.com/page');
      expect(res.body.total).to.equal(10);
    });

    it('defaults order to PROMPTS_COUNT DESC when no sort params', async () => {
      clients.sourceClient.sources.resolves({ source: [] });
      clients.voSourcesClient.sourcesTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com');
      await handleBrandCitedPages(sp, clients);
      expect(clients.sourceClient.sources.firstCall.args[0].order).to.deep.equal({
        by: SOURCES_REQUEST_ORDER_BY_ENUM.PROMPTS_COUNT,
        direction: ORDER_DIRECTION_ENUM.DESC,
      });
    });

    it('maps sortBy/sortDirection into the gRPC order (URL ASC)', async () => {
      clients.sourceClient.sources.resolves({ source: [] });
      clients.voSourcesClient.sourcesTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com&sortBy=URL&sortDirection=ASC');
      await handleBrandCitedPages(sp, clients);
      expect(clients.sourceClient.sources.firstCall.args[0].order).to.deep.equal({
        by: SOURCES_REQUEST_ORDER_BY_ENUM.URL,
        direction: ORDER_DIRECTION_ENUM.ASC,
      });
    });

    it('falls back to default order.by for an unknown sortBy', async () => {
      clients.sourceClient.sources.resolves({ source: [] });
      clients.voSourcesClient.sourcesTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com&sortBy=BOGUS');
      await handleBrandCitedPages(sp, clients);
      expect(clients.sourceClient.sources.firstCall.args[0].order.by)
        .to.equal(SOURCES_REQUEST_ORDER_BY_ENUM.PROMPTS_COUNT);
    });

    it('uses month param and falls back when targetDate fails', async () => {
      clients.sourceClient.sources.onFirstCall().rejects(new Error('targetDate fail'));
      clients.sourceClient.sources.onSecondCall().resolves({ source: [{ url: 'https://example.com/p', promptsCount: 1 }] });
      clients.brandClient.statsByLLM.rejects(new Error('statsByLLM fail'));
      clients.voSourcesClient.sourcesTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com&month=2026-03');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('handles monthYm with successful statsByLLM for total', async () => {
      clients.sourceClient.sources.resolves({ source: [] });
      clients.brandClient.statsByLLM.resolves({
        llm: [{
          date: { year: 2026, month: 3 }, ownedSources: 42, mentions: 1, aiVisibility: 10, audience: 5,
        }],
      });
      const sp = new URLSearchParams('domain=example.com&month=2026-03');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(42);
    });

    it('handles monthYm with statsByLLM returning zero cited_pages → uses that value', async () => {
      clients.sourceClient.sources.resolves({ source: [] });
      clients.brandClient.statsByLLM.resolves({ llm: [] });
      clients.voSourcesClient.sourcesTotals.resolves({ totals: [{ category: 1, count: 7 }] });
      const sp = new URLSearchParams('domain=example.com&month=2026-03');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(0);
    });

    it('handles monthYm with statsByLLM failing → voSourcesClient fallback', async () => {
      clients.sourceClient.sources.resolves({ source: [] });
      clients.brandClient.statsByLLM.rejects(new Error('statsByLLM fail'));
      clients.voSourcesClient.sourcesTotals.resolves({ totals: [{ category: 1, count: 7 }] });
      const sp = new URLSearchParams('domain=example.com&month=2026-03');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(7);
    });

    it('handles monthYm with both fallbacks failing', async () => {
      clients.sourceClient.sources.resolves({ source: [] });
      clients.brandClient.statsByLLM.rejects(new Error('fail'));
      clients.voSourcesClient.sourcesTotals.rejects(new Error('fail'));
      const sp = new URLSearchParams('domain=example.com&month=2026-03');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(0);
    });

    it('filters out sources with empty page_url', async () => {
      clients.sourceClient.sources.resolves({ source: [{ url: '', promptsCount: 1 }, { url: '  ', promptsCount: 1 }] });
      clients.voSourcesClient.sourcesTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(0);
    });

    it('uses engine query parameter', async () => {
      clients.sourceClient.sources.resolves({ source: [] });
      clients.voSourcesClient.sourcesTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('uses voSourcesClient when no monthYm', async () => {
      clients.sourceClient.sources.resolves({ source: [] });
      clients.voSourcesClient.sourcesTotals.rejects(new Error('fail'));
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(0);
    });

    it('falls back to cp.all when llmEnum slug is not in breakdown', async () => {
      clients.sourceClient.sources.resolves({ source: [] });
      clients.brandClient.statsByLLM.resolves({
        llm: [{
          date: { year: 2026, month: 3 }, ownedSources: 15, mentions: 1, aiVisibility: 10, audience: 5,
        }],
      });
      const sp = new URLSearchParams('domain=example.com&month=2026-03&engine=perplexity');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(15);
    });

    it('citedPagesOwnedCount uses cp.all when llm has no UI slug', async () => {
      clients.brandClient.statsByLLM.resolves({
        llm: [{
          date: { year: 2026, month: 3 }, ownedSources: 77, mentions: 1, aiVisibility: 10, audience: 5,
        }],
      });
      const val = await citedPagesOwnedCountFromStatsByLlmForMonth(
        COUNTRY_ENUM.US,
        brandTarget('example.com'),
        { year: 2026, month: 3 },
        LLM_ENUM.UNSPECIFIED,
        clients,
      );
      expect(val).to.equal(77);
    });

    it('throws when sources call fails without targetDate', async () => {
      clients.sourceClient.sources.rejects(new Error('sources fail'));
      clients.brandClient.statsByLLM.resolves({ llm: [] });
      clients.voSourcesClient.sourcesTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com');
      try {
        await handleBrandCitedPages(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e.message).to.equal('sources fail');
      }
    });

    it('handles source with null url', async () => {
      clients.sourceClient.sources.resolves({ source: [{ url: null, promptsCount: 1 }] });
      clients.voSourcesClient.sourcesTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.body.data).to.have.length(0);
    });

    it('uses specific engine with monthYm and statsByLLM', async () => {
      clients.sourceClient.sources.resolves({ source: [] });
      clients.brandClient.statsByLLM.resolves({
        llm: [
          {
            date: { year: 2026, month: 3 }, ownedSources: 10, mentions: 1, aiVisibility: 10, audience: 5,
          },
          {
            date: { year: 2026, month: 3 }, ownedSources: 7, mentions: 1, aiVisibility: 5, audience: 2, llm: LLM_ENUM.CHAT_GPT,
          },
        ],
      });
      const sp = new URLSearchParams('domain=example.com&month=2026-03&engine=chatgpt');
      const res = await handleBrandCitedPages(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(7);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleBrandTopicOpportunities                                      */
  /* ------------------------------------------------------------------ */
  describe('handleBrandTopicOpportunities', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('single LLM path filters by topic volume >= 5000', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [
          {
            prompt: 'High vol', promptHash: 'h1', serpId: 's1', topicName: 'T1', topicId: '1', topicVolume: 10000, mentionedBrandsCount: 3, sourcesCount: 1,
          },
          {
            prompt: 'Low vol', promptHash: 'h2', serpId: 's2', topicName: 'T2', topicId: '2', topicVolume: 1000, mentionedBrandsCount: 1, sourcesCount: 1,
          },
        ],
      });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].prompt).to.equal('High vol');
    });

    it('all-LLM fan-out path', async () => {
      for (const llm of FTS_LLMS) {
        clients.promptClient.prompts.withArgs(sinon.match({ llm })).resolves({
          prompts: [{
            prompt: 'Big topic', promptHash: 'h', serpId: 's', topicName: 'T', topicId: '1', topicVolume: 7000, mentionedBrandsCount: 5, sourcesCount: 1, llm,
          }],
        });
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data.length).to.be.greaterThan(0);
    });

    it('single LLM handles prompts fetch error gracefully', async () => {
      clients.promptClient.prompts.rejects(new Error('gRPC fail'));
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('deduplicates prompts by promptHash+serpId key', async () => {
      const prompt = {
        prompt: 'Dup', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', topicVolume: 6000, mentionedBrandsCount: 2, sourcesCount: 1,
      };
      clients.promptClient.prompts.resolves({ prompts: [prompt, prompt] });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
    });

    it('deduplicates by normalized prompt when hash/serpId are empty', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [
          {
            prompt: 'Same query', topicName: 'T', topicId: '1', topicVolume: 8000, mentionedBrandsCount: 1, sourcesCount: 1,
          },
          {
            prompt: 'Same query', topicName: 'T', topicId: '1', topicVolume: 8000, mentionedBrandsCount: 1, sourcesCount: 1,
          },
        ],
      });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
    });

    it('sorts opportunities by mentions desc, topic_volume desc', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [
          {
            prompt: 'A', promptHash: 'a', serpId: 'a', topicName: 'T', topicId: '1', topicVolume: 9000, mentionedBrandsCount: 1, sourcesCount: 1,
          },
          {
            prompt: 'B', promptHash: 'b', serpId: 'b', topicName: 'T', topicId: '2', topicVolume: 9000, mentionedBrandsCount: 5, sourcesCount: 1,
          },
        ],
      });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.body.data[0].prompt).to.equal('B');
    });

    it('sort tiebreaker: same mentions and volume, sorts by prompt then engine', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [
          {
            prompt: 'B prompt', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', topicVolume: 6000, mentionedBrandsCount: 3, sourcesCount: 1,
          },
          {
            prompt: 'A prompt', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: '2', topicVolume: 6000, mentionedBrandsCount: 3, sourcesCount: 1,
          },
        ],
      });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.body.data[0].prompt).to.equal('A prompt');
    });

    it('all-LLM dedup with perLlmArrays element undefined', async () => {
      for (const llm of FTS_LLMS) {
        clients.promptClient.prompts.withArgs(sinon.match({ llm })).rejects(new Error('fail'));
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('paginates through multiple pages of prompts', async () => {
      const bigBatch = Array.from({ length: 100 }, (_, i) => ({
        prompt: `P${i}`,
        promptHash: `h${i}`,
        serpId: `s${i}`,
        topicName: 'T',
        topicId: '1',
        topicVolume: 6000,
        mentionedBrandsCount: 2,
        sourcesCount: 1,
      }));
      clients.promptClient.prompts.resolves({ prompts: bigBatch });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('dedup with null prompt fields in opportunity merge', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [
          {
            prompt: null, topicName: 'T', topicId: null, topicVolume: 7000, mentionedBrandsCount: 1, sourcesCount: 1,
          },
        ],
      });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('topic opportunities merge uses norm key when serpId is absent', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Only hash', promptHash: 'hx', topicName: 'T', topicId: '1', topicVolume: 6000, mentionedBrandsCount: 2, sourcesCount: 1,
        }],
      });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('handles raw.prompts undefined in fetch', async () => {
      clients.promptClient.prompts.resolves({});
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('opportunity sort tiebreaker: same mentions same volume, by prompt', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [
          { prompt: 'B', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', topicVolume: 6000, mentionedBrandsCount: 3, sourcesCount: 1 },
          { prompt: 'A', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: '2', topicVolume: 6000, mentionedBrandsCount: 3, sourcesCount: 1 },
        ],
      });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.body.data[0].prompt).to.equal('A');
    });

    it('opportunity sort final tiebreaker: same prompt, by engine', async () => {
      const llm0 = FTS_LLMS[0];
      const llm1 = FTS_LLMS[1];
      clients.promptClient.prompts.withArgs(sinon.match({ llm: llm0 })).resolves({
        prompts: [{ prompt: 'Same', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', topicVolume: 6000, mentionedBrandsCount: 3, sourcesCount: 1, llm: llm0 }],
      });
      clients.promptClient.prompts.withArgs(sinon.match({ llm: llm1 })).resolves({
        prompts: [{ prompt: 'Same', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: '2', topicVolume: 6000, mentionedBrandsCount: 3, sourcesCount: 1, llm: llm1 }],
      });
      for (let i = 2; i < FTS_LLMS.length; i++) {
        clients.promptClient.prompts.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('dedupe merge inner sort: same volume, null prompts, tie-break by engine', async () => {
      const llm0 = FTS_LLMS[0];
      const llm1 = FTS_LLMS[1];
      clients.promptClient.prompts.withArgs(sinon.match({ llm: llm0 })).resolves({
        prompts: [{
          prompt: undefined, promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', topicVolume: 6000, mentionedBrandsCount: 3, sourcesCount: 1, llm: llm0,
        }],
      });
      clients.promptClient.prompts.withArgs(sinon.match({ llm: llm1 })).resolves({
        prompts: [{
          prompt: null, promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: '2', topicVolume: 6000, mentionedBrandsCount: 3, sourcesCount: 1, llm: llm1,
        }],
      });
      for (let i = 2; i < FTS_LLMS.length; i++) {
        clients.promptClient.prompts.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data.length).to.equal(2);
    });

    it('dedupe merge inner sort: same volume, different prompts, tie-break by localeCompare', async () => {
      const llm0 = FTS_LLMS[0];
      const llm1 = FTS_LLMS[1];
      clients.promptClient.prompts.withArgs(sinon.match({ llm: llm0 })).resolves({
        prompts: [{
          prompt: 'Beta', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: '1', topicVolume: 6000, mentionedBrandsCount: 3, sourcesCount: 1, llm: llm0,
        }],
      });
      clients.promptClient.prompts.withArgs(sinon.match({ llm: llm1 })).resolves({
        prompts: [{
          prompt: 'Alpha', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: '2', topicVolume: 6000, mentionedBrandsCount: 3, sourcesCount: 1, llm: llm1,
        }],
      });
      for (let i = 2; i < FTS_LLMS.length; i++) {
        clients.promptClient.prompts.withArgs(sinon.match({ llm: FTS_LLMS[i] })).resolves({ prompts: [] });
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopicOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].prompt).to.equal('Alpha');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleBrandTopBrands                                               */
  /* ------------------------------------------------------------------ */
  describe('handleBrandTopBrands', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('sorts by name ascending when sortBy=NAME&sortDirection=ASC', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Zebra', count: 10 }, { brandName: 'Apple', count: 100 }],
      });
      const sp = new URLSearchParams('domain=example.com&sortBy=NAME&sortDirection=ASC');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.body.data.map((r) => r.name)).to.deep.equal(['Apple', 'Zebra']);
    });

    it('sorts by mentions ascending when sortDirection=ASC (default sortBy)', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Big', count: 100 }, { brandName: 'Small', count: 1 }],
      });
      const sp = new URLSearchParams('domain=example.com&sortDirection=ASC');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.body.data.map((r) => r.name)).to.deep.equal(['Small', 'Big']);
    });

    it('fetches the full set (not a truncated window) for NAME sort with an offset', async () => {
      clients.brandClient.topBrandsByDomain.resolves({ brands: [] });
      await handleBrandTopBrands(new URLSearchParams('domain=example.com&sortBy=NAME&offset=10&limit=10'), clients);
      // NAME order differs from the client's native mentions-desc, so the whole set
      // must be fetched before sorting+slicing — otherwise page 2 slices a wrong subset.
      expect(clients.brandClient.topBrandsByDomain.firstCall.args[0].limit).to.equal(1000);
    });

    it('uses a truncated fetch window for the default mentions-desc order with an offset', async () => {
      clients.brandClient.topBrandsByDomain.resolves({ brands: [] });
      await handleBrandTopBrands(new URLSearchParams('domain=example.com&offset=10&limit=10'), clients);
      expect(clients.brandClient.topBrandsByDomain.firstCall.args[0].limit).to.equal(21);
    });

    it('returns 200 with brands list', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'BrandA', count: 100 }],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].name).to.equal('BrandA');
    });

    it('omits country field when region is worldwide', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Acme', count: 10 }],
      });
      const sp = new URLSearchParams('domain=www.example.com&region=WW');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0]).to.not.have.property('country');
    });

    it('uses llm=ALL fallback then fan-out on error', async () => {
      clients.brandClient.topBrandsByDomain.withArgs(sinon.match({ llm: LLM_ENUM.ALL })).rejects(new Error('not supported'));
      for (const llm of FTS_LLMS) {
        clients.brandClient.topBrandsByDomain.withArgs(sinon.match({ llm })).resolves({
          brands: [{ brandName: 'Merged', count: 50 }],
        });
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data.length).to.be.greaterThan(0);
    });

    it('filters out brands with empty names', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: '', count: 10 }, { brandName: 'Valid', count: 5 }],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.body.data).to.have.length(1);
    });

    it('uses specific engine when provided', async () => {
      clients.brandClient.topBrandsByDomain.resolves({ brands: [] });
      const sp = new URLSearchParams('domain=example.com&engine=gemini');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.status).to.equal(200);
      expect(clients.brandClient.topBrandsByDomain.firstCall.args[0]).to.have.property('llm');
    });

    it('handles www. prefix in domain', async () => {
      clients.brandClient.topBrandsByDomain.resolves({ brands: [] });
      const sp = new URLSearchParams('domain=www.example.com');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.status).to.equal(200);
      expect(clients.brandClient.topBrandsByDomain.firstCall.args[0].brandDomain).to.equal('example.com');
    });

    it('paginates correctly with offset', async () => {
      const brands = Array.from({ length: 5 }, (_, i) => ({ brandName: `Brand${i}`, count: 100 - i }));
      clients.brandClient.topBrandsByDomain.resolves({ brands });
      const sp = new URLSearchParams('domain=example.com&offset=2&limit=2');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.body.data).to.have.length(2);
      expect(res.body.total).to.equal(5);
    });

    it('fan-out individual LLM errors are caught', async () => {
      clients.brandClient.topBrandsByDomain.withArgs(sinon.match({ llm: LLM_ENUM.ALL })).rejects(new Error('fail'));
      for (const llm of FTS_LLMS) {
        clients.brandClient.topBrandsByDomain.withArgs(sinon.match({ llm })).rejects(new Error('fail'));
      }
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('handles raw.brands being undefined', async () => {
      clients.brandClient.topBrandsByDomain.resolves({});
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('sorts tiebreaker by name when mentions are equal', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Zebra', count: 100 }, { brandName: 'Apple', count: 100 }],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandTopBrands(sp, clients);
      expect(res.body.data[0].name).to.equal('Apple');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleBrandCitedSources                                            */
  /* ------------------------------------------------------------------ */
  describe('handleBrandCitedSources', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleBrandCitedSources(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('maps sortBy/sortDirection into the gRPC order (default PROMPTS_COUNT DESC; DOMAIN ASC)', async () => {
      clients.sourceClient.sourceDomains.resolves({ domains: [] });
      clients.voSourcesClient.domainsTotals.resolves({ totals: [] });
      await handleBrandCitedSources(new URLSearchParams('domain=example.com'), clients);
      expect(clients.sourceClient.sourceDomains.firstCall.args[0].order).to.deep.equal({
        by: DOMAINS_REQUEST_ORDER_BY_ENUM.PROMPTS_COUNT,
        direction: ORDER_DIRECTION_ENUM.DESC,
      });
      clients.sourceClient.sourceDomains.resetHistory();
      await handleBrandCitedSources(new URLSearchParams('domain=example.com&sortBy=DOMAIN&sortDirection=ASC'), clients);
      expect(clients.sourceClient.sourceDomains.firstCall.args[0].order).to.deep.equal({
        by: DOMAINS_REQUEST_ORDER_BY_ENUM.DOMAIN,
        direction: ORDER_DIRECTION_ENUM.ASC,
      });
    });

    it('returns 200 with domains list', async () => {
      clients.sourceClient.sourceDomains.resolves({
        domains: [{
          domain: 'www.source.com', sourcesCount: 5, promptsCount: 3, mentions: 10,
        }],
      });
      clients.voSourcesClient.domainsTotals.resolves({ totals: [{ count: 20 }] });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCitedSources(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].sourceDomain).to.equal('source.com');
      expect(res.body.total).to.equal(20);
    });

    it('handles domainsTotals rejection gracefully', async () => {
      clients.sourceClient.sourceDomains.resolves({
        domains: [{
          domain: 'a.com', sourcesCount: 1, promptsCount: 1, mentions: 1,
        }],
      });
      clients.voSourcesClient.domainsTotals.rejects(new Error('fail'));
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCitedSources(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(1);
    });

    it('throws when list call fails', async () => {
      clients.sourceClient.sourceDomains.rejects(new Error('gRPC fail'));
      clients.voSourcesClient.domainsTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com');
      try {
        await handleBrandCitedSources(sp, clients);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e.message).to.equal('gRPC fail');
      }
    });

    it('includes organic_traffic when present', async () => {
      clients.sourceClient.sourceDomains.resolves({
        domains: [{
          domain: 'test.com', sourcesCount: 1, promptsCount: 1, mentions: 1, organicTraffic: 5000,
        }],
      });
      clients.voSourcesClient.domainsTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCitedSources(sp, clients);
      expect(res.body.data[0].organicTraffic).to.equal(5000);
    });

    it('excludes organic_traffic when NaN/Infinity', async () => {
      clients.sourceClient.sourceDomains.resolves({
        domains: [{
          domain: 'test.com', sourcesCount: 1, promptsCount: 1, mentions: 1, organicTraffic: Infinity,
        }],
      });
      clients.voSourcesClient.domainsTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCitedSources(sp, clients);
      expect(res.body.data[0]).to.not.have.property('organicTraffic');
    });

    it('filters out empty source_domain entries', async () => {
      clients.sourceClient.sourceDomains.resolves({
        domains: [{
          domain: '', sourcesCount: 1, promptsCount: 1, mentions: 1,
        }],
      });
      clients.voSourcesClient.domainsTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCitedSources(sp, clients);
      expect(res.body.data).to.have.length(0);
    });

    it('includes country from source domain field', async () => {
      clients.sourceClient.sourceDomains.resolves({
        domains: [{
          domain: 'test.com', sourcesCount: 1, promptsCount: 1, mentions: 1, country: 15,
        }],
      });
      clients.voSourcesClient.domainsTotals.resolves({ totals: [] });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCitedSources(sp, clients);
      expect(res.body.data[0]).to.have.property('country');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleBrandSourceOpportunities                                     */
  /* ------------------------------------------------------------------ */
  describe('handleBrandSourceOpportunities', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('maps sortBy/sortDirection into the gap gRPC order (default ORGANIC_TRAFFIC DESC; MENTIONS ASC)', async () => {
      clients.brandClient.topBrandsByDomain.resolves({ brands: [] });
      clients.sourceClient.gapSourceDomains.resolves({ domains: [] });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      await handleBrandSourceOpportunities(new URLSearchParams('domain=example.com'), clients);
      expect(clients.sourceClient.gapSourceDomains.firstCall.args[0].order).to.deep.equal({
        by: DOMAINS_REQUEST_ORDER_BY_ENUM.ORGANIC_TRAFFIC,
        direction: ORDER_DIRECTION_ENUM.DESC,
      });
      clients.sourceClient.gapSourceDomains.resetHistory();
      await handleBrandSourceOpportunities(new URLSearchParams('domain=example.com&sortBy=MENTIONS&sortDirection=ASC'), clients);
      expect(clients.sourceClient.gapSourceDomains.firstCall.args[0].order).to.deep.equal({
        by: DOMAINS_REQUEST_ORDER_BY_ENUM.MENTIONS,
        direction: ORDER_DIRECTION_ENUM.ASC,
      });
    });

    it('returns 200 with gap source domains', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp1', count: 10 }],
      });
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: 'gap.com', sourcesCount: 2, promptsCount: 3, targetMentions: 5, organicTraffic: 1000,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 10 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].sourceDomain).to.equal('gap.com');
    });

    it('skips unusable competitor names when building competitors list', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [
          { brandName: '   ', count: 1 },
          { brandName: 'GoodComp', count: 5 },
        ],
      });
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{ domain: 'gap.com', sourcesCount: 1, promptsCount: 1, targetMentions: 1 }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
    });

    it('returns empty when competitors list is empty and gap kinds need competitors', async () => {
      clients.brandClient.topBrandsByDomain.resolves({ brands: [] });
      const sp = new URLSearchParams('domain=example.com&gapKinds=MISSING');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('NotFound gRPC error returns empty results', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.rejects(new ConnectError('not found', Code.NotFound));
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('rethrows non-NotFound errors', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.rejects(new Error('internal error'));
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com');
      try {
        await handleBrandSourceOpportunities(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e.message).to.equal('internal error');
      }
    });

    it('handles gap_snapshot_date param', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.resolves({ domains: [] });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&gapSnapshotDate=2026-03-15');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('handles custom gap_kinds param', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.resolves({ domains: [] });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&gapKinds=SHARED,WEAK');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('strips www. from source domains', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: 'www.stripped.com', sourcesCount: 1, promptsCount: 1, targetMentions: 1,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.body.data[0].sourceDomain).to.equal('stripped.com');
    });

    it('filters out focal brand from competitors', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'example', count: 100 }, { brandName: 'Other', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.resolves({ domains: [] });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('handles topBrandsByDomain failure gracefully', async () => {
      clients.brandClient.topBrandsByDomain.rejects(new Error('fail'));
      const sp = new URLSearchParams('domain=example.com&gapKinds=MISSING');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('handles totals rejection with floor fallback', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{
          domain: 'a.com', sourcesCount: 1, promptsCount: 1, targetMentions: 1,
        }],
      });
      clients.sourceClient.gapSourceDomainsTotals.rejects(new Error('fail'));
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.total).to.equal(1);
    });

    it('gap kind ALL (1) does not need competitors', async () => {
      clients.brandClient.topBrandsByDomain.resolves({ brands: [] });
      clients.sourceClient.gapSourceDomains.resolves({ domains: [] });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&gapKinds=ALL');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('detects NotFound via message pattern when not ConnectError', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      const err = new Error('Code: NotFound - no data');
      clients.sourceClient.gapSourceDomains.rejects(err);
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.deep.equal([]);
    });

    it('detects NotFound via \\bNotFound\\b regex', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.rejects(new Error('NotFound'));
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('handles rejection with reason object lacking message', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      const reason = { code: 'SOME_CODE' };
      clients.sourceClient.gapSourceDomains.returns(Promise.reject(reason));
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com');
      try {
        await handleBrandSourceOpportunities(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e).to.equal(reason);
      }
    });

    it('handles null rejection reason', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.returns(Promise.reject(null));
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com');
      try {
        await handleBrandSourceOpportunities(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e).to.be.null;
      }
    });

    it('handles rawResult.domains being undefined', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.resolves({});
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('falls back to hostname then host in domain chain', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [
          { hostname: 'hname.com', sourcesCount: 1, promptsCount: 1, targetMentions: 1 },
          { host: 'h.com', sourcesCount: 1, promptsCount: 1, targetMentions: 1 },
          { sourcesCount: 1, promptsCount: 1, targetMentions: 1 },
        ],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 3 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.body.data[0].sourceDomain).to.equal('hname.com');
      expect(res.body.data[1].sourceDomain).to.equal('h.com');
      expect(res.body.data).to.have.length(2);
    });

    it('falls back to mentions when targetMentions is null', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{ domain: 'a.com', sourcesCount: 1, promptsCount: 1, mentions: 7, country: 15 }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.body.data[0].mentions).to.equal(7);
      expect(res.body.data[0]).to.have.property('country');
    });

    it('falls back to 0 when both targetMentions and mentions null', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: 'Comp', count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.resolves({
        domains: [{ domain: 'a.com', sourcesCount: 1, promptsCount: 1 }],
      });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 1 });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.body.data[0].mentions).to.equal(0);
    });

    it('handles topRaw.brands being undefined when fetching competitors', async () => {
      clients.brandClient.topBrandsByDomain.resolves({});
      clients.sourceClient.gapSourceDomains.resolves({ domains: [] });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&gapKinds=ALL');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('handles brandName being falsy in competitors filter', async () => {
      clients.brandClient.topBrandsByDomain.resolves({
        brands: [{ brandName: '', count: 10 }, { count: 5 }],
      });
      clients.sourceClient.gapSourceDomains.resolves({ domains: [] });
      clients.sourceClient.gapSourceDomainsTotals.resolves({ total: 0 });
      const sp = new URLSearchParams('domain=example.com&gapKinds=ALL');
      const res = await handleBrandSourceOpportunities(sp, clients);
      expect(res.status).to.equal(200);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handleBrandCompetitors                                             */
  /* ------------------------------------------------------------------ */
  describe('handleBrandCompetitors', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleBrandCompetitors(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 200 with competitors list', async () => {
      clients.competitorClient.brandCompetitors.resolves({
        competitors: [{ domain: 'comp.com', name: 'Comp' }],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCompetitors(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].domain).to.equal('comp.com');
    });

    it('uses count param clamped between 1 and 20', async () => {
      clients.competitorClient.brandCompetitors.resolves({ competitors: [] });
      const sp = new URLSearchParams('domain=example.com&count=50');
      await handleBrandCompetitors(sp, clients);
      expect(clients.competitorClient.brandCompetitors.firstCall.args[0].count).to.equal(20);
    });

    it('handles empty count string', async () => {
      clients.competitorClient.brandCompetitors.resolves({ competitors: [] });
      const sp = new URLSearchParams('domain=example.com&count=');
      await handleBrandCompetitors(sp, clients);
      expect(clients.competitorClient.brandCompetitors.firstCall.args[0]).to.not.have.property('count');
    });

    it('uses domain as fallback name', async () => {
      clients.competitorClient.brandCompetitors.resolves({
        competitors: [{ domain: 'comp.com' }],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCompetitors(sp, clients);
      expect(res.body.data[0].name).to.equal('comp.com');
    });

    it('handles raw.competitors being undefined', async () => {
      clients.competitorClient.brandCompetitors.resolves({});
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCompetitors(sp, clients);
      expect(res.body.data).to.deep.equal([]);
    });

    it('handles competitor with missing domain and name', async () => {
      clients.competitorClient.brandCompetitors.resolves({
        competitors: [{}],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleBrandCompetitors(sp, clients);
      expect(res.body.data[0].domain).to.equal('');
      expect(res.body.data[0].name).to.equal('');
    });
  });
});
