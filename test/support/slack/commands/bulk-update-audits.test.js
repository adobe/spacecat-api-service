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
import BulkUpdateAuditConfigCommand from '../../../../src/support/slack/commands/bulk-update-audits.js';

describe('BulkUpdateAuditConfigCommand', () => {
  let context;
  let slackContext;
  let getSiteByBaseURLStub;
  let updateSiteStub;

  beforeEach(async () => {
    getSiteByBaseURLStub = sinon.stub();
    updateSiteStub = sinon.stub();
    context = {
      log: {
        error: sinon.stub(),
      },
      dataAccess: {
        getSiteByBaseURL: getSiteByBaseURLStub,
        updateSite: updateSiteStub,
      },
    };

    slackContext = {
      say: sinon.stub(),
    };
  });

  it('should handle successful execution', async () => {
    const args = ['enable', 'site1.com,site2.com', 'auditType1,auditType2'];
    const site = {
      getOrganizationId: () => 'default',
      getAuditConfig: () => ({
        updateAuditTypeConfig: sinon.stub(),
      }),
    };

    getSiteByBaseURLStub.resolves(site);
    updateSiteStub.resolves();

    const command = BulkUpdateAuditConfigCommand(context);
    await command.handleExecution(args, slackContext);

    sinon.assert.calledWith(getSiteByBaseURLStub, 'site1.com');
    sinon.assert.calledWith(getSiteByBaseURLStub, 'site2.com');
    sinon.assert.calledTwice(updateSiteStub);
  });

  it('should handle error during execution', async () => {
    const args = ['enable', 'site1.com,site2.com', 'auditType1,auditType2'];
    const error = new Error('Test error');

    getSiteByBaseURLStub.rejects(error);

    const command = BulkUpdateAuditConfigCommand(context);
    await command.handleExecution(args, slackContext);

    sinon.assert.calledWith(context.log.error, error);
    sinon.assert.calledWith(slackContext.say, `Error during bulk update: ${error.message}`);
  });
});
