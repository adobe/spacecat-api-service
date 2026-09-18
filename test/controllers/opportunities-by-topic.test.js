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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

const SITE_ID = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d';

// Focused controller test for getByTopic: the engine + embedding client are stubbed (the engine's
// own behavior is covered in test/support/lookup-by-topic.test.js), so this asserts only the
// controller's responsibilities — validation, the guards, embedding-client construction, the
// minScore env read, and delegation.
describe('OpportunitiesController.getByTopic', function () {
  this.timeout(20000); // esmock cold-start on the first load of the controller graph
  const sandbox = sinon.createSandbox();
  let controller;
  let lookupByTopicStub;
  let createFromStub;
  let embeddingClient;
  let hasAccessStub;
  let siteFindByIdStub;
  let batchGetByKeysStub;
  let dataAccess;
  let log;

  const build = async () => {
    const OpportunitiesController = await esmock('../../src/controllers/opportunities.js', {
      '../../src/support/lookup-by-topic.js': {
        lookupByTopic: lookupByTopicStub,
        DEFAULT_MIN_SCORE: 0.1,
      },
      '@adobe/spacecat-shared-gpt-client': {
        AzureEmbeddingClient: { createFrom: createFromStub },
      },
      '../../src/support/access-control-util.js': {
        default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
      },
    });
    controller = OpportunitiesController({ dataAccess, log, env: {} });
  };

  const call = (over = {}) => controller.getByTopic({
    params: { siteId: SITE_ID },
    data: { topics: ['pricing'] },
    env: {},
    log,
    ...over,
  });

  beforeEach(() => {
    lookupByTopicStub = sandbox.stub().resolves({ response: { results: [], opportunities: {} } });
    embeddingClient = { createEmbeddings: sandbox.stub() };
    createFromStub = sandbox.stub().returns(embeddingClient);
    hasAccessStub = sandbox.stub().resolves(true);
    siteFindByIdStub = sandbox.stub().resolves({ getId: () => SITE_ID });
    batchGetByKeysStub = sandbox.stub().resolves({ data: [] });
    log = {
      info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(), debug: sandbox.stub(),
    };
    dataAccess = {
      Opportunity: { batchGetByKeys: batchGetByKeysStub },
      Site: { findById: siteFindByIdStub },
      services: { postgrestClient: { from: () => {} } },
    };
  });

  afterEach(() => sandbox.restore());

  it('returns 400 for an invalid locale', async () => {
    await build();
    const res = await call({ data: { topics: ['x'], locale: 'not a locale!!' } });
    expect(res.status).to.equal(400);
  });

  it('returns 400 for an invalid site id', async () => {
    await build();
    const res = await call({ params: { siteId: 'nope' } });
    expect(res.status).to.equal(400);
  });

  it('returns 404 when the site does not exist', async () => {
    siteFindByIdStub.resolves(null);
    await build();
    const res = await call();
    expect(res.status).to.equal(404);
  });

  it('returns 403 when the caller lacks access', async () => {
    hasAccessStub.resolves(false);
    await build();
    const res = await call();
    expect(res.status).to.equal(403);
  });

  it('returns 503 when the postgrest client is unavailable', async () => {
    dataAccess.services = {};
    await build();
    const res = await call();
    expect(res.status).to.equal(503);
    expect(lookupByTopicStub).to.not.have.been.called;
  });

  it('returns 503 when the embedding client cannot be constructed', async () => {
    createFromStub.throws(new Error('Missing Azure OpenAI embedding deployment name'));
    await build();
    const res = await call();
    expect(res.status).to.equal(503);
    expect(log.error).to.have.been.called;
    expect(lookupByTopicStub).to.not.have.been.called;
  });

  it('delegates to the engine with the embedding client, topics, and env-derived minScore', async () => {
    await build();
    const res = await call({ env: { LOOKUP_TOPIC_MIN_SCORE: '0.35' }, data: { topics: ['pricing', 'support'] } });

    expect(res.status).to.equal(200);
    expect(createFromStub).to.have.been.calledOnce;
    expect(lookupByTopicStub).to.have.been.calledOnce;
    const [pgArg, embArg, cfg] = lookupByTopicStub.firstCall.args;
    expect(pgArg).to.equal(dataAccess.services.postgrestClient);
    expect(embArg).to.equal(embeddingClient);
    expect(cfg.siteId).to.equal(SITE_ID);
    expect(cfg.rawTopics).to.deep.equal(['pricing', 'support']);
    expect(cfg.defaultMinScore).to.equal(0.35);
    expect(cfg.log).to.equal(log);
    expect(cfg.mapKey).to.equal('opportunities');
  });

  it('falls back to DEFAULT_MIN_SCORE when the env value is absent or out of range', async () => {
    await build();
    await call({ env: { LOOKUP_TOPIC_MIN_SCORE: '5' } });
    expect(lookupByTopicStub.firstCall.args[2].defaultMinScore).to.equal(0.1);
  });

  it('site-ownership filterEntities drops opportunities whose siteId mismatches and warns', async () => {
    await build();
    await call();
    const { filterEntities } = lookupByTopicStub.firstCall.args[2];
    const kept = { getId: () => 'o1', getSiteId: () => SITE_ID, getType: () => 'cited-analysis' };
    const foreign = { getId: () => 'o2', getSiteId: () => 'other-site', getType: () => 'cited-analysis' };
    const result = await filterEntities([kept, foreign]);
    expect(result.map((o) => o.getId())).to.deep.equal(['o1']);
    expect(log.warn).to.have.been.calledWithMatch(/did not match the requested site/);
  });

  it('fetchEntities hydrates via batchGetByKeys, defaulting to [] when data is absent', async () => {
    batchGetByKeysStub.resolves({ data: [{ getId: () => 'o1' }] });
    await build();
    await call();
    const { fetchEntities } = lookupByTopicStub.firstCall.args[2];
    const hydrated = await fetchEntities(['o1']);
    expect(batchGetByKeysStub).to.have.been.calledOnceWith([{ opportunityId: 'o1' }]);
    expect(hydrated).to.have.length(1);

    batchGetByKeysStub.resolves({});
    expect(await fetchEntities(['o1'])).to.deep.equal([]);
  });

  it('the entity accessors (getId/getStatus/toFullDto) read from the opportunity', async () => {
    await build();
    await call();
    const cfg = lookupByTopicStub.firstCall.args[2];
    const oppty = {
      getId: () => 'o1',
      getStatus: () => 'NEW',
      getData: () => ({ x: 1 }),
      getType: () => 'cited-analysis',
      getTitle: () => 't',
      getDescription: () => 'd',
      getTags: () => [],
      getSiteId: () => SITE_ID,
      getAuditId: () => 'a',
      getRunbook: () => '',
      getGuidance: () => ({}),
      getOrigin: () => 'AUTOMATION',
      getCreatedAt: () => '2026-01-01',
      getUpdatedAt: () => '2026-01-02',
      getUpdatedBy: () => 'sys',
      getLastAuditedAt: () => '2026-01-02',
    };
    expect(cfg.getId(oppty)).to.equal('o1');
    expect(cfg.getStatus(oppty)).to.equal('NEW');
    expect(cfg.toFullDto(oppty)).to.include({ id: 'o1', type: 'cited-analysis' });
  });

  it('tolerates an absent request body (params default to {})', async () => {
    await build();
    const res = await call({ data: undefined });
    expect(res.status).to.equal(200);
    expect(lookupByTopicStub.firstCall.args[2].params).to.deep.equal({});
    expect(lookupByTopicStub.firstCall.args[2].rawTopics).to.equal(undefined);
  });

  it('returns 400 when the engine reports a validation error', async () => {
    lookupByTopicStub.resolves({ error: 'topics must be an array' });
    await build();
    const res = await call();
    expect(res.status).to.equal(400);
  });
});
