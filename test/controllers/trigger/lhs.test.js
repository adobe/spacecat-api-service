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
        imsOrgId: 'org123',
      }),
      createSite({
        id: 'site2',
        baseURL: 'http://site2.com',
        imsOrgId: 'org123',
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

  it('triggers an audit for all sites when url is "ALL"', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'ALL' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    dataAccessMock.getSites.resolves(sites);

    const response = await trigger(context);
    const result = await response.json();

    expect(dataAccessMock.getSites.calledOnce).to.be.true;
    expect(sqsMock.sendMessage.callCount).to.equal(2);
    expect(result.message[0]).to.equal('Triggered auditType audit for all 2 sites');
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

  it('triggers an audit for a single site when url is specific', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'http://site1.com' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    dataAccessMock.getSiteByBaseURL.resolves(sites[0]);

    const response = await trigger(context);
    const result = await response.json();

    expect(dataAccessMock.getSiteByBaseURL.calledOnceWith('http://site1.com')).to.be.true;
    expect(sqsMock.sendMessage.calledOnce).to.be.true;
    expect(result.message[0]).to.equal('Triggered auditType audit for site1');
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
    expect(result.message).to.equal('Site not found');
  });

  it('does not trigger audit when audits are disabled for sites', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'all' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    dataAccessMock.getSites.resolves([
      createSite({
        id: 'site1',
        baseURL: 'http://site1.com',
        imsOrgId: 'org123',
        auditConfig: { auditsDisabled: true },
      }),
      createSite({
        id: 'site2',
        baseURL: 'http://site2.com',
        imsOrgId: 'org123',
        auditConfig: { auditsDisabled: false },
      }),
    ]);

    const response = await trigger(context);

    expect(response.status).to.equal(200);
    expect(sqsMock.sendMessage.callCount).to.equal(1);
  });

  it('does not trigger audit for site where audit type is disabled', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'all' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    dataAccessMock.getSites.resolves([
      createSite({
        id: 'site1',
        baseURL: 'http://site1.com',
        imsOrgId: 'org123',
        auditConfig: { auditsDisabled: false, auditTypeConfigs: { auditType: { disabled: true } } },
      }),
      createSite({
        id: 'site2',
        baseURL: 'http://site2.com',
        imsOrgId: 'org123',
        auditConfig: { auditsDisabled: false },
      }),
    ]);

    const response = await trigger(context);

    expect(response.status).to.equal(200);
    expect(sqsMock.sendMessage.callCount).to.equal(1);
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

    expect(response.status).to.equal(500);
    expect(response.headers.get('x-error')).to.equal('internal server error: Error: Unexpected error');
  });
});
