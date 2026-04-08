/*
 * Copyright 2025 Adobe. All rights reserved.
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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import nock from 'nock';

import ToolsController from '../../src/controllers/tools.js';

use(sinonChai);

describe('Tools Controller', () => {
  let sandbox;
  let toolsController;
  let context;
  let loggerStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    loggerStub = {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
    };

    context = {
      dataAccess: {},
      data: {},
      params: {},
      env: { HLX_ADMIN_TOKEN: 'test-token' },
    };

    toolsController = ToolsController(context, loggerStub, context.env);
  });

  afterEach(() => {
    nock.cleanAll();
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    expect(toolsController).to.have.property('resolveConfig');
  });

  describe('resolveConfig', () => {
    it('should return 400 when gitHubURL is missing', async () => {
      context.data = {};

      const response = await toolsController.resolveConfig(context);
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('gitHubURL is required');
    });

    it('should return 400 when gitHubURL is invalid', async () => {
      context.data = { gitHubURL: 'https://not-a-github-url.com/foo' };

      const response = await toolsController.resolveConfig(context);
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Invalid GitHub repository URL');
    });

    it('should return 500 when HLX_ADMIN_TOKEN is not configured', async () => {
      context.data = { gitHubURL: 'https://github.com/adobe/test-repo' };
      context.env.HLX_ADMIN_TOKEN = undefined;
      toolsController = ToolsController(context, loggerStub, context.env);

      const response = await toolsController.resolveConfig(context);
      expect(response.status).to.equal(500);
    });

    it('should return resolved hlxConfig and code on success', async () => {
      context.data = { gitHubURL: 'https://github.com/adobe/test-repo' };

      nock('https://admin.hlx.page')
        .get('/config/adobe/aggregated/test-repo.json')
        .reply(200, {
          cdn: { prod: { host: 'main--test-repo--adobe.aem.live' } },
          code: { owner: 'adobe', repo: 'test-repo', source: 'https://github.com/adobe/test-repo' },
          content: { source: { type: 'onedrive', url: 'https://adobe.sharepoint.com/sites/test' } },
        });

      const response = await toolsController.resolveConfig(context);
      expect(response.status).to.equal(200);

      const body = await response.json();
      expect(body.hlxConfig).to.be.an('object');
      expect(body.hlxConfig.rso).to.deep.include({ owner: 'adobe', site: 'test-repo' });
      expect(body.hlxConfig.cdn).to.be.an('object');
      expect(body.hlxConfig.code).to.be.an('object');
      expect(body.code).to.deep.include({
        type: 'github',
        owner: 'adobe',
        repo: 'test-repo',
        ref: 'main',
        url: 'https://github.com/adobe/test-repo',
      });
    });

    it('should fall back to fstab.yaml when admin API returns 404', async () => {
      context.data = { gitHubURL: 'https://github.com/adobe/test-repo' };

      nock('https://admin.hlx.page')
        .get('/config/adobe/aggregated/test-repo.json')
        .reply(404);

      nock('https://raw.githubusercontent.com')
        .get('/adobe/test-repo/main/fstab.yaml')
        .reply(200, 'mountpoints:\n  /: https://adobe.sharepoint.com/sites/test');

      const response = await toolsController.resolveConfig(context);
      expect(response.status).to.equal(200);

      const body = await response.json();
      expect(body.hlxConfig.content.source.type).to.equal('onedrive');
      expect(body.hlxConfig.content.source.url).to.equal('https://adobe.sharepoint.com/sites/test');
      expect(body.code.owner).to.equal('adobe');
      expect(body.code.repo).to.equal('test-repo');
    });

    it('should return basic hlxConfig when both admin API and fstab fail', async () => {
      context.data = { gitHubURL: 'https://github.com/adobe/test-repo' };

      nock('https://admin.hlx.page')
        .get('/config/adobe/aggregated/test-repo.json')
        .reply(404);

      nock('https://raw.githubusercontent.com')
        .get('/adobe/test-repo/main/fstab.yaml')
        .reply(404);

      const response = await toolsController.resolveConfig(context);
      expect(response.status).to.equal(200);

      const body = await response.json();
      expect(body.hlxConfig.rso).to.deep.equal({ owner: 'adobe', site: 'test-repo', ref: 'main' });
      expect(body.hlxConfig.content).to.be.undefined;
      expect(body.code.type).to.equal('github');
    });

    it('should return 500 when resolveHlxConfigFromGitHubURL throws', async () => {
      context.data = { gitHubURL: 'https://github.com/adobe/test-repo' };

      const ToolsControllerMocked = (await import('esmock')).default(
        '../../src/controllers/tools.js',
        {
          '../../src/support/hlx-config.js': {
            resolveHlxConfigFromGitHubURL: sinon.stub().rejects(new Error('Unexpected failure')),
          },
        },
      );

      const mockedController = (await ToolsControllerMocked)(context, loggerStub, context.env);
      const response = await mockedController.resolveConfig(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to resolve config');
    });
  });
});
