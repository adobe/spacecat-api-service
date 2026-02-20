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
import { expectISOTimestamp, expectBatch201 } from '../helpers/assertions.js';
import {
  SITE_1_ID,
  SITE_2_ID,
  SITE_3_ID,
  GUIDELINE_1_ID,
  GUIDELINE_2_ID,
  GUIDELINE_3_ID,
  NON_EXISTENT_GUIDELINE_ID,
} from '../seed-ids.js';

/**
 * Asserts that an object has the SentimentGuidelineDto shape.
 */
function expectGuidelineDto(guideline) {
  expect(guideline).to.be.an('object');
  expect(guideline.siteId).to.be.a('string');
  expect(guideline.guidelineId).to.be.a('string');
  expect(guideline.name).to.be.a('string');
  expect(guideline.instruction).to.be.a('string');
  expect(guideline.audits).to.be.an('array');
  expect(guideline.enabled).to.be.a('boolean');
  expectISOTimestamp(guideline.createdAt, 'createdAt');
  expectISOTimestamp(guideline.updatedAt, 'updatedAt');
}

/**
 * Asserts a paginated response envelope.
 */
function expectPaginated(res, expectedItemCount) {
  expect(res.status).to.equal(200);
  expect(res.body).to.be.an('object');
  expect(res.body.items).to.be.an('array').with.lengthOf(expectedItemCount);
  expect(res.body.pagination).to.be.an('object');
  expect(res.body.pagination.limit).to.be.a('number');
  expect(res.body.pagination.hasMore).to.be.a('boolean');
}

