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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon, { stub } from 'sinon';

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

import { Organization, Project, Site } from '@adobe/spacecat-shared-data-access';
import SiteSchema from '@adobe/spacecat-shared-data-access/src/models/site/site.schema.js';
import ProjectSchema from '@adobe/spacecat-shared-data-access/src/models/project/project.schema.js';
import OrganizationSchema from '@adobe/spacecat-shared-data-access/src/models/organization/organization.schema.js';
import AccessControlUtil from '../../src/support/access-control-util.js';
import ProjectsController from '../../src/controllers/project.js';

use(chaiAsPromised);
use(sinonChai);

const sampleConfig = Config({
  slack: { workspace: 'external' },
  handlers: {},
  imports: [],
});
const projectId = '550e8400-e29b-41d4-a716-446655440000';
const orgId = '9033554c-de8a-44ac-a356-09b51af8cc28';

const sites = [
  {
    siteId: 'site1',
    organizationId: orgId,
    projectId,
    baseURL: 'https://site1.com',
    deliveryType: 'aem_edge',
    config: Config(sampleConfig),
  },
  {
    siteId: 'site2',
    organizationId: '5f3b3626-029c-476e-924b-0c1bba2e871f',
    projectId,
    baseURL: 'https://site2.com',
    deliveryType: 'aem_edge',
    config: Config(sampleConfig),
  },
].map((site) => new Site(
  { entities: { site: { model: {} } } },
  {
    log: console,
    getCollection: stub().returns({
      schema: SiteSchema,
      findById: stub(),
    }),
  },
  SiteSchema,
  site,
  console,
));

