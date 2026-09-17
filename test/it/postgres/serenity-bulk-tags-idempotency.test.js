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
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { acceptBulkTags } from '../../../src/support/serenity/handlers/bulk-tags-job.js';
import { POSTGREST_WRITER_JWT } from '../shared/postgrest-jwt.js';
import { resetPostgres } from './seed.js';

const POSTGREST_URL = `http://localhost:${process.env.IT_POSTGREST_PORT || '3300'}`;
const ORG_ID = '11111111-1111-4111-b111-111111111111';
const PROMISE_TOKEN = { promise_token: 'it-promise-token' };
const PROMISE_PAIR = 'SEMRUSH';
const BULK_JOB_TYPE = 'serenity-bulk-tags';
const IDEMPOTENCY_ENDPOINT = 'POST /serenity/prompts/bulk-tags';

const requestBody = {
  geoTargetId: 1,
  languageCode: 'en',
  operation: 'assign',
  tagIds: ['family'],
  filter: { search: 'launch', tagIds: [], tagFilterMode: 'faceted-v1' },
};

function createIntegrationDataAccess() {
  return createDataAccess({
    postgrestUrl: POSTGREST_URL,
    postgrestSchema: 'public',
    postgrestApiKey: POSTGREST_WRITER_JWT,
    region: 'us-east-1',
  }, {
    debug() {},
    info() {},
    warn() {},
    error() {},
  });
}

function createTransport() {
  return {
    listProjectTags: sinon.stub().callsFake((_, __, options = {}) => Promise.resolve({
      items: options.parentId === 'tag-root'
        ? [{
          id: 'family',
          name: 'Family',
          parent_id: 'tag-root',
          children_count: 0,
          path: [{ id: 'tag-root', name: 'tag' }],
        }]
        : [{ id: 'tag-root', name: 'tag', children_count: 1 }],
    })),
  };
}

function createContext(dataAccess, sendMessage) {
  return {
    dataAccess,
    sqs: { sendMessage },
    env: { SERENITY_JOB_RUNNER_QUEUE_URL: 'it-serenity-jobs' },
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  };
}

function accept({
  context,
  callerId = 'caller-a',
  projectId = 'project-a',
  idempotencyKey = 'shared-key',
  body = requestBody,
}) {
  return acceptBulkTags({
    context,
    transport: createTransport(),
    brandId: 'brand-a',
    orgId: ORG_ID,
    workspaceId: 'workspace-a',
    projectId,
    body,
    callerId,
    idempotencyKey,
    log: context.log,
    promiseToken: PROMISE_TOKEN,
    promisePair: PROMISE_PAIR,
  });
}

async function selectRows(client, table, configure) {
  const query = configure(client.from(table).select('*'));
  const { data, error } = await query;
  if (error) {
    throw error;
  }
  return data;
}

