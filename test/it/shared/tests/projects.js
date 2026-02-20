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

import { expect } from 'chai';
import { expectISOTimestamp } from '../helpers/assertions.js';
import {
  ORG_1_ID,
  PROJECT_1_ID,
  PROJECT_1_NAME,
  PROJECT_2_ID,
  NON_EXISTENT_PROJECT_ID,
} from '../seed-ids.js';

/**
 * Asserts that an object has the ProjectDto shape.
 */
function expectProjectDto(project) {
  expect(project).to.be.an('object');
  expect(project.id).to.be.a('string');
  expect(project.projectName).to.be.a('string');
  expect(project.organizationId).to.be.a('string');
  expectISOTimestamp(project.createdAt, 'createdAt');
  expectISOTimestamp(project.updatedAt, 'updatedAt');
}

/**
 * Shared Project endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function projectTests(getHttpClient, resetData) {
  describe('Projects', () => {
    // ── Read endpoints ──

    describe('GET /projects (admin-only list)', () => {
      before(() => resetData());

      it('admin: returns all projects', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/projects');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.length.of.at.least(2);
        res.body.forEach((p) => expectProjectDto(p));
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/projects');
        expect(res.status).to.equal(403);
      });
    });

    describe('GET /projects/:projectId', () => {
      before(() => resetData());

      it('user: returns accessible project', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/projects/${PROJECT_1_ID}`);
        expect(res.status).to.equal(200);
        expectProjectDto(res.body);
        expect(res.body.id).to.equal(PROJECT_1_ID);
        expect(res.body.projectName).to.equal(PROJECT_1_NAME);
        expect(res.body.organizationId).to.equal(ORG_1_ID);
      });

      it('user: returns 403 for denied org project', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/projects/${PROJECT_2_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent project', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/projects/${NON_EXISTENT_PROJECT_ID}`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/projects/not-a-uuid');
        expect(res.status).to.equal(400);
      });
    });

    // ── Write endpoints ──

    describe('POST /projects', () => {
      before(() => resetData());

      it('admin: creates project', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/projects', {
          projectName: 'New Test Project',
          organizationId: ORG_1_ID,
        });
        expect(res.status).to.equal(201);
        expectProjectDto(res.body);
        expect(res.body.projectName).to.equal('New Test Project');
        expect(res.body.organizationId).to.equal(ORG_1_ID);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.post('/projects', {
          projectName: 'User Project',
          organizationId: ORG_1_ID,
        });
        expect(res.status).to.equal(403);
      });

      it('admin: returns 400 for empty body', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/projects', {});
        expect(res.status).to.equal(400);
      });
    });

    describe('PATCH /projects/:projectId', () => {
      let testProjectId;

      before(async () => {
        await resetData();
        // Create a test-scoped project to mutate
        const http = getHttpClient();
        const res = await http.admin.post('/projects', {
          projectName: 'Patch Target',
          organizationId: ORG_1_ID,
        });
        expect(res.status).to.equal(201);
        testProjectId = res.body.id;
      });

      it('user: updates project name', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/projects/${testProjectId}`, {
          projectName: 'Updated Project Name',
        });
        expect(res.status).to.equal(200);
        expectProjectDto(res.body);
        expect(res.body.projectName).to.equal('Updated Project Name');
      });

      it('user: returns 403 for denied org project', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/projects/${PROJECT_2_ID}`, {
          projectName: 'Denied Update',
        });
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent project', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/projects/${NON_EXISTENT_PROJECT_ID}`, {
          projectName: 'Missing',
        });
        expect(res.status).to.equal(404);
      });

      it('user: returns 400 for no updates', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/projects/${testProjectId}`, {});
        expect(res.status).to.equal(400);
      });
    });

    describe('DELETE /projects/:projectId', () => {
      let testProjectId;

      before(async () => {
        await resetData();
        // Create a test-scoped project to delete
        const http = getHttpClient();
        const res = await http.admin.post('/projects', {
          projectName: 'Delete Target',
          organizationId: ORG_1_ID,
        });
        expect(res.status).to.equal(201);
        testProjectId = res.body.id;
      });

      it('admin: deletes project', async () => {
        const http = getHttpClient();
        const res = await http.admin.delete(`/projects/${testProjectId}`);
        expect(res.status).to.equal(204);

        // Verify it's gone
        const check = await http.admin.get(`/projects/${testProjectId}`);
        expect(check.status).to.equal(404);
      });

      it('admin: returns 404 for non-existent project', async () => {
        const http = getHttpClient();
        const res = await http.admin.delete(`/projects/${NON_EXISTENT_PROJECT_ID}`);
        expect(res.status).to.equal(404);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`/projects/${PROJECT_1_ID}`);
        expect(res.status).to.equal(403);
      });
    });
  });
}
