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
import esmock from 'esmock';

use(chaiAsPromised);

const SITE = 'site-1';
const PG = { id: 'pg' };

describe('lookup-by-topic support', () => {
  const sandbox = sinon.createSandbox();
  let mod;
  let lookupVectorStub;
  let getQueryEmbeddingStub;
  let upsertQueryEmbeddingStub;
  let touchQueryEmbeddingStub;
  let embeddingClient;
  let log;

  beforeEach(async () => {
    lookupVectorStub = sandbox.stub().resolves([]);
    getQueryEmbeddingStub = sandbox.stub().resolves(null); // default: cache miss
    upsertQueryEmbeddingStub = sandbox.stub().resolves('hash');
    touchQueryEmbeddingStub = sandbox.stub().resolves();
    embeddingClient = { createEmbeddings: sandbox.stub().resolves([]) };
    log = {
      info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(), debug: sandbox.stub(),
    };
    mod = await esmock('../../src/support/lookup-by-topic.js', {
      '@adobe/spacecat-shared-data-access': {
        lookupOpportunitiesByVector: lookupVectorStub,
        getQueryEmbedding: getQueryEmbeddingStub,
        upsertQueryEmbedding: upsertQueryEmbeddingStub,
        touchQueryEmbedding: touchQueryEmbeddingStub,
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  const opp = (id, status = 'NEW') => ({
    id,
    status,
    siteId: SITE,
    dto: {
      id, type: 'cited-analysis', status, title: `t-${id}`, updatedAt: '2026-01-01', data: { big: id },
    },
  });

  const fetchFrom = (list) => {
    const byId = new Map(list.map((e) => [e.id, e]));
    return async (ids) => ids.map((id) => byId.get(id)).filter(Boolean);
  };

  const topicCfg = (over = {}) => ({
    siteId: SITE,
    rawTopics: over.rawTopics,
    params: over.params ?? {},
    defaultMinScore: over.defaultMinScore ?? 0.1,
    log,
    validStatuses: ['NEW', 'IN_PROGRESS', 'IGNORED', 'RESOLVED'],
    defaultExcludedStatuses: ['IGNORED'],
    fetchEntities: over.fetchEntities ?? fetchFrom([]),
    filterEntities: over.filterEntities,
    getId: (e) => e.id,
    getStatus: (e) => e.status,
    toFullDto: (e) => e.dto,
    lightweightFields: ['id', 'type', 'status', 'title', 'updatedAt'],
    mapKey: 'opportunities',
  });

  const run = (over = {}) => mod.lookupByTopic(PG, embeddingClient, topicCfg(over));

  describe('parseLookupTopics', () => {
    it('rejects a non-array', () => {
      expect(mod.parseLookupTopics('x')).to.deep.equal({ error: 'topics must be an array' });
    });
    it('rejects more than 100 entries', () => {
      expect(mod.parseLookupTopics(Array.from({ length: 101 }, (_, i) => `t${i}`)).error).to.match(/at most 100/);
    });
    it('drops non-string / empty / oversized entries', () => {
      const longTopic = 'a'.repeat(2049);
      expect(mod.parseLookupTopics(['a', '', '  ', 3, null, longTopic, 'b'])).to.deep.equal({ topics: ['a', 'b'] });
    });
  });

  describe('parseTopicK', () => {
    it('defaults to 10 when absent', () => {
      expect(mod.parseTopicK(undefined)).to.deep.equal({ k: 10 });
    });
    it('accepts an in-range integer (number or string)', () => {
      expect(mod.parseTopicK(25)).to.deep.equal({ k: 25 });
      expect(mod.parseTopicK('25')).to.deep.equal({ k: 25 });
    });
    it('rejects out-of-range, non-integer, or float', () => {
      expect(mod.parseTopicK(0).error).to.match(/between 1 and 100/);
      expect(mod.parseTopicK(101).error).to.match(/between 1 and 100/);
      expect(mod.parseTopicK('abc').error).to.match(/between 1 and 100/);
      expect(mod.parseTopicK(2.5).error).to.match(/between 1 and 100/);
    });
  });

  describe('parseMinScore', () => {
    it('defaults to the supplied default when absent', () => {
      expect(mod.parseMinScore(undefined, 0.2)).to.deep.equal({ minScore: 0.2 });
    });
    it('accepts an in-range number', () => {
      expect(mod.parseMinScore('0.5', 0.1)).to.deep.equal({ minScore: 0.5 });
      expect(mod.parseMinScore(0, 0.1)).to.deep.equal({ minScore: 0 });
    });
    it('rejects out-of-range, non-numeric, or a non-number/string type', () => {
      expect(mod.parseMinScore('-0.1', 0.1).error).to.match(/between 0 and 1/);
      expect(mod.parseMinScore('abc', 0.1).error).to.match(/between 0 and 1/);
      expect(mod.parseMinScore({}, 0.1).error).to.match(/between 0 and 1/);
    });
  });

  describe('lookupByTopic validation errors', () => {
    it('surfaces a topics error', async () => {
      expect(await run({ rawTopics: 'x' })).to.deep.equal({ error: 'topics must be an array' });
    });
    it('surfaces a status error', async () => {
      expect((await run({ rawTopics: ['a'], params: { status: 'BOGUS' } })).error).to.match(/Invalid status/);
    });
    it('surfaces a k error', async () => {
      expect((await run({ rawTopics: ['a'], params: { k: 999 } })).error).to.match(/k must be/);
    });
    it('surfaces a minScore error', async () => {
      expect((await run({ rawTopics: ['a'], params: { minScore: 5 } })).error).to.match(/minScore must be/);
    });
    it('returns an empty response for an empty/all-dropped topic list', async () => {
      expect(await run({ rawTopics: ['', '  '] })).to.deep.equal({ response: { results: [], opportunities: {} } });
      expect(embeddingClient.createEmbeddings).to.not.have.been.called;
    });
    it('rejects an oversized union of matched opportunities', async () => {
      embeddingClient.createEmbeddings.resolves([[1]]);
      lookupVectorStub.resolves(
        Array.from({ length: 1001 }, (_, i) => ({ entityId: `o${i}`, entityType: 'cited-analysis', score: 0.9 })),
      );
      expect((await run({ rawTopics: ['a'] })).error).to.match(/Too many matched opportunities/);
    });
    it('surfaces a non-string fields projection error', async () => {
      embeddingClient.createEmbeddings.resolves([[1]]);
      lookupVectorStub.resolves([{ entityId: 'o1', entityType: 'cited-analysis', score: 0.9 }]);
      const res = await run({ rawTopics: ['a'], params: { fields: 123 }, fetchEntities: fetchFrom([opp('o1')]) });
      expect(res.error).to.equal('fields must be a string');
    });
  });

  describe('lookupByTopic search', () => {
    it('embeds a cache miss, caches it, runs ANN, projects survivors, and logs', async () => {
      embeddingClient.createEmbeddings.resolves([[0.1, 0.2]]);
      lookupVectorStub.resolves([
        { entityId: 'o1', entityType: 'cited-analysis', score: 0.9 },
        { entityId: 'o2', entityType: 'cited-analysis', score: 0.7 },
      ]);
      const res = await run({ rawTopics: ['pricing'], fetchEntities: fetchFrom([opp('o1'), opp('o2')]) });

      expect(embeddingClient.createEmbeddings).to.have.been.calledOnceWith(['pricing']);
      expect(embeddingClient.createEmbeddings.firstCall.args[1]).to.equal(undefined); // native dims
      expect(upsertQueryEmbeddingStub).to.have.been.calledOnce;
      expect(lookupVectorStub).to.have.been.calledOnceWith(PG, {
        siteId: SITE, sourceType: 'topic', vector: [0.1, 0.2], k: 10, minScore: 0.1,
      });
      expect(res.response.results).to.deep.equal([
        { topic: 'pricing', matches: [{ opportunityId: 'o1', score: 0.9 }, { opportunityId: 'o2', score: 0.7 }] },
      ]);
      expect(res.response.opportunities.o1).to.deep.equal({
        id: 'o1', type: 'cited-analysis', status: 'NEW', title: 't-o1', updatedAt: '2026-01-01',
      });
      expect(log.info).to.have.been.calledWithMatch(/\[lookup-by-topic\]/);
    });

    it('uses the durable cache on a hit and bumps last_access (no embed)', async () => {
      getQueryEmbeddingStub.resolves({ vector: [0.3], textHash: 'h' });
      lookupVectorStub.resolves([{ entityId: 'o1', entityType: 'cited-analysis', score: 0.8 }]);
      const res = await run({ rawTopics: ['pricing'], fetchEntities: fetchFrom([opp('o1')]) });

      expect(embeddingClient.createEmbeddings).to.not.have.been.called;
      expect(touchQueryEmbeddingStub).to.have.been.calledOnce;
      expect(res.response.results[0].matches).to.deep.equal([{ opportunityId: 'o1', score: 0.8 }]);
    });

    it('passes k and minScore through to the RPC', async () => {
      embeddingClient.createEmbeddings.resolves([[1]]);
      await run({ rawTopics: ['x'], params: { k: 3, minScore: 0.5 } });
      expect(lookupVectorStub.firstCall.args[1]).to.include({ k: 3, minScore: 0.5 });
    });

    it('dedupes duplicate topics to one embed + one ANN but returns one result per input', async () => {
      embeddingClient.createEmbeddings.resolves([[0.1]]);
      lookupVectorStub.resolves([{ entityId: 'o1', entityType: 'cited-analysis', score: 0.9 }]);
      const res = await run({ rawTopics: ['same', 'same'], fetchEntities: fetchFrom([opp('o1')]) });

      expect(embeddingClient.createEmbeddings).to.have.been.calledOnceWith(['same']);
      expect(lookupVectorStub).to.have.been.calledOnce;
      expect(res.response.results).to.have.length(2);
      expect(res.response.results[0]).to.deep.equal(res.response.results[1]);
    });

    it('unions ids across topics and hydrates once', async () => {
      embeddingClient.createEmbeddings.resolves([[1], [2]]);
      lookupVectorStub.onCall(0).resolves([{ entityId: 'o1', entityType: 'cited-analysis', score: 0.9 }]);
      lookupVectorStub.onCall(1).resolves([
        { entityId: 'o1', entityType: 'cited-analysis', score: 0.6 },
        { entityId: 'o2', entityType: 'cited-analysis', score: 0.5 },
      ]);
      const fetchEntities = sandbox.stub().callsFake(fetchFrom([opp('o1'), opp('o2')]));
      const res = await run({ rawTopics: ['a', 'b'], fetchEntities });

      expect(fetchEntities).to.have.been.calledOnce;
      expect(fetchEntities.firstCall.args[0]).to.deep.equal(['o1', 'o2']);
      expect(res.response.results[1].matches).to.deep.equal([
        { opportunityId: 'o1', score: 0.6 }, { opportunityId: 'o2', score: 0.5 },
      ]);
      expect(Object.keys(res.response.opportunities)).to.have.members(['o1', 'o2']);
    });

    it('does not hydrate or filter when no topic matches anything', async () => {
      embeddingClient.createEmbeddings.resolves([[1]]);
      const fetchEntities = sandbox.stub().callsFake(fetchFrom([]));
      const filterEntities = sandbox.stub().callsFake((l) => l);
      const res = await run({ rawTopics: ['a'], fetchEntities, filterEntities });
      expect(fetchEntities).to.not.have.been.called;
      expect(filterEntities).to.not.have.been.called;
      expect(res.response).to.deep.equal({ results: [{ topic: 'a', matches: [] }], opportunities: {} });
    });

    it('warns when the index references ids that cannot be hydrated (stale index)', async () => {
      embeddingClient.createEmbeddings.resolves([[1]]);
      lookupVectorStub.resolves([
        { entityId: 'o1', entityType: 'cited-analysis', score: 0.9 },
        { entityId: 'ghost', entityType: 'cited-analysis', score: 0.8 },
      ]);
      await run({ rawTopics: ['a'], fetchEntities: fetchFrom([opp('o1')]) });
      expect(log.warn).to.have.been.calledWithMatch(/could not be hydrated/);
    });

    it('drops matches whose opportunity is excluded by the default status filter (IGNORED)', async () => {
      embeddingClient.createEmbeddings.resolves([[1]]);
      lookupVectorStub.resolves([
        { entityId: 'o1', entityType: 'cited-analysis', score: 0.9 },
        { entityId: 'o2', entityType: 'cited-analysis', score: 0.8 },
      ]);
      const res = await run({
        rawTopics: ['a'], fetchEntities: fetchFrom([opp('o1', 'NEW'), opp('o2', 'IGNORED')]),
      });
      expect(res.response.results[0].matches).to.deep.equal([{ opportunityId: 'o1', score: 0.9 }]);
      expect(res.response.opportunities).to.not.have.property('o2');
    });

    it('honors an explicit status include-list', async () => {
      embeddingClient.createEmbeddings.resolves([[1]]);
      lookupVectorStub.resolves([
        { entityId: 'o1', entityType: 'cited-analysis', score: 0.9 },
        { entityId: 'o2', entityType: 'cited-analysis', score: 0.8 },
      ]);
      const res = await run({
        rawTopics: ['a'], params: { status: 'IGNORED' }, fetchEntities: fetchFrom([opp('o1', 'NEW'), opp('o2', 'IGNORED')]),
      });
      expect(res.response.results[0].matches).to.deep.equal([{ opportunityId: 'o2', score: 0.8 }]);
    });

    it('applies filterEntities before status filtering', async () => {
      embeddingClient.createEmbeddings.resolves([[1]]);
      lookupVectorStub.resolves([
        { entityId: 'o1', entityType: 'cited-analysis', score: 0.9 },
        { entityId: 'o2', entityType: 'cited-analysis', score: 0.8 },
      ]);
      const res = await run({
        rawTopics: ['a'],
        fetchEntities: fetchFrom([opp('o1'), opp('o2')]),
        filterEntities: async (l) => l.filter((e) => e.id !== 'o2'),
      });
      expect(res.response.results[0].matches).to.deep.equal([{ opportunityId: 'o1', score: 0.9 }]);
      expect(res.response.opportunities).to.not.have.property('o2');
    });

    it('supports a sparse fieldset via `fields`', async () => {
      embeddingClient.createEmbeddings.resolves([[1]]);
      lookupVectorStub.resolves([{ entityId: 'o1', entityType: 'cited-analysis', score: 0.9 }]);
      const res = await run({ rawTopics: ['a'], params: { fields: 'title' }, fetchEntities: fetchFrom([opp('o1')]) });
      expect(res.response.opportunities.o1).to.deep.equal({ id: 'o1', title: 't-o1' });
    });

    it('surfaces a projection error for an invalid (unknown) fields param', async () => {
      embeddingClient.createEmbeddings.resolves([[1]]);
      lookupVectorStub.resolves([{ entityId: 'o1', entityType: 'cited-analysis', score: 0.9 }]);
      const res = await run({ rawTopics: ['a'], params: { fields: 'nope' }, fetchEntities: fetchFrom([opp('o1')]) });
      expect(res.error).to.match(/Invalid fields/);
    });
  });

  describe('best-effort cache writes', () => {
    it('swallows a touch failure on a cache hit (logs debug)', async () => {
      getQueryEmbeddingStub.resolves({ vector: [0.3], textHash: 'h' });
      touchQueryEmbeddingStub.rejects(new Error('touch boom'));
      lookupVectorStub.resolves([{ entityId: 'o1', entityType: 'cited-analysis', score: 0.8 }]);
      const res = await run({ rawTopics: ['a'], fetchEntities: fetchFrom([opp('o1')]) });
      expect(res.response.results[0].matches).to.deep.equal([{ opportunityId: 'o1', score: 0.8 }]);
      expect(log.debug).to.have.been.calledWithMatch(/touchQueryEmbedding failed/);
    });

    it('swallows an upsert failure on a cache miss (logs debug)', async () => {
      embeddingClient.createEmbeddings.resolves([[0.1]]);
      upsertQueryEmbeddingStub.rejects(new Error('upsert boom'));
      lookupVectorStub.resolves([{ entityId: 'o1', entityType: 'cited-analysis', score: 0.8 }]);
      const res = await run({ rawTopics: ['a'], fetchEntities: fetchFrom([opp('o1')]) });
      expect(res.response.results[0].matches).to.deep.equal([{ opportunityId: 'o1', score: 0.8 }]);
      expect(log.debug).to.have.been.calledWithMatch(/upsertQueryEmbedding failed/);
    });

    it('propagates an embedding failure (infra error, not a 400)', async () => {
      embeddingClient.createEmbeddings.rejects(new Error('azure down'));
      await expect(run({ rawTopics: ['a'] })).to.be.rejectedWith('azure down');
    });
  });
});
