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
  handlePromptsResponsesAll,
  handlePromptsResponsesBatch,
} from '../../../../src/support/ai-visibility/handlers/prompts.js';

const decodeTestCursor = (c) => JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
const encodeTestCursor = (offset) => Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');

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

    it('normalizes a protobuf Date object on the response into an ISO YYYY-MM-DD string', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q', promptHash: 'h', serpId: 's', topicId: 't', topicName: 'T', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0,
        }],
      });
      clients.prRelationsClient.prompt.resolves({
        value: {
          response: 'Full',
          sources: [],
          mentionedBrands: [],
          date: {
            $typeName: 'semrush...Date', year: 2026, month: 7, day: 3,
          },
        },
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].date).to.equal('2026-07-03');
    });

    it('marks a full relation response complete (source=full, relationStatus=ok) and passes date through', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q', promptHash: 'h', serpId: 's', topicId: 't', topicName: 'T', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0, briefResponse: 'excerpt',
        }],
      });
      clients.prRelationsClient.prompt.resolves({
        value: {
          response: 'Full answer', sources: [], mentionedBrands: [], date: '2026-08-01',
        },
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].response).to.equal('Full answer');
      expect(res.body.data[0].responseSource).to.equal('full');
      expect(res.body.data[0].responseComplete).to.equal(true);
      expect(res.body.data[0].relationStatus).to.equal('ok');
      expect(res.body.data[0].date).to.equal('2026-08-01');
    });

    it('flags a silent excerpt fallback when the relation call rejects (source=excerpt, incomplete, error)', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q', promptHash: 'h', serpId: 's', topicId: 't', topicName: 'T', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0, briefResponse: 'fallback text',
        }],
      });
      clients.prRelationsClient.prompt.rejects(new Error('upstream'));
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      // legacy behaviour preserved: response still carries the excerpt text
      expect(res.body.data[0].response).to.equal('fallback text');
      // new: the degradation is now explicit instead of silent
      expect(res.body.data[0].responseSource).to.equal('excerpt');
      expect(res.body.data[0].responseComplete).to.equal(false);
      expect(res.body.data[0].relationStatus).to.equal('error');
    });

    it('marks relationStatus=skipped when prompt identity is missing', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0,
        }],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].relationStatus).to.equal('skipped');
      expect(res.body.data[0].responseSource).to.equal('none');
      expect(res.body.data[0].responseComplete).to.equal(false);
      expect(clients.prRelationsClient.prompt.called).to.be.false;
    });

    it('reports responseSource=none when neither a full response nor an excerpt exists', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q', promptHash: 'h', serpId: 's', topicId: 't', topicName: 'T', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0,
        }],
      });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponses(sp, clients);
      expect(res.body.data[0].response).to.equal('');
      expect(res.body.data[0].responseSource).to.equal('none');
      expect(res.body.data[0].responseComplete).to.equal(false);
      expect(res.body.data[0].relationStatus).to.equal('ok');
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

  /* ------------------------------------------------------------------ */
  /*  handlePromptsResponsesAll (whole-brand cursor traversal)           */
  /* ------------------------------------------------------------------ */
  describe('handlePromptsResponsesAll', () => {
    const makePrompts = (n) => Array.from({ length: n }, (_, i) => ({
      prompt: `P${i}`,
      promptHash: `h${i}`,
      serpId: `s${i}`,
      topicName: 'T',
      topicId: `t${i}`,
      llm: 1,
      mentionedBrandsCount: 0,
      sourcesCount: 0,
    }));

    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handlePromptsResponsesAll(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_domain');
    });

    it('returns 400 on a malformed cursor', async () => {
      const sp = new URLSearchParams('domain=example.com&cursor=not-a-valid-cursor');
      const res = await handlePromptsResponsesAll(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('invalid_cursor');
      expect(clients.promptClient.prompts.called).to.be.false;
    });

    it('returns a page with the shared item shape and a null cursor when the corpus is exhausted', async () => {
      clients.promptClient.prompts.resolves({ prompts: makePrompts(3) });
      clients.prRelationsClient.prompt.resolves({
        value: {
          response: 'Full', sources: [{ url: 'https://x.com' }], mentionedBrands: [{ name: 'B' }], date: '2026-08-01',
        },
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponsesAll(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data).to.have.length(3);
      expect(res.body.data[0].response).to.equal('Full');
      expect(res.body.data[0].responseSource).to.equal('full');
      expect(res.body.data[0].citedPages).to.have.length(1);
      expect(res.body.nextCursor).to.be.null;
      expect(res.body.truncated).to.equal(false);
      expect(res.body.truncationReason).to.be.null;
      expect(res.body.snapshotId).to.be.null;
      expect(res.body.executionDate).to.equal('2026-08-01');
    });

    it('emits a decodable nextCursor for a full page below the ceiling', async () => {
      clients.promptClient.prompts.resolves({ prompts: makePrompts(100) });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com&limit=100');
      const res = await handlePromptsResponsesAll(sp, clients);
      expect(res.body.nextCursor).to.be.a('string');
      expect(decodeTestCursor(res.body.nextCursor)).to.deep.equal({ offset: 100 });
      expect(res.body.truncated).to.equal(false);
    });

    it('advances the backend offset when a cursor is supplied', async () => {
      clients.promptClient.prompts.resolves({ prompts: makePrompts(2) });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com');
      sp.set('cursor', encodeTestCursor(40));
      await handlePromptsResponsesAll(sp, clients);
      expect(clients.promptClient.prompts.firstCall.args[0].range.offset).to.equal(40);
    });

    it('signals backend_offset_ceiling without a next cursor when the offset ceiling is reached', async () => {
      clients.promptClient.prompts.resolves({ prompts: makePrompts(100) });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com&limit=100');
      sp.set('cursor', encodeTestCursor(950));
      const res = await handlePromptsResponsesAll(sp, clients);
      expect(res.body.nextCursor).to.be.null;
      expect(res.body.truncated).to.equal(true);
      expect(res.body.truncationReason).to.equal('backend_offset_ceiling');
    });

    it('clamps limit to the hard cap', async () => {
      clients.promptClient.prompts.resolves({ prompts: [] });
      const sp = new URLSearchParams('domain=example.com&limit=999');
      await handlePromptsResponsesAll(sp, clients);
      expect(clients.promptClient.prompts.firstCall.args[0].range.limit).to.equal(200);
    });

    it('falls back to the default limit for a fractional limit in (0,1) (guards the same-offset cursor loop)', async () => {
      clients.promptClient.prompts.resolves({ prompts: [] });
      const sp = new URLSearchParams('domain=example.com&limit=0.5');
      await handlePromptsResponsesAll(sp, clients);
      // Math.floor(0.5) === 0 would make the backend return 0 rows and re-emit the
      // cursor at the same offset; the guard must fall back to the default (100).
      expect(clients.promptClient.prompts.firstCall.args[0].range.limit).to.equal(100);
    });

    it('filters by promptQuery but advances the cursor by rows fetched', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [
          {
            prompt: 'best seo tools for 2026', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: 't1', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0,
          },
          {
            prompt: 'weather forecast today', promptHash: 'h2', serpId: 's2', topicName: 'T', topicId: 't2', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0,
          },
        ],
      });
      clients.prRelationsClient.prompt.resolves({ value: null });
      const sp = new URLSearchParams('domain=example.com&promptQuery=best+seo+tools+for+2026');
      const res = await handlePromptsResponsesAll(sp, clients);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].prompt).to.equal('best seo tools for 2026');
      // 2 rows fetched (< limit) → natural end, no next cursor
      expect(res.body.nextCursor).to.be.null;
    });

    it('derives executionDate from the pre-filter page even when promptQuery drops the dated row', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [
          {
            prompt: 'keep this exact prompt', promptHash: 'h0', serpId: 's0', topicName: 'T', topicId: 't0', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0,
          },
          {
            prompt: 'drop different prompt entirely', promptHash: 'h1', serpId: 's1', topicName: 'T', topicId: 't1', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0,
          },
        ],
      });
      // kept row has no date; the filtered-out row carries the page snapshot date.
      clients.prRelationsClient.prompt
        .onFirstCall().resolves({ value: null })
        .onSecondCall().resolves({
          value: {
            response: 'R', sources: [], mentionedBrands: [], date: '2026-08-09',
          },
        });
      const sp = new URLSearchParams('domain=example.com&promptQuery=keep+this+exact+prompt');
      const res = await handlePromptsResponsesAll(sp, clients);
      expect(res.body.data).to.have.length(1);
      expect(res.body.data[0].prompt).to.equal('keep this exact prompt');
      expect(res.body.data[0].date).to.be.null;
      // executionDate comes from the pre-filter set, so the page still reports the snapshot
      expect(res.body.executionDate).to.equal('2026-08-09');
      // both fetched rows were hydrated (pre-filter), not just the kept one
      expect(clients.prRelationsClient.prompt.callCount).to.equal(2);
    });

    it('carries per-item relation status through the shared builder', async () => {
      clients.promptClient.prompts.resolves({
        prompts: [{
          prompt: 'Q', llm: 1, mentionedBrandsCount: 0, sourcesCount: 0,
        }],
      });
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponsesAll(sp, clients);
      expect(res.body.data[0].relationStatus).to.equal('skipped');
      expect(clients.prRelationsClient.prompt.called).to.be.false;
    });

    it('handles raw.prompts being undefined', async () => {
      clients.promptClient.prompts.resolves({});
      const sp = new URLSearchParams('domain=example.com');
      const res = await handlePromptsResponsesAll(sp, clients);
      expect(res.body.data).to.deep.equal([]);
      expect(res.body.nextCursor).to.be.null;
      expect(res.body.executionDate).to.be.null;
    });
  });

  /* ------------------------------------------------------------------ */
  /*  handlePromptsResponsesBatch (bulk identity hydration)              */
  /* ------------------------------------------------------------------ */
  describe('handlePromptsResponsesBatch', () => {
    it('returns 400 when domain is missing', async () => {
      const res = await handlePromptsResponsesBatch({ items: [{ promptHash: 'h', serpId: 's', topicId: 't' }] }, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_domain');
    });

    it('returns 400 when body is not an object', async () => {
      const res = await handlePromptsResponsesBatch(null, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_domain');
    });

    it('returns 400 when body is an array (Array.isArray guard)', async () => {
      const res = await handlePromptsResponsesBatch(
        [{ promptHash: 'h', serpId: 's', topicId: 't' }],
        clients,
      );
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_domain');
      expect(clients.prRelationsClient.prompt.called).to.be.false;
    });

    it('returns 400 when items is missing or empty', async () => {
      const res1 = await handlePromptsResponsesBatch({ domain: 'example.com' }, clients);
      expect(res1.status).to.equal(400);
      expect(res1.body.error).to.equal('missing_items');
      const res2 = await handlePromptsResponsesBatch({ domain: 'example.com', items: [] }, clients);
      expect(res2.status).to.equal(400);
      expect(res2.body.error).to.equal('missing_items');
    });

    it('returns 400 when items exceeds the cap', async () => {
      const items = Array.from({ length: 501 }, (_, i) => ({ promptHash: `h${i}`, serpId: `s${i}`, topicId: `t${i}` }));
      const res = await handlePromptsResponsesBatch({ domain: 'example.com', items }, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('too_many_items');
      expect(clients.prRelationsClient.prompt.called).to.be.false;
    });

    it('returns 400 when an item is malformed (not an object)', async () => {
      const res = await handlePromptsResponsesBatch({
        domain: 'example.com',
        items: [{ promptHash: 'h', serpId: 's', topicId: 't' }, 'not-an-object'],
      }, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('malformed_item');
      expect(clients.prRelationsClient.prompt.called).to.be.false;
    });

    it('preserves order and never drops items across ok/skipped/error outcomes', async () => {
      clients.prRelationsClient.prompt
        .onFirstCall().resolves({
          value: {
            prompt: 'Q0', response: 'Full answer', sources: [{ url: 'https://x.com' }], mentionedBrands: [{ name: 'Acme' }], date: '2026-08-01',
          },
        })
        .onSecondCall().rejects(new Error('upstream'));
      const items = [
        { promptHash: 'h0', serpId: 's0', topicId: 't0' }, // ok
        { promptHash: 'h1', serpId: 's1', topicId: 't1' }, // error (rejects)
        { promptHash: 'h2', serpId: '', topicId: 't2' }, // skipped (empty serpId)
      ];
      const res = await handlePromptsResponsesBatch({ domain: 'example.com', items }, clients);
      expect(res.status).to.equal(200);
      expect(res.body.requested).to.equal(3);
      expect(res.body.data).to.have.length(3);

      expect(res.body.data[0].relationStatus).to.equal('ok');
      expect(res.body.data[0].promptHash).to.equal('h0');
      expect(res.body.data[0].prompt).to.equal('Q0');
      expect(res.body.data[0].response).to.equal('Full answer');
      expect(res.body.data[0].responseSource).to.equal('full');
      expect(res.body.data[0].responseComplete).to.equal(true);
      expect(res.body.data[0].date).to.equal('2026-08-01');
      expect(res.body.data[0].citedPages).to.have.length(1);
      expect(res.body.data[0].mentionedBrands).to.deep.equal(['Acme']);

      expect(res.body.data[1].relationStatus).to.equal('error');
      expect(res.body.data[1].promptHash).to.equal('h1');
      expect(res.body.data[1].responseSource).to.equal('none');

      expect(res.body.data[2].relationStatus).to.equal('skipped');
      expect(res.body.data[2].serpId).to.equal('');
      expect(res.body.data[2].responseSource).to.equal('none');
      // only the two items with a full identity issued a relation call
      expect(clients.prRelationsClient.prompt.callCount).to.equal(2);
    });

    it('applies per-item country/engine over the top-level default', async () => {
      clients.prRelationsClient.prompt.resolves({ value: null });
      const items = [
        {
          promptHash: 'h0', serpId: 's0', topicId: 't0', engine: 'gemini',
        },
        { promptHash: 'h1', serpId: 's1', topicId: 't1' }, // inherits top-level
      ];
      const res = await handlePromptsResponsesBatch({
        domain: 'example.com', country: 'US', engine: 'chatgpt', items,
      }, clients);
      expect(res.status).to.equal(200);
      expect(res.body.data[0].engine).to.equal('gemini');
      expect(res.body.data[1].engine).to.equal('chatgpt');
    });

    it('echoes the identity and returns responseSource=none for a null relation', async () => {
      clients.prRelationsClient.prompt.resolves({ value: null });
      const res = await handlePromptsResponsesBatch({
        domain: 'example.com',
        items: [{ promptHash: 'h', serpId: 's', topicId: 't' }],
      }, clients);
      expect(res.body.data[0].promptHash).to.equal('h');
      expect(res.body.data[0].serpId).to.equal('s');
      expect(res.body.data[0].topicId).to.equal('t');
      expect(res.body.data[0].response).to.equal('');
      expect(res.body.data[0].responseSource).to.equal('none');
      expect(res.body.data[0].relationStatus).to.equal('ok');
    });
  });
});
