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
import { expectISOTimestamp, expectBatch207 } from '../helpers/assertions.js';
import {
  SITE_1_ID,
  SITE_3_ID,
  OPPTY_1_ID,
  OPPTY_2_ID,
  OPPTY_3_ID,
  FIX_1_ID,
  FIX_1_CREATED_DATE,
  SUGG_1_ID,
  NON_EXISTENT_FIX_ID,
} from '../seed-ids.js';

const BASE = `/sites/${SITE_1_ID}/opportunities/${OPPTY_1_ID}/fixes`;
const DENIED_BASE = `/sites/${SITE_3_ID}/opportunities/${OPPTY_3_ID}/fixes`;
const STATUS_BASE = `/sites/${SITE_1_ID}/opportunities/${OPPTY_1_ID}/status`;

/**
 * Asserts that an object has the FixDto shape.
 */
function expectFixDto(fix) {
  expect(fix).to.be.an('object');
  expect(fix.id).to.be.a('string');
  expect(fix.opportunityId).to.be.a('string');
  expect(fix.type).to.be.a('string');
  expect(fix.status).to.be.a('string');
  expect(fix).to.have.property('changeDetails');
  expectISOTimestamp(fix.createdAt, 'createdAt');
  expectISOTimestamp(fix.updatedAt, 'updatedAt');
}

