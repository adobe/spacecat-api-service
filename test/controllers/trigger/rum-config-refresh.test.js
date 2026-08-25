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

import sinon from 'sinon';
import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import rumConfigRefresh from '../../../src/controllers/trigger/rum-config-refresh.js';

use(sinonChai);
use(chaiAsPromised);

const sandbox = sinon.createSandbox();

describe('rum-config-refresh handler', () => {
  let context;
  let dataAccessMock;
  let sqsMock;
  let sites;

  beforeEach(() => {
    const configuration = {
      isHandlerEnabledForSite: sandbox.stub(),
    };

    sites = [
      { getId: () => 'site1', baseURL: 'https://site1.com' },
      { getId: () => 'site2', baseURL: 'https://site2.com' },
    ];

    configuration.isHandlerEnabledForSite.withArgs('rum-config-refresh', sites[0]).returns(false);
    configuration.isHandlerEnabledForSite.withArgs('rum-config-refresh', sites[1]).returns(true);

    dataAccessMock = {
      Configuration: {
        findLatest: sandbox.stub().resolves(configuration),
      },
      Site: {
        all: sandbox.stub().resolves(sites),
        findByBaseURL: sandbox.stub().resolves(sites[1]),
      },
    };

    sqsMock = {
      sendMessage: sandbox.stub().resolves(),
    };

    context = {
      log: console,
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      env: { AUDIT_JOBS_QUEUE_URL: 'https://sqs-queue-url.com' },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('triggers rum-config-refresh audit for all enabled sites', async () => {
    context.data = { type: 'rum-config-refresh', url: 'ALL' };

    const response = await rumConfigRefresh(context);
    const result = await response.json();

    expect(dataAccessMock.Site.all.calledOnce).to.be.true;
    expect(sqsMock.sendMessage.callCount).to.equal(1);
    expect(result.message[0]).to.equal('Triggered rum-config-refresh audit for site2');
  });

  it('triggers rum-config-refresh audit for a single site', async () => {
    context.data = { type: 'rum-config-refresh', url: 'https://site2.com' };

    const response = await rumConfigRefresh(context);
    const result = await response.json();

    expect(dataAccessMock.Site.findByBaseURL.calledOnce).to.be.true;
    expect(sqsMock.sendMessage.callCount).to.equal(1);
    expect(result.message[0]).to.equal('Triggered rum-config-refresh audit for site2');
  });

  it('returns not found when site does not exist', async () => {
    dataAccessMock.Site.findByBaseURL.resolves(null);
    context.data = { type: 'rum-config-refresh', url: 'https://unknown.com' };

    const response = await rumConfigRefresh(context);

    expect(response.status).to.equal(404);
  });

  it('returns message when no site is enabled for the audit type', async () => {
    const configuration = { isHandlerEnabledForSite: sandbox.stub().returns(false) };
    dataAccessMock.Configuration.findLatest.resolves(configuration);
    context.data = { type: 'rum-config-refresh', url: 'ALL' };

    const response = await rumConfigRefresh(context);
    const result = await response.json();

    expect(sqsMock.sendMessage.callCount).to.equal(0);
    expect(result.message[0]).to.equal('No site is enabled for rum-config-refresh audit type');
  });
});