describe('Serenity bulk-tag PostgreSQL idempotency', () => {
  beforeEach(async () => {
    await resetPostgres();
  });

  it('atomically converges concurrent requests and replays in-progress and terminal jobs', async () => {
    const firstDataAccess = createIntegrationDataAccess();
    const secondDataAccess = createIntegrationDataAccess();
    const sendMessage = sinon.stub().callsFake(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });

    const responses = await Promise.all([
      accept({ context: createContext(firstDataAccess, sendMessage) }),
      accept({ context: createContext(secondDataAccess, sendMessage) }),
    ]);

    expect(responses.map(({ status }) => status).sort()).to.deep.equal([200, 202]);
    expect(responses[0].body.jobId).to.equal(responses[1].body.jobId);
    expect(responses.map(({ body }) => body.replayed).sort()).to.deep.equal([false, true]);
    expect(sendMessage).to.have.been.calledOnce;

    const jobs = await selectRows(
      firstDataAccess.services.postgrestClient,
      'async_jobs',
      (query) => query.eq('metadata->>jobType', BULK_JOB_TYPE),
    );
    const keys = await selectRows(
      firstDataAccess.services.postgrestClient,
      'idempotency_keys',
      (query) => query.eq('organization_id', ORG_ID).eq('endpoint', IDEMPOTENCY_ENDPOINT),
    );
    expect(jobs).to.have.length(1);
    expect(keys).to.have.length(1);
    expect(keys[0]).to.include({ status: 'completed' });
    expect(keys[0].response).to.include({ jobId: jobs[0].id });
    expect(Date.parse(keys[0].expires_at)).to.be.greaterThan(Date.now());

    const job = await firstDataAccess.AsyncJob.findById(jobs[0].id);
    job.setStatus('COMPLETED');
    job.setResult({ outcome: 'SUCCESS' });
    await job.save();

    const terminalReplay = await accept({
      context: createContext(secondDataAccess, sendMessage),
    });
    expect(terminalReplay).to.deep.equal({
      status: 200,
      body: {
        jobId: jobs[0].id,
        jobType: 'bulkTags',
        status: 'COMPLETED',
        replayed: true,
      },
    });
    expect(sendMessage).to.have.been.calledOnce;

    const canonicalReplay = await accept({
      context: createContext(secondDataAccess, sendMessage),
      body: {
        ...requestBody,
        tagIds: ['family', 'family'],
        filter: {
          tagIds: [],
          tagFilterMode: 'faceted-v1',
          search: 'launch',
        },
      },
    });
    expect(canonicalReplay.body.jobId).to.equal(jobs[0].id);
    expect(canonicalReplay.body.replayed).to.equal(true);
    expect(sendMessage).to.have.been.calledOnce;

    const conflicts = await Promise.all([
      { body: { ...requestBody, operation: 'remove' } },
      { body: { ...requestBody, tagIds: ['different-tag'] } },
      {
        body: {
          ...requestBody,
          filter: { ...requestBody.filter, search: 'different search' },
        },
      },
    ].map(async (changedRequest) => {
      try {
        await accept({
          context: createContext(secondDataAccess, sendMessage),
          ...changedRequest,
        });
        return null;
      } catch (error) {
        return error;
      }
    }));
    conflicts.forEach((conflict) => {
      expect(conflict).to.include({ status: 409, code: 'idempotencyConflict' });
    });
    expect(sendMessage).to.have.been.calledOnce;
  });

  it('rejects cross-scope key reuse and replaces an expired record', async () => {
    const dataAccess = createIntegrationDataAccess();
    const sendMessage = sinon.stub().resolves();
    const context = createContext(dataAccess, sendMessage);

    const first = await accept({ context });
    const conflicts = await Promise.all([
      { callerId: 'caller-b' },
      { projectId: 'project-b' },
    ].map(async (changedScope) => {
      let conflict;
      try {
        await accept({ context, ...changedScope });
      } catch (error) {
        conflict = error;
      }
      return conflict;
    }));
    conflicts.forEach((conflict) => {
      expect(conflict).to.include({ status: 409, code: 'idempotencyConflict' });
    });
    expect(sendMessage).to.have.been.calledOnce;

    const keys = await selectRows(
      dataAccess.services.postgrestClient,
      'idempotency_keys',
      (query) => query.eq('organization_id', ORG_ID).eq('endpoint', IDEMPOTENCY_ENDPOINT),
    );
    expect(keys).to.have.length(1);
    const firstKey = keys.find(({ response }) => response.jobId === first.body.jobId);
    expect(firstKey).to.exist;

    const { error: expiryError } = await dataAccess.services.postgrestClient
      .from('idempotency_keys')
      .update({ expires_at: '2000-01-01T00:00:00.000Z' })
      .eq('id', firstKey.id);
    expect(expiryError).to.equal(null);

    const replacement = await accept({ context });
    expect(replacement.status).to.equal(202);
    expect(replacement.body.jobId).not.to.equal(first.body.jobId);
    expect(sendMessage).to.have.been.calledTwice;

    const replacementKeys = await selectRows(
      dataAccess.services.postgrestClient,
      'idempotency_keys',
      (query) => query.eq('organization_id', ORG_ID).eq('endpoint', IDEMPOTENCY_ENDPOINT),
    );
    expect(replacementKeys).to.have.length(1);
    expect(replacementKeys.some(({ response }) => response.jobId === replacement.body.jobId))
      .to.equal(true);
  });

  it('removes the job and claim when enqueueing fails', async () => {
    const dataAccess = createIntegrationDataAccess();
    const sendMessage = sinon.stub().rejects(new Error('queue unavailable'));

    await expect(accept({
      context: createContext(dataAccess, sendMessage),
      idempotencyKey: 'failed-key',
    })).to.be.rejectedWith('queue unavailable');

    const jobs = await selectRows(
      dataAccess.services.postgrestClient,
      'async_jobs',
      (query) => query.eq('metadata->>jobType', BULK_JOB_TYPE),
    );
    const keys = await selectRows(
      dataAccess.services.postgrestClient,
      'idempotency_keys',
      (query) => query.eq('organization_id', ORG_ID).eq('endpoint', IDEMPOTENCY_ENDPOINT),
    );
    expect(jobs).to.deep.equal([]);
    expect(keys).to.deep.equal([]);
  });
});
