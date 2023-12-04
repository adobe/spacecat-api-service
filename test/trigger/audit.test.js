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
/* eslint-disable no-unused-expressions */ // expect statements

import sinon from 'sinon';
import chai from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import nock from 'nock';
import triggerAudit, {
  getSlackChannelId, DEFAULT_PARAMS, FALLBACK_SLACK_CHANNEL, SLACK_MESSAGE,
} from '../../src/trigger/audit.js';
import { emptyResponse, fullResponse } from './data.js';
import { getQueryParams } from '../../src/support/slack.js';

chai.use(sinonChai);
chai.use(chaiAsPromised);
const { expect } = chai;

const sandbox = sinon.createSandbox();

describe('audit handler', () => {
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
        SLACK_BOT_TOKEN: 'token',
        TARGET_SLACK_CHANNELS: 'ch1=ASD,ch2=DSA,ch3=TRE',
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
    await expect(triggerAudit(context)).to.be.rejectedWith('Required env variables is missing');
  });

  it('rejects when queueUrl is not set', async () => {
    delete context.env.AUDIT_JOBS_QUEUE_URL;
    await expect(triggerAudit(context)).to.be.rejectedWith('Required env variables is missing');
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

    await expect(triggerAudit(context)).to.be.rejectedWith('Unexpected response format. $.results.data is not array');
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

    const resp = await triggerAudit(context);

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

    const resp = await triggerAudit(context);

    expect(resp.status).to.equal(404);
  });

  it('queue the audit task when requested url in rum api', async () => {
    context.data.type = 'cwv';
    context.data.url = 'adobe.com';
    context.data.target = 'ch3';

    nock('https://helix-pages.anywhere.run')
      .get('/helix-services/run-query@v3/dash/domain-list')
      .query({
        ...DEFAULT_PARAMS,
        domainkey: context.env.RUM_DOMAIN_KEY,
      })
      .reply(200, fullResponse);

    const resp = await triggerAudit(context);

    const message = {
      type: context.data.type,
      url: context.data.url,
      auditContext: { slackContext: { channel: 'TRE' } },
    };

    expect(context.sqs.sendMessage).to.have.been.calledOnce;
    expect(context.sqs.sendMessage).to.have.been
      .calledWith(context.env.AUDIT_JOBS_QUEUE_URL, message);
    expect(resp.status).to.equal(200);
  });

  it('queue multiple audit tasks when all urls requested', async () => {
    context.data.type = 'cwv';
    context.data.url = 'all';
    context.data.target = 'ch2';

    nock('https://helix-pages.anywhere.run')
      .get('/helix-services/run-query@v3/dash/domain-list')
      .query({
        ...DEFAULT_PARAMS,
        domainkey: context.env.RUM_DOMAIN_KEY,
      })
      .reply(200, fullResponse);

    nock('https://slack.com')
      .get('/api/chat.postMessage')
      .query(getQueryParams('DSA', SLACK_MESSAGE.cvw))
      .reply(200, {
        ok: true,
        channel: 'DSA',
        ts: 'ts1',
      });

    const resp = await triggerAudit(context);

    expect(context.sqs.sendMessage).to.have.been.calledThrice;
    expect(context.sqs.sendMessage).to.have.been.calledWith(context.env.AUDIT_JOBS_QUEUE_URL, {
      type: 'cwv',
      url: 'adobe.com',
      auditContext: { slackContext: { channel: 'DSA', ts: 'ts1' } },
    });
    expect(context.sqs.sendMessage).to.have.been.calledWith(context.env.AUDIT_JOBS_QUEUE_URL, {
      type: 'cwv',
      url: 'bamboohr.com',
      auditContext: { slackContext: { channel: 'DSA', ts: 'ts1' } },
    });
    expect(context.sqs.sendMessage).to.have.been.calledWith(context.env.AUDIT_JOBS_QUEUE_URL, {
      type: 'cwv',
      url: 'nurtec.com',
      auditContext: { slackContext: { channel: 'DSA', ts: 'ts1' } },
    });
    expect(resp.status).to.equal(200);
  });

  it('fallbacks to default slack channel when no configured', async () => {
    expect(getSlackChannelId(undefined, undefined)).to.equal(FALLBACK_SLACK_CHANNEL);
    expect(getSlackChannelId(null, '')).to.equal(FALLBACK_SLACK_CHANNEL);
    expect(getSlackChannelId(undefined, '')).to.equal(FALLBACK_SLACK_CHANNEL);
    expect(getSlackChannelId(undefined, ',')).to.equal(FALLBACK_SLACK_CHANNEL);
    expect(getSlackChannelId(undefined, '=,')).to.equal(FALLBACK_SLACK_CHANNEL);
    expect(getSlackChannelId(undefined, 'ch= ,')).to.equal(FALLBACK_SLACK_CHANNEL);
    expect(getSlackChannelId('channel', 'channel1=,channel2= ')).to.equal(FALLBACK_SLACK_CHANNEL);
    expect(getSlackChannelId(null, 'asd')).to.equal(FALLBACK_SLACK_CHANNEL);
  });

  it('fallbacks to default slack channel when no found in env', async () => {
    const channelId = getSlackChannelId('ch4', 'ch1=ASD,ch2=DSA,ch3=TRE');
    expect(channelId).to.equal(FALLBACK_SLACK_CHANNEL);
  });

  it('returs to desired slack channel', async () => {
    const channelId = getSlackChannelId('ch3', 'ch1=ASD,ch2=DSA,ch3=TRE');
    expect(channelId).to.equal('TRE');
  });
});
