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
import { createPromptExecutionStatusHandler } from '../../../src/controllers/llmo/llmo-brand-presence.js';

const ORG_ID = '0178a3f0-1234-7000-8000-000000000001';
const SITE_ID = 'aabbccdd-0000-7000-8000-000000000002';
const TOPIC_ID_1 = 'aaaaaaaa-0000-7000-8000-000000000001';
const TOPIC_ID_2 = 'bbbbbbbb-0000-7000-8000-000000000002';
const PROMPT_ID_1 = 'cccccccc-0000-7000-8000-000000000001';
const PROMPT_ID_2 = 'dddddddd-0000-7000-8000-000000000002';

function makeContext(data = {}, params = {}) {
  return {
    params: { spaceCatId: ORG_ID, brandId: 'all', ...params },
    data,
    log: { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() },
    dataAccess: {
      Site: { postgrestService: {} },
    },
  };
}

function makeClient(execRows = [], siteRows = [{ id: SITE_ID }]) {
  const execChain = {
    select: sinon.stub().returnsThis(),
    eq: sinon.stub().returnsThis(),
    gte: sinon.stub().returnsThis(),
    lte: sinon.stub().returnsThis(),
    in: sinon.stub().returnsThis(),
    limit: sinon.stub().resolves({ data: execRows, error: null }),
  };
  const sitesChain = {
    select: sinon.stub().returnsThis(),
    eq: sinon.stub().returnsThis(),
    limit: sinon.stub().resolves({ data: siteRows, error: null }),
  };
  const fromStub = sinon.stub().callsFake((table) => (table === 'sites' ? sitesChain : execChain));
  return { from: fromStub, execChain, sitesChain };
}

