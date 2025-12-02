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

  describe('toggleWWWHostname', () => {
    it('should remove www from hostname', () => {
      const result = toggleWWWHostname('www.example.com');
      expect(result).to.equal('example.com');
    });

    it('should add www to hostname without subdomain', () => {
      const result = toggleWWWHostname('example.com');
      expect(result).to.equal('www.example.com');
    });

    it('should not toggle hostname with non-www subdomain', () => {
      const result = toggleWWWHostname('blog.example.com');
      expect(result).to.equal('blog.example.com');
    });

    it('should not toggle hostname with multiple subdomains', () => {
      const result = toggleWWWHostname('api.staging.example.com');
      expect(result).to.equal('api.staging.example.com');
    });

    it('should handle invalid hostnames gracefully', () => {
      const result = toggleWWWHostname('invalid,hostname');
      expect(result).to.equal('www.invalid,hostname');
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
        getConfig: sandbox.stub().returns({}),
      };
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('should prioritize www version when it has RUM data', async () => {
      site.getBaseURL.returns('https://example.com');
      rumApiClient.retrieveDomainkey.withArgs('www.example.com').resolves('domain-key');

      const result = await wwwUrlResolver(site, context);

      expect(result).to.equal('www.example.com');
      expect(rumApiClient.retrieveDomainkey).to.have.been.calledWith('www.example.com');
      expect(context.log.debug).to.have.been.calledWith('Resolved URL www.example.com for https://example.com using RUM API Client');
    });

    it('should fall back to non-www version when www has no RUM data', async () => {
      site.getBaseURL.returns('https://www.example.com');
      rumApiClient.retrieveDomainkey.withArgs('www.example.com').rejects(new Error('No domain key'));
      rumApiClient.retrieveDomainkey.withArgs('example.com').resolves('domain-key');

      const result = await wwwUrlResolver(site, context);

      expect(result).to.equal('example.com');
      expect(rumApiClient.retrieveDomainkey).to.have.been.calledWith('www.example.com');
      expect(rumApiClient.retrieveDomainkey).to.have.been.calledWith('example.com');
      expect(context.log.debug).to.have.been.calledWith('Resolved URL example.com for https://www.example.com using RUM API Client');
    });

    it('should throw error when neither version has RUM data', async () => {
      site.getBaseURL.returns('https://example.com');
      rumApiClient.retrieveDomainkey.rejects(new Error('No domain key'));

      await expect(wwwUrlResolver(site, context)).to.be.rejectedWith('No RUM data found for https://example.com (tried both www.example.com and example.com)');
      expect(context.log.error).to.have.been.calledTwice;
    });

    it('should handle www subdomain correctly when checking both versions', async () => {
      site.getBaseURL.returns('https://www.bhgfinancial.com');
      rumApiClient.retrieveDomainkey.withArgs('www.bhgfinancial.com').rejects(new Error('No domain key'));
      rumApiClient.retrieveDomainkey.withArgs('bhgfinancial.com').resolves('domain-key');

      const result = await wwwUrlResolver(site, context);

      expect(result).to.equal('bhgfinancial.com');
      expect(context.log.debug).to.have.been.calledWith('Resolved URL bhgfinancial.com for https://www.bhgfinancial.com using RUM API Client');
    });

    it('should log errors for both failed attempts before throwing', async () => {
      site.getBaseURL.returns('https://example.com');
      rumApiClient.retrieveDomainkey.rejects(new Error('API error'));

      await expect(wwwUrlResolver(site, context)).to.be.rejectedWith('No RUM data found');
      expect(context.log.error).to.have.been.calledWith('Could not retrieve RUM domainkey for www version www.example.com: API error');
      expect(context.log.error).to.have.been.calledWith('Could not retrieve RUM domainkey for non-www version example.com: API error');
    });
  });
});
