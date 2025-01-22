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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import { triggerFromData } from '../../../../src/controllers/trigger/common/trigger.js';

use(chaiAsPromised);
use(sinonChai);

describe('Trigger from data access', () => {
  let context;
  let dataAccessMock;
  let sqsMock;
  let sandbox;
  let sites;
  let orgs;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    const configuration = {
      isHandlerEnabledForOrg: sandbox.stub(),
      isHandlerEnabledForSite: sandbox.stub(),
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
      {
        getId: () => 'site3',
        baseURL: 'http://site3.com',
        organizationId: 'org124',
      },
      {
        getId: () => 'site4',
        baseURL: 'http://site2.com',
        organizationId: 'org125',
      },
    ];

    orgs = [
      {
        id: 'org123',
        name: 'ABCD',
      },
      {
        id: 'org124',
        name: 'ABCD',
        config: {
          audits: {
            auditsDisabled: true,
          },
        },
      },
      {
        id: 'org125',
        name: 'ABCD',
        config: {
          audits: {
            auditsDisabled: false,
            auditTypeConfigs: {
              auditType: { disabled: true },
              type1: { disabled: true },
              type2: { disabled: true },
            },
          },
        },
      },
    ];
    configuration.isHandlerEnabledForOrg.withArgs('auditType', orgs[0]).returns(false);
    configuration.isHandlerEnabledForOrg.withArgs('type1', orgs[0]).returns(false);
    configuration.isHandlerEnabledForOrg.withArgs('type2', orgs[0]).returns(false);
    configuration.isHandlerEnabledForOrg.withArgs('auditType', orgs[2]).returns(false);
    configuration.isHandlerEnabledForOrg.withArgs('type1', orgs[2]).returns(false);
    configuration.isHandlerEnabledForOrg.withArgs('type2', orgs[2]).returns(false);
    configuration.isHandlerEnabledForSite.withArgs('auditType', sites[0]).returns(true);
    configuration.isHandlerEnabledForSite.withArgs('auditType', sites[1]).returns(true);
    configuration.isHandlerEnabledForSite.withArgs('auditType', sites[2]).returns(false);
    configuration.isHandlerEnabledForSite.withArgs('auditType', sites[3]).returns(false);
    configuration.isHandlerEnabledForSite.withArgs('type1', sites[0]).returns(true);
    configuration.isHandlerEnabledForSite.withArgs('type1', sites[1]).returns(true);
    configuration.isHandlerEnabledForSite.withArgs('type1', sites[2]).returns(false);
    configuration.isHandlerEnabledForSite.withArgs('type1', sites[3]).returns(false);
    configuration.isHandlerEnabledForSite.withArgs('type2', sites[0]).returns(true);
    configuration.isHandlerEnabledForSite.withArgs('type2', sites[1]).returns(true);
    configuration.isHandlerEnabledForSite.withArgs('type2', sites[2]).returns(false);
    configuration.isHandlerEnabledForSite.withArgs('type2', sites[3]).returns(false);

    dataAccessMock = {
      Configuration: {
        findLatest: sandbox.stub().resolves(configuration),
      },
      Organization: {
        all: sandbox.stub().resolves(orgs),
      },
      Site: {
        all: sandbox.stub().resolves(sites),
        allByDeliveryType: sandbox.stub().resolves(sites),
        findByBaseURL: sandbox.stub().resolves(sites[0]),
        findById: sandbox.stub().resolves(sites[0]),
      },
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

    const config = {
      url: context.data.url,
      auditTypes: [context.data.type],
      deliveryType: 'all',
    };

    const response = await triggerFromData(context, config);
    const result = await response.json();

    expect(dataAccessMock.Site.all).to.have.been.calledOnce;
    expect(sqsMock.sendMessage.callCount).to.equal(2);
    expect(result.message[0]).to.equal('Triggered auditType audit for all 2 sites');
  });

  it('triggers an audit for all sites when url is "ALL" and deliveryType is aem_edge', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'ALL' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    const config = {
      url: context.data.url,
      auditTypes: [context.data.type],
      deliveryType: 'aem_edge',
    };

    const response = await triggerFromData(context, config);
    const result = await response.json();

    expect(dataAccessMock.Site.allByDeliveryType).to.have.been.calledOnceWithExactly('aem_edge');
    expect(sqsMock.sendMessage.callCount).to.equal(2);
    expect(result.message[0]).to.equal('Triggered auditType audit for all 2 sites');
  });

  it('triggers audits of both multiple types for all sites', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'lhs', url: 'ALL' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    const config = {
      url: context.data.url,
      auditTypes: ['type1', 'type2'],
      deliveryType: 'all',
    };

    const response = await triggerFromData(context, config);
    const result = await response.json();

    expect(dataAccessMock.Site.all).to.have.been.calledOnce;
    expect(sqsMock.sendMessage.callCount).to.equal(4);
    expect(result.message).to.be.an('array').with.lengthOf(2);
    expect(result.message[0]).to.equal('Triggered type1 audit for all 2 sites');
    expect(result.message[1]).to.equal('Triggered type2 audit for all 2 sites');
  });

  it('triggers an audit for a single site when url is specific', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'http://site1.com' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    const config = {
      url: context.data.url,
      auditTypes: [context.data.type],
      deliveryType: 'all',
    };

    const response = await triggerFromData(context, config);
    const result = await response.json();

    expect(dataAccessMock.Site.findByBaseURL).to.have.been.calledOnceWithExactly('http://site1.com');
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

    const config = {
      url: context.data.url,
      auditTypes: [context.data.type],
      deliveryType: 'all',
    };

    dataAccessMock.Site.findByBaseURL.resolves(null);

    const response = await triggerFromData(context, config);
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

    const config = {
      url: context.data.url,
      auditTypes: [context.data.type],
      deliveryType: 'all',
    };
    const configuration = {
      isHandlerEnabledForSite: sandbox.stub(),
    };
    const sites2 = [
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
    dataAccessMock.Site.all.resolves(sites2);
    configuration.isHandlerEnabledForSite.withArgs('auditType', sites2[0]).returns(false);
    configuration.isHandlerEnabledForSite.withArgs('auditType', sites2[1]).returns(true);
    dataAccessMock.Configuration.findLatest.resolves(configuration);

    const response = await triggerFromData(context, config);

    expect(response.status).to.equal(200);
    expect(sqsMock.sendMessage.callCount).to.equal(1);
  });

  it('does not trigger audit when audit is disabled for audit type', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'all' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    const config = {
      url: context.data.url,
      auditTypes: [context.data.type],
      deliveryType: 'all',
    };

    dataAccessMock.Site.all.resolves([
      {
        getId: () => 'site1',
        baseURL: 'http://site1.com',
        organizationId: 'org123',
      },
    ]);

    const response = await triggerFromData(context, config);
    const result = await response.json();

    expect(response.status).to.equal(200);
    expect(sqsMock.sendMessage.callCount).to.equal(0);
    expect(result.message[0]).to.equal('No site is enabled for auditType audit type');
  });

  it('does not trigger audit for site where audit type is disabled', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'all' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    const config = {
      url: context.data.url,
      auditTypes: [context.data.type],
      deliveryType: 'all',
    };
    const configuration = {
      isHandlerEnabledForSite: sandbox.stub(),
    };
    const sites2 = [
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
    dataAccessMock.Site.all.resolves(sites2);
    configuration.isHandlerEnabledForSite.withArgs('auditType', sites2[0]).returns(false);
    configuration.isHandlerEnabledForSite.withArgs('auditType', sites2[1]).returns(true);
    dataAccessMock.Configuration.findLatest.resolves(configuration);

    const response = await triggerFromData(context, config);

    expect(response.status).to.equal(200);
    expect(sqsMock.sendMessage.callCount).to.equal(1);
  });

  it('should throw exception on unexpected errors', async () => {
    context = {
      dataAccess: dataAccessMock,
      sqs: sqsMock,
      data: { type: 'auditType', url: 'https://example.com' },
      env: { AUDIT_JOBS_QUEUE_URL: 'http://sqs-queue-url.com' },
    };

    const config = {
      url: context.data.url,
      auditTypes: [context.data.type],
      deliveryType: 'all',
    };

    dataAccessMock.Site.findByBaseURL.rejects(new Error('Unexpected error'));

    await expect(triggerFromData(context, config)).to.be.rejectedWith('Unexpected error');
  });
});
