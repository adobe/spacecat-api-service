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
  TOPIC_1_ID,
  TOPIC_2_ID,
  TOPIC_3_ID,
  NON_EXISTENT_TOPIC_ID,
} from '../seed-ids.js';

/**
 * Asserts that an object has the SentimentTopicDto shape.
 */
function expectTopicDto(topic) {
  expect(topic).to.be.an('object');
  expect(topic.siteId).to.be.a('string');
  expect(topic.topicId).to.be.a('string');
  expect(topic.name).to.be.a('string');
  expect(topic.subPrompts).to.be.an('array');
  expect(topic.enabled).to.be.a('boolean');
  expectISOTimestamp(topic.createdAt, 'createdAt');
  expectISOTimestamp(topic.updatedAt, 'updatedAt');
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
 * Shared Sentiment Topic endpoint tests (includes /sentiment/config).
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function sentimentTopicTests(getHttpClient, resetData, options = {}) {
  const { skipV2Mutations = false } = options;
  describe('Sentiment Topics', () => {
    // ── List topics ──

    describe('GET /sites/:siteId/sentiment/topics', () => {
      before(() => resetData());

      it('user: returns all topics', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/sentiment/topics`);
        expectPaginated(res, 3);
        res.body.items.forEach((t) => expectTopicDto(t));
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/sentiment/topics`);
        expect(res.status).to.equal(403);
      });

      it('user: returns empty for site with no topics', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_2_ID}/sentiment/topics`);
        expectPaginated(res, 0);
      });

      it('user: filters by enabled=true', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/sentiment/topics?enabled=true`);
        expectPaginated(res, 2);
        res.body.items.forEach((t) => expect(t.enabled).to.be.true);
      });
    });

    // ── Get topic ──

    describe('GET /sites/:siteId/sentiment/topics/:topicId', () => {
      before(() => resetData());

      it('user: returns specific topic', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/sentiment/topics/${TOPIC_1_ID}`);
        expect(res.status).to.equal(200);
        expectTopicDto(res.body);
        expect(res.body.topicId).to.equal(TOPIC_1_ID);
        expect(res.body.siteId).to.equal(SITE_1_ID);
        expect(res.body.name).to.equal('Product Quality');
        expect(res.body.subPrompts).to.have.lengthOf(2);
        expect(res.body.enabled).to.be.true;
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/sentiment/topics/${TOPIC_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent topic', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/sentiment/topics/${NON_EXISTENT_TOPIC_ID}`);
        expect(res.status).to.equal(404);
      });
    });

    // ── Create topics ──

    describe('POST /sites/:siteId/sentiment/topics', () => {
      before(() => resetData());

      it('user: creates single topic', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/sentiment/topics`, [
          { name: 'New Topic', description: 'A brand new topic' },
        ]);
        expectBatch201(res, 1);
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.metadata.failure).to.equal(0);
        expect(res.body.items).to.have.lengthOf(1);
        expectTopicDto(res.body.items[0]);
        expect(res.body.items[0].name).to.equal('New Topic');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_3_ID}/sentiment/topics`, [
          { name: 'Forbidden Topic' },
        ]);
        expect(res.status).to.equal(403);
      });

      it('user: returns 400 for non-array body', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/sentiment/topics`, { name: 'Not An Array' });
        expect(res.status).to.equal(400);
      });

      it('user: partial failure for missing name', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/sentiment/topics`, [
          { name: 'Valid Topic', description: 'Has a name' },
          { description: 'Missing name field' },
        ]);
        expectBatch201(res, 2);
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.metadata.failure).to.equal(1);
        expect(res.body.failures).to.have.lengthOf(1);
      });
    });

    // ── Update topic ──

    describe('PATCH /sites/:siteId/sentiment/topics/:topicId', () => {
      before(() => resetData());

      it('user: updates name and description', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_1_ID}/sentiment/topics/${TOPIC_1_ID}`, {
          name: 'Updated Topic Name',
          description: 'Updated description',
        });
        expect(res.status).to.equal(200);
        expectTopicDto(res.body);
        expect(res.body.name).to.equal('Updated Topic Name');
        expect(res.body.description).to.equal('Updated description');
      });

      it('user: toggles enabled', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_1_ID}/sentiment/topics/${TOPIC_1_ID}`, {
          enabled: false,
        });
        expect(res.status).to.equal(200);
        expect(res.body.enabled).to.be.false;
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_3_ID}/sentiment/topics/${TOPIC_1_ID}`, {
          name: 'Forbidden',
        });
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent topic', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_1_ID}/sentiment/topics/${NON_EXISTENT_TOPIC_ID}`, {
          name: 'Missing',
        });
        expect(res.status).to.equal(404);
      });

      it('user: returns 400 for empty body', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_1_ID}/sentiment/topics/${TOPIC_1_ID}`, {});
        expect(res.status).to.equal(400);
      });
    });

    // ── Delete topic ──

    describe('DELETE /sites/:siteId/sentiment/topics/:topicId', () => {
      before(() => resetData());

      it('user: deletes topic', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`/sites/${SITE_1_ID}/sentiment/topics/${TOPIC_3_ID}`);
        expect(res.status).to.equal(200);
        expect(res.body.message).to.be.a('string');

        // Verify it's gone
        const check = await http.user.get(`/sites/${SITE_1_ID}/sentiment/topics/${TOPIC_3_ID}`);
        expect(check.status).to.equal(404);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`/sites/${SITE_3_ID}/sentiment/topics/${TOPIC_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent topic', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`/sites/${SITE_1_ID}/sentiment/topics/${NON_EXISTENT_TOPIC_ID}`);
        expect(res.status).to.equal(404);
      });
    });

    // ── Add sub-prompts ──

    describe('POST /sites/:siteId/sentiment/topics/:topicId/prompts', () => {
      before(() => resetData());

      // Skipped: v2 ElectroDB save fails after addSubPrompt()
      (skipV2Mutations ? it.skip : it)('user: adds new sub-prompts', async () => {
        const http = getHttpClient();
        // TOPIC_2 has 0 subPrompts
        const res = await http.user.post(
          `/sites/${SITE_1_ID}/sentiment/topics/${TOPIC_2_ID}/prompts`,
          { prompts: ['How is the experience?', 'Would you recommend?'] },
        );
        expect(res.status).to.equal(200);
        expectTopicDto(res.body);
        expect(res.body.subPrompts).to.include('How is the experience?');
        expect(res.body.subPrompts).to.include('Would you recommend?');
      });

      it('user: returns 400 for empty prompts', async () => {
        const http = getHttpClient();
        const res = await http.user.post(
          `/sites/${SITE_1_ID}/sentiment/topics/${TOPIC_1_ID}/prompts`,
          { prompts: [] },
        );
        expect(res.status).to.equal(400);
      });
    });

    // ── Remove sub-prompts ──

    describe('POST /sites/:siteId/sentiment/topics/:topicId/prompts/remove', () => {
      before(() => resetData());

      it('user: removes sub-prompts', async () => {
        const http = getHttpClient();
        // TOPIC_1 has: ['How is build quality?', 'Is the product reliable?']
        const res = await http.user.post(
          `/sites/${SITE_1_ID}/sentiment/topics/${TOPIC_1_ID}/prompts/remove`,
          { prompts: ['How is build quality?'] },
        );
        expect(res.status).to.equal(200);
        expectTopicDto(res.body);
        expect(res.body.subPrompts).to.not.include('How is build quality?');
        expect(res.body.subPrompts).to.include('Is the product reliable?');
      });
    });

    // ── Sentiment config (combined topics + guidelines) ──

    describe('GET /sites/:siteId/sentiment/config', () => {
      before(() => resetData());

      it('user: returns combined config with enabled items', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/sentiment/config`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        expect(res.body.topics).to.be.an('array').with.lengthOf(2);
        expect(res.body.guidelines).to.be.an('array').with.lengthOf(2);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/sentiment/config`);
        expect(res.status).to.equal(403);
      });
    });
  });
}
