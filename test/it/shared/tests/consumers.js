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
// expectISOTimestamp not used - consumer seed has fixed timestamps
import {
  CONSUMER_1_ID,
  CONSUMER_1_CLIENT_ID,
  CONSUMER_2_ID,
  NON_EXISTENT_CONSUMER_ID,
} from '../seed-ids.js';

/**
 * Asserts that an object has the ConsumerDto shape.
 */
function expectConsumerDto(consumer) {
  expect(consumer).to.be.an('object');
  expect(consumer.consumerId).to.be.a('string');
  expect(consumer.clientId).to.be.a('string');
  expect(consumer.technicalAccountId).to.be.a('string');
  expect(consumer.imsOrgId).to.be.a('string');
  expect(consumer.consumerName).to.be.a('string');
  expect(consumer.status).to.be.a('string');
  expect(consumer.capabilities).to.be.an('array');
  // Seed data has fixed timestamps, so just check format (not recency)
  expect(consumer.createdAt).to.be.a('string').and.match(/^\d{4}-\d{2}-\d{2}T/);
  expect(consumer.updatedAt).to.be.a('string').and.match(/^\d{4}-\d{2}-\d{2}T/);
}

/**
 * Shared Consumer endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 * All endpoints require S2S admin access (admin persona has is_s2s_admin).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function consumerTests(getHttpClient, resetData) {
  describe('Consumers', () => {
    describe('GET /consumers', () => {
      before(() => resetData());

      it('admin: returns all consumers', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/consumers');
        expect(res.status).to.equal(200);
        // CONSUMER_1 (site:read + site:write) and CONSUMER_2 (readAll capabilities).
        expect(res.body).to.be.an('array').with.lengthOf(2);
        res.body.forEach((c) => expectConsumerDto(c));
        const ids = res.body.map((c) => c.consumerId);
        expect(ids).to.include(CONSUMER_1_ID);
        expect(ids).to.include(CONSUMER_2_ID);
      });

      it('user: returns 403 (requires S2S admin)', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/consumers');
        expect(res.status).to.equal(403);
      });
    });

    describe('GET /consumers/:consumerId', () => {
      before(() => resetData());

      it('admin: returns consumer by id', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/consumers/${CONSUMER_1_ID}`);
        expect(res.status).to.equal(200);
        expectConsumerDto(res.body);
        expect(res.body.consumerId).to.equal(CONSUMER_1_ID);
        expect(res.body.clientId).to.equal(CONSUMER_1_CLIENT_ID);
      });

      it('admin: returns 404 for non-existent consumer', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/consumers/${NON_EXISTENT_CONSUMER_ID}`);
        expect(res.status).to.equal(404);
      });

      it('user: returns 403 (requires S2S admin)', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/consumers/${CONSUMER_1_ID}`);
        expect(res.status).to.equal(403);
      });
    });

    describe('GET /consumers/by-client-id/:clientId', () => {
      before(() => resetData());

      it('admin: returns consumer by clientId', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/consumers/by-client-id/${CONSUMER_1_CLIENT_ID}`);
        expect(res.status).to.equal(200);
        expectConsumerDto(res.body);
        expect(res.body.clientId).to.equal(CONSUMER_1_CLIENT_ID);
      });

      it('admin: returns 404 for non-existent clientId', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/consumers/by-client-id/unknown-client-id-999999999999');
        expect(res.status).to.equal(404);
      });

      it('user: returns 403 (requires S2S admin)', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/consumers/by-client-id/${CONSUMER_1_CLIENT_ID}`);
        expect(res.status).to.equal(403);
      });
    });

    describe('PATCH /consumers/:consumerId', () => {
      before(() => resetData());

      it('admin: updates consumer name', async () => {
        const http = getHttpClient();
        const res = await http.admin.patch(`/consumers/${CONSUMER_1_ID}`, {
          consumerName: 'Updated IT Consumer',
        });
        expect(res.status).to.equal(200);
        expect(res.body.consumerName).to.equal('Updated IT Consumer');
      });

      it('user: returns 403 (requires S2S admin)', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/consumers/${CONSUMER_1_ID}`, {
          consumerName: 'Should not work',
        });
        expect(res.status).to.equal(403);
      });
    });

    describe('POST /consumers/:consumerId/revoke', () => {
      before(() => resetData());

      it('admin: revokes consumer', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/consumers/${CONSUMER_1_ID}/revoke`, {});
        expect(res.status).to.equal(200);
        expect(res.body.status).to.equal('REVOKED');
        expect(res.body.revokedAt).to.be.a('string');
      });

      it('user: returns 403 (requires S2S admin)', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/consumers/${CONSUMER_1_ID}/revoke`, {});
        expect(res.status).to.equal(403);
      });
    });
  });
}
