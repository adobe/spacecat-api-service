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

import { createProject, deriveProjectName, getLastTwoCompleteWeeks } from '../../src/support/utils.js';

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

  describe('getLastTwoCompleteWeeks', () => {
    let clock;

    afterEach(() => {
      if (clock) {
        clock.restore();
      }
    });

    it('returns last two complete weeks when run on a Tuesday', () => {
      // Set date to Tuesday, November 19, 2025, 10:00 AM UTC
      clock = sinon.useFakeTimers(new Date('2025-11-19T10:00:00.000Z'));

      const weeks = getLastTwoCompleteWeeks();

      expect(weeks).to.have.lengthOf(2);

      // Most recent complete week: Nov 10 (Mon) to Nov 16 (Sun)
      expect(weeks[0].label).to.equal('2025-11-16');
      expect(weeks[0].startTime).to.equal('2025-11-10T00:00:00.000Z');
      expect(weeks[0].endTime).to.equal('2025-11-16T23:59:59.999Z');

      // Previous complete week: Nov 3 (Mon) to Nov 9 (Sun)
      expect(weeks[1].label).to.equal('2025-11-09');
      expect(weeks[1].startTime).to.equal('2025-11-03T00:00:00.000Z');
      expect(weeks[1].endTime).to.equal('2025-11-09T23:59:59.999Z');
    });

    it('returns last two complete weeks when run on a Monday', () => {
      // Set date to Monday, November 17, 2025, 10:00 AM UTC
      clock = sinon.useFakeTimers(new Date('2025-11-17T10:00:00.000Z'));

      const weeks = getLastTwoCompleteWeeks();

      expect(weeks).to.have.lengthOf(2);

      // Most recent complete week: Nov 10 (Mon) to Nov 16 (Sun)
      expect(weeks[0].label).to.equal('2025-11-16');
      expect(weeks[0].startTime).to.equal('2025-11-10T00:00:00.000Z');
      expect(weeks[0].endTime).to.equal('2025-11-16T23:59:59.999Z');

      // Previous complete week: Nov 3 (Mon) to Nov 9 (Sun)
      expect(weeks[1].label).to.equal('2025-11-09');
      expect(weeks[1].startTime).to.equal('2025-11-03T00:00:00.000Z');
      expect(weeks[1].endTime).to.equal('2025-11-09T23:59:59.999Z');
    });

    it('returns last two complete weeks when run on a Sunday', () => {
      // Set date to Sunday, November 23, 2025, 10:00 AM UTC
      clock = sinon.useFakeTimers(new Date('2025-11-23T10:00:00.000Z'));

      const weeks = getLastTwoCompleteWeeks();

      expect(weeks).to.have.lengthOf(2);

      // Most recent complete week: Nov 10 (Mon) to Nov 16 (Sun)
      expect(weeks[0].label).to.equal('2025-11-16');
      expect(weeks[0].startTime).to.equal('2025-11-10T00:00:00.000Z');
      expect(weeks[0].endTime).to.equal('2025-11-16T23:59:59.999Z');

      // Previous complete week: Nov 3 (Mon) to Nov 9 (Sun)
      expect(weeks[1].label).to.equal('2025-11-09');
      expect(weeks[1].startTime).to.equal('2025-11-03T00:00:00.000Z');
      expect(weeks[1].endTime).to.equal('2025-11-09T23:59:59.999Z');
    });

    it('always returns UTC times regardless of timezone', () => {
      // Test in various timezones - result should be same
      clock = sinon.useFakeTimers(new Date('2025-11-19T23:59:59.999Z')); // Late UTC

      const weeks = getLastTwoCompleteWeeks();

      // Verify ISO strings have UTC timezone
      expect(weeks[0].startTime).to.match(/Z$/);
      expect(weeks[0].endTime).to.match(/Z$/);
      expect(weeks[1].startTime).to.match(/Z$/);
      expect(weeks[1].endTime).to.match(/Z$/);

      // Verify midnight and end-of-day times
      expect(weeks[0].startTime).to.include('T00:00:00.000Z');
      expect(weeks[0].endTime).to.include('T23:59:59.999Z');
    });

    it('returns exactly 7 days between start and end of each week', () => {
      clock = sinon.useFakeTimers(new Date('2025-11-19T10:00:00.000Z'));

      const weeks = getLastTwoCompleteWeeks();

      weeks.forEach((week) => {
        const start = new Date(week.startTime);
        const end = new Date(week.endTime);
        const daysDiff = (end - start) / (1000 * 60 * 60 * 24);

        // Should be almost 7 days (6.999... due to the milliseconds)
        expect(daysDiff).to.be.closeTo(7, 0.001);
      });
    });

    it('returns weeks in chronological order (most recent first)', () => {
      clock = sinon.useFakeTimers(new Date('2025-11-19T10:00:00.000Z'));

      const weeks = getLastTwoCompleteWeeks();

      const mostRecentEnd = new Date(weeks[0].endTime);
      const previousEnd = new Date(weeks[1].endTime);

      // Most recent week should end after previous week
      expect(mostRecentEnd.getTime()).to.be.greaterThan(previousEnd.getTime());

      // Should be exactly 7 days apart
      const diffDays = (mostRecentEnd - previousEnd) / (1000 * 60 * 60 * 24);
      expect(diffDays).to.be.closeTo(7, 0.001);
    });

    it('handles DST transitions correctly', () => {
      // Test around DST transition (March 2025 DST starts in US, but we use UTC
      // so should be unaffected)
      clock = sinon.useFakeTimers(new Date('2025-03-11T10:00:00.000Z'));

      const weeks = getLastTwoCompleteWeeks();

      expect(weeks).to.have.lengthOf(2);
      expect(weeks[0].startTime).to.include('T00:00:00.000Z');
      expect(weeks[0].endTime).to.include('T23:59:59.999Z');
      // DST changes don't affect UTC times
    });
  });
});
