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
import esmock from 'esmock';

use(sinonChai);

describe('RunGlobalImportCommand', () => {
  let RunGlobalImportCommand;
  let context;
  let slackContext;
  let dataAccessStub;
  let configStub;
  let extractURLFromSlackInputStub;
  let postSiteNotFoundMessageStub;
  let postErrorMessageStub;
  let triggerGlobalImportRunStub;

  beforeEach(async () => {
    extractURLFromSlackInputStub = sinon.stub().returns(null);
    postSiteNotFoundMessageStub = sinon.stub().resolves();
    postErrorMessageStub = sinon.stub().callsFake(async (sayFn, err) => {
      await sayFn(`:x: ${err.message}`);
    });
    triggerGlobalImportRunStub = sinon.stub().resolves();

    RunGlobalImportCommand = (await esmock(
      '../../../../src/support/slack/commands/run-global-import.js',
      {
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: extractURLFromSlackInputStub,
          postErrorMessage: postErrorMessageStub,
          postSiteNotFoundMessage: postSiteNotFoundMessageStub,
        },
        '../../../../src/support/utils.js': {
          triggerGlobalImportRun: triggerGlobalImportRunStub,
        },
      },
    )).default;

    configStub = {
      getJobs: sinon.stub().returns([
        { group: 'imports', type: 'stale-suggestions-cleanup' },
        { group: 'imports', type: 'optimize-at-edge-enabled-marking' },
      ]),
    };

    dataAccessStub = {
      Configuration: {
        findLatest: sinon.stub().resolves(configStub),
      },
      Site: {
        findByBaseURL: sinon.stub(),
        findById: sinon.stub(),
      },
    };

    context = {
      log: { error: sinon.spy() },
      dataAccess: dataAccessStub,
    };

    slackContext = {
      say: sinon.stub().resolves(),
      user: 'jdoe',
      channelId: 'C123',
      threadTs: '1712345678.9012',
    };
  });

  it('initializes with base command metadata', () => {
    const command = RunGlobalImportCommand(context);
    expect(command.id).to.equal('run-global-import');
    expect(command.name).to.equal('Run Global Import');
    expect(command.phrases).to.deep.equal(['run global import']);
  });

  it('shows usage when importType is missing', async () => {
    const command = RunGlobalImportCommand(context);

    await command.handleExecution([], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(command.usage());
    expect(triggerGlobalImportRunStub).not.to.have.been.called;
  });

  it('warns when importType is not a valid global import type', async () => {
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['not-a-real-type'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('not a valid global import type');
    expect(triggerGlobalImportRunStub).not.to.have.been.called;
  });

  it('warns when the import type is not configured', async () => {
    configStub.getJobs.returns([]);
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['stale-suggestions-cleanup'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('is not configured in the system');
    expect(triggerGlobalImportRunStub).not.to.have.been.called;
  });

  it('posts site-not-found when the given site cannot be resolved by URL', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves(null);
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['optimize-at-edge-enabled-marking', 'example.com'], slackContext);

    expect(postSiteNotFoundMessageStub).to.have.been.calledOnceWith(slackContext.say, 'example.com');
    expect(triggerGlobalImportRunStub).not.to.have.been.called;
  });

  it('posts site-not-found when the given site cannot be resolved by ID', async () => {
    extractURLFromSlackInputStub.returns(null);
    dataAccessStub.Site.findById.resolves(null);
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['optimize-at-edge-enabled-marking', 'site-id-1'], slackContext);

    expect(postSiteNotFoundMessageStub).to.have.been.calledOnceWith(slackContext.say, 'site-id-1');
    expect(triggerGlobalImportRunStub).not.to.have.been.called;
  });

  it('triggers a bulk run (no site) and confirms without a site suffix', async () => {
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['stale-suggestions-cleanup'], slackContext);

    expect(triggerGlobalImportRunStub).to.have.been.calledOnceWith(
      configStub,
      'stale-suggestions-cleanup',
      slackContext,
      context,
      {
        siteId: undefined, force: false, forcedBy: 'jdoe', validateOnly: false,
      },
    );
    expect(slackContext.say.firstCall.args[0]).to.include('Triggered global import: *stale-suggestions-cleanup*');
    expect(slackContext.say.firstCall.args[0]).not.to.include('force');
    expect(slackContext.say.firstCall.args[0]).not.to.include('validate-only');
  });

  it('scopes the run to a single site resolved by URL', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    const mockSite = { getId: () => 'site-1', getBaseURL: () => 'https://example.com' };
    dataAccessStub.Site.findByBaseURL.resolves(mockSite);
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['optimize-at-edge-enabled-marking', 'example.com'], slackContext);

    expect(triggerGlobalImportRunStub).to.have.been.calledOnceWith(
      configStub,
      'optimize-at-edge-enabled-marking',
      slackContext,
      context,
      {
        siteId: 'site-1', force: false, forcedBy: 'jdoe', validateOnly: false,
      },
    );
    expect(slackContext.say.firstCall.args[0]).to.include('for site *https://example.com* (`site-1`)');
  });

  it('rejects --force combined with --validate-only', async () => {
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['optimize-at-edge-enabled-marking', 'example.com', '--force', '--validate-only'], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(':warning: `--force` and `--validate-only` cannot be used together.');
    expect(triggerGlobalImportRunStub).not.to.have.been.called;
  });

  it('rejects --force without a site', async () => {
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['optimize-at-edge-enabled-marking', '--force'], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(':warning: `--force`/`--validate-only` requires a site (URL or ID) to scope to — it has no effect on a bulk run.');
    expect(triggerGlobalImportRunStub).not.to.have.been.called;
  });

  it('rejects --validate-only without a site', async () => {
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['optimize-at-edge-enabled-marking', '--validate-only'], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(':warning: `--force`/`--validate-only` requires a site (URL or ID) to scope to — it has no effect on a bulk run.');
    expect(triggerGlobalImportRunStub).not.to.have.been.called;
  });

  it('triggers with force:true and confirms with the force suffix', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    const mockSite = { getId: () => 'site-1', getBaseURL: () => 'https://example.com' };
    dataAccessStub.Site.findByBaseURL.resolves(mockSite);
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['optimize-at-edge-enabled-marking', 'example.com', '--force'], slackContext);

    expect(triggerGlobalImportRunStub).to.have.been.calledOnceWith(
      configStub,
      'optimize-at-edge-enabled-marking',
      slackContext,
      context,
      {
        siteId: 'site-1', force: true, forcedBy: 'jdoe', validateOnly: false,
      },
    );
    expect(slackContext.say.firstCall.args[0]).to.include('*force*: skipping prerender content validation.');
    expect(slackContext.say.firstCall.args[0]).not.to.include('validate-only');
  });

  it('triggers with validateOnly:true and confirms with the validate-only suffix', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    const mockSite = { getId: () => 'site-1', getBaseURL: () => 'https://example.com' };
    dataAccessStub.Site.findByBaseURL.resolves(mockSite);
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['optimize-at-edge-enabled-marking', 'example.com', '--validate-only'], slackContext);

    expect(triggerGlobalImportRunStub).to.have.been.calledOnceWith(
      configStub,
      'optimize-at-edge-enabled-marking',
      slackContext,
      context,
      {
        siteId: 'site-1', force: false, forcedBy: 'jdoe', validateOnly: true,
      },
    );
    expect(slackContext.say.firstCall.args[0]).to.include('*validate-only*: running prerender content validation only, not touching enablement.');
    expect(slackContext.say.firstCall.args[0]).not.to.include('*force*');
  });

  it('parses the flag anywhere in the args, independent of position', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    const mockSite = { getId: () => 'site-1', getBaseURL: () => 'https://example.com' };
    dataAccessStub.Site.findByBaseURL.resolves(mockSite);
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['--validate-only', 'optimize-at-edge-enabled-marking', 'example.com'], slackContext);

    expect(triggerGlobalImportRunStub).to.have.been.calledOnceWith(
      configStub,
      'optimize-at-edge-enabled-marking',
      slackContext,
      context,
      {
        siteId: 'site-1', force: false, forcedBy: 'jdoe', validateOnly: true,
      },
    );
  });

  it('logs and posts an error when Configuration.findLatest throws', async () => {
    dataAccessStub.Configuration.findLatest.rejects(new Error('db unavailable'));
    const command = RunGlobalImportCommand(context);

    await expect(command.handleExecution(['optimize-at-edge-enabled-marking'], slackContext))
      .to.be.rejectedWith('db unavailable');
  });

  it('logs and posts an error when triggerGlobalImportRun throws', async () => {
    triggerGlobalImportRunStub.rejects(new Error('sqs failure'));
    const command = RunGlobalImportCommand(context);

    await command.handleExecution(['stale-suggestions-cleanup'], slackContext);

    expect(context.log.error).to.have.been.calledOnce;
    expect(postErrorMessageStub).to.have.been.calledOnce;
    expect(postErrorMessageStub.firstCall.args[0]).to.equal(slackContext.say);
    expect(postErrorMessageStub.firstCall.args[1]).to.be.instanceOf(Error);
  });
});
