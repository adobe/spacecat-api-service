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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import ForceOptimizeAtEdgeEnableCommand from '../../../../src/support/slack/commands/force-optimize-at-edge-enable.js';

use(sinonChai);

describe('ForceOptimizeAtEdgeEnableCommand', () => {
  // extractURLFromSlackInput strips www. and prepends https:// so 'www.example.com' → 'https://example.com'
  const SITE_URL_INPUT = 'www.example.com';
  const SITE_BASE_URL = 'https://example.com';
  const SITE_ID = '019f366a-db00-71ea-8b85-7c12fc5df9f4';
  const IMPORTS_QUEUE = 'https://sqs.test/imports-queue';
  const FORCE_TYPE = 'force-optimize-at-edge-enabled-marking';

  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let mockSite;
  let mockConfig;

  beforeEach(() => {
    mockSite = {
      getId: sinon.stub().returns(SITE_ID),
      getBaseURL: sinon.stub().returns(SITE_BASE_URL),
    };
    mockConfig = {
      getQueues: sinon.stub().returns({ imports: IMPORTS_QUEUE }),
    };
    dataAccessStub = {
      Site: {
        findByBaseURL: sinon.stub().resolves(mockSite),
        findById: sinon.stub().resolves(mockSite),
      },
      Configuration: {
        findLatest: sinon.stub().resolves(mockConfig),
      },
    };
    sqsStub = { sendMessage: sinon.stub().resolves() };

    context = {
      dataAccess: dataAccessStub,
      sqs: sqsStub,
      log: { error: sinon.stub(), info: sinon.stub() },
      env: {},
    };

    slackContext = { say: sinon.stub(), user: 'U123ABC' };
  });

  describe('Initialization', () => {
    it('initializes with correct id, name, and phrases', () => {
      const command = ForceOptimizeAtEdgeEnableCommand(context);
      expect(command.id).to.equal('force-optimize-at-edge-enable');
      expect(command.name).to.equal('Force Optimize at Edge Enable');
      expect(command.phrases).to.deep.equal(['force-optimize-at-edge-enable']);
    });
  });

  describe('handleExecution', () => {
    it('shows usage when no site is provided', async () => {
      const command = ForceOptimizeAtEdgeEnableCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      expect(sqsStub.sendMessage).to.not.have.been.called;
    });

    it('posts site-not-found when the site cannot be resolved by base URL', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);
      const command = ForceOptimizeAtEdgeEnableCommand(context);
      await command.handleExecution([SITE_URL_INPUT], slackContext);

      expect(slackContext.say).to.have.been.called;
      expect(sqsStub.sendMessage).to.not.have.been.called;
    });

    it('posts site-not-found when the site cannot be resolved by id', async () => {
      dataAccessStub.Site.findById.resolves(null);
      const command = ForceOptimizeAtEdgeEnableCommand(context);
      await command.handleExecution([SITE_ID], slackContext);

      expect(dataAccessStub.Site.findById).to.have.been.calledWith(SITE_ID);
      expect(slackContext.say).to.have.been.called;
      expect(sqsStub.sendMessage).to.not.have.been.called;
    });

    it('warns and does not enqueue when Configuration.findLatest() returns nothing', async () => {
      dataAccessStub.Configuration.findLatest.resolves(null);
      const command = ForceOptimizeAtEdgeEnableCommand(context);
      await command.handleExecution([SITE_URL_INPUT], slackContext);

      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWithMatch('Could not load the current configuration');
    });

    it('enqueues the force-enable message when resolved by base URL', async () => {
      const command = ForceOptimizeAtEdgeEnableCommand(context);
      await command.handleExecution([SITE_URL_INPUT], slackContext);

      expect(dataAccessStub.Site.findByBaseURL).to.have.been.calledWith(SITE_BASE_URL);
      expect(sqsStub.sendMessage).to.have.been.calledOnceWith(IMPORTS_QUEUE, {
        type: FORCE_TYPE,
        siteId: SITE_ID,
        forcedBy: 'U123ABC',
      });
      expect(slackContext.say).to.have.been.calledWithMatch('Triggered');
    });

    it('resolves the site by id when the input is not a URL', async () => {
      const command = ForceOptimizeAtEdgeEnableCommand(context);
      await command.handleExecution([SITE_ID], slackContext);

      expect(dataAccessStub.Site.findById).to.have.been.calledWith(SITE_ID);
      expect(dataAccessStub.Site.findByBaseURL).to.not.have.been.called;
      expect(sqsStub.sendMessage).to.have.been.calledOnceWith(IMPORTS_QUEUE, {
        type: FORCE_TYPE,
        siteId: SITE_ID,
        forcedBy: 'U123ABC',
      });
    });

    it('posts an error message when enqueuing throws, logging the full error (with stack)', async () => {
      const sqsError = new Error('sqs down');
      sqsStub.sendMessage.rejects(sqsError);
      const command = ForceOptimizeAtEdgeEnableCommand(context);
      await command.handleExecution([SITE_URL_INPUT], slackContext);

      expect(context.log.error).to.have.been.calledWithMatch('Error in force-optimize-at-edge-enable:', sqsError);
      expect(slackContext.say).to.have.been.called;
    });
  });
});
