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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import nock from 'nock';
import trigger, { INITIAL_APEX_SLACK_MESSAGE } from '../../../src/controllers/trigger/apex.js';
import { getQueryParams } from '../../../src/utils/slack/base.js';

use(sinonChai);

describe('Apex trigger', () => {
  let context;
  let dataAccessMock;
  let sqsMock;
  let sandbox;
  let sites;
  let orgs;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    const configuration = {
      isHandlerEnabledForSite: sandbox.stub().resolves(true),
    };

    sites = [
      {
        getId: () => 'site1',
        baseURL: 'http://site1.com',
        organizationId: 'org123',
      },
      {
        getId: () => 'site2',
        baseURL: 'http://site2.com',
        organizationId: 'org123',
      },
    ];

    orgs = [
      {
        id: 'org123',
        name: 'ABCD',
      },
    ];

    dataAccessMock = {
      Configuration: {
        findLatest: sandbox.stub().resolves(configuration),
      },
      Organization: {
        all: sandbox.stub().resolves(orgs),
      },
      Site: {
        allByDeliveryType: sandbox.stub().resolves(sites),
      },
    };

    sqsMock = {
      sendMessage: sandbox.stub().resolves(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('triggers a single apex audit', async () => {
    context = {
      log: console,
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'apex', url: 'ALL' },
      env: {
        AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com',
        SLACK_BOT_TOKEN: 'token',
        AUDIT_REPORT_SLACK_CHANNEL_ID: 'DSA',
      },
    };

    // dataAccessMock.getSitesByDeliveryType.resolves(sites);

    nock('https://slack.com')
      .get('/api/chat.postMessage')
      .query(getQueryParams('DSA', INITIAL_APEX_SLACK_MESSAGE))
      .reply(200, {
        ok: true,
        channel: 'DSA',
        ts: 'ts1',
      });

    const response = await trigger(context, [context.data.type]);
    const result = await response.json();

    expect(dataAccessMock.Site.allByDeliveryType).to.have.been.calledOnce;
    expect(sqsMock.sendMessage.callCount).to.equal(2);
    expect(result.message[0]).to.equal('Triggered apex audit for all 2 sites');
  });
});
