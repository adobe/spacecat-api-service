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

/* eslint-env mocha */

import sinon from 'sinon';
import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import cwvTrends from '../../../src/controllers/trigger/cwv-trends.js';

use(sinonChai);
use(chaiAsPromised);

const sandbox = sinon.createSandbox();

describe('cwv-trends handler', () => {
  let context;
  let sqsMock;
  let sites;

  beforeEach(() => {
    const configuration = {
      isHandlerEnabledForSite: sandbox.stub().returns(true),
    };

    sites = [
      { getId: () => 'site1', baseURL: 'http://site1.com' },
    ];

    sqsMock = {
      sendMessage: sandbox.stub().resolves(),
    };

    context = {
      log: console,
      dataAccess: {
        Configuration: {
          findLatest: sandbox.stub().resolves(configuration),
        },
        Site: {
          findByBaseURL: sandbox.stub().resolves(sites[0]),
        },
      },
      sqs: sqsMock,
      data: {
        type: 'cwv-trends-audit',
        url: 'http://site1.com',
      },
      env: {
        AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com',
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('triggers a cwv-trends-audit without endDate', async () => {
    const response = await cwvTrends(context);
    const result = await response.json();

    expect(sqsMock.sendMessage.calledOnce).to.be.true;
    expect(result.message[0]).to.equal('Triggered cwv-trends-audit audit for site1');

    const [, payload] = sqsMock.sendMessage.firstCall.args;
    expect(payload.auditContext).to.deep.equal({});
  });

  it('triggers a cwv-trends-audit with endDate forwarded into auditContext', async () => {
    context.data.endDate = '2026-04-05';

    const response = await cwvTrends(context);
    const result = await response.json();

    expect(sqsMock.sendMessage.calledOnce).to.be.true;
    expect(result.message[0]).to.equal('Triggered cwv-trends-audit audit for site1');

    const [, payload] = sqsMock.sendMessage.firstCall.args;
    expect(payload.auditContext).to.deep.equal({ endDate: '2026-04-05' });
  });

  it('returns 400 when endDate has wrong format', async () => {
    context.data.endDate = 'not-a-date';

    const response = await cwvTrends(context);

    expect(response.status).to.equal(400);
    expect(sqsMock.sendMessage.called).to.be.false;
  });

  it('returns 400 when endDate is an invalid calendar date', async () => {
    context.data.endDate = '2026-13-99';

    const response = await cwvTrends(context);

    expect(response.status).to.equal(400);
    expect(sqsMock.sendMessage.called).to.be.false;
  });
});
