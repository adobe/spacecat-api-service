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

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import nock from 'nock';
import { getQueryParams, postSlackMessage } from '../../src/support/slack.js';

chai.use(chaiAsPromised);
const { expect } = chai;

describe('slack', () => {
  let context;

  beforeEach('setup', () => {
    context = {
      log: console,
      env: {
        SLACK_BOT_TOKEN: 'tokentoken',
      },
    };
  });

  it('fails when slack bot token is missing', async () => {
    delete context.env.SLACK_BOT_TOKEN;

    await expect(postSlackMessage('ch', 'msg', undefined)).to.be.rejectedWith('Missing slack bot token');
  });

  it('fails when message sending fails', async () => {
    const token = context.env.SLACK_BOT_TOKEN;
    nock('https://slack.com', {
      reqheaders: {
        authorization: `Bearer ${token}`,
      },
    })
      .get('/api/chat.postMessage')
      .query(getQueryParams('ch', 'msg'))
      .reply(400);

    await expect(postSlackMessage('ch', 'msg', token)).to.be.rejectedWith('Failed to send initial slack message. Status: 400');
  });

  it('fails when message was not acknowledged', async () => {
    const token = context.env.SLACK_BOT_TOKEN;
    nock('https://slack.com', {
      reqheaders: {
        authorization: `Bearer ${token}`,
      },
    })
      .get('/api/chat.postMessage')
      .query(getQueryParams('ch', 'msg'))
      .reply(200, {
        ok: false,
        error: 'invalid_blocks',
      });

    await expect(postSlackMessage('ch', 'msg', token)).to.be.rejectedWith('Slack message was not acknowledged. Error: invalid_blocks');
  });

  it('returns channel and thread info when message was sent successfully', async () => {
    const token = context.env.SLACK_BOT_TOKEN;
    nock('https://slack.com', {
      reqheaders: {
        authorization: `Bearer ${token}`,
      },
    })
      .get('/api/chat.postMessage')
      .query(getQueryParams('ch1', 'msg'))
      .reply(200, {
        ok: true,
        channel: 'ch1',
        ts: 'ts1',
      });

    const resp = await postSlackMessage('ch1', 'msg', token);

    expect(resp.channel).to.equal('ch1');
    expect(resp.ts).to.equal('ts1');
  });
});