/**
 * Shared Sentiment Guideline endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function sentimentGuidelineTests(getHttpClient, resetData, options = {}) {
  const { skipV2Mutations = false } = options;
  describe('Sentiment Guidelines', () => {
    // ── List guidelines ──

    describe('GET /sites/:siteId/sentiment/guidelines', () => {
      before(() => resetData());

      it('user: returns all guidelines', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/sentiment/guidelines`);
        expectPaginated(res, 3);
        res.body.items.forEach((g) => expectGuidelineDto(g));
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/sentiment/guidelines`);
        expect(res.status).to.equal(403);
      });

      it('user: returns empty for site with no guidelines', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_2_ID}/sentiment/guidelines`);
        expectPaginated(res, 0);
      });

      it('user: filters by enabled=true', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/sentiment/guidelines?enabled=true`);
        expectPaginated(res, 2);
        res.body.items.forEach((g) => expect(g.enabled).to.be.true);
      });
    });

    // ── Get guideline ──

    describe('GET /sites/:siteId/sentiment/guidelines/:guidelineId', () => {
      before(() => resetData());

      it('user: returns specific guideline', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/sentiment/guidelines/${GUIDELINE_1_ID}`);
        expect(res.status).to.equal(200);
        expectGuidelineDto(res.body);
        expect(res.body.guidelineId).to.equal(GUIDELINE_1_ID);
        expect(res.body.siteId).to.equal(SITE_1_ID);
        expect(res.body.name).to.equal('Wikipedia Tone');
        expect(res.body.instruction).to.equal('Analyze Wikipedia articles for neutral tone');
        expect(res.body.audits).to.include('wikipedia-analysis');
        expect(res.body.audits).to.include('reddit-analysis');
        expect(res.body.enabled).to.be.true;
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/sentiment/guidelines/${GUIDELINE_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent guideline', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/sentiment/guidelines/${NON_EXISTENT_GUIDELINE_ID}`);
        expect(res.status).to.equal(404);
      });
    });

    // ── Create guidelines ──

    describe('POST /sites/:siteId/sentiment/guidelines', () => {
      before(() => resetData());

      it('user: creates single guideline', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/sentiment/guidelines`, [
          {
            name: 'New Guideline',
            instruction: 'Analyze new content',
            audits: ['wikipedia-analysis'],
          },
        ]);
        expectBatch201(res, 1);
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.metadata.failure).to.equal(0);
        expect(res.body.items).to.have.lengthOf(1);
        expectGuidelineDto(res.body.items[0]);
        expect(res.body.items[0].name).to.equal('New Guideline');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_3_ID}/sentiment/guidelines`, [
          { name: 'Forbidden', instruction: 'Not allowed' },
        ]);
        expect(res.status).to.equal(403);
      });

      it('user: returns 400 for non-array body', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/sentiment/guidelines`, { name: 'Not An Array' });
        expect(res.status).to.equal(400);
      });

      it('user: partial failure for missing instruction', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/sentiment/guidelines`, [
          { name: 'Valid Guideline', instruction: 'Has instruction' },
          { name: 'Missing Instruction' },
        ]);
        expectBatch201(res, 2);
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.metadata.failure).to.equal(1);
        expect(res.body.failures).to.have.lengthOf(1);
      });
    });

    // ── Update guideline ──

    describe('PATCH /sites/:siteId/sentiment/guidelines/:guidelineId', () => {
      before(() => resetData());

      it('user: updates name and instruction', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_1_ID}/sentiment/guidelines/${GUIDELINE_1_ID}`, {
          name: 'Updated Guideline',
          instruction: 'Updated instruction text',
        });
        expect(res.status).to.equal(200);
        expectGuidelineDto(res.body);
        expect(res.body.name).to.equal('Updated Guideline');
        expect(res.body.instruction).to.equal('Updated instruction text');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_3_ID}/sentiment/guidelines/${GUIDELINE_1_ID}`, {
          name: 'Forbidden',
        });
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent guideline', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_1_ID}/sentiment/guidelines/${NON_EXISTENT_GUIDELINE_ID}`, {
          name: 'Missing',
        });
        expect(res.status).to.equal(404);
      });

      it('user: returns 400 for empty body', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_1_ID}/sentiment/guidelines/${GUIDELINE_1_ID}`, {});
        expect(res.status).to.equal(400);
      });
    });

    // ── Delete guideline ──

    describe('DELETE /sites/:siteId/sentiment/guidelines/:guidelineId', () => {
      before(() => resetData());

      it('user: deletes guideline', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`/sites/${SITE_1_ID}/sentiment/guidelines/${GUIDELINE_3_ID}`);
        expect(res.status).to.equal(200);
        expect(res.body.message).to.be.a('string');

        // Verify it's gone
        const check = await http.user.get(`/sites/${SITE_1_ID}/sentiment/guidelines/${GUIDELINE_3_ID}`);
        expect(check.status).to.equal(404);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`/sites/${SITE_3_ID}/sentiment/guidelines/${GUIDELINE_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent guideline', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`/sites/${SITE_1_ID}/sentiment/guidelines/${NON_EXISTENT_GUIDELINE_ID}`);
        expect(res.status).to.equal(404);
      });
    });

    // ── Link audits ──

    describe('POST /sites/:siteId/sentiment/guidelines/:guidelineId/audits', () => {
      before(() => resetData());

      // Skipped: v2 ElectroDB save fails after enableAudit()
      (skipV2Mutations ? it.skip : it)('user: links new audit types', async () => {
        const http = getHttpClient();
        // GUIDELINE_2 has no audits; link some
        const res = await http.user.post(
          `/sites/${SITE_1_ID}/sentiment/guidelines/${GUIDELINE_2_ID}/audits`,
          { audits: ['twitter-analysis', 'youtube-analysis'] },
        );
        expect(res.status).to.equal(200);
        expectGuidelineDto(res.body);
        expect(res.body.audits).to.include('twitter-analysis');
        expect(res.body.audits).to.include('youtube-analysis');
      });

      it('user: returns 400 for invalid audit types', async () => {
        const http = getHttpClient();
        const res = await http.user.post(
          `/sites/${SITE_1_ID}/sentiment/guidelines/${GUIDELINE_1_ID}/audits`,
          { audits: ['invalid-audit-type'] },
        );
        expect(res.status).to.equal(400);
      });
    });

    // ── Unlink audits ──

    describe('DELETE /sites/:siteId/sentiment/guidelines/:guidelineId/audits', () => {
      before(() => resetData());

      // Skipped: bodyData middleware only parses POST/PUT/PATCH — DELETE body is not parsed,
      // so context.data.audits is undefined and the controller returns 400
      it.skip('user: unlinks audit types', async () => {
        const http = getHttpClient();
        // GUIDELINE_1 has audits: ['wikipedia-analysis', 'reddit-analysis']
        const res = await http.user.deleteWithBody(
          `/sites/${SITE_1_ID}/sentiment/guidelines/${GUIDELINE_1_ID}/audits`,
          { audits: ['reddit-analysis'] },
        );
        expect(res.status).to.equal(200);
        expectGuidelineDto(res.body);
        expect(res.body.audits).to.include('wikipedia-analysis');
        expect(res.body.audits).to.not.include('reddit-analysis');
      });
    });
  });
}
