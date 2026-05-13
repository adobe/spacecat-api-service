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
import { fetchFanoutTopics } from '../../../src/support/fanout/topics-rpc.js';

use(sinonChai);

const ORG_ID = '5d4e5082-b030-433d-9dbd-7007116f701f';
const BRAND_ID = '3e3556f0-6494-4e8f-858f-01f2c358861a';

describe('fetchFanoutTopics', () => {
  let postgrestClient;

  beforeEach(() => {
    postgrestClient = { rpc: sinon.stub() };
  });

  it('calls rpc_fanout_topics with the expected parameters', async () => {
    postgrestClient.rpc.resolves({ data: [], error: null });

    await fetchFanoutTopics(postgrestClient, { organizationId: ORG_ID, brandId: BRAND_ID });

    expect(postgrestClient.rpc).to.have.been.calledWith('rpc_fanout_topics', {
      p_organization_id: ORG_ID,
      p_brand_id: BRAND_ID,
      p_limit: 1000,
    });
  });

  it('honours an explicit limit', async () => {
    postgrestClient.rpc.resolves({ data: [], error: null });

    await fetchFanoutTopics(postgrestClient, {
      organizationId: ORG_ID,
      brandId: BRAND_ID,
      limit: 50,
    });

    expect(postgrestClient.rpc.firstCall.args[1].p_limit).to.equal(50);
  });

  it('maps snake_case rows to camelCase with numeric rates', async () => {
    postgrestClient.rpc.resolves({
      data: [{
        topic_uuid: '11111111-1111-7111-8111-111111111111',
        topic_id: 'best-crm',
        name: 'Best CRM',
        description: 'A description',
        prompts_total: 8,
        mention_rate: '0.47',
        citation_rate: '0.03',
      }],
      error: null,
    });

    const out = await fetchFanoutTopics(postgrestClient, {
      organizationId: ORG_ID,
      brandId: BRAND_ID,
    });

    expect(out).to.deep.equal([{
      topicUuid: '11111111-1111-7111-8111-111111111111',
      topicId: 'best-crm',
      name: 'Best CRM',
      description: 'A description',
      promptsTotal: 8,
      mentionRate: 0.47,
      citationRate: 0.03,
    }]);
  });

  it('preserves null rates for topics with no executions', async () => {
    postgrestClient.rpc.resolves({
      data: [{
        topic_uuid: 'x',
        topic_id: 'x',
        name: 'X',
        description: null,
        prompts_total: 0,
        mention_rate: null,
        citation_rate: null,
      }],
      error: null,
    });

    const [row] = await fetchFanoutTopics(postgrestClient, {
      organizationId: ORG_ID,
      brandId: BRAND_ID,
    });

    expect(row.mentionRate).to.equal(null);
    expect(row.citationRate).to.equal(null);
    expect(row.description).to.equal(null);
  });

  it('handles empty results', async () => {
    postgrestClient.rpc.resolves({ data: null, error: null });

    const out = await fetchFanoutTopics(postgrestClient, {
      organizationId: ORG_ID,
      brandId: BRAND_ID,
    });

    expect(out).to.deep.equal([]);
  });

  it('throws when the RPC returns an error', async () => {
    postgrestClient.rpc.resolves({ data: null, error: { message: 'permission denied' } });

    let thrown;
    try {
      await fetchFanoutTopics(postgrestClient, { organizationId: ORG_ID, brandId: BRAND_ID });
    } catch (e) {
      thrown = e;
    }

    expect(thrown?.message).to.include('rpc_fanout_topics failed: permission denied');
  });
});
