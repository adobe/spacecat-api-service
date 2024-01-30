/*
 * Copyright 2024 Adobe. All rights reserved.
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

import { createSite } from '@adobe/spacecat-shared-data-access/src/models/site.js';

import { expect } from 'chai';
import sinon from 'sinon';

import nock from 'nock';
import { getQueryParams } from '../../../src/utils/slack/base.js';
import trigger, { INITIAL_KEYWORDS_SLACK_MESSAGE } from '../../../src/controllers/trigger/keywords.js';

describe('Keywords trigger', () => {
  let context;
  let dataAccessMock;
  let sqsMock;
  let sandbox;
  let sites;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    sites = [
      createSite({
        id: 'id1',
        baseURL: 'https://foo.com',
        auditConfig: {
          auditTypeConfigs: {
            'organic-keywords': {
              disabled: false,
            },
          },
        },
      }),
      createSite({
        id: 'id2',
        baseURL: 'https://bar.com',
      }),
    ];

    dataAccessMock = {
      getSitesByDeliveryType: sandbox.stub(),
    };

    sqsMock = {
      sendMessage: sandbox.stub().resolves(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('triggers a keyword audit', async () => {
    context = {
      log: console,
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'organic-keywords', url: 'ALL' },
      env: {
        AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com',
        SLACK_BOT_TOKEN: 'token',
        AUDIT_REPORT_SLACK_CHANNEL_ID: 'channelId',
      },
    };

    dataAccessMock.getSitesByDeliveryType.resolves(sites);

    nock('https://slack.com')
      .get('/api/chat.postMessage')
      .query(getQueryParams('channelId', INITIAL_KEYWORDS_SLACK_MESSAGE))
      .reply(200, {
        ok: true,
        channel: 'channelId',
        ts: 'threadId',
      });

    const response = await trigger(context);
    const result = await response.json();

    expect(dataAccessMock.getSitesByDeliveryType.calledOnce).to.be.true;
    expect(sqsMock.sendMessage.callCount).to.equal(1);
    expect(result.message[0]).to.equal('Triggered organic-keywords audit for id1');
  });
});
