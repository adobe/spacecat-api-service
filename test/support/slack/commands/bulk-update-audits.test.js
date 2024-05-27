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
import esmock from 'esmock';
import * as sitesController from '../../../../src/controllers/sites.js';
import BulkEnableAuditsCommand from '../../../../src/support/slack/commands/bulk-update-audits.js';

describe('BulkEnableAuditsCommand', () => {
  let context;
  let slackContext;
  let bulkUpdateSitesConfigStub;

  beforeEach(async () => {
    context = {
      log: {
        error: sinon.stub(),
      },
    };

    slackContext = {
      say: sinon.stub(),
    };

    bulkUpdateSitesConfigStub = await esmock(sitesController, {
      bulkUpdateSitesConfig: async () => {
        // Mock implementation goes here
      },
    });
  });

  afterEach(() => {
    bulkUpdateSitesConfigStub.restore();
  });

  xit('should handle successful execution', async () => {
    const args = ['site1.com,site2.com', 'auditType1,auditType2'];
    const responses = [
      { baseURL: 'site1.com', response: { status: 200 } },
      { baseURL: 'site2.com', response: { status: 200 } },
    ];

    bulkUpdateSitesConfigStub.bulkUpdateSitesConfig = async () => responses;

    const command = BulkEnableAuditsCommand(context);
    await command.handleExecution(args, slackContext);

    sinon.assert.calledWith(bulkUpdateSitesConfigStub.bulkUpdateSitesConfig, {
      data: { baseURLs: ['site1.com', 'site2.com'], enableAudits: true, auditTypes: ['auditType1', 'auditType2'] },
    });
  });
});
