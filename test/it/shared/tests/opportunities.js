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
import { expectISOTimestamp, sortById } from '../helpers/assertions.js';
import {
  SITE_1_ID,
  SITE_3_ID,
  NON_EXISTENT_SITE_ID,
  OPPTY_1_ID,
  OPPTY_2_ID,
  NON_EXISTENT_OPPTY_ID,
} from '../seed-ids.js';

/**
 * Asserts that an object has the OpportunityDto shape.
 */
function expectOpportunityDto(oppty) {
  expect(oppty).to.be.an('object');
  expect(oppty.id).to.be.a('string');
  expect(oppty.siteId).to.be.a('string');
  expect(oppty.type).to.be.a('string');
  expect(oppty.status).to.be.a('string');
  expect(oppty.title).to.be.a('string');
  // data, guidance, tags are optional — may be absent when null/undefined
  expectISOTimestamp(oppty.createdAt, 'createdAt');
  expectISOTimestamp(oppty.updatedAt, 'updatedAt');
}

/**
 * Shared Opportunity endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function opportunityTests(getHttpClient, resetData) {
  describe('Opportunities', () => {
    // ── Read endpoints ──

    describe('GET /sites/:siteId/opportunities', () => {
      before(() => resetData());

      it('user: returns opportunities for accessible site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/opportunities`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        res.body.forEach((oppty) => expectOpportunityDto(oppty));

        const ids = sortById(res.body).map((o) => o.id);
        expect(ids).to.include(OPPTY_1_ID);
        expect(ids).to.include(OPPTY_2_ID);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/opportunities`);
        expect(res.status).to.equal(403);
      });

      it('admin: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${NON_EXISTENT_SITE_ID}/opportunities`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites/not-a-uuid/opportunities');
        expect(res.status).to.equal(400);
      });
    });

    describe('GET /sites/:siteId/opportunities/by-status/:status', () => {
      before(() => resetData());

      it('user: returns opportunities filtered by status', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/opportunities/by-status/NEW`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);
        expectOpportunityDto(res.body[0]);
        expect(res.body[0].id).to.equal(OPPTY_1_ID);
        expect(res.body[0].status).to.equal('NEW');
      });

      it('user: returns empty array for status with no matches', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/opportunities/by-status/IGNORED`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/opportunities/by-status/NEW`);
        expect(res.status).to.equal(403);
      });
    });

    describe('GET /sites/:siteId/opportunities/:opportunityId', () => {
      before(() => resetData());

      it('user: returns specific opportunity', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/opportunities/${OPPTY_1_ID}`);
        expect(res.status).to.equal(200);
        expectOpportunityDto(res.body);
        expect(res.body.id).to.equal(OPPTY_1_ID);
        expect(res.body.siteId).to.equal(SITE_1_ID);
        expect(res.body.type).to.equal('code-suggestions');
        expect(res.body.status).to.equal('NEW');
        expect(res.body.title).to.equal('Fix CWV issues');

        // Enriched fields
        expect(res.body.runbook).to.equal('https://wiki.example.com/runbooks/cwv-optimization');
        expect(res.body.guidance).to.deep.equal({
          steps: ['Review affected pages', 'Optimize LCP resources', 'Re-audit'],
        });
        expect(res.body.tags).to.be.an('array').that.includes('performance');
        expect(res.body.tags).to.include('cwv');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/opportunities/${OPPTY_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent opportunity', async () => {
        const http = getHttpClient();
        const res = await http.user.get(
          `/sites/${SITE_1_ID}/opportunities/${NON_EXISTENT_OPPTY_ID}`,
        );
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_1_ID}/opportunities/not-a-uuid`);
        expect(res.status).to.equal(400);
      });
    });

    // ── Write endpoints ──

    describe('POST /sites/:siteId/opportunities', () => {
      before(() => resetData());

      it('user: creates opportunity', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities`, {
          type: 'content-update',
          origin: 'AI',
          title: 'Test created opportunity',
          description: 'Created by IT test',
          data: { testKey: 'testValue' },
        });
        expect(res.status).to.equal(201);
        expectOpportunityDto(res.body);
        expect(res.body.siteId).to.equal(SITE_1_ID);
        expect(res.body.type).to.equal('content-update');
        expect(res.body.title).to.equal('Test created opportunity');
        expect(res.body.status).to.equal('NEW');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_3_ID}/opportunities`, {
          type: 'code-suggestions',
          origin: 'AI',
          title: 'Should not be created',
        });
        expect(res.status).to.equal(403);
      });

      it('user: returns 400 for empty body', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities`);
        expect(res.status).to.equal(400);
      });
    });

    describe('PATCH /sites/:siteId/opportunities/:opportunityId', () => {
      let testOpptyId;

      before(async () => {
        await resetData();
        // Create a test-scoped opportunity to mutate
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities`, {
          type: 'content-update',
          origin: 'AI',
          title: 'Patch test opportunity',
          description: 'Will be patched',
        });
        expect(res.status).to.equal(201);
        testOpptyId = res.body.id;
      });

      it('user: updates opportunity title', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(
          `/sites/${SITE_1_ID}/opportunities/${testOpptyId}`,
          { title: 'Updated title' },
        );
        expect(res.status).to.equal(200);
        expectOpportunityDto(res.body);
        expect(res.body.title).to.equal('Updated title');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(
          `/sites/${SITE_3_ID}/opportunities/${testOpptyId}`,
          { title: 'Should fail' },
        );
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent opportunity', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(
          `/sites/${SITE_1_ID}/opportunities/${NON_EXISTENT_OPPTY_ID}`,
          { title: 'Should fail' },
        );
        expect(res.status).to.equal(404);
      });

      it('user: returns 400 for no updates', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(
          `/sites/${SITE_1_ID}/opportunities/${testOpptyId}`,
        );
        expect(res.status).to.equal(400);
      });
    });

    describe('DELETE /sites/:siteId/opportunities/:opportunityId', () => {
      let testOpptyId;

      before(async () => {
        await resetData();
        // Create a test-scoped opportunity to delete
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities`, {
          type: 'content-update',
          origin: 'AI',
          title: 'Delete test opportunity',
        });
        expect(res.status).to.equal(201);
        testOpptyId = res.body.id;
      });

      it('user: deletes opportunity', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(
          `/sites/${SITE_1_ID}/opportunities/${testOpptyId}`,
        );
        expect(res.status).to.equal(204);

        // Verify it's gone
        const check = await http.user.get(
          `/sites/${SITE_1_ID}/opportunities/${testOpptyId}`,
        );
        expect(check.status).to.equal(404);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(
          `/sites/${SITE_3_ID}/opportunities/${NON_EXISTENT_OPPTY_ID}`,
        );
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent opportunity', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(
          `/sites/${SITE_1_ID}/opportunities/${NON_EXISTENT_OPPTY_ID}`,
        );
        expect(res.status).to.equal(404);
      });
    });
  });
}
