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
});
