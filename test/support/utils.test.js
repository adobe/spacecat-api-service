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
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import nock from 'nock';

import {
  createProject,
  deriveProjectName,
  autoResolveAuthorUrl,
  updateCodeConfig,
  getIsSummitPlgEnabled,
  resolveAemAccessToken,
  ErrorWithStatusCode,
} from '../../src/support/utils.js';

use(chaiAsPromised);
use(sinonChai);

describe('utils', () => {
  describe('deriveProjectName', () => {
    it('should derive a project name from a url with path', () => {
      const baseURL = 'https://example.com/de';
      const projectName = deriveProjectName(baseURL);
      expect(projectName).to.equal('example.com');
    });

    it('should derive a project name from a url with www subdomain', () => {
      const baseURL = 'https://www.example.com';
      const projectName = deriveProjectName(baseURL);
      expect(projectName).to.equal('example.com');
    });

    it('should derive a project name from a url with www and language code', () => {
      const baseURL = 'https://www.en.example.com';
      const projectName = deriveProjectName(baseURL);
      expect(projectName).to.equal('example.com');
    });

    it('should derive a project name from a url with non language subdomain', () => {
      const baseURL = 'https://blog.example.com';
      const projectName = deriveProjectName(baseURL);
      expect(projectName).to.equal('blog.example.com');
    });
  });

  describe('createProject', () => {
    let sandbox;
    let context;
    let slackContext;

    beforeEach(() => {
      sandbox = sinon.createSandbox();

      context = {
        log: {
          error: sandbox.stub(),
        },
        dataAccess: {
          Project: {
            findById: sandbox.stub(),
            allByOrganizationId: sandbox.stub().resolves([]),
            create: sandbox.stub(),
          },
        },
      };

      slackContext = {
        say: sandbox.stub(),
      };
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('returns existing project if project id is provided and project exists', async () => {
      const existingProject = {
        getProjectName: sandbox.stub().returns('example.com'),
        getId: sandbox.stub().returns('project123'),
      };
      context.dataAccess.Project.findById.resolves(existingProject);

      const project = await createProject(context, slackContext, 'https://example.com', 'org123', 'project123');

      expect(project).to.equal(existingProject);
      expect(slackContext.say).to.have.been.calledWith(':information_source: Added site https://example.com to existing project example.com. Project ID: project123');
      expect(context.dataAccess.Project.create).not.to.have.been.called;
    });

    it('ignores a provided project id if project does not exist', async () => {
      const expectedProject = {
        projectName: 'example.com',
        organizationId: 'org123',
        getProjectName: sandbox.stub().returns('example.com'),
        getId: sandbox.stub().returns('project123'),
      };
      context.dataAccess.Project.create.resolves(expectedProject);
      context.dataAccess.Project.findById.resolves(null);

      const project = await createProject(context, slackContext, 'https://example.com', 'org123', 'project123');

      expect(context.dataAccess.Project.create).to.have.been.calledWith({
        projectName: expectedProject.projectName,
        organizationId: expectedProject.organizationId,
      });
      expect(project).to.equal(expectedProject);
      expect(slackContext.say).to.have.been.calledWith(':information_source: Added site https://example.com to new project example.com. Project ID: project123');
    });

    it('finds an existing project within the given org with a matching name', async () => {
      const existingProject = {
        projectName: 'example.com',
        organizationId: 'org123',
        getProjectName: sandbox.stub().returns('example.com'),
        getId: sandbox.stub().returns('project123'),
      };
      context.dataAccess.Project.allByOrganizationId.resolves([existingProject]);

      const project = await createProject(context, slackContext, 'https://example.com/uk', 'org123', 'project123');

      expect(context.dataAccess.Project.allByOrganizationId).to.have.been.calledWith('org123');
      expect(context.dataAccess.Project.create).not.to.have.been.called;
      expect(project).to.equal(existingProject);
      expect(slackContext.say).to.have.been.calledWith(':information_source: Added site https://example.com/uk to existing project example.com. Project ID: project123');
    });

    it('creates a new project', async () => {
      const expectedProject = {
        projectName: 'example.com',
        organizationId: 'org123',
        getProjectName: sandbox.stub().returns('example.com'),
        getId: sandbox.stub().returns('project123'),
      };
      context.dataAccess.Project.create.resolves(expectedProject);
      context.dataAccess.Project.findById.resolves(null);

      const project = await createProject(context, slackContext, 'https://fr.example.com/', 'org123');

      expect(context.dataAccess.Project.create).to.have.been.calledWith({
        projectName: expectedProject.projectName,
        organizationId: expectedProject.organizationId,
      });
      expect(project).to.equal(expectedProject);
      expect(slackContext.say).to.have.been.calledWith(':information_source: Added site https://fr.example.com/ to new project example.com. Project ID: project123');
    });

    it('logs an error if creating a project fails', async () => {
      context.dataAccess.Project.create.rejects(new Error('Failed to create project'));

      await expect(createProject(context, slackContext, 'https://fr.example.com/', 'org123')).to.be.rejectedWith('Failed to create project');
      expect(context.log.error).to.have.been.calledWith('Error creating project: Failed to create project');
      expect(slackContext.say).to.have.been.calledWith(':x: Error creating project: Failed to create project');
    });
  });

  describe('autoResolveAuthorUrl', () => {
    let sandbox;
    let context;
    let rumApiClientStub;
    let site;

    // Build yesterday's date path for nock URL matching
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const datePath = `${yesterday.getUTCFullYear()}/${(yesterday.getUTCMonth() + 1).toString().padStart(2, '0')}/${yesterday.getUTCDate().toString().padStart(2, '0')}`;

    beforeEach(() => {
      sandbox = sinon.createSandbox();

      rumApiClientStub = {
        retrieveDomainkey: sandbox.stub(),
      };

      context = {
        log: {
          info: sandbox.stub(),
          warn: sandbox.stub(),
          error: sandbox.stub(),
          debug: sandbox.stub(),
        },
        env: {
          RUM_ADMIN_KEY: 'test-admin-key',
        },
        rumApiClient: rumApiClientStub,
      };

      site = {
        getBaseURL: sandbox.stub().returns('https://www.example.com'),
        getConfig: sandbox.stub().returns({
          getFetchConfig: sandbox.stub().returns(null),
        }),
      };
    });

    afterEach(() => {
      sandbox.restore();
      nock.cleanAll();
    });

    it('returns resolved author URL when RUM bundle has an AEM CS publish host', async () => {
      rumApiClientStub.retrieveDomainkey.resolves('test-domainkey');

      nock('https://bundles.aem.page')
        .get(`/bundles/example.com/${datePath}`)
        .query({ domainkey: 'test-domainkey' })
        .reply(200, {
          rumBundles: [
            {
              id: '123',
              host: 'publish-p12345-e67890.adobeaemcloud.com',
              url: 'https://www.example.com/page1',
            },
          ],
        });

      const result = await autoResolveAuthorUrl(site, context);

      expect(result).to.deep.equal({
        authorURL: 'https://author-p12345-e67890.adobeaemcloud.com',
        programId: '12345',
        environmentId: '67890',
        host: 'publish-p12345-e67890.adobeaemcloud.com',
      });
      expect(context.log.info).to.have.been.calledWith(
        'Auto-resolved author URL from RUM bundle host: https://author-p12345-e67890.adobeaemcloud.com',
      );
    });

    it('returns resolved author URL when RUM bundle has an AEM CS .net publish host', async () => {
      rumApiClientStub.retrieveDomainkey.resolves('test-domainkey');

      nock('https://bundles.aem.page')
        .get(`/bundles/example.com/${datePath}`)
        .query({ domainkey: 'test-domainkey' })
        .reply(200, {
          rumBundles: [
            {
              id: '123',
              host: 'publish-p106488-e1080713.adobeaemcloud.net',
              url: 'https://www.example.com/page1',
            },
          ],
        });

      const result = await autoResolveAuthorUrl(site, context);

      expect(result).to.deep.equal({
        authorURL: 'https://author-p106488-e1080713.adobeaemcloud.com',
        programId: '106488',
        environmentId: '1080713',
        host: 'publish-p106488-e1080713.adobeaemcloud.net',
      });
    });

    it('uses overrideBaseURL from fetchConfig when available', async () => {
      site.getConfig.returns({
        getFetchConfig: sandbox.stub().returns({
          overrideBaseURL: 'https://custom.example.com',
        }),
      });
      rumApiClientStub.retrieveDomainkey.resolves('test-domainkey');

      nock('https://bundles.aem.page')
        .get(`/bundles/custom.example.com/${datePath}`)
        .query({ domainkey: 'test-domainkey' })
        .reply(200, {
          rumBundles: [
            {
              id: '123',
              host: 'publish-p111-e222.adobeaemcloud.com',
              url: 'https://custom.example.com/page1',
            },
          ],
        });

      const result = await autoResolveAuthorUrl(site, context);

      expect(result).to.deep.equal({
        authorURL: 'https://author-p111-e222.adobeaemcloud.com',
        programId: '111',
        environmentId: '222',
        host: 'publish-p111-e222.adobeaemcloud.com',
      });
    });

    it('returns host only when host is not an AEM CS publish host', async () => {
      rumApiClientStub.retrieveDomainkey.resolves('test-domainkey');

      nock('https://bundles.aem.page')
        .get(`/bundles/example.com/${datePath}`)
        .query({ domainkey: 'test-domainkey' })
        .reply(200, {
          rumBundles: [
            {
              id: '123',
              host: 'main--mysite--org.aem.live',
              url: 'https://www.example.com/page1',
            },
          ],
        });

      const result = await autoResolveAuthorUrl(site, context);

      expect(result).to.deep.equal({ host: 'main--mysite--org.aem.live' });
      expect(context.log.info).to.have.been.calledWithMatch(/is not an AEM CS publish host/);
    });

    it('returns null when no RUM bundles are returned', async () => {
      rumApiClientStub.retrieveDomainkey.resolves('test-domainkey');

      nock('https://bundles.aem.page')
        .get(`/bundles/example.com/${datePath}`)
        .query({ domainkey: 'test-domainkey' })
        .reply(200, { rumBundles: [] });

      const result = await autoResolveAuthorUrl(site, context);

      expect(result).to.be.null;
      expect(context.log.info).to.have.been.calledWithMatch(/No RUM bundles found/);
    });

    it('returns null when fetch fails', async () => {
      rumApiClientStub.retrieveDomainkey.resolves('test-domainkey');

      nock('https://bundles.aem.page')
        .get(`/bundles/example.com/${datePath}`)
        .query({ domainkey: 'test-domainkey' })
        .reply(404);

      const result = await autoResolveAuthorUrl(site, context);

      expect(result).to.be.null;
      expect(context.log.warn).to.have.been.calledWithMatch(/Failed to fetch RUM bundles/);
    });

    it('returns null when wwwUrlResolver fails', async () => {
      rumApiClientStub.retrieveDomainkey.rejects(new Error('No domainkey'));

      const result = await autoResolveAuthorUrl(site, context);

      expect(result).to.be.null;
      expect(context.log.warn).to.have.been.calledWithMatch(/Auto-resolve author URL failed/);
    });

    it('returns host object when first bundle host is undefined', async () => {
      rumApiClientStub.retrieveDomainkey.resolves('test-domainkey');

      nock('https://bundles.aem.page')
        .get(`/bundles/example.com/${datePath}`)
        .query({ domainkey: 'test-domainkey' })
        .reply(200, {
          rumBundles: [
            {
              id: '1',
              url: 'https://www.example.com/page1',
            },
          ],
        });

      const result = await autoResolveAuthorUrl(site, context);

      expect(result).to.deep.equal({ host: undefined });
      expect(context.log.info).to.have.been.calledWithMatch(/is not an AEM CS publish host/);
    });
  });

  describe('resolveAemAccessToken', () => {
    let sandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('uses promise token from context.data before header sources', async () => {
      const context = {
        data: { promiseToken: { promise_token: 'data-token' } },
        request: { headers: { get: () => 'request-token' } },
      };
      const exchangePromiseTokenFn = sandbox.stub().resolves('ims-token-from-data');
      const getImsUserTokenFn = sandbox.stub();

      const token = await resolveAemAccessToken(context, {
        exchangePromiseTokenFn,
        getImsUserTokenFn,
      });

      expect(token).to.equal('ims-token-from-data');
      expect(exchangePromiseTokenFn).to.have.been.calledOnceWithExactly(context, 'data-token');
      expect(getImsUserTokenFn).to.not.have.been.called;
    });

    it('uses promise token from request headers when data token is absent', async () => {
      const context = {
        request: { headers: { get: (name) => (name === 'x-promise-token' ? 'request-token' : null) } },
        pathInfo: { headers: { 'x-promise-token': 'path-token' } },
      };
      const exchangePromiseTokenFn = sandbox.stub().resolves('ims-token-from-request');

      const token = await resolveAemAccessToken(context, { exchangePromiseTokenFn });

      expect(token).to.equal('ims-token-from-request');
      expect(exchangePromiseTokenFn).to.have.been.calledOnceWithExactly(context, 'request-token');
    });

    it('uses promise token from pathInfo headers with case-insensitive lookup', async () => {
      const context = {
        request: { headers: { get: () => '' } },
        pathInfo: { headers: { 'X-PROMISE-TOKEN': 'path-token' } },
      };
      const exchangePromiseTokenFn = sandbox.stub().resolves('ims-token-from-path');

      const token = await resolveAemAccessToken(context, { exchangePromiseTokenFn });

      expect(token).to.equal('ims-token-from-path');
      expect(exchangePromiseTokenFn).to.have.been.calledOnceWithExactly(context, 'path-token');
    });

    it('falls back to getImsUserToken when no promise token is provided', async () => {
      const context = {};
      const getImsUserTokenFn = sandbox.stub().returns('ims-token-from-auth-header');
      const exchangePromiseTokenFn = sandbox.stub();

      const token = await resolveAemAccessToken(context, {
        exchangePromiseTokenFn,
        getImsUserTokenFn,
      });

      expect(token).to.equal('ims-token-from-auth-header');
      expect(getImsUserTokenFn).to.have.been.calledOnceWithExactly(context);
      expect(exchangePromiseTokenFn).to.not.have.been.called;
    });

    it('uses invocation bearer header when getImsUserToken cannot resolve a token', async () => {
      const context = {
        invocation: {
          event: {
            headers: {
              Authorization: 'Bearer invocation-token',
            },
          },
        },
      };
      const getImsUserTokenFn = sandbox.stub().throws(new ErrorWithStatusCode('Missing Authorization header', 400));

      const token = await resolveAemAccessToken(context, { getImsUserTokenFn });

      expect(token).to.equal('invocation-token');
    });

    it('throws 400 when no bearer token is available in any source', async () => {
      const context = {
        invocation: {
          event: {
            headers: {},
          },
        },
      };
      const getImsUserTokenFn = sandbox.stub().throws(new ErrorWithStatusCode('Missing Authorization header', 400));

      try {
        await resolveAemAccessToken(context, { getImsUserTokenFn });
        expect.fail('expected resolveAemAccessToken to throw');
      } catch (e) {
        expect(e).to.be.instanceOf(ErrorWithStatusCode);
        expect(e.status).to.equal(400);
        expect(e.message).to.equal('Missing Authorization header');
      }
    });

    it('throws 400 when invocation authorization header is not Bearer', async () => {
      const context = {
        invocation: {
          event: {
            headers: {
              authorization: 'Basic token',
            },
          },
        },
      };
      const getImsUserTokenFn = sandbox.stub().throws(new ErrorWithStatusCode('Missing Authorization header', 400));

      try {
        await resolveAemAccessToken(context, { getImsUserTokenFn });
        expect.fail('expected resolveAemAccessToken to throw');
      } catch (e) {
        expect(e).to.be.instanceOf(ErrorWithStatusCode);
        expect(e.status).to.equal(400);
        expect(e.message).to.equal('Missing Authorization header');
      }
    });

    it('throws 401 when promise token exchange fails', async () => {
      const context = {
        data: { promiseToken: { promise_token: 'data-token' } },
      };
      const exchangePromiseTokenFn = sandbox.stub().rejects(new Error('exchange failed'));

      try {
        await resolveAemAccessToken(context, { exchangePromiseTokenFn });
        expect.fail('expected resolveAemAccessToken to throw');
      } catch (e) {
        expect(e).to.be.instanceOf(ErrorWithStatusCode);
        expect(e.status).to.equal(401);
        expect(e.message).to.equal('Authentication failed with upstream IMS service');
      }
    });
  });

  describe('updateCodeConfig', () => {
    let sandbox;
    let log;
    let slackContext;
    let site;

    beforeEach(() => {
      sandbox = sinon.createSandbox();

      log = {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      };

      slackContext = {
        say: sandbox.stub(),
      };

      site = {
        getBaseURL: sandbox.stub().returns('https://www.example.com'),
        getCode: sandbox.stub(),
        setCode: sandbox.stub(),
      };
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('sets code config when host matches EDS pattern', async () => {
      site.getCode.returns({});

      await updateCodeConfig(site, 'main--maidenform--hanes-brands.aem.live', slackContext, log);

      expect(site.setCode).to.have.been.calledWith({
        type: 'github',
        owner: 'hanes-brands',
        repo: 'maidenform',
        ref: 'main',
        url: 'https://github.com/hanes-brands/maidenform',
      });
      expect(log.info).to.have.been.calledWithMatch(/Auto-resolved code config from host/);
      expect(slackContext.say).to.have.been.calledWithMatch(/Auto-resolved code config/);
    });

    it('skips when host is not provided', async () => {
      site.getCode.returns({});

      await updateCodeConfig(site, undefined, slackContext, log);

      expect(site.setCode).not.to.have.been.called;
      expect(log.debug).to.have.been.calledWithMatch(/has no host to resolve code config from/);
    });

    it('skips when host is null', async () => {
      site.getCode.returns({});

      await updateCodeConfig(site, null, slackContext, log);

      expect(site.setCode).not.to.have.been.called;
      expect(log.debug).to.have.been.calledWithMatch(/has no host to resolve code config from/);
    });

    it('skips when host does not match any supported pattern', async () => {
      site.getCode.returns({});

      await updateCodeConfig(site, 'some-random-host.example.com', slackContext, log);

      expect(site.setCode).not.to.have.been.called;
      expect(log.debug).to.have.been.calledWithMatch(/does not match a supported pattern/);
    });

    it('skips when code config already has owner and repo', async () => {
      site.getCode.returns({ owner: 'existing-owner', repo: 'existing-repo' });

      await updateCodeConfig(site, 'main--maidenform--hanes-brands.aem.live', slackContext, log);

      expect(site.setCode).not.to.have.been.called;
      expect(log.debug).to.have.been.calledWithMatch(/already has code config/);
    });

    it('logs debug when AEM CS host does not match EDS pattern', async () => {
      site.getCode.returns({});

      await updateCodeConfig(site, 'author-p12345-e67890.adobeaemcloud.com', slackContext, log);

      expect(site.setCode).not.to.have.been.called;
      expect(log.debug).to.have.been.calledWithMatch(/does not match a supported pattern/);
    });
  });

  describe('getIsSummitPlgEnabled', () => {
    let sandbox;
    let context;
    let site;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      site = { getId: sandbox.stub().returns('site-123') };
      context = {
        log: { error: sandbox.stub() },
        dataAccess: {},
      };
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('returns true when Configuration has summit-plg enabled for site', async () => {
      const isHandlerEnabledForSite = sandbox.stub().withArgs('summit-plg', site).returns(true);
      context.dataAccess.Configuration = {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite,
        }),
      };

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.true;
      expect(context.dataAccess.Configuration.findLatest).to.have.been.calledOnce;
      expect(isHandlerEnabledForSite).to.have.been.calledWith('summit-plg', site);
    });

    it('returns false when Configuration has summit-plg disabled for site', async () => {
      context.dataAccess.Configuration = {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite: sandbox.stub().withArgs('summit-plg', site).returns(false),
        }),
      };

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.false;
    });

    it('returns false when context.dataAccess has no Configuration', async () => {
      context.dataAccess = {};

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.false;
    });

    it('returns false when context.dataAccess is undefined', async () => {
      context.dataAccess = undefined;

      expect(await getIsSummitPlgEnabled(site, context)).to.be.false;
    });

    it('returns false and logs error when findLatest throws', async () => {
      context.dataAccess.Configuration = {
        findLatest: sandbox.stub().rejects(new Error('DB error')),
      };

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.false;
      expect(context.log.error).to.have.been.calledWithMatch(/Error checking audit summit-plg for site/, sinon.match.instanceOf(Error));
    });
  });
});