describe('createPromptExecutionStatusHandler', () => {
  let getOrgAndValidateAccess;

  beforeEach(() => {
    getOrgAndValidateAccess = sinon.stub().resolves({ organization: {} });
  });

  it('returns 400 when promptIds is missing', async () => {
    const handler = createPromptExecutionStatusHandler(getOrgAndValidateAccess);
    const ctx = makeContext({});
    ctx.dataAccess.Site.postgrestService = makeClient();
    const res = await handler(ctx);
    expect(res.status).to.equal(400);
  });

  it('returns 400 when promptIds contains no valid UUIDs', async () => {
    const handler = createPromptExecutionStatusHandler(getOrgAndValidateAccess);
    const ctx = makeContext({ promptIds: 'not-a-uuid,also-bad' });
    ctx.dataAccess.Site.postgrestService = makeClient();
    const res = await handler(ctx);
    expect(res.status).to.equal(400);
  });

  it('accepts promptIds passed as an array', async () => {
    const handler = createPromptExecutionStatusHandler(getOrgAndValidateAccess);
    const ctx = makeContext({ promptIds: [PROMPT_ID_1, PROMPT_ID_2] });
    ctx.dataAccess.Site.postgrestService = makeClient([]);
    const res = await handler(ctx);
    expect(res.status).to.equal(200);
  });

  it('returns 400 when promptIds is a non-string non-array value', async () => {
    const handler = createPromptExecutionStatusHandler(getOrgAndValidateAccess);
    const ctx = makeContext({ promptIds: 12345 });
    ctx.dataAccess.Site.postgrestService = makeClient();
    const res = await handler(ctx);
    expect(res.status).to.equal(400);
  });

  it('returns aggregated items for valid promptIds', async () => {
    const rows = [
      {
        topic_id: TOPIC_ID_1, prompt: 'What is AI?', region_code: 'US', model: 'chatgpt-free',
      },
      {
        topic_id: TOPIC_ID_1, prompt: 'What is AI?', region_code: 'US', model: 'google',
      },
      {
        topic_id: TOPIC_ID_1, prompt: 'What is AI?', region_code: 'DE', model: 'chatgpt-free',
      },
      {
        topic_id: TOPIC_ID_2, prompt: 'Tell me about X', region_code: 'US', model: 'perplexity',
      },
    ];
    const handler = createPromptExecutionStatusHandler(getOrgAndValidateAccess);
    const ctx = makeContext({
      promptIds: `${PROMPT_ID_1},${PROMPT_ID_2}`,
      startDate: '2026-04-28',
      endDate: '2026-05-04',
    });
    ctx.dataAccess.Site.postgrestService = makeClient(rows);

    const res = await handler(ctx);
    expect(res.status).to.equal(200);

    const body = await res.json();
    expect(body.items).to.have.length(3);

    const usItem = body.items.find(
      (i) => i.topicId === TOPIC_ID_1 && i.prompt === 'What is AI?' && i.regionCode === 'US',
    );
    expect(usItem).to.exist;
    expect(usItem.matchedModels).to.deep.equal(['chatgpt', 'google']);

    const deItem = body.items.find(
      (i) => i.topicId === TOPIC_ID_1 && i.prompt === 'What is AI?' && i.regionCode === 'DE',
    );
    expect(deItem.matchedModels).to.deep.equal(['chatgpt']);

    const t2Item = body.items.find((i) => i.topicId === TOPIC_ID_2);
    expect(t2Item.matchedModels).to.deep.equal(['perplexity']);
  });

  it('filters by prompt_id and passes siteId filter when provided', async () => {
    const handler = createPromptExecutionStatusHandler(getOrgAndValidateAccess);
    const client = makeClient([]);
    const ctx = makeContext({
      promptIds: PROMPT_ID_1,
      siteId: SITE_ID,
      startDate: '2026-04-28',
      endDate: '2026-05-04',
    });
    ctx.dataAccess.Site.postgrestService = client;

    await handler(ctx);
    expect(client.execChain.in.calledWith('prompt_id', [PROMPT_ID_1])).to.be.true;
    expect(client.execChain.eq.calledWith('site_id', SITE_ID)).to.be.true;
  });

  it('returns 403 when siteId does not belong to org', async () => {
    const handler = createPromptExecutionStatusHandler(getOrgAndValidateAccess);
    const client = makeClient([], []); // empty site rows → site not in org
    const ctx = makeContext({
      promptIds: PROMPT_ID_1,
      siteId: SITE_ID,
    });
    ctx.dataAccess.Site.postgrestService = client;

    const res = await handler(ctx);
    expect(res.status).to.equal(403);
  });

  it('returns 400 when PostgREST query fails', async () => {
    const handler = createPromptExecutionStatusHandler(getOrgAndValidateAccess);
    const execChain = {
      select: sinon.stub().returnsThis(),
      eq: sinon.stub().returnsThis(),
      gte: sinon.stub().returnsThis(),
      lte: sinon.stub().returnsThis(),
      in: sinon.stub().returnsThis(),
      limit: sinon.stub().resolves({ data: null, error: { message: 'db error' } }),
    };
    const client = { from: sinon.stub().returns(execChain) };
    const ctx = makeContext({ promptIds: PROMPT_ID_1 });
    ctx.dataAccess.Site.postgrestService = client;

    const res = await handler(ctx);
    expect(res.status).to.equal(400);
  });

  it('returns 400 when PostgREST service is unavailable', async () => {
    const handler = createPromptExecutionStatusHandler(getOrgAndValidateAccess);
    const ctx = makeContext({ promptIds: PROMPT_ID_1 });
    ctx.dataAccess.Site.postgrestService = null;

    const res = await handler(ctx);
    expect(res.status).to.equal(400);
  });

  it('returns empty items when no execution rows match', async () => {
    const handler = createPromptExecutionStatusHandler(getOrgAndValidateAccess);
    const ctx = makeContext({ promptIds: PROMPT_ID_1 });
    ctx.dataAccess.Site.postgrestService = makeClient([]);

    const res = await handler(ctx);
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.items).to.deep.equal([]);
  });

  it('returns empty items when PostgREST returns null data without error', async () => {
    const handler = createPromptExecutionStatusHandler(getOrgAndValidateAccess);
    const execChain = {
      select: sinon.stub().returnsThis(),
      eq: sinon.stub().returnsThis(),
      gte: sinon.stub().returnsThis(),
      lte: sinon.stub().returnsThis(),
      in: sinon.stub().returnsThis(),
      limit: sinon.stub().resolves({ data: null, error: null }),
    };
    const client = { from: sinon.stub().returns(execChain) };
    const ctx = makeContext({ promptIds: PROMPT_ID_1 });
    ctx.dataAccess.Site.postgrestService = client;

    const res = await handler(ctx);
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.items).to.deep.equal([]);
  });
});
