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

import { expect } from 'chai';
import sinon from 'sinon';
import trigger from '../../src/trigger/lhs.js';

describe('trigger function', () => {
  let context;
  let dataAccessMock;
  let sqsMock;
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    dataAccessMock = {
      getSitesToAudit: sandbox.stub(),
      getSiteByBaseURL: sandbox.stub(),
    };

    sqsMock = {
      sendMessage: sandbox.stub().resolves(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('triggers an audit for all sites when url is "ALL"', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'ALL' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    dataAccessMock.getSitesToAudit.resolves(['http://site1.com', 'http://site2.com']);

    const response = await trigger(context);
    const result = await response.json();

    expect(dataAccessMock.getSitesToAudit.calledOnce).to.be.true;
    expect(sqsMock.sendMessage.callCount).to.equal(2);
    expect(result.message).to.equal('Triggering auditType audit for all 2 sites');
  });

  it('triggers an audit for a single site when url is specific', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'http://example.com' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    dataAccessMock.getSiteByBaseURL.resolves({ getBaseURL: () => 'http://site1.com' });

    const response = await trigger(context);
    const result = await response.json();

    expect(dataAccessMock.getSiteByBaseURL.calledOnceWith('http://example.com')).to.be.true;
    expect(sqsMock.sendMessage.calledOnce).to.be.true;
    expect(result.message).to.equal('Triggering auditType audit for http://site1.com');
  });

  it('returns a 404 response when the site is not found', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'https://example.com' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    dataAccessMock.getSiteByBaseURL.resolves(null);

    const response = await trigger(context);
    const result = await response.json();

    expect(response.status).to.equal(404);
    expect(result.error).to.equal('Site not found');
  });

  it('should handle unexpected errors gracefully', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'https://example.com' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    dataAccessMock.getSiteByBaseURL.rejects(new Error('Unexpected error'));

    const response = await trigger(context);
    const result = await response.json();

    expect(response.status).to.equal(500);
    expect(result.error).to.equal('Unexpected error');
  });
});
