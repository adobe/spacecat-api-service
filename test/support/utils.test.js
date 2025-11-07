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
import TierClient from '@adobe/spacecat-shared-tier-client';
import { createProject, deriveProjectName, filterSitesForProductCode } from '../../src/support/utils.js';

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

  describe('filterSitesForProductCode', () => {
    let sandbox;
    let context;
    let organization;
    let mockTierClient;

    beforeEach(() => {
      sandbox = sinon.createSandbox();

      mockTierClient = {
        checkValidEntitlement: sandbox.stub(),
      };

      sandbox.stub(TierClient, 'createForOrg').returns(mockTierClient);

      context = {
        log: {
          error: sandbox.stub(),
          info: sandbox.stub(),
        },
        dataAccess: {
          SiteEnrollmentV2: {
            batchGetByKeys: sandbox.stub(),
          },
        },
      };

      organization = {
        getId: () => 'org-123',
        getName: () => 'Test Organization',
      };
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('filters sites that have valid enrollments for the product code', async () => {
      const sites = [
        { getId: () => 'site-1', getBaseURL: () => 'https://site1.com' },
        { getId: () => 'site-2', getBaseURL: () => 'https://site2.com' },
        { getId: () => 'site-3', getBaseURL: () => 'https://site3.com' },
      ];

      const mockEntitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'LLMO',
      };

      const mockEnrollments = [
        { getSiteId: () => 'site-1', getEntitlementId: () => 'entitlement-123' },
        { getSiteId: () => 'site-3', getEntitlementId: () => 'entitlement-123' },
      ];

      mockTierClient.checkValidEntitlement.resolves({ entitlement: mockEntitlement });
      context.dataAccess.SiteEnrollmentV2.batchGetByKeys.resolves({
        data: mockEnrollments,
        unprocessed: [],
      });

      const result = await filterSitesForProductCode(context, organization, sites, 'LLMO');

      expect(result).to.have.lengthOf(2);
      expect(result[0].getId()).to.equal('site-1');
      expect(result[1].getId()).to.equal('site-3');
      expect(TierClient.createForOrg).to.have.been.calledWith(context, organization, 'LLMO');
      expect(context.dataAccess.SiteEnrollmentV2.batchGetByKeys).to.have.been.calledOnce;
    });

    it('returns empty array when no sites have valid enrollments', async () => {
      const sites = [
        { getId: () => 'site-1', getBaseURL: () => 'https://site1.com' },
        { getId: () => 'site-2', getBaseURL: () => 'https://site2.com' },
      ];

      const mockEntitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'LLMO',
      };

      mockTierClient.checkValidEntitlement.resolves({ entitlement: mockEntitlement });
      context.dataAccess.SiteEnrollmentV2.batchGetByKeys.resolves({
        data: [],
        unprocessed: [],
      });

      const result = await filterSitesForProductCode(context, organization, sites, 'LLMO');

      expect(result).to.have.lengthOf(0);
    });

    it('returns empty array when no entitlement exists', async () => {
      const sites = [
        { getId: () => 'site-1', getBaseURL: () => 'https://site1.com' },
      ];

      mockTierClient.checkValidEntitlement.resolves({ entitlement: null });
      context.dataAccess.SiteEnrollmentV2.batchGetByKeys.resolves({
        data: [],
        unprocessed: [],
      });

      const result = await filterSitesForProductCode(context, organization, sites, 'LLMO');

      expect(result).to.have.lengthOf(0);
    });

    it('handles empty sites array', async () => {
      const sites = [];

      const mockEntitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'LLMO',
      };

      mockTierClient.checkValidEntitlement.resolves({ entitlement: mockEntitlement });
      context.dataAccess.SiteEnrollmentV2.batchGetByKeys.resolves({
        data: [],
        unprocessed: [],
      });

      const result = await filterSitesForProductCode(context, organization, sites, 'LLMO');

      expect(result).to.have.lengthOf(0);
    });

    it('builds correct composite keys for batch query', async () => {
      const sites = [
        { getId: () => 'site-1', getBaseURL: () => 'https://site1.com' },
        { getId: () => 'site-2', getBaseURL: () => 'https://site2.com' },
      ];

      const mockEntitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'LLMO',
      };

      mockTierClient.checkValidEntitlement.resolves({ entitlement: mockEntitlement });
      context.dataAccess.SiteEnrollmentV2.batchGetByKeys.resolves({
        data: [],
        unprocessed: [],
      });

      await filterSitesForProductCode(context, organization, sites, 'LLMO');

      const expectedKeys = [
        { entitlementId: 'entitlement-123', siteId: 'site-1' },
        { entitlementId: 'entitlement-123', siteId: 'site-2' },
      ];

      expect(context.dataAccess.SiteEnrollmentV2.batchGetByKeys)
        .to.have.been.calledWith(expectedKeys);
    });

    it('filters sites correctly when some enrollments match', async () => {
      const sites = [
        { getId: () => 'site-1', getBaseURL: () => 'https://site1.com' },
        { getId: () => 'site-2', getBaseURL: () => 'https://site2.com' },
        { getId: () => 'site-3', getBaseURL: () => 'https://site3.com' },
        { getId: () => 'site-4', getBaseURL: () => 'https://site4.com' },
      ];

      const mockEntitlement = {
        getId: () => 'entitlement-456',
        getProductCode: () => 'ASO',
      };

      const mockEnrollments = [
        { getSiteId: () => 'site-2', getEntitlementId: () => 'entitlement-456' },
        { getSiteId: () => 'site-4', getEntitlementId: () => 'entitlement-456' },
      ];

      mockTierClient.checkValidEntitlement.resolves({ entitlement: mockEntitlement });
      context.dataAccess.SiteEnrollmentV2.batchGetByKeys.resolves({
        data: mockEnrollments,
        unprocessed: [],
      });

      const result = await filterSitesForProductCode(context, organization, sites, 'ASO');

      expect(result).to.have.lengthOf(2);
      expect(result[0].getId()).to.equal('site-2');
      expect(result[1].getId()).to.equal('site-4');
    });
  });
});
