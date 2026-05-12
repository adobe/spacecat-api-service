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
import {
  handlePromptsResponses,
  handlePromptsResponsesLatest,
} from '../../../../src/support/ai-visibility/handlers/prompts.js';

describe('AI Visibility – prompts handlers', () => {
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
  /*  handlePromptsResponses                                             */
  /* ------------------------------------------------------------------ */
  describe('handlePromptsResponses', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_domain');
    });

    it('returns 200 with relations data', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Test prompt',
          promptHash: 'h1',
          serpId: 's1',
          topicName: 'Topic',
          topicId: 't1',
          llm: 1,
          mentionedBrandsCount: 2,
          sourcesCount: 3,
          briefResponse: 'excerpt',
        }],
      });
      clients.prRelationsClient.prompt.resolves({
        value: {
          response: 'Full response',
          sources: [{ url: 'https://source.com' }],
          mentionedBrands: [{ name: 'BrandA' }],
        },
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].response).to.equal('Full response');
      expect(res.body.data[0].citedPages).to.have.length(1);
      expect(res.body.data[0].mentionedBrands).to.have.length(1);
      expect(res.body.data[0].responseExcerpt).to.equal('excerpt');
    });

    it('treats rejected relation fetch as empty relation payload', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h1',
          serpId: 's1',
          topicName: 'T',
          topicId: 't1',
          llm: 1,
          mentionedBrandsCount: 1,
          sourcesCount: 1,
          briefResponse: 'fallback text',
        }],
      });
      clients.prRelationsClient.prompt.rejects(new Error('upstream'));
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].response).to.equal('fallback text');
      expect(res.body.data[0].citedPages).to.deep.equal([]);
    });

    it('handles prompt filter', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [
          {
            prompt: 'best seo tools for 2026', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: 't1', llm: 1, mentionedBrandsCount: 1, sourcesCount: 1,
          },
          {
            prompt: 'weather forecast', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: 't2', llm: 1, mentionedBrandsCount: 1, sourcesCount: 1,
          },
        ],
      });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com&prompt=best+seo+tools+for+2026');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(1);
      expect(res.body.total).to.equal(1);
    });

    it('skips relation fetch when promptHash/serpId/topicId missing', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0,
        }],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].response).to.equal('');
      expect(res.body.data[0].citedPages).to.deep.equal([]);
      expect(clients.prRelationsClient.prompt.called).to.be.false;
    });

    it('falls back to briefResponse when relation value is null', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicId: 't',
          topicName: 'T',
          llm: 1,
          mentionedBrandsCount: 0,
          sourcesCount: 0,
          briefResponse: 'brief',
        }],
      });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].response).to.equal('brief');
    });

    it('paginates correctly with offset and limit', async () => {
      const prompts = Array.from({ length: 5 }, (_, i) => ({
        prompt: `P${i}`,
        promptHash: `h${i}`,
        serpId: `s${i}`,
        topicName: 'T',
        topicId: `t${i}`,
        llm: 1,
        mentionedBrandsCount: 0,
        sourcesCount: 0,
      }));
      clients.promptClient.prompts.resolves({ prompts });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com&offset=2&limit=2');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data).to.have.length(2);
      expect(res.body.total).to.equal(5);
      expect(res.body.data[0].prompt).to.equal('P2');
    });

    it('handles raw.prompts being undefined', async () => {
      clients.promptClient.prompts.resolves({});
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data).to.deep.equal([]);
      expect(res.body.total).to.equal(0);
    });

    it('handles p.llm being 0/undefined (falls back to query llm)', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicId: 't',
          topicName: 'T',
          llm: 0,
          mentionedBrandsCount: 0,
          sourcesCount: 0,
        }],
      });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com&engine=chatgpt');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].engine).to.be.a('string');
    });

    it('handles p.promptHash/serpId/topicId being null', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: null,
          serpId: null,
          topicId: null,
          topicName: 'T',
          llm: 1,
          mentionedBrandsCount: 0,
          sourcesCount: 0,
          briefResponse: 'b',
        }],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].promptHash).to.equal('');
      expect(res.body.data[0].serpId).to.equal('');
      expect(res.body.data[0].topicId).to.equal('');
    });

    it('handles rel?.response being null (falls to briefResponse)', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicId: 't',
          topicName: 'T',
          llm: 1,
          mentionedBrandsCount: 0,
          sourcesCount: 0,
          briefResponse: 'brief text',
        }],
      });
      clients.prRelationsClient.prompt.resolves({
        value: { response: null, sources: [], mentionedBrands: [] },
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].response).to.equal('brief text');
    });

    it('handles briefResponse being null', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicId: 't',
          topicName: 'T',
          llm: 1,
          mentionedBrandsCount: 0,
          sourcesCount: 0,
        }],
      });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].response).to.equal('');
      expect(res.body.data[0].responseExcerpt).to.equal('');
    });

    it('handles empty mentionedBrands in relation', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicId: 't',
          topicName: 'T',
          llm: 1,
          mentionedBrandsCount: 0,
          sourcesCount: 0,
        }],
      });
      clients.prRelationsClient.prompt.resolves({
        value: { response: 'R', sources: [], mentionedBrands: [{ name: '' }, { domain: 'brand.com' }] },
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].mentionedBrands).to.deep.equal(['brand.com']);
    });

    it('handles non-array sources in relation', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicId: 't',
          topicName: 'T',
          llm: 1,
          mentionedBrandsCount: 0,
          sourcesCount: 0,
        }],
      });
      clients.prRelationsClient.prompt.resolves({
        value: { response: 'R', sources: 'not-an-array' },
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].citedPages).to.deep.equal([]);
    });

    it('handles empty prompt filter returning all prompts', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [
          {
            prompt: 'A', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: 't1', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0,
          },
          {
            prompt: 'B', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: 't2', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0,
          },
        ],
      });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com&prompt=');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data).to.have.length(2);
    });

    it('relation with null mentionedBrands', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicId: 't',
          topicName: 'T',
          llm: 1,
          mentionedBrandsCount: 0,
          sourcesCount: 0,
        }],
      });
      clients.prRelationsClient.prompt.resolves({
        value: { response: 'R', sources: [], mentionedBrands: null },
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].mentionedBrands).to.deep.equal([]);
    });

    it('uses prompt llm for relation request when available', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q',
          promptHash: 'h',
          serpId: 's',
          topicId: 't',
          topicName: 'T',
          llm: 4,
          mentionedBrandsCount: 0,
          sourcesCount: 0,
        }],
      });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com');
      await handlePromptsResponses(sp, clients);
      expect(clients.prRelationsClient.prompt.firstCall.args[0].llm).to.equal(4);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handlePromptsResponsesLatest                                       */
  /* ------------------------------------------------------------------ */
  describe('handlePromptsResponsesLatest', () => {
    it('returns 400 when params are missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handlePromptsResponsesLatest(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_params');
    });

    it('returns 400 when only prompt_hash is provided', async () => {
      const sp = new URLSearchParams('promptHash=h1');
      const res = await handlePromptsResponsesLatest(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when topic_id is missing', async () => {
      const sp = new URLSearchParams('promptHash=h1&serpId=s1');
      const res = await handlePromptsResponsesLatest(sp, clients);
      expect(res.status).to.equal(400);
    });

    it('returns 200 with full detail', async () => {
      clients.prRelationsClient.prompt.resolves({
        value: {
          prompt: 'Test prompt',
          response: 'Full response text',
          sources: [{ url: 'https://example.com' }],
          mentionedBrands: [{ name: 'Brand1' }, { name: 'Brand2' }],
          date: '2026-05-01',
        },
      });
      const sp = new URLSearchParams('promptHash=h1&serpId=s1&topicId=t1');
      const res = await handlePromptsResponsesLatest(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data.prompt).to.equal('Test prompt');
      expect(res.body.data.response).to.equal('Full response text');
      expect(res.body.data.citedPages).to.have.length(1);
      expect(res.body.data.mentionedBrands).to.have.length(2);
      expect(res.body.data.date).to.equal('2026-05-01');
      expect(res.body.data.topicId).to.equal('t1');
    });

    it('returns { data: null } when value is null', async () => {
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('promptHash=h1&serpId=s1&topicId=t1');
      const res = await handlePromptsResponsesLatest(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.be.null;
    });

    it('returns { data: null } when value is undefined', async () => {
      clients.prRelationsClient.prompt.resolves({});
      const sp = new URLSearchParams('promptHash=h1&serpId=s1&topicId=t1');
      const res = await handlePromptsResponsesLatest(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.be.null;
    });

    it('handles non-array sources', async () => {
      clients.prRelationsClient.prompt.resolves({
        value: {
          prompt: 'Q', response: 'R', sources: 'bad', mentionedBrands: [], date: null,
        },
      });
      const sp = new URLSearchParams('promptHash=h1&serpId=s1&topicId=t1');
      const res = await handlePromptsResponsesLatest(sp, clients);
      expect(res.body.data.citedPages).to.deep.equal([]);
    });

    it('filters empty mentioned brand labels', async () => {
      clients.prRelationsClient.prompt.resolves({
        value: {
          prompt: 'Q', response: 'R', sources: [], mentionedBrands: [{ name: '' }, { name: 'Real' }], date: null,
        },
      });
      const sp = new URLSearchParams('promptHash=h1&serpId=s1&topicId=t1');
      const res = await handlePromptsResponsesLatest(sp, clients);
      expect(res.body.data.mentionedBrands).to.deep.equal(['Real']);
    });

    it('handles null mentionedBrands in latest response', async () => {
      clients.prRelationsClient.prompt.resolves({
        value: {
          prompt: 'Q', response: 'R', sources: [], mentionedBrands: null, date: null,
        },
      });
      const sp = new URLSearchParams('promptHash=h1&serpId=s1&topicId=t1');
      const res = await handlePromptsResponsesLatest(sp, clients);
      expect(res.body.data.mentionedBrands).to.deep.equal([]);
    });

    it('handles undefined mentionedBrands in latest response', async () => {
      clients.prRelationsClient.prompt.resolves({
        value: {
          prompt: 'Q', response: 'R', sources: [], date: null,
        },
      });
      const sp = new URLSearchParams('promptHash=h1&serpId=s1&topicId=t1');
      const res = await handlePromptsResponsesLatest(sp, clients);
      expect(res.body.data.mentionedBrands).to.deep.equal([]);
    });

    it('handles null date', async () => {
      clients.prRelationsClient.prompt.resolves({
        value: {
          prompt: 'Q', response: 'R', sources: [], mentionedBrands: [], date: null,
        },
      });
      const sp = new URLSearchParams('promptHash=h1&serpId=s1&topicId=t1');
      const res = await handlePromptsResponsesLatest(sp, clients);
      expect(res.body.data.date).to.be.null;
    });
  });
});
