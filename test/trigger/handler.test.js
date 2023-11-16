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
/* eslint-disable no-unused-expressions */ // expect statements

import sinon from 'sinon';
import chai from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import nock from 'nock';
import handler from '../../src/trigger/handler.js';

chai.use(sinonChai);
chai.use(chaiAsPromised);
const { expect } = chai;

const sandbox = sinon.createSandbox();

describe('trigger handler', () => {
  let context;

  beforeEach('setup', () => {
    context = {
      log: console,
      data: {
        type: 'cwv',
        url: 'space.cat',
      },
    };
  });

  afterEach('clean', () => {
    sandbox.restore();
  });

  it('rejects when domainkey is not set', async () => {
    delete context.data.type;
    const resp = await handler(context);
    expect(resp.status).to.equal(400);
  });

  it('rejects when domainkey is not set2', async () => {
    delete context.data.url;
    const resp = await handler(context);
    expect(resp.status).to.equal(400);
  });

  it('rejects when domainkey is not set3', async () => {
    context.data.type = 'unknown-audit-type';
    const resp = await handler(context);
    expect(resp.status).to.equal(400);
  });

  it('rejects when domainkey is not set4', async () => {
    context.env = {
      RUM_DOMAIN_KEY: 'domainkey',
      AUDIT_JOBS_QUEUE_URL: 'queueUrl',
    };

    nock('https://helix-pages.anywhere.run')
      .get('/helix-services/run-query@v3/dash/domain-list')
      .query(true)
      .reply(200, 'invalid-response');

    await expect(handler(context)).to.be.rejectedWith('Failed to trigger cwv audit for space.cat');
  });
});