/**
 * Shared FixEntity endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function fixTests(getHttpClient, resetData) {
  describe('FixEntities', () => {
    // ── Read endpoints ──

    describe('GET .../fixes', () => {
      before(() => resetData());

      it('user: returns fixes for opportunity', async () => {
        const http = getHttpClient();
        const res = await http.user.get(BASE);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        res.body.forEach((f) => expectFixDto(f));
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(DENIED_BASE);
        expect(res.status).to.equal(403);
      });

      it('user: returns empty for opportunity with no fixes', async () => {
        const http = getHttpClient();
        const res = await http.user.get(
          `/sites/${SITE_1_ID}/opportunities/${OPPTY_2_ID}/fixes`,
        );
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });
    });

    describe('GET .../fixes?fixCreatedDate (date-filtered with suggestions)', () => {
      before(() => resetData());

      it('user: returns fixes with attached suggestions for matching date', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}?fixCreatedDate=${FIX_1_CREATED_DATE}`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);

        const fix = res.body[0];
        expectFixDto(fix);
        expect(fix.id).to.equal(FIX_1_ID);
        // Date-filtered path attaches suggestions via _suggestions → DTO includes them
        expect(fix.suggestions).to.be.an('array').with.lengthOf(1);
        expect(fix.suggestions[0].id).to.equal(SUGG_1_ID);
      });

      it('user: returns empty for date with no junction records', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}?fixCreatedDate=2099-12-31`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 403 for denied site with fixCreatedDate', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${DENIED_BASE}?fixCreatedDate=${FIX_1_CREATED_DATE}`);
        expect(res.status).to.equal(403);
      });
    });

    describe('GET .../fixes/by-status/:status', () => {
      before(() => resetData());

      it('user: returns fixes filtered by status', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/by-status/PENDING`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);
        expectFixDto(res.body[0]);
        expect(res.body[0].status).to.equal('PENDING');
      });

      it('user: returns empty for status with no matches', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/by-status/FAILED`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${DENIED_BASE}/by-status/PENDING`);
        expect(res.status).to.equal(403);
      });
    });

    describe('GET .../fixes/:fixId', () => {
      before(() => resetData());

      it('user: returns specific fix', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/${FIX_1_ID}`);
        expect(res.status).to.equal(200);
        expectFixDto(res.body);
        expect(res.body.id).to.equal(FIX_1_ID);
        expect(res.body.opportunityId).to.equal(OPPTY_1_ID);
        expect(res.body.type).to.equal('CODE_CHANGE');
        expect(res.body.status).to.equal('PENDING');

        // Enriched fields — exercises executedBy↔executed_by, publishedAt↔published_at
        expect(res.body.executedBy).to.equal('test-bot@example.com');
        expect(res.body.publishedAt).to.equal('2025-01-21T08:00:00.000Z');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${DENIED_BASE}/${FIX_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent fix', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/${NON_EXISTENT_FIX_ID}`);
        expect(res.status).to.equal(404);
      });
    });

    describe('GET .../fixes/:fixId/suggestions', () => {
      before(() => resetData());

      it('user: returns suggestions linked via junction', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/${FIX_1_ID}/suggestions`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);
        expect(res.body[0].id).to.equal(SUGG_1_ID);
      });

      it('user: returns 404 for non-existent fix', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/${NON_EXISTENT_FIX_ID}/suggestions`);
        expect(res.status).to.equal(404);
      });
    });

    // ── Write endpoints ──

    describe('POST .../fixes (batch 207)', () => {
      before(() => resetData());

      it('user: creates single fix', async () => {
        const http = getHttpClient();
        const res = await http.user.post(BASE, [
          {
            type: 'CODE_CHANGE',
            changeDetails: { file: '/test.js', diff: '+test' },
          },
        ]);
        expectBatch207(res, 1, 'fixes');
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.fixes[0].statusCode).to.equal(201);
        expect(res.body.fixes[0].fix).to.be.an('object');
        expect(res.body.fixes[0].fix.type).to.equal('CODE_CHANGE');
      });

      it('user: creates fix with suggestion association', async () => {
        const http = getHttpClient();
        const res = await http.user.post(BASE, [
          {
            type: 'CODE_CHANGE',
            changeDetails: { file: '/assoc-test.js', diff: '+linked' },
            suggestionIds: [SUGG_1_ID],
          },
        ]);
        expectBatch207(res, 1, 'fixes');
        expect(res.body.metadata.success).to.equal(1);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.post(DENIED_BASE, [
          { type: 'CODE_CHANGE', changeDetails: { file: '/denied.js' } },
        ]);
        expect(res.status).to.equal(403);
      });

      it('user: returns 400 for non-array body', async () => {
        const http = getHttpClient();
        const res = await http.user.post(BASE, { type: 'CODE_CHANGE' });
        expect(res.status).to.equal(400);
      });
    });

    describe('PATCH .../fixes/:fixId', () => {
      let testFixId;

      before(async () => {
        await resetData();
        // Create a test-scoped fix to mutate
        const http = getHttpClient();
        const res = await http.user.post(BASE, [
          { type: 'CODE_CHANGE', changeDetails: { file: '/patch-test.js' } },
        ]);
        expect(res.status).to.equal(207);
        testFixId = res.body.fixes[0].fix.id;
      });

      it('user: updates fix changeDetails', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`${BASE}/${testFixId}`, {
          changeDetails: { file: '/updated.js', diff: '+updated' },
        });
        expect(res.status).to.equal(200);
        expectFixDto(res.body);
        expect(res.body.changeDetails.file).to.equal('/updated.js');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`${DENIED_BASE}/${testFixId}`, {
          changeDetails: { file: '/denied.js' },
        });
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent fix', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`${BASE}/${NON_EXISTENT_FIX_ID}`, {
          changeDetails: { file: '/missing.js' },
        });
        expect(res.status).to.equal(404);
      });

      it('user: returns 400 for no updates', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`${BASE}/${testFixId}`);
        expect(res.status).to.equal(400);
      });
    });

    describe('PATCH .../opportunities/:opportunityId/status (batch fix status)', () => {
      let testFixId;

      before(async () => {
        await resetData();
        // Create a test-scoped fix for status update
        const http = getHttpClient();
        const res = await http.user.post(BASE, [
          { type: 'CODE_CHANGE', changeDetails: { file: '/status-test.js' } },
        ]);
        expect(res.status).to.equal(207);
        testFixId = res.body.fixes[0].fix.id;
      });

      it('user: updates single fix status', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(STATUS_BASE, [
          { id: testFixId, status: 'DEPLOYED' },
        ]);
        expectBatch207(res, 1, 'fixes');
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.fixes[0].statusCode).to.equal(200);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const deniedStatus = `/sites/${SITE_3_ID}/opportunities/${OPPTY_3_ID}/status`;
        const res = await http.user.patch(deniedStatus, [
          { id: testFixId, status: 'DEPLOYED' },
        ]);
        expect(res.status).to.equal(403);
      });

      it('user: returns 400 for non-array body', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(STATUS_BASE, { id: testFixId, status: 'DEPLOYED' });
        expect(res.status).to.equal(400);
      });
    });

    describe('DELETE .../fixes/:fixId', () => {
      let testFixId;

      before(async () => {
        await resetData();
        // Create a test-scoped fix to delete
        const http = getHttpClient();
        const res = await http.user.post(BASE, [
          { type: 'CODE_CHANGE', changeDetails: { file: '/delete-test.js' } },
        ]);
        expect(res.status).to.equal(207);
        testFixId = res.body.fixes[0].fix.id;
      });

      it('user: deletes fix', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`${BASE}/${testFixId}`);
        expect(res.status).to.equal(204);

        // Verify it's gone
        const check = await http.user.get(`${BASE}/${testFixId}`);
        expect(check.status).to.equal(404);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`${DENIED_BASE}/${NON_EXISTENT_FIX_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent fix', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`${BASE}/${NON_EXISTENT_FIX_ID}`);
        expect(res.status).to.equal(404);
      });
    });
  });
}
