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

import { createSite } from '@adobe/spacecat-shared-data-access/src/models/site.js';

import { expect } from 'chai';
import sinon from 'sinon';

import trigger from '../../../src/controllers/trigger/lhs.js';

describe('LHS Trigger', () => {
  let context;
  let dataAccessMock;
  let sqsMock;
  let sandbox;
  let sites;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    sites = [
      createSite({
        id: 'site1',
        baseURL: 'http://site1.com',
        organizationId: 'org123',
      }),
      createSite({
        id: 'site2',
        baseURL: 'http://site2.com',
        organizationId: 'org123',
      }),
    ];

    dataAccessMock = {
      getSites: sandbox.stub(),
      getSiteByBaseURL: sandbox.stub(),
      getSiteByID: sandbox.stub(),
    };

    sqsMock = {
      sendMessage: sandbox.stub().resolves(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('triggers a single audit for all sites when url is "ALL"', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'lhs-mobile', url: 'ALL' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    dataAccessMock.getSites.resolves(sites);

    const response = await trigger(context);
    const result = await response.json();

    expect(dataAccessMock.getSites.calledOnce).to.be.true;
    expect(sqsMock.sendMessage.callCount).to.equal(2);
    expect(result.message[0]).to.equal('Triggered lhs-mobile audit for all 2 sites');
  });

  it('triggers audits of both lhs types for all sites', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'lhs', url: 'ALL' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    dataAccessMock.getSites.resolves(sites);

    const response = await trigger(context);
    const result = await response.json();

    expect(dataAccessMock.getSites.calledOnce).to.be.true;
    expect(sqsMock.sendMessage.callCount).to.equal(4);
    expect(result.message).to.be.an('array').with.lengthOf(2);
    expect(result.message[0]).to.equal('Triggered lhs-desktop audit for all 2 sites');
    expect(result.message[1]).to.equal('Triggered lhs-mobile audit for all 2 sites');
  });
});
