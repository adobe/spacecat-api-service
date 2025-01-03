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
import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import cwv from '../../../src/controllers/trigger/cwv.js';

use(sinonChai);
use(chaiAsPromised);

const sandbox = sinon.createSandbox();

describe('cvw handler', () => {
  let context;
  let dataAccessMock;
  let sqsMock;
  let sites;
  let orgs;

  beforeEach(() => {
    const configuration = {
      isHandlerEnabledForSite: sandbox.stub(),
    };
    sites = [
      {
        getId: () => 'site1',
        baseURL: 'http://site1.com',
      },
      {
        getId: () => 'site2',
        baseURL: 'http://site2.com',
      },
    ];
    configuration.isHandlerEnabledForSite.withArgs('cwv', sites[0]).returns(false);
    configuration.isHandlerEnabledForSite.withArgs('cwv', sites[1]).returns(true);
    orgs = [
      {
        id: 'default',
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

  it('triggers a cwv audit', async () => {
    context = {
      log: console,
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'cwv', url: 'ALL' },
      env: {
        AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com',
        SLACK_BOT_TOKEN: 'token',
        AUDIT_REPORT_SLACK_CHANNEL_ID: 'DSA',
      },
    };

    const response = await cwv(context);
    const result = await response.json();

    expect(dataAccessMock.Site.allByDeliveryType.calledOnce).to.be.true;
    expect(sqsMock.sendMessage.callCount).to.equal(1);
    expect(result.message[0]).to.equal('Triggered cwv audit for site2');
  });
});
