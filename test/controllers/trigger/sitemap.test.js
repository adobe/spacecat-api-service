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

import { expect } from 'chai';
import sinon from 'sinon';

import nock from 'nock';
import trigger, { INITIAL_SITEMAP_SLACK_MESSAGE } from '../../../src/controllers/trigger/sitemap.js';
import { getQueryParams } from '../../../src/utils/slack/base.js';

describe('Sitemap trigger', () => {
  let context;
  let dataAccessMock;
  let sqsMock;
  let sandbox;
  let sites;
  let orgs;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    sites = [{
      id: 'site1',
      baseURL: 'http://site1.com',
      getOrganizationId: () => 'org123',
    },
    {
      id: 'site2',
      baseURL: 'http://site2.com',
      getOrganizationId: () => 'org123',
    },
    ];

    orgs = [
      {
        getId: () => 'org123',
        name: 'ABCD',
      }];

    dataAccessMock = {
      getOrganizations: sandbox.stub().resolves(orgs),
      getSitesByDeliveryType: sandbox.stub(),
    };

    sqsMock = {
      sendMessage: sandbox.stub().resolves(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('triggers a sitemap audit', async () => {
    context = {
      log: console,
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'sitemap', url: 'ALL' },
      env: {
        AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com',
        SLACK_BOT_TOKEN: 'token',
        AUDIT_REPORT_SLACK_CHANNEL_ID: 'DSA',
      },
    };

    dataAccessMock.getSitesByDeliveryType.resolves(sites);

    nock('https://slack.com')
      .get('/api/chat.postMessage')
      .query(getQueryParams('DSA', INITIAL_SITEMAP_SLACK_MESSAGE))
      .reply(200, {
        ok: true,
        channel: 'DSA',
        ts: 'ts1',
      });
    for (const site of sites) {
      site.getAuditConfig = sinon.stub().returns({
        auditsDisabled: sinon.stub().returns(true),
        getAuditTypeConfig: sinon.stub().returns({
          disabled: sinon.stub().returns(false),
        }),
      });
    }
    for (const org of orgs) {
      org.getAuditConfig = sinon.stub().returns({
        auditsDisabled: sinon.stub().returns(true),
        getAuditTypeConfig: sinon.stub().returns({
          disabled: sinon.stub().returns(false),
        }),
      });
    }

    const response = await trigger(context);
    const result = await response.json();
    expect(dataAccessMock.getSitesByDeliveryType.calledOnce).to.be.true;
    expect(sqsMock.sendMessage.callCount).to.be.greaterThanOrEqual(0);
    expect(result.message[0]).to.be.contain([]);
  });
});
