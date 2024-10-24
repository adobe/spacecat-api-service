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

import sinon from 'sinon';
import { expect } from 'chai';
import EnableAuditCommand from '../../../../src/support/slack/commands/enable-audit.js';
import { SiteDto } from '../../../../src/dto/site.js';

describe('IsAuditEnabledCommand', () => {
  const sandbox = sinon.createSandbox();

  const sites = [
    { id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge' },
  ].map((site) => SiteDto.fromJson(site));

  let mockConfiguration;
  let mockDataAccess;
  let mockContext;
  let mockSlackContext;

  beforeEach(async () => {
    mockConfiguration = {
      enableHandlerForSite: sandbox.stub(),
      disableHandlerForSite: sandbox.stub(),
      getVersion: sandbox.stub(),
      getJobs: sandbox.stub(),
      getHandlers: sandbox.stub(),
      getQueues: sandbox.stub(),
      isHandlerEnabledForSite: sandbox.stub(),
    };

    mockDataAccess = {
      getConfiguration: sandbox.stub().resolves(mockConfiguration),
      getSiteByBaseURL: sandbox.stub(),
      updateConfiguration: sandbox.stub(),
    };

    mockContext = {
      dataAccess: mockDataAccess,
    };

    mockSlackContext = {
      say: sinon.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('is audit enabled for site with version', async () => {
    mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);
    mockConfiguration.getVersion.returns('v1');

    const command = EnableAuditCommand(mockContext);
    const args = ['http://site1.com', 'broken-backlinks'];
    await command.handleExecution(args, mockSlackContext);

    expect(mockDataAccess.updateConfiguration.called).to.be.true;
  });

  it('is audit enabled for site without version', async () => {
    mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);
    mockConfiguration.getVersion.returns('');

    const command = EnableAuditCommand(mockContext);
    const args = ['http://site1.com', 'broken-backlinks'];
    await command.handleExecution(args, mockSlackContext);

    expect(mockDataAccess.updateConfiguration.called).to.be.true;
  });
});
