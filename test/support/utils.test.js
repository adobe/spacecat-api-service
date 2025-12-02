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
import { expect } from 'chai';
import sinon from 'sinon';

import {
  createProject,
  deriveProjectName,
  hasNonWWWSubdomain,
  toggleWWWHostname,
  wwwUrlResolver,
} from '../../src/support/utils.js';

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

  describe('hasNonWWWSubdomain', () => {
    it('should return true for URLs with non-www subdomains', () => {
      expect(hasNonWWWSubdomain('https://subdomain.domain.com')).to.equal(true);
      expect(hasNonWWWSubdomain('https://blog.example.com')).to.equal(true);
      expect(hasNonWWWSubdomain('https://sub.domain.museum')).to.equal(true);
      expect(hasNonWWWSubdomain('https://sub.domain.com/path?query=123')).to.equal(true);
    });

    it('should return false for URLs without subdomains or with www subdomain', () => {
      expect(hasNonWWWSubdomain('https://www.example.com/path/')).to.equal(false);
      expect(hasNonWWWSubdomain('https://www.site.com')).to.equal(false);
      expect(hasNonWWWSubdomain('https://domain.com')).to.equal(false);
      expect(hasNonWWWSubdomain('https://example.co.uk')).to.equal(false);
      expect(hasNonWWWSubdomain('https://example.com.tr')).to.equal(false);
      expect(hasNonWWWSubdomain('https://example,site')).to.equal(false);
    });
  });

  describe('toggleWWWHostname', () => {
    it('should add www to non-www hostname', () => {
      expect(toggleWWWHostname('example.com')).to.equal('www.example.com');
      expect(toggleWWWHostname('domain.org')).to.equal('www.domain.org');
    });

    it('should remove www from www hostname', () => {
      expect(toggleWWWHostname('www.example.com')).to.equal('example.com');
      expect(toggleWWWHostname('www.domain.org')).to.equal('domain.org');
    });

    it('should not toggle hostnames with non-www subdomains', () => {
      expect(toggleWWWHostname('blog.example.com')).to.equal('blog.example.com');
      expect(toggleWWWHostname('subdomain.domain.org')).to.equal('subdomain.domain.org');
    });
  });

  describe('wwwUrlResolver', () => {
    let sandbox;
    let context;
    let site;
    let rumApiClient;

    beforeEach(async () => {
      sandbox = sinon.createSandbox();

      rumApiClient = {
        retrieveDomainkey: sandbox.stub(),
      };

      // Dynamically import and stub RUMAPIClient
      const RUMAPIClientModule = await import('@adobe/spacecat-shared-rum-api-client');
      sandbox.stub(RUMAPIClientModule.default, 'createFrom').returns(rumApiClient);

      context = {
        log: {
          debug: sandbox.stub(),
          error: sandbox.stub(),
        },
      };

      site = {
        getBaseURL: sandbox.stub(),
        getConfig: sandbox.stub().returns({
          getFetchConfig: sandbox.stub().returns({}),
        }),
      };
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('should return overrideBaseURL when configured', async () => {
      site.getConfig.returns({
        getFetchConfig: () => ({
          overrideBaseURL: 'https://override.example.com',
        }),
      });

      const result = await wwwUrlResolver(site, context);

      expect(result).to.equal('override.example.com');
      expect(rumApiClient.retrieveDomainkey).not.to.have.been.called;
    });

    it('should return hostname directly for non-www subdomains', async () => {
      site.getBaseURL.returns('https://blog.example.com');

      const result = await wwwUrlResolver(site, context);

      expect(result).to.equal('blog.example.com');
      expect(context.log.debug).to.have.been.calledWith('Resolved URL blog.example.com since https://blog.example.com contains subdomain');
      expect(rumApiClient.retrieveDomainkey).not.to.have.been.called;
    });

    it('should prioritize www-toggled version (www added) when it has RUM data', async () => {
      site.getBaseURL.returns('https://example.com');
      rumApiClient.retrieveDomainkey.withArgs('www.example.com').resolves('domain-key');

      const result = await wwwUrlResolver(site, context);

      expect(result).to.equal('www.example.com');
      expect(rumApiClient.retrieveDomainkey).to.have.been.calledWith('www.example.com');
      expect(context.log.debug).to.have.been.calledWith('Resolved URL www.example.com for https://example.com using RUM API Client');
    });

    it('should prioritize www-toggled version (www removed) when it has RUM data', async () => {
      site.getBaseURL.returns('https://www.example.com');
      rumApiClient.retrieveDomainkey.withArgs('example.com').resolves('domain-key');

      const result = await wwwUrlResolver(site, context);

      expect(result).to.equal('example.com');
      expect(rumApiClient.retrieveDomainkey).to.have.been.calledWith('example.com');
      expect(context.log.debug).to.have.been.calledWith('Resolved URL example.com for https://www.example.com using RUM API Client');
    });

    it('should fall back to original hostname when www-toggled has no RUM data', async () => {
      site.getBaseURL.returns('https://example.com');
      rumApiClient.retrieveDomainkey.withArgs('www.example.com').rejects(new Error('No domain key'));
      rumApiClient.retrieveDomainkey.withArgs('example.com').resolves('domain-key');

      const result = await wwwUrlResolver(site, context);

      expect(result).to.equal('example.com');
      expect(rumApiClient.retrieveDomainkey).to.have.been.calledWith('www.example.com');
      expect(rumApiClient.retrieveDomainkey).to.have.been.calledWith('example.com');
      expect(context.log.debug).to.have.been.calledWith('Resolved URL example.com for https://example.com using RUM API Client');
    });

    it('should fall back to www version when both RUM checks fail', async () => {
      site.getBaseURL.returns('https://example.com');
      rumApiClient.retrieveDomainkey.rejects(new Error('No domain key'));

      const result = await wwwUrlResolver(site, context);

      expect(result).to.equal('www.example.com');
      expect(context.log.debug).to.have.been.calledWith('Fallback to www.example.com for URL resolution for https://example.com');
      expect(context.log.error).to.have.been.calledTwice;
    });

    it('should fall back to www version for www hostname when both RUM checks fail', async () => {
      site.getBaseURL.returns('https://www.example.com');
      rumApiClient.retrieveDomainkey.rejects(new Error('No domain key'));

      const result = await wwwUrlResolver(site, context);

      expect(result).to.equal('www.example.com');
      expect(context.log.debug).to.have.been.calledWith('Fallback to www.example.com for URL resolution for https://www.example.com');
    });

    it('should log errors for both failed RUM attempts', async () => {
      site.getBaseURL.returns('https://example.com');
      rumApiClient.retrieveDomainkey.rejects(new Error('API error'));

      await wwwUrlResolver(site, context);

      expect(context.log.error).to.have.been.calledWith('Could not retrieved RUM domainkey for example.com: API error');
      expect(context.log.error).to.have.been.calledTwice;
    });
  });
});
