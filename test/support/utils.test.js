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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import nock from 'nock';

import TierClient from '@adobe/spacecat-shared-tier-client';
import { AUTHORING_TYPES, DELIVERY_TYPES } from '@adobe/spacecat-shared-utils';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';
import {
  createProject,
  deriveProjectName,
  autoResolveAuthorUrl,
  updateCodeConfig,
  getIsSummitPlgEnabled,
  getCookieValue,
  filterSitesForProductCode,
  queueDetectCdnAudit,
  queueDeliveryConfigWriter,
  validateSiteForRedirects,
  sendAutofixMessage,
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
      site = {
        getId: sandbox.stub().returns('site-123'),
        getOrganizationId: sandbox.stub().returns('org-456'),
      };
      context = {
        log: { error: sandbox.stub() },
        dataAccess: {},
      };
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('returns true when summit-plg is enabled and entitlement is PLG ASO', async () => {
      const isHandlerEnabledForSite = sandbox.stub().withArgs('summit-plg', site).returns(true);
      context.dataAccess.Configuration = {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite,
        }),
      };
      context.dataAccess.Entitlement = {
        findByOrganizationIdAndProductCode: sandbox.stub()
          .withArgs('org-456', 'ASO')
          .resolves({ getTier: () => 'PLG' }),
      };

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.true;
      expect(context.dataAccess.Configuration.findLatest).to.have.been.calledOnce;
      expect(isHandlerEnabledForSite).to.have.been.calledWith('summit-plg', site);
      expect(context.dataAccess.Entitlement.findByOrganizationIdAndProductCode)
        .to.have.been.calledWith('org-456', 'ASO');
    });

    it('returns false when summit-plg is enabled but entitlement is FREE_TRIAL', async () => {
      context.dataAccess.Configuration = {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite: sandbox.stub().withArgs('summit-plg', site).returns(true),
        }),
      };
      context.dataAccess.Entitlement = {
        findByOrganizationIdAndProductCode: sandbox.stub()
          .resolves({ getTier: () => 'FREE_TRIAL' }),
      };

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.false;
    });

    it('returns false when summit-plg is enabled but entitlement is PRE_ONBOARD', async () => {
      context.dataAccess.Configuration = {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite: sandbox.stub().withArgs('summit-plg', site).returns(true),
        }),
      };
      context.dataAccess.Entitlement = {
        findByOrganizationIdAndProductCode: sandbox.stub()
          .resolves({ getTier: () => 'PRE_ONBOARD' }),
      };

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.false;
    });

    it('returns false when summit-plg is enabled but entitlement is PAID', async () => {
      context.dataAccess.Configuration = {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite: sandbox.stub().withArgs('summit-plg', site).returns(true),
        }),
      };
      context.dataAccess.Entitlement = {
        findByOrganizationIdAndProductCode: sandbox.stub()
          .resolves({ getTier: () => 'PAID' }),
      };

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.false;
    });

    it('returns false when summit-plg is enabled but no ASO entitlement exists', async () => {
      context.dataAccess.Configuration = {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite: sandbox.stub().withArgs('summit-plg', site).returns(true),
        }),
      };
      context.dataAccess.Entitlement = {
        findByOrganizationIdAndProductCode: sandbox.stub().resolves(null),
      };

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.false;
    });

    it('returns false when summit-plg is enabled but Entitlement model is missing', async () => {
      context.dataAccess.Configuration = {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite: sandbox.stub().withArgs('summit-plg', site).returns(true),
        }),
      };

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.false;
    });

    it('returns false when summit-plg is enabled but organizationId is missing', async () => {
      site.getOrganizationId.returns(undefined);
      context.dataAccess.Configuration = {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite: sandbox.stub().withArgs('summit-plg', site).returns(true),
        }),
      };
      context.dataAccess.Entitlement = {
        findByOrganizationIdAndProductCode: sandbox.stub(),
      };

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.false;
      const findEntitlement = context.dataAccess.Entitlement.findByOrganizationIdAndProductCode;
      expect(findEntitlement).to.not.have.been.called;
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

    it('returns false and logs error when entitlement lookup throws', async () => {
      context.dataAccess.Configuration = {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite: sandbox.stub().withArgs('summit-plg', site).returns(true),
        }),
      };
      context.dataAccess.Entitlement = {
        findByOrganizationIdAndProductCode: sandbox.stub().rejects(new Error('Entitlement DB error')),
      };

      const result = await getIsSummitPlgEnabled(site, context);

      expect(result).to.be.false;
      expect(context.log.error).to.have.been.calledOnce;
    });
  });

  describe('getCookieValue', () => {
    it('returns the value for a matching cookie name', () => {
      const context = { pathInfo: { headers: { cookie: 'session=abc; promiseToken=token123' } } };
      expect(getCookieValue(context, 'promiseToken')).to.equal('token123');
    });

    it('returns null when the cookie is not present', () => {
      const context = { pathInfo: { headers: { cookie: 'session=abc' } } };
      expect(getCookieValue(context, 'promiseToken')).to.equal(null);
    });

    it('returns null when cookie header is missing', () => {
      expect(getCookieValue({}, 'promiseToken')).to.equal(null);
      expect(getCookieValue({ pathInfo: {} }, 'promiseToken')).to.equal(null);
      expect(getCookieValue({ pathInfo: { headers: {} } }, 'promiseToken')).to.equal(null);
    });

    it('preserves value containing = characters (base64 tokens)', () => {
      const base64Token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZw==';
      const context = { pathInfo: { headers: { cookie: `promiseToken=${base64Token}` } } };
      expect(getCookieValue(context, 'promiseToken')).to.equal(base64Token);
    });

    it('preserves value with multiple = padding characters', () => {
      const context = { pathInfo: { headers: { cookie: 'promiseToken=abc123==' } } };
      expect(getCookieValue(context, 'promiseToken')).to.equal('abc123==');
    });

    it('handles multiple cookies with = in values', () => {
      const context = { pathInfo: { headers: { cookie: 'other=x=y; promiseToken=a=b=c; last=z' } } };
      expect(getCookieValue(context, 'promiseToken')).to.equal('a=b=c');
    });

    it('returns null for empty cookie string', () => {
      const context = { pathInfo: { headers: { cookie: '' } } };
      expect(getCookieValue(context, 'promiseToken')).to.equal(null);
    });
  });

  describe('filterSitesForProductCode', () => {
    let mockTierClient;
    let mockContext;
    let mockOrg;
    let mockSites;
    let sandbox2;
    let nonAdminUtil;
    let adminUtil;

    beforeEach(() => {
      sandbox2 = sinon.createSandbox();

      mockSites = [
        { getId: () => 'site-1' },
        { getId: () => 'site-2' },
      ];

      mockOrg = { getId: () => 'org-1' };

      mockTierClient = {
        checkValidEntitlement: sandbox2.stub(),
      };
      sandbox2.stub(TierClient, 'createForOrg').returns(mockTierClient);

      mockContext = {
        dataAccess: {
          SiteEnrollment: {
            allByEntitlementId: sandbox2.stub(),
          },
        },
        log: { error: sinon.stub() },
      };

      nonAdminUtil = { hasAdminAccess: () => false };
      adminUtil = { hasAdminAccess: () => true };
    });

    afterEach(() => {
      sandbox2.restore();
    });

    it('returns empty array when no entitlement exists', async () => {
      mockTierClient.checkValidEntitlement.resolves({ entitlement: null });

      const result = await filterSitesForProductCode(mockContext, mockOrg, mockSites, 'llmo', nonAdminUtil);

      expect(result).to.deep.equal([]);
    });

    it('returns enrolled sites for PLG-tier entitlement', async () => {
      mockTierClient.checkValidEntitlement.resolves({
        entitlement: {
          getId: () => 'ent-1',
          getTier: () => EntitlementModel.TIERS.PLG,
        },
      });
      mockContext.dataAccess.SiteEnrollment.allByEntitlementId.resolves([
        { getSiteId: () => 'site-1' },
      ]);

      const result = await filterSitesForProductCode(mockContext, mockOrg, mockSites, 'llmo', nonAdminUtil);

      expect(result).to.have.lengthOf(1);
      expect(result[0].getId()).to.equal('site-1');
    });

    it('returns empty array for PRE_ONBOARD-tier entitlement for non-admin', async () => {
      mockTierClient.checkValidEntitlement.resolves({
        entitlement: {
          getId: () => 'ent-1',
          getTier: () => EntitlementModel.TIERS.PRE_ONBOARD,
        },
      });

      const result = await filterSitesForProductCode(mockContext, mockOrg, mockSites, 'llmo', nonAdminUtil);

      expect(result).to.deep.equal([]);
      expect(mockContext.dataAccess.SiteEnrollment.allByEntitlementId).to.not.have.been.called;
    });

    it('returns enrolled sites for PRE_ONBOARD-tier entitlement for admin', async () => {
      mockTierClient.checkValidEntitlement.resolves({
        entitlement: {
          getId: () => 'ent-1',
          getTier: () => EntitlementModel.TIERS.PRE_ONBOARD,
        },
      });
      mockContext.dataAccess.SiteEnrollment.allByEntitlementId.resolves([
        { getSiteId: () => 'site-1' },
      ]);

      const result = await filterSitesForProductCode(mockContext, mockOrg, mockSites, 'llmo', adminUtil);

      expect(result).to.have.lengthOf(1);
      expect(result[0].getId()).to.equal('site-1');
      expect(mockContext.dataAccess.SiteEnrollment.allByEntitlementId).to.have.been.calledOnce;
    });

    it('returns enrolled sites for FREE_TRIAL-tier entitlement', async () => {
      mockTierClient.checkValidEntitlement.resolves({
        entitlement: {
          getId: () => 'ent-1',
          getTier: () => EntitlementModel.TIERS.FREE_TRIAL,
        },
      });
      mockContext.dataAccess.SiteEnrollment.allByEntitlementId.resolves([
        { getSiteId: () => 'site-1' },
      ]);

      const result = await filterSitesForProductCode(mockContext, mockOrg, mockSites, 'llmo', nonAdminUtil);

      expect(result).to.have.lengthOf(1);
      expect(result[0].getId()).to.equal('site-1');
    });

    it('returns enrolled sites for PAID-tier entitlement', async () => {
      mockTierClient.checkValidEntitlement.resolves({
        entitlement: {
          getId: () => 'ent-1',
          getTier: () => EntitlementModel.TIERS.PAID,
        },
      });
      mockContext.dataAccess.SiteEnrollment.allByEntitlementId.resolves([
        { getSiteId: () => 'site-1' },
        { getSiteId: () => 'site-2' },
      ]);

      const result = await filterSitesForProductCode(mockContext, mockOrg, mockSites, 'llmo', nonAdminUtil);

      expect(result).to.have.lengthOf(2);
    });

    it('returns empty array for any unrecognized future tier for non-admin (allow-list pattern)', async () => {
      mockTierClient.checkValidEntitlement.resolves({
        entitlement: {
          getId: () => 'ent-1',
          getTier: () => 'FUTURE_TIER',
        },
      });

      const result = await filterSitesForProductCode(mockContext, mockOrg, mockSites, 'llmo', nonAdminUtil);

      expect(result).to.deep.equal([]);
    });

    it('returns enrolled sites for any unrecognized future tier for admin', async () => {
      mockTierClient.checkValidEntitlement.resolves({
        entitlement: {
          getId: () => 'ent-1',
          getTier: () => 'FUTURE_TIER',
        },
      });
      mockContext.dataAccess.SiteEnrollment.allByEntitlementId.resolves([
        { getSiteId: () => 'site-1' },
        { getSiteId: () => 'site-2' },
      ]);

      const result = await filterSitesForProductCode(mockContext, mockOrg, mockSites, 'llmo', adminUtil);

      expect(result).to.have.lengthOf(2);
    });
  });

  describe('validateSiteForRedirects', () => {
    function makeSite({
      id = 'site-1',
      baseURL = 'https://example.com',
      authoringType = AUTHORING_TYPES.CS,
      deliveryType = DELIVERY_TYPES.AEM_CS,
      deliveryConfig = { programId: 'p1', environmentId: 'e1' },
    } = {}) {
      return {
        getId: () => id,
        getBaseURL: () => baseURL,
        getAuthoringType: () => authoringType,
        getDeliveryType: () => deliveryType,
        getDeliveryConfig: () => deliveryConfig,
      };
    }

    // happy path
    it('return validForRedirects: true, programID: string, environmentID: string when site is valid for redirects', async () => {
      const result = validateSiteForRedirects(makeSite());
      expect(result).to.deep.equal({
        validForRedirects: true,
        skipMessage: '',
        programId: 'p1',
        environmentId: 'e1',
      });
    });

    it('returns valid when authoring is cs/crosswalk with delivery ids', () => {
      const result = validateSiteForRedirects(makeSite({ authoringType: AUTHORING_TYPES.CS_CW }));
      expect(result.validForRedirects).to.be.true;
      expect(result.programId).to.equal('p1');
      expect(result.environmentId).to.equal('e1');
    });

    it('returns valid when delivery is aem_cs even if authoring is not CS', () => {
      const result = validateSiteForRedirects(
        makeSite({ authoringType: AUTHORING_TYPES.AMS, deliveryType: DELIVERY_TYPES.AEM_CS }),
      );
      expect(result.validForRedirects).to.be.true;
    });

    it('returns invalid when authoring and delivery are not valid for update-redirects', () => {
      const site = makeSite({
        authoringType: AUTHORING_TYPES.AMS,
        deliveryType: DELIVERY_TYPES.AEM_EDGE,
        deliveryConfig: { programId: 'p1', environmentId: 'e1' },
      });
      const result = validateSiteForRedirects(site);
      expect(result.validForRedirects).to.be.false;
      expect(result.skipMessage).to.match(
        /not valid for redirects because authoringType is `ams` and deliveryType is `aem_edge`/,
      );
      expect(result.programId).to.equal('p1');
      expect(result.environmentId).to.equal('e1');
    });

    it('returns invalid and clears ids when programId or environmentId is missing', () => {
      const site = makeSite({ deliveryConfig: { programId: 'p1', environmentId: '' } });
      const result = validateSiteForRedirects(site);
      expect(result.validForRedirects).to.be.false;
      expect(result.programId).to.be.undefined;
      expect(result.environmentId).to.be.undefined;
      expect(result.skipMessage).to.include('environmentID and/or programID is missing');
    });

    it('uses empty deliveryConfig when getDeliveryConfig is absent', () => {
      const site = {
        getId: () => 's1',
        getBaseURL: () => 'https://x.com',
        getAuthoringType: () => AUTHORING_TYPES.CS,
        getDeliveryType: () => DELIVERY_TYPES.AEM_CS,
      };
      const result = validateSiteForRedirects(site);
      expect(result.validForRedirects).to.be.false;
      expect(result.programId).to.be.undefined;
      expect(result.environmentId).to.be.undefined;
    });
  });

  describe('queueDetectCdnAudit', () => {
    let sandbox;
    let context;
    let sqsStub;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      sqsStub = { sendMessage: sandbox.stub().resolves() };
      context = {
        env: { AUDIT_JOBS_QUEUE_URL: 'https://sqs.example.com/queue' },
        log: { error: sandbox.stub() },
        sqs: sqsStub,
      };
    });

    afterEach(() => sandbox.restore());

    it('returns error when baseURL and site are both missing', async () => {
      const result = await queueDetectCdnAudit({ slackContext: {} }, context);
      expect(result).to.deep.equal({ ok: false, error: ':warning: detect-cdn: missing or invalid URL.' });
    });

    it('falls back to site.getBaseURL() when baseURL is not provided', async () => {
      const site = { getBaseURL: () => 'https://site.com', getId: () => 'site-1' };
      const result = await queueDetectCdnAudit({ site, slackContext: {} }, context);
      expect(result).to.deep.equal({ ok: true });
      expect(sqsStub.sendMessage.firstCall.args[1]).to.include({ baseURL: 'https://site.com' });
    });

    it('returns error when sqs is missing', async () => {
      const result = await queueDetectCdnAudit(
        { baseURL: 'https://example.com', slackContext: {} },
        { ...context, sqs: null },
      );
      expect(result).to.deep.equal({ ok: false, error: ':x: Server misconfiguration: missing SQS client.' });
    });

    it('returns error when AUDIT_JOBS_QUEUE_URL is missing', async () => {
      const result = await queueDetectCdnAudit(
        { baseURL: 'https://example.com', slackContext: {} },
        { ...context, env: {} },
      );
      expect(result).to.deep.equal({ ok: false, error: ':x: Server misconfiguration: missing `AUDIT_JOBS_QUEUE_URL`.' });
    });

    it('returns error when env is absent', async () => {
      const { env: _, ...ctxWithoutEnv } = context;
      const result = await queueDetectCdnAudit(
        { baseURL: 'https://example.com', slackContext: {} },
        ctxWithoutEnv,
      );
      expect(result).to.deep.equal({ ok: false, error: ':x: Server misconfiguration: missing `AUDIT_JOBS_QUEUE_URL`.' });
    });

    it('includes siteId in payload when site has an id', async () => {
      const site = { getBaseURL: () => 'https://site.com', getId: () => 'abc-123' };
      await queueDetectCdnAudit({ site, baseURL: 'https://example.com', slackContext: {} }, context);
      expect(sqsStub.sendMessage.firstCall.args[1]).to.include({ siteId: 'abc-123' });
    });

    it('omits siteId when site is absent', async () => {
      await queueDetectCdnAudit({ baseURL: 'https://example.com', slackContext: {} }, context);
      expect(sqsStub.sendMessage.firstCall.args[1]).to.not.have.property('siteId');
    });

    it('includes slackContext in payload when channelId and threadTs are present', async () => {
      const slackContext = { channelId: 'C123', threadTs: '1234.5' };
      await queueDetectCdnAudit({ baseURL: 'https://example.com', slackContext }, context);
      expect(sqsStub.sendMessage.firstCall.args[1].slackContext).to.deep.equal({
        channelId: 'C123',
        threadTs: '1234.5',
      });
    });

    it('omits slackContext from payload when channelId is null', async () => {
      const slackContext = { channelId: null, threadTs: '1234.5' };
      await queueDetectCdnAudit({ baseURL: 'https://example.com', slackContext }, context);
      expect(sqsStub.sendMessage.firstCall.args[1]).to.not.have.property('slackContext');
    });

    it('omits slackContext from payload when threadTs is null', async () => {
      const slackContext = { channelId: 'C123', threadTs: null };
      await queueDetectCdnAudit({ baseURL: 'https://example.com', slackContext }, context);
      expect(sqsStub.sendMessage.firstCall.args[1]).to.not.have.property('slackContext');
    });

    it('calls say when say function is provided', async () => {
      const say = sandbox.stub().resolves();
      const slackContext = { say, channelId: 'C123', threadTs: '1234.5' };
      await queueDetectCdnAudit({ baseURL: 'https://example.com', slackContext }, context);
      expect(say).to.have.been.calledOnce;
      expect(say.firstCall.args[0]).to.include('Queued CDN detection');
    });

    it('sends message with correct type and baseURL', async () => {
      await queueDetectCdnAudit({ baseURL: 'https://example.com', slackContext: {} }, context);
      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      expect(sqsStub.sendMessage.firstCall.args[0]).to.equal('https://sqs.example.com/queue');
      expect(sqsStub.sendMessage.firstCall.args[1]).to.include({
        type: 'detect-cdn',
        baseURL: 'https://example.com',
      });
    });

    it('throws and logs error when sendMessage rejects', async () => {
      sqsStub.sendMessage.rejects(new Error('SQS failure'));
      await expect(
        queueDetectCdnAudit({ baseURL: 'https://example.com', slackContext: {} }, context),
      ).to.be.rejectedWith('SQS failure');
      expect(context.log.error).to.have.been.calledOnce;
    });
  });

  describe('queueDeliveryConfigWriter', () => {
    // Real values from SiteModel constants
    const CS = 'cs';
    const CS_CW = 'cs/crosswalk';
    const AEM_CS = 'aem_cs';
    const NON_CS = 'AMS';

    let sandbox;
    let context;
    let sqsStub;

    function makeSite({
      id = 'site-1',
      baseURL = 'https://example.com',
      authoringType = CS,
      deliveryType = AEM_CS,
      deliveryConfig = { programId: 'p1', environmentId: 'e1' },
    } = {}) {
      return {
        getId: () => id,
        getBaseURL: () => baseURL,
        getAuthoringType: () => authoringType,
        getDeliveryType: () => deliveryType,
        getDeliveryConfig: () => deliveryConfig,
      };
    }

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      sqsStub = { sendMessage: sandbox.stub().resolves() };
      context = {
        env: { AUDIT_JOBS_QUEUE_URL: 'https://sqs.example.com/queue' },
        log: { error: sandbox.stub(), info: sandbox.stub() },
        sqs: sqsStub,
      };
    });

    afterEach(() => sandbox.restore());

    it('returns error when site is null', async () => {
      const result = await queueDeliveryConfigWriter(
        { site: null, baseURL: 'https://example.com', slackContext: {} },
        context,
      );
      expect(result.ok).to.be.false;
      expect(result.error).to.include('No site found');
    });

    it('returns error when resolved baseURL is empty', async () => {
      const site = {
        getId: () => 'site-1',
        getBaseURL: () => '',
        getAuthoringType: () => CS,
        getDeliveryType: () => AEM_CS,
        getDeliveryConfig: () => ({ programId: 'p1', environmentId: 'e1' }),
      };
      const result = await queueDeliveryConfigWriter({ site, slackContext: {} }, context);
      expect(result.ok).to.be.false;
      expect(result.error).to.include('missing or invalid URL');
    });

    it('falls back to site.getBaseURL() when baseURL param is absent', async () => {
      const site = makeSite({ baseURL: 'https://fallback.com' });
      await queueDeliveryConfigWriter({ site, slackContext: {} }, context);
      expect(sqsStub.sendMessage.firstCall.args[1]).to.include({ baseURL: 'https://fallback.com' });
    });

    it('returns error when sqs is missing', async () => {
      const result = await queueDeliveryConfigWriter(
        { site: makeSite(), baseURL: 'https://example.com', slackContext: {} },
        { ...context, sqs: null },
      );
      expect(result).to.deep.equal({ ok: false, error: ':x: Server misconfiguration: missing SQS client.' });
    });

    it('returns error when AUDIT_JOBS_QUEUE_URL is missing', async () => {
      const result = await queueDeliveryConfigWriter(
        { site: makeSite(), baseURL: 'https://example.com', slackContext: {} },
        { ...context, env: {} },
      );
      expect(result.ok).to.be.false;
      expect(result.error).to.include('AUDIT_JOBS_QUEUE_URL');
    });

    it('returns error when env is absent', async () => {
      const { env: _, ...ctxNoEnv } = context;
      const result = await queueDeliveryConfigWriter(
        { site: makeSite(), baseURL: 'https://example.com', slackContext: {} },
        ctxNoEnv,
      );
      expect(result.ok).to.be.false;
    });

    it('includes redirect params when authoringType is CS', async () => {
      const site = makeSite({ authoringType: CS, deliveryType: 'other' });
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext: {} }, context);
      expect(sqsStub.sendMessage.firstCall.args[1]).to.include({
        programId: 'p1',
        environmentId: 'e1',
        minutes: 2000,
        updateRedirects: true,
      });
    });

    it('includes redirect params when authoringType is CS_CW', async () => {
      const site = makeSite({ authoringType: CS_CW, deliveryType: 'other' });
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext: {} }, context);
      expect(sqsStub.sendMessage.firstCall.args[1]).to.include({ programId: 'p1', environmentId: 'e1' });
    });

    it('includes redirect params when deliveryType is AEM_CS (authoringType non-CS)', async () => {
      const site = makeSite({ authoringType: NON_CS, deliveryType: AEM_CS });
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext: {} }, context);
      expect(sqsStub.sendMessage.firstCall.args[1]).to.include({ programId: 'p1', environmentId: 'e1' });
    });

    it('omits redirect params and logs info when site is not valid for redirects', async () => {
      const site = makeSite({ authoringType: NON_CS, deliveryType: 'AEM_AMS' });
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext: {} }, context);
      const payload = sqsStub.sendMessage.firstCall.args[1];
      expect(payload).to.not.have.property('programId');
      expect(payload).to.not.have.property('environmentId');
      expect(context.log.info).to.have.been.calledWithMatch('CDN detection only');
    });

    it('skips redirect params and logs info when programId is missing', async () => {
      const site = makeSite({ deliveryConfig: { programId: '', environmentId: 'e1' } });
      const result = await queueDeliveryConfigWriter(
        { site, baseURL: 'https://example.com', slackContext: {} },
        context,
      );
      expect(result).to.deep.equal({ ok: true });
      expect(sqsStub.sendMessage.firstCall.args[1]).to.not.have.property('programId');
      expect(context.log.info).to.have.been.calledWithMatch(
        'environmentID and/or programID is missing',
      );
    });

    it('skips redirect params and logs info when environmentId is missing', async () => {
      const site = makeSite({ deliveryConfig: { programId: 'p1', environmentId: '' } });
      const result = await queueDeliveryConfigWriter(
        { site, baseURL: 'https://example.com', slackContext: {} },
        context,
      );
      expect(result).to.deep.equal({ ok: true });
      expect(sqsStub.sendMessage.firstCall.args[1]).to.not.have.property('programId');
      expect(context.log.info).to.have.been.calledWithMatch(
        'environmentID and/or programID is missing',
      );
    });

    it('skips redirect params and logs info when getDeliveryConfig is absent', async () => {
      const site = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://example.com',
        getAuthoringType: () => CS,
        getDeliveryType: () => AEM_CS,
        // no getDeliveryConfig
      };
      const result = await queueDeliveryConfigWriter(
        { site, baseURL: 'https://example.com', slackContext: {} },
        context,
      );
      expect(result).to.deep.equal({ ok: true });
      expect(sqsStub.sendMessage.firstCall.args[1]).to.not.have.property('programId');
      expect(context.log.info).to.have.been.calledWithMatch(
        'environmentID and/or programID is missing',
      );
    });

    it('includes slackContext in payload when channelId and threadTs are present', async () => {
      const site = makeSite();
      const slackContext = { channelId: 'C123', threadTs: '1234.5' };
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext }, context);
      expect(sqsStub.sendMessage.firstCall.args[1].slackContext).to.deep.equal({
        channelId: 'C123',
        threadTs: '1234.5',
      });
    });

    it('omits slackContext from payload when channelId is null', async () => {
      const site = makeSite();
      const slackContext = { channelId: null, threadTs: '1234.5' };
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext }, context);
      expect(sqsStub.sendMessage.firstCall.args[1]).to.not.have.property('slackContext');
    });

    it('omits slackContext from payload when threadTs is null', async () => {
      const site = makeSite();
      const slackContext = { channelId: 'C123', threadTs: null };
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext }, context);
      expect(sqsStub.sendMessage.firstCall.args[1]).to.not.have.property('slackContext');
    });

    it('calls say with redirect note when site is valid for redirects', async () => {
      const say = sandbox.stub().resolves();
      const site = makeSite();
      const slackContext = { say, channelId: 'C123', threadTs: '1234.5' };
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext }, context);
      expect(say).to.have.been.calledOnce;
      expect(say.firstCall.args[0]).to.include('redirect pattern detection');
    });

    it('calls say without redirect note when site is not valid for redirects', async () => {
      const say = sandbox.stub().resolves();
      const site = makeSite({ authoringType: NON_CS, deliveryType: 'AEM_AMS' });
      const slackContext = { say, channelId: 'C123', threadTs: '1234.5' };
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext }, context);
      expect(say).to.have.been.calledOnce;
      expect(say.firstCall.args[0]).to.not.include('redirect pattern detection');
    });

    it('calls say without redirect note when programId/environmentId are missing', async () => {
      const say = sandbox.stub().resolves();
      const site = makeSite({ deliveryConfig: { programId: '', environmentId: '' } });
      const slackContext = { say, channelId: 'C123', threadTs: '1234.5' };
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext }, context);
      expect(say).to.have.been.calledOnce;
      expect(say.firstCall.args[0]).to.not.include('redirect pattern detection');
    });

    it('does not call say when say is not provided', async () => {
      const site = makeSite();
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext: {} }, context);
      expect(sqsStub.sendMessage).to.have.been.calledOnce;
    });

    it('sends message with correct type, siteId, and baseURL', async () => {
      const site = makeSite();
      await queueDeliveryConfigWriter({ site, baseURL: 'https://example.com', slackContext: {} }, context);
      expect(sqsStub.sendMessage.firstCall.args[0]).to.equal('https://sqs.example.com/queue');
      expect(sqsStub.sendMessage.firstCall.args[1]).to.include({
        type: 'delivery-config-writer',
        siteId: 'site-1',
        baseURL: 'https://example.com',
      });
    });

    it('returns { ok: true } on success', async () => {
      const site = makeSite();
      const result = await queueDeliveryConfigWriter(
        { site, baseURL: 'https://example.com', slackContext: {} },
        context,
      );
      expect(result).to.deep.equal({ ok: true });
    });

    it('uses provided minutes and updateRedirects when site is valid for redirects', async () => {
      const site = makeSite();
      await queueDeliveryConfigWriter(
        {
          site, baseURL: 'https://example.com', minutes: 500, updateRedirects: false, slackContext: {},
        },
        context,
      );
      const payload = sqsStub.sendMessage.firstCall.args[1];
      expect(payload).to.include({ minutes: 500, updateRedirects: false });
    });

    it('throws and logs error when sendMessage rejects', async () => {
      sqsStub.sendMessage.rejects(new Error('SQS down'));
      await expect(
        queueDeliveryConfigWriter(
          { site: makeSite(), baseURL: 'https://example.com', slackContext: {} },
          context,
        ),
      ).to.be.rejectedWith('SQS down');
      expect(context.log.error).to.have.been.calledOnce;
    });
  });

  describe('sendAutofixMessage', () => {
    let mockSqs;

    beforeEach(() => {
      mockSqs = { sendMessage: sinon.stub().resolves() };
    });

    it('sends message with relationshipContext.fixTargetPageId when provided', async () => {
      await sendAutofixMessage(
        mockSqs,
        'https://queue-url',
        'site-1',
        'opp-1',
        ['s-1', 's-2'],
        'token',
        null,
        null,
        null,
        {
          url: 'https://example.com',
          relationshipContext: { fixTargetPageId: 'page-uuid-123' },
        },
      );

      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const payload = mockSqs.sendMessage.firstCall.args[1];
      expect(payload).to.have.property('relationshipContext');
      expect(payload.relationshipContext).to.deep.equal({ fixTargetPageId: 'page-uuid-123' });
      expect(payload).to.have.property('url', 'https://example.com');
      expect(payload).to.have.property('siteId', 'site-1');
      expect(payload).to.have.property('opportunityId', 'opp-1');
      expect(payload.suggestionIds).to.deep.equal(['s-1', 's-2']);
    });

    it('sends message with relationshipContext when additional fields are provided', async () => {
      await sendAutofixMessage(
        mockSqs,
        'https://queue-url',
        'site-1',
        'opp-1',
        ['s-1'],
        'token',
        null,
        null,
        null,
        {
          url: 'https://example.com',
          relationshipContext: {
            fixTargetPageId: 'page-uuid-123',
            cancelInheritance: true,
            fixTargetMode: 'source',
            appliedOnPagePath: '/content/wknd/language-masters/en/adventures/bali-surf-camp',
          },
        },
      );

      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const payload = mockSqs.sendMessage.firstCall.args[1];
      expect(payload).to.have.property('relationshipContext');
      expect(payload.relationshipContext).to.deep.equal({
        fixTargetPageId: 'page-uuid-123',
        cancelInheritance: true,
        fixTargetMode: 'source',
        appliedOnPagePath: '/content/wknd/language-masters/en/adventures/bali-surf-camp',
      });
    });

    it('omits relationshipContext when not provided', async () => {
      await sendAutofixMessage(
        mockSqs,
        'https://queue-url',
        'site-1',
        'opp-1',
        ['s-1'],
        'token',
        null,
        null,
        null,
        { url: 'https://example.com' },
      );

      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const payload = mockSqs.sendMessage.firstCall.args[1];
      expect(payload).to.not.have.property('relationshipContext');
      expect(payload).to.have.property('url', 'https://example.com');
    });

    it('omits relationshipContext when it is undefined', async () => {
      await sendAutofixMessage(
        mockSqs,
        'https://queue-url',
        'site-1',
        'opp-1',
        ['s-1'],
        'token',
        null,
        null,
        null,
        { url: 'https://example.com', relationshipContext: undefined },
      );

      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const payload = mockSqs.sendMessage.firstCall.args[1];
      expect(payload).to.not.have.property('relationshipContext');
    });

    it('includes customData when provided alongside relationshipContext', async () => {
      const customData = { key: 'value' };
      await sendAutofixMessage(
        mockSqs,
        'https://queue-url',
        'site-1',
        'opp-1',
        ['s-1'],
        'token',
        null,
        null,
        customData,
        {
          url: 'https://example.com',
          relationshipContext: { fixTargetPageId: 'page-123' },
        },
      );

      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const payload = mockSqs.sendMessage.firstCall.args[1];
      expect(payload.relationshipContext).to.deep.equal({ fixTargetPageId: 'page-123' });
      expect(payload).to.have.property('customData');
      expect(payload.customData).to.deep.equal({ key: 'value' });
    });
  });
});
