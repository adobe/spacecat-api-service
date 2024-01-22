/*
 * Copyright 2023 Adobe. All rights reserved.
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

import sinon from 'sinon';
import chai from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import nock from 'nock';
import notfound, {
} from '../../../src/controllers/trigger/notfound.js';

import { emptyResponse, fullResponse } from './data.js';

chai.use(sinonChai);
chai.use(chaiAsPromised);

const { expect } = chai;

const sandbox = sinon.createSandbox();
const DEFAULT_PARAMS = {
  interval: 30,
  offset: 0,
  limit: 100000,
};

describe('not found handler', () => {
  let context;

  beforeEach('setup', () => {
    context = {
      log: console,
      runtime: {
        region: 'us-east-1',
      },
      data: {},
      env: {
        AUDIT_JOBS_QUEUE_URL: 'queueUrl',
        RUM_DOMAIN_KEY: 'domainkey',
      },
      sqs: {
        sendMessage: sandbox.stub().resolves(),
      },
    };
  });

  afterEach('clean', () => {
    sandbox.restore();
  });

  it('rejects when domainkey is not set', async () => {
    delete context.env.RUM_DOMAIN_KEY;
    await expect(notfound(context)).to.be.rejectedWith('Required env variables are missing');
  });

  it('rejects when queueUrl is not set', async () => {
    delete context.env.AUDIT_JOBS_QUEUE_URL;
    await expect(notfound(context)).to.be.rejectedWith('Required env variables are missing');
  });

  it('rejects when response is not in expected shape', async () => {
    context.data.url = 'space.cat';
    nock('https://helix-pages.anywhere.run')
      .get('/helix-services/run-query@v3/dash/domain-list')
      .query({
        ...DEFAULT_PARAMS,
        domainkey: context.env.RUM_DOMAIN_KEY,
      })
      .reply(200, '{"key": "value"}');

    await expect(notfound(context)).to.be.rejectedWith('Unexpected response from rum api. $.results.data is not array');
  });

  it('return 404 when empty response is received from the rum api', async () => {
    context.data.url = 'all';
    nock('https://helix-pages.anywhere.run')
      .get('/helix-services/run-query@v3/dash/domain-list')
      .query({
        ...DEFAULT_PARAMS,
        domainkey: context.env.RUM_DOMAIN_KEY,
      })
      .reply(200, emptyResponse);

    const resp = await notfound(context);

    expect(resp.status).to.equal(404);
  });

  it('return 404 when desired url not found in the response coming from the rum api', async () => {
    context.data.url = 'non-existing-url.com';

    nock('https://helix-pages.anywhere.run')
      .get('/helix-services/run-query@v3/dash/domain-list')
      .query({
        ...DEFAULT_PARAMS,
        domainkey: context.env.RUM_DOMAIN_KEY,
      })
      .reply(200, fullResponse);

    const resp = await notfound(context);

    expect(resp.status).to.equal(404);
  });

  it('queue the audit task when requested url in rum api', async () => {
    context.data.type = 'cwv';
    context.data.url = 'adobe.com';

    nock('https://helix-pages.anywhere.run')
      .get('/helix-services/run-query@v3/dash/domain-list')
      .query({
        ...DEFAULT_PARAMS,
        domainkey: context.env.RUM_DOMAIN_KEY,
      })
      .reply(200, fullResponse);

    const resp = await notfound(context);

    const message = {
      type: context.data.type,
      url: `https://${context.data.url}`,
    };

    expect(context.sqs.sendMessage).to.have.been.calledOnce;
    expect(context.sqs.sendMessage).to.have.been
      .calledWith(context.env.AUDIT_JOBS_QUEUE_URL, message);
    expect(resp.status).to.equal(200);
  });

  it('queue multiple audit tasks when all urls requested', async () => {
    context.data.type = 'cwv';
    context.data.url = 'all';

    nock('https://helix-pages.anywhere.run')
      .get('/helix-services/run-query@v3/dash/domain-list')
      .query({
        ...DEFAULT_PARAMS,
        domainkey: context.env.RUM_DOMAIN_KEY,
      })
      .reply(200, fullResponse);

    const resp = await notfound(context);

    expect(context.sqs.sendMessage).to.have.been.calledThrice;
    expect(context.sqs.sendMessage).to.have.been.calledWith(context.env.AUDIT_JOBS_QUEUE_URL, {
      type: 'cwv',
      url: 'https://adobe.com',
    });
    expect(context.sqs.sendMessage).to.have.been.calledWith(context.env.AUDIT_JOBS_QUEUE_URL, {
      type: 'cwv',
      url: 'https://bamboohr.com',
    });
    expect(context.sqs.sendMessage).to.have.been.calledWith(context.env.AUDIT_JOBS_QUEUE_URL, {
      type: 'cwv',
      url: 'https://nurtec.com',
    });
    expect(resp.status).to.equal(200);
  });
});
