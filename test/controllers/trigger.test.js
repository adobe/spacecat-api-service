/*
 * Copyright 2013 Adobe. All rights reserved.
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
import handler from '../../src/controllers/trigger.js';

use(sinonChai);
use(chaiAsPromised);

const sandbox = sinon.createSandbox();

describe('trigger handler', () => {
  let context;
  const orgs = [{
    getId: () => 'org123',
    getName: () => 'ABCD',
    getAuditConfig: sinon.stub().returns({
      auditsDisabled: sinon.stub().returns(true),
      getAuditTypeConfig: sinon.stub().returns({
        disabled: sinon.stub().returns(false),
      }),
    }),
  }];
  const site = {
    getId: () => 'site1',
    baseURL: 'http://site1.com',
    getOrganizationId: () => 'org123',
    getAuditConfig: sinon.stub().returns({
      auditsDisabled: sinon.stub().returns(true),
      getAuditTypeConfig: sinon.stub().returns({
        disabled: sinon.stub().returns(false),
      }),
    }),
  };

  beforeEach('setup', () => {
    context = {
      log: console,
      data: {
        type: 'cwv',
        url: 'space.cat',
      },
      dataAccess: {
        Configuration: {
          findLatest: sandbox.stub().resolves({ isHandlerEnabledForSite: () => true }),
        },
        Organization: {
          all: sandbox.stub().resolves(orgs),
        },
        Site: {
          findByBaseURL: sandbox.stub().resolves(site),
        },
      },
    };
  });

  afterEach('clean', () => {
    sandbox.restore();
  });

  it('rejects when url is missing', async () => {
    delete context.data.type;
    const resp = await handler(context);
    expect(resp.status).to.equal(400);
  });

  it('rejects when type is missing', async () => {
    delete context.data.url;
    const resp = await handler(context);
    expect(resp.status).to.equal(400);
  });

  it('rejects when audit type is unknown', async () => {
    context.data.type = 'unknown-audit-type';
    const resp = await handler(context);
    expect(resp.status).to.equal(400);
  });

  it('fails when cvw handler returns exception', async () => {
    context.env = {
      RUM_DOMAIN_KEY: 'domainkey',
      AUDIT_JOBS_QUEUE_URL: 'queueUrl',
    };

    await expect(handler(context)).to.be.rejectedWith('Failed to trigger cwv audit for space.cat');
  });

  it('successfully executes when RUM API response is correct json format', async () => {
    context.data.type = 'cwv';
    context.env = {
      AUDIT_JOBS_QUEUE_URL: 'queueUrl',
    };
    context.sqs = { sendMessage: () => {} };
    await expect(handler(context)).to.be.fulfilled;
  });
});