const organization = new Organization(
  {
    entities: {
      organization: {
        model: {
        },
        patch: sinon.stub().returns({
          composite: () => ({ go: () => {} }),
          set: () => {},
        }),
      },
    },
  },
  {
    log: console,
    getCollection: stub().returns({
      schema: OrganizationSchema,
      findById: stub(),
    }),
  },
  OrganizationSchema,
  { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28', name: 'Org 1' },
  console,
);

const project = new Project(
  {
    entities: {
      project: {
        model: {
          schema: {
            indexes: {},
            attributes: { projectName: { type: 'string', get: (value) => value } },
          },
        },
        patch: sinon.stub().returns({
          composite: () => ({ go: () => {} }),
          set: () => {},
        }),
      },
    },
  },
  {
    log: console,
    getCollection: stub().returns({
      schema: ProjectSchema,
      findById: stub(),
    }),
  },
  ProjectSchema,
  {
    projectId: '550e8400-e29b-41d4-a716-446655440000',
    projectName: 'New Project',
    organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28',
  },
  console,
);

describe('Projects Controller', () => {
  const sandbox = sinon.createSandbox();

  let mockDataAccess;
  let context;
  let projectsController;

  beforeEach(() => {
    mockDataAccess = {
      Project: {
        create: stub().resolves(project),
        all: stub().resolves([project]),
        findById: stub().resolves(project),
        findByProjectName: stub().resolves(project),
      },
      Site: {
        allByProjectId: stub().resolves(sites),
        allByProjectIdAndPrimaryLocale: stub().resolves(sites),
        allByOrganizationIdAndProjectName: stub().resolves(sites),
        allByProjectName: stub().resolves(sites),
      },
      Organization: {
        findById: stub().resolves(organization),
      },
    };

    context = {
      dataAccess: mockDataAccess,
      pathInfo: {
        headers: { 'x-product': 'abcd' },
      },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ email: 'test@example.com', is_admin: true }),
      },
    };

    projectsController = ProjectsController(context, { TEST_ENV: 'true' });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Constructor Validation', () => {
    it('should throw error when context is not provided', () => {
      expect(() => ProjectsController()).to.throw('Context required');
    });

    it('should throw error when context is null', () => {
      expect(() => ProjectsController(null)).to.throw('Context required');
    });

    it('should throw error when context is undefined', () => {
      expect(() => ProjectsController(undefined)).to.throw('Context required');
    });

    it('should throw error when context is not an object', () => {
      expect(() => ProjectsController('invalid')).to.throw('Context required');
    });

    it('should throw error when context is an empty object', () => {
      expect(() => ProjectsController({})).to.throw('Context required');
    });

    it('should throw error when dataAccess is missing from context', () => {
      expect(() => ProjectsController({ other: 'value' })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is null', () => {
      expect(() => ProjectsController({ dataAccess: null })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is undefined', () => {
      expect(() => ProjectsController({ dataAccess: undefined })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is not an object', () => {
      expect(() => ProjectsController({ dataAccess: 'invalid' })).to.throw('Data access required');
    });

    it('should throw error when env is not provided', () => {
      expect(() => ProjectsController(context)).to.throw('Environment object required');
    });

    it('should throw error when env is null', () => {
      expect(() => ProjectsController(context, null)).to.throw('Environment object required');
    });

    it('should throw error when env is not an object', () => {
      expect(() => ProjectsController(context, 'invalid')).to.throw('Environment object required');
    });
  });

  describe('createProject', () => {
    it('should create a project successfully for admin users', async () => {
      const response = await projectsController.createProject({
        data: { projectName: 'New Project', organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' },
        ...context,
      });

      expect(response.status).to.equal(201);
      const responseBody = await response.json();
      expect(responseBody).to.deep.equal({
        id: '550e8400-e29b-41d4-a716-446655440000',
        projectName: 'New Project',
        organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28',
      });
      expect(mockDataAccess.Project.create).to.have.been.calledWith({ name: 'New Project', organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' });
    });

    it('should return forbidden for non-admin users', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });
      const response = await projectsController.createProject({
        data: { projectName: 'New Project', organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' },
        ...context,
      });

      expect(response.status).to.equal(403);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Only admins can create new projects');
    });

    it('should return bad request when creation fails', async () => {
      mockDataAccess.Project.create.rejects(new Error('Validation failed'));
      const response = await projectsController.createProject({
        data: { projectName: 'New Project', organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' },
        ...context,
      });

      expect(response.status).to.equal(400);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Validation failed');
    });
  });

  describe('getAll', () => {
    it('should return all projects for admin users', async () => {
      const response = await projectsController.getAll(context);

      expect(response.status).to.equal(200);
      const responseBody = await response.json();
      expect(responseBody).to.have.length(1);
      expect(responseBody[0]).to.deep.equal({
        id: '550e8400-e29b-41d4-a716-446655440000',
        projectName: 'New Project',
        organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28',
      });
      expect(mockDataAccess.Project.all).to.have.been.called;
    });

    it('should return forbidden for non-admin users', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });
      const response = await projectsController.getAll(context);

      expect(response.status).to.equal(403);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Only admins can view all projects');
    });
  });

  describe('getByID', () => {
    it('should return project by ID when user has access', async () => {
      const response = await projectsController.getByID({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(200);
      const responseBody = await response.json();
      expect(responseBody).to.deep.equal({
        id: '550e8400-e29b-41d4-a716-446655440000',
        projectName: 'New Project',
        organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28',
      });
      expect(mockDataAccess.Project.findById).to.have.been.calledWith('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should return bad request for invalid project ID', async () => {
      const response = await projectsController.getByID({
        params: { projectId: 'invalid-id' },
        ...context,
      });

      expect(response.status).to.equal(400);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Project ID required');
    });

    it('should return not found when project does not exist', async () => {
      mockDataAccess.Project.findById.resolves(null);
      const response = await projectsController.getByID({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(404);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Project not found');
    });

    it('should return forbidden when user lacks access to view project', async () => {
      // Mock access control to return false for hasAccess
      const mockAccessControlUtil = {
        hasAdminAccess: stub().returns(true),
        hasAccess: stub().resolves(false), // This will cause the forbidden response
      };
      sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtil);

      const testController = ProjectsController(context, { TEST_ENV: 'true' });

      const response = await testController.getByID({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(403);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can view its projects');
    });
  });

  describe('removeProject', () => {
    it('should remove project successfully for admin users', async () => {
      const response = await projectsController.removeProject({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(204);
      expect(mockDataAccess.Project.findById).to.have.been.calledWith('550e8400-e29b-41d4-a716-446655440000');
      expect(project.remove).to.have.been.called;
    });

    it('should return forbidden for non-admin users', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });
      const response = await projectsController.removeProject({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(403);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Only admins can delete projects');
    });

    it('should return bad request for invalid project ID', async () => {
      const response = await projectsController.removeProject({
        params: { projectId: 'invalid-id' },
        ...context,
      });

      expect(response.status).to.equal(400);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Project ID required');
    });

    it('should return not found when project does not exist', async () => {
      mockDataAccess.Project.findById.resolves(null);
      const response = await projectsController.removeProject({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(404);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Project not found');
    });
  });

  describe('updateProject', () => {
    it('should update project name successfully', async () => {
      const response = await projectsController.updateProject({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        data: { projectName: 'Updated Project Name' },
        ...context,
      });

      expect(response.status).to.equal(200);
      expect(project.setName).to.have.been.calledWith('Updated Project Name');
      expect(project.save).to.have.been.called;
    });

    it('should return bad request when no updates provided', async () => {
      const response = await projectsController.updateProject({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        data: { projectName: 'New Project', organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, // Same values
        ...context,
      });

      expect(response.status).to.equal(400);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('No updates provided');
    });

    it('should return bad request for invalid project ID', async () => {
      const response = await projectsController.updateProject({
        params: { projectId: 'invalid-id' },
        data: { name: 'Updated Project Name' },
        ...context,
      });

      expect(response.status).to.equal(400);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Project ID required');
    });

    it('should return not found when project does not exist', async () => {
      mockDataAccess.Project.findById.resolves(null);
      const response = await projectsController.updateProject({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440001' },
        data: { projectNAme: 'Updated Project Name' },
        ...context,
      });

      expect(response.status).to.equal(404);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Project not found');
    });

    it('should return bad request for missing request body', async () => {
      const response = await projectsController.updateProject({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        data: null,
        ...context,
      });

      expect(response.status).to.equal(400);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Request body required');
    });

    it('should update project organization ID successfully', async () => {
      const response = await projectsController.updateProject({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        data: { organizationId: '550e8400-e29b-41d4-a716-446655440003' },
        ...context,
      });

      expect(response.status).to.equal(200);
      expect(project.setOrganizationId).to.have.been.calledWith('550e8400-e29b-41d4-a716-446655440003');
      expect(project.save).to.have.been.called;
    });

    it('should return forbidden when user lacks access during update', async () => {
      // Mock access control to return false for hasAccess but true for admin
      context.attributes.authInfo.withProfile({ is_admin: true });
      const mockAccessControlUtil = {
        hasAdminAccess: stub().returns(true),
        hasAccess: stub().resolves(false), // This will cause the forbidden response
      };
      sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtil);

      const testController = ProjectsController(context, { TEST_ENV: 'true' });

      const response = await testController.updateProject({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        data: { name: 'Updated Name' },
        ...context,
      });

      expect(response.status).to.equal(403);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can update its projects');
    });
  });

  describe('getPrimaryLocaleSites', () => {
    it('should return primary locale sites for a project when user has access', async () => {
      const response = await projectsController.getPrimaryLocaleSites({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(200);
      const responseBody = await response.json();
      expect(responseBody).to.have.length(2);
      expect(responseBody[0].id).to.equal('site1');
      expect(mockDataAccess.Site.allByProjectIdAndPrimaryLocale).to.have.been.calledWith('550e8400-e29b-41d4-a716-446655440000', true);
    });

    it('should return bad request for invalid project ID', async () => {
      const response = await projectsController.getPrimaryLocaleSites({
        params: { projectId: 'invalid-id' },
        ...context,
      });

      expect(response.status).to.equal(400);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Project ID required');
    });

    it('should return not found when project does not exist', async () => {
      mockDataAccess.Project.findById.resolves(null);
      const response = await projectsController.getPrimaryLocaleSites({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(404);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Project not found');
    });

    it('should return forbidden when user lacks access to view primary locale sites', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      const testController = ProjectsController(context, { TEST_ENV: 'true' });

      const response = await testController.getPrimaryLocaleSites({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(403);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can view its project sites');
    });
  });

  describe('getSitesByProjectId', () => {
    it('should return sites for a project when user has access', async () => {
      const response = await projectsController.getSitesByProjectId({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(200);
      const responseBody = await response.json();
      expect(responseBody).to.have.length(2);
      expect(responseBody[0].id).to.equal('site1');
      expect(mockDataAccess.Site.allByProjectId).to.have.been.calledWith('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should return bad request for invalid project ID', async () => {
      const response = await projectsController.getSitesByProjectId({
        params: { projectId: 'invalid-id' },
        ...context,
      });

      expect(response.status).to.equal(400);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Project ID required');
    });

    it('should return not found when project does not exist', async () => {
      mockDataAccess.Project.findById.resolves(null);
      const response = await projectsController.getSitesByProjectId({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(404);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Project not found');
    });

    it('should return forbidden when user lacks access to project sites', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);

      const testController = ProjectsController(context, { TEST_ENV: 'true' });

      const response = await testController.getSitesByProjectId({
        params: { projectId: '550e8400-e29b-41d4-a716-446655440000' },
        ...context,
      });

      expect(response.status).to.equal(403);
      const responseBody = await response.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can view its project sites');
    });
  });

  describe('contains all controller functions', () => {
    const expectedFunctions = [
      'createProject',
      'getAll',
      'getByID',
      'getPrimaryLocaleSites',
      'getSitesByProjectId',
      'getSitesByProjectName',
      'removeProject',
      'updateProject',
    ];

    expectedFunctions.forEach((functionName) => {
      it(`should have ${functionName} function`, () => {
        expect(projectsController).to.have.property(functionName);
        expect(projectsController[functionName]).to.be.a('function');
      });
    });
  });

  describe('getSitesByProjectName', () => {
    it('gets all sites for a project by project name', async () => {
      mockDataAccess.Project.findByProjectName.resolves(project);
      mockDataAccess.Site.allByProjectName.resolves(sites);

      const result = await projectsController.getSitesByProjectName({
        params: { projectName: 'test-project' },
        ...context,
      });
      const response = await result.json();

      expect(result.status).to.equal(200);
      expect(response).to.have.length(2);
      expect(response[0]).to.have.property('id', 'site1');
    });

    it('returns bad request when project name is missing', async () => {
      const result = await projectsController.getSitesByProjectName({
        params: { projectName: '' },
        ...context,
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Project name required');
    });

    it('returns not found when project is not found', async () => {
      mockDataAccess.Project.findByProjectName.resolves(null);

      const result = await projectsController.getSitesByProjectName({
        params: { projectName: 'nonexistent-project' },
        ...context,
      });
      const error = await result.json();

      expect(result.status).to.equal(404);
      expect(error).to.have.property('message', 'Project not found');
    });

    it('returns forbidden when user has no access to project', async () => {
      const mockProject = {
        getId: () => 'project-123',
        toJSON: () => ({ id: 'project-123', name: 'Test Project' }),
      };
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);

      mockDataAccess.Project.findByProjectName.resolves(mockProject);

      const result = await projectsController.getSitesByProjectName({
        params: { projectName: 'test-project' },
        ...context,
      });
      const error = await result.json();

      expect(result.status).to.equal(403);
      expect(error).to.have.property('message', 'Only users belonging to the organization can view its project sites');
    });
  });
});
