/*
 * Copyright 2026 Adobe. All rights reserved.
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
import { ORG_1_ID } from '../seed-ids.js';

const POSTGREST_PORT = process.env.IT_POSTGREST_PORT || '3300';
const POSTGREST_URL = `http://localhost:${POSTGREST_PORT}`;

/**
 * Query PostgREST directly to inspect topic_categories junction rows.
 * The SpaceCat API does not expose this table via its own routes.
 */
async function getTopicCategories(topicUuid) {
  const res = await fetch(
    `${POSTGREST_URL}/topic_categories?topic_id=eq.${topicUuid}`,
    { headers: { Accept: 'application/json' } },
  );
  return res.json();
}

/**
 * Integration tests for topic creation with topic_categories junction.
 *
 * Validates that createTopic upserts a topic_categories row when categoryId
 * is provided in the topic payload, and skips when it is absent.
 */
export default function topicTests(getHttpClient, resetData) {
  describe('Topics — topic_categories junction', () => {
    describe('POST /v2/orgs/:orgId/topics with categoryId', () => {
      before(() => resetData());

      it('creates a topic_categories junction row linking topic to category', async () => {
        const http = getHttpClient();

        // 1. Create a category
        const catRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { id: 'baseurl-discovery-research', name: 'Discovery & Research', origin: 'human' },
        );
        expect(catRes.status).to.equal(201);
        const categoryUuid = catRes.body.uuid;

        // 2. Create a topic WITH categoryId
        const topicRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/topics`,
          { name: 'Adobe Firefly', categoryId: categoryUuid },
        );
        expect(topicRes.status).to.equal(201);
        const topicUuid = topicRes.body.uuid;

        // 3. Verify topic_categories junction via PostgREST
        const junctionRows = await getTopicCategories(topicUuid);
        expect(junctionRows).to.have.lengthOf(1);
        expect(junctionRows[0].topic_id).to.equal(topicUuid);
        expect(junctionRows[0].category_id).to.equal(categoryUuid);
      });
    });

    describe('POST /v2/orgs/:orgId/topics without categoryId', () => {
      before(() => resetData());

      it('does not create a topic_categories junction row', async () => {
        const http = getHttpClient();

        // Create a topic WITHOUT categoryId
        const topicRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/topics`,
          { name: 'Standalone Topic' },
        );
        expect(topicRes.status).to.equal(201);
        const topicUuid = topicRes.body.uuid;

        // Verify no topic_categories junction row
        const junctionRows = await getTopicCategories(topicUuid);
        expect(junctionRows).to.have.lengthOf(0);
      });
    });

    describe('GET /v2/orgs/:orgId/topics surfaces categoryUuids', () => {
      before(() => resetData());

      it('returns categoryUuids array on topic response after creation with categoryId', async () => {
        const http = getHttpClient();

        // Create a category
        const catRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { id: 'baseurl-awareness', name: 'Awareness', origin: 'human' },
        );
        expect(catRes.status).to.equal(201);
        const categoryUuid = catRes.body.uuid;

        // Create a topic with categoryId — the POST response must already
        // include categoryUuids so callers don't see an empty array on the
        // creation response and a populated one on the next GET.
        const topicRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/topics`,
          { name: 'Brand Awareness', categoryId: categoryUuid },
        );
        expect(topicRes.status).to.equal(201);
        expect(topicRes.body.categoryUuids).to.be.an('array').with.lengthOf(1);
        expect(topicRes.body.categoryUuids[0]).to.equal(categoryUuid);

        // GET topics and verify categoryUuids is populated
        const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/topics`);
        expect(listRes.status).to.equal(200);
        const topic = listRes.body.topics.find((t) => t.name === 'Brand Awareness');
        expect(topic).to.exist;
        expect(topic.categoryUuids).to.be.an('array').with.lengthOf(1);
        expect(topic.categoryUuids[0]).to.equal(categoryUuid);
      });

      it('returns empty categoryUuids array for topics without categories', async () => {
        const http = getHttpClient();

        // Create a topic without categoryId
        const topicRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/topics`,
          { name: 'Uncategorized Topic' },
        );
        expect(topicRes.status).to.equal(201);
        expect(topicRes.body.categoryUuids).to.be.an('array').with.lengthOf(0);

        // GET topics and verify categoryUuids is empty
        const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/topics`);
        expect(listRes.status).to.equal(200);
        const topic = listRes.body.topics.find((t) => t.name === 'Uncategorized Topic');
        expect(topic).to.exist;
        expect(topic.categoryUuids).to.be.an('array').with.lengthOf(0);
      });

      it('drops soft-deleted categories from categoryUuids', async () => {
        const http = getHttpClient();

        // Create two categories and link both to one topic
        const catARes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { id: 'soft-del-cat-a', name: 'CatA', origin: 'human' },
        );
        const catBRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { id: 'soft-del-cat-b', name: 'CatB', origin: 'human' },
        );
        expect(catARes.status).to.equal(201);
        expect(catBRes.status).to.equal(201);
        const catA = catARes.body.uuid;
        const catB = catBRes.body.uuid;

        // Create topic linked to catA, then patch a second link to catB via
        // re-POST (upsert keeps both junction rows).
        await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/topics`,
          { id: 'multi-cat-topic', name: 'Multi Cat Topic', categoryId: catA },
        );
        await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/topics`,
          { id: 'multi-cat-topic', name: 'Multi Cat Topic', categoryId: catB },
        );

        // Soft-delete catB
        const delRes = await http.admin.delete(
          `/v2/orgs/${ORG_1_ID}/categories/soft-del-cat-b`,
        );
        expect(delRes.status).to.be.oneOf([200, 204]);

        // GET topics — only catA should appear in categoryUuids
        const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/topics`);
        expect(listRes.status).to.equal(200);
        const topic = listRes.body.topics.find((t) => t.id === 'multi-cat-topic');
        expect(topic).to.exist;
        expect(topic.categoryUuids).to.be.an('array');
        expect(topic.categoryUuids).to.include(catA);
        expect(topic.categoryUuids).to.not.include(catB);
      });
    });

    describe('Idempotency: duplicate topic with same categoryId', () => {
      before(() => resetData());

      it('upserts topic and junction without duplicating either', async () => {
        const http = getHttpClient();

        // Create a category
        const catRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { id: 'baseurl-comparison', name: 'Comparison & Decision', origin: 'human' },
        );
        expect(catRes.status).to.equal(201);
        const categoryUuid = catRes.body.uuid;

        const topicPayload = { name: 'Content Management', categoryId: categoryUuid };

        // First POST
        const res1 = await http.admin.post(`/v2/orgs/${ORG_1_ID}/topics`, topicPayload);
        expect(res1.status).to.equal(201);
        const topicUuid = res1.body.uuid;

        // Second POST (upsert)
        const res2 = await http.admin.post(`/v2/orgs/${ORG_1_ID}/topics`, topicPayload);
        expect(res2.status).to.equal(201);
        expect(res2.body.uuid).to.equal(topicUuid); // same row

        // Only one junction row
        const junctionRows = await getTopicCategories(topicUuid);
        expect(junctionRows).to.have.lengthOf(1);
      });
    });
  });
}
