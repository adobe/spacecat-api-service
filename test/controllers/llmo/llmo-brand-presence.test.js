/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { createBrandPresenceHandlers } from '../../../src/controllers/llmo/llmo-brand-presence.js';

use(sinonChai);

function createChainableMock(resolveValue = { data: [], error: null }) {
  const c = {
    from: sinon.stub().returnsThis(),
    select: sinon.stub().returnsThis(),
    eq: sinon.stub().returnsThis(),
    gte: sinon.stub().returnsThis(),
    lte: sinon.stub().returnsThis(),
    order: sinon.stub().returnsThis(),
    ilike: sinon.stub().returnsThis(),
    in: sinon.stub().returnsThis(),
    limit: sinon.stub().resolves(resolveValue),
    range: sinon.stub().resolves(resolveValue),
    then(resolve) { return Promise.resolve(resolveValue).then(resolve); },
  };
  return c;
}

describe('llmo-brand-presence', () => {
  let sandbox;
  let getSiteAndValidateLlmo;
  let mockContext;
  let mockClient;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    getSiteAndValidateLlmo = sandbox.stub().resolves({ site: {}, config: {}, llmoConfig: {} });
    mockContext = {
      params: { siteId: '0178a3f0-1234-7000-8000-000000000001', topic: 'test-topic' },
      data: {},
      log: { info: sandbox.stub(), error: sandbox.stub(), warn: sandbox.stub() },
      dataAccess: {
        Site: {
          postgrestService: null,
        },
      },
    };
    mockClient = createChainableMock();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('runWithPostgrest', () => {
    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getFilterDimensions(mockContext);

      expect(result.status).to.equal(400);
      expect(getSiteAndValidateLlmo).not.to.have.been.called;
    });

    it('returns forbidden when user has no org access', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getSiteAndValidateLlmo.rejects(new Error('Only users belonging to the organization can view its sites'));

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getFilterDimensions(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when LLMO is not enabled', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getSiteAndValidateLlmo.rejects(new Error('LLM Optimizer is not enabled for this site, add llmo config to the site'));

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getFilterDimensions(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns badRequest when generic error is thrown', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getSiteAndValidateLlmo.rejects(new Error('Database connection failed'));

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getFilterDimensions(mockContext);

      expect(result.status).to.equal(400);
      expect(mockContext.log.error).to.have.been.calledWith('Brand presence API error: Database connection failed');
    });
  });

  describe('getFilterDimensions', () => {
    it('returns ok with categories, topics, regions, origins, models', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [
          {
            category_name: 'Cat1',
            topics: 't1',
            region_code: 'US',
            origin: 'human',
            model: 'chatgpt',
          },
          {
            category_name: 'Cat2',
            topics: 't2,t3',
            region_code: 'DE',
            origin: 'ai',
            model: 'gemini',
          },
        ],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getFilterDimensions(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.categories).to.include('Cat1', 'Cat2');
      expect(body.topics).to.include('t1', 't2', 't3');
      expect(body.regions).to.include('US', 'DE');
      expect(body.origins).to.include('human', 'ai');
      expect(body.models).to.include('chatgpt', 'gemini');
    });
  });

  describe('getWeeks', () => {
    it('returns ok with weeks array', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [{ execution_date: '2025-01-15' }, { execution_date: '2025-01-20' }],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getWeeks(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(Array.isArray(body)).to.be.true;
    });
  });

  describe('getMetadata', () => {
    it('returns has_data and has_data_last_week', async () => {
      let limitCalls = 0;
      const client = createChainableMock({ data: [], error: null });
      client.limit = sandbox.stub().callsFake(() => {
        limitCalls += 1;
        return Promise.resolve({
          data: limitCalls === 1 ? [{ id: '1' }] : [],
          error: null,
        });
      });
      mockContext.dataAccess.Site.postgrestService = client;

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getMetadata(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.have.property('has_data');
      expect(body).to.have.property('has_data_last_week');
    });
  });

  describe('getStats', () => {
    it('returns visibility_score, brand_mentions, citations', async () => {
      const execData = {
        data: [
          { id: 'exec-1', visibility_score: 80, mentions: true },
          { id: 'exec-2', visibility_score: 60, mentions: false },
        ],
        error: null,
      };
      const sourcesData = { data: [{ execution_id: 'exec-1' }], error: null };
      let fromCallCount = 0;
      const client = {
        from: sandbox.stub().callsFake(() => {
          fromCallCount += 1;
          const resp = fromCallCount === 1 ? execData : sourcesData;
          const chain = {
            select: sandbox.stub().returnsThis(),
            eq: sandbox.stub().returnsThis(),
            gte: sandbox.stub().returnsThis(),
            lte: sandbox.stub().returnsThis(),
            in: sandbox.stub().returnsThis(),
            limit: sandbox.stub().resolves(resp),
            get then() {
              return (resolve) => Promise.resolve(resp).then(resolve);
            },
          };
          chain.from = client.from;
          return chain;
        }),
      };

      mockContext.dataAccess.Site.postgrestService = client;

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getStats(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.have.property('visibility_score');
      expect(body).to.have.property('brand_mentions');
      expect(body).to.have.property('citations');
    });
  });

  describe('getSentimentOverview', () => {
    it('returns weeks array', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [{ execution_date: '2025-01-15', sentiment: 'positive' }],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getSentimentOverview(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(Array.isArray(body)).to.be.true;
    });

    it('aggregates positive, neutral, and negative sentiment by week', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [
          { execution_date: '2025-01-13', sentiment: 'positive' },
          { execution_date: '2025-01-14', sentiment: 'neutral' },
          { execution_date: '2025-01-15', sentiment: 'negative' },
        ],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getSentimentOverview(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.have.lengthOf(1);
      expect(body[0]).to.have.property('positive', 1);
      expect(body[0]).to.have.property('neutral', 1);
      expect(body[0]).to.have.property('negative', 1);
      expect(body[0].prompts_with_sentiment).to.equal(3);
    });
  });

  describe('getWeeklyTrends', () => {
    it('returns weekly metrics', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [{ week: '2025-W03', mentions_count: 10, citations_count: 5 }],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getWeeklyTrends(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(Array.isArray(body)).to.be.true;
    });
  });

  describe('getTopics', () => {
    it('returns topics', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [{ topics: 'test', category_name: 'Cat1' }],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getTopics(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(Array.isArray(body)).to.be.true;
    });
  });

  describe('getTopicPrompts', () => {
    it('returns prompts for topic', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [{ prompt: 'What is X?', topics: 'test-topic' }],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getTopicPrompts(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(Array.isArray(body)).to.be.true;
    });
  });

  describe('getSearch', () => {
    it('returns badRequest when q is too short', async () => {
      mockContext.data = { q: 'a' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getSearch(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns combined results when q is valid', async () => {
      mockContext.data = { q: 'creative' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [{ topics: 'creative tools', category_name: 'Cat1' }],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getSearch(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(Array.isArray(body)).to.be.true;
    });
  });

  describe('getShareOfVoice', () => {
    it('returns competitor data', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [{ competitor: 'Canva', mentions: 5 }],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getShareOfVoice(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(Array.isArray(body)).to.be.true;
    });
  });

  describe('getCompetitorTrends', () => {
    it('returns competitor trends', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [{ execution_date: '2025-01-15', competitor: 'Figma' }],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getCompetitorTrends(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(Array.isArray(body)).to.be.true;
    });
  });

  describe('getPrompts', () => {
    it('returns prompts', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [{ prompt: 'What?', topics: 't1' }],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getPrompts(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(Array.isArray(body)).to.be.true;
    });
  });

  describe('getSources', () => {
    it('returns sources for executionId', async () => {
      mockContext.data = { executionId: '0178a3f2-8f5a-7e04-8d2a-9f3b1c4e5d6e' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [{ url: 'https://example.com', execution_id: '0178a3f2-8f5a-7e04-8d2a-9f3b1c4e5d6e' }],
        error: null,
      });

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getSources(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(Array.isArray(body)).to.be.true;
    });

    it('returns sources when no executionId (site-level)', async () => {
      mockContext.data = {};
      let fromCall = 0;
      const client = {
        from: sandbox.stub().callsFake(() => {
          fromCall += 1;
          const resp = fromCall === 1
            ? { data: [{ id: 'exec-1' }], error: null }
            : { data: [{ url: 'https://x.com' }], error: null };
          const chain = {
            select: sandbox.stub().returnsThis(),
            eq: sandbox.stub().returnsThis(),
            in: sandbox.stub().returnsThis(),
            limit: sandbox.stub().resolves(resp),
            range: sandbox.stub().resolves(resp),
            then(resolve) { return Promise.resolve(resp).then(resolve); },
          };
          return chain;
        }),
      };
      mockContext.dataAccess.Site.postgrestService = client;

      const handlers = createBrandPresenceHandlers(getSiteAndValidateLlmo);
      const result = await handlers.getSources(mockContext);

      expect(result.status).to.equal(200);
    });
  });
});
