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
import { SITE_1_BASE_URL } from '../seed-ids.js';

/**
 * Shared GET /trigger endpoint tests.
 * Tests focus on input validation and routing paths that do not require a live SQS queue
 * (the IT environment uses a dummy SQS URL; the success/SQS path is covered by unit tests).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function triggerTests(getHttpClient, resetData) {
  describe('GET /trigger (cwv-trends-audit)', () => {
    before(() => resetData());

    it('admin: returns 400 when type query param is missing', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/trigger?url=${encodeURIComponent(SITE_1_BASE_URL)}`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when url query param is missing', async () => {
      const http = getHttpClient();
      const res = await http.admin.get('/trigger?type=cwv-trends-audit');
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 for unknown audit type', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/trigger?type=unknown-type&url=${encodeURIComponent(SITE_1_BASE_URL)}`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when endDate is not a valid date format', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/trigger?type=cwv-trends-audit&url=${encodeURIComponent(SITE_1_BASE_URL)}&endDate=not-a-date`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when endDate is an invalid calendar date', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/trigger?type=cwv-trends-audit&url=${encodeURIComponent(SITE_1_BASE_URL)}&endDate=2026-13-99`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 404 when site does not exist', async () => {
      const http = getHttpClient();
      const res = await http.admin.get('/trigger?type=cwv-trends-audit&url=https%3A%2F%2Fnonexistent.example.com');
      expect(res.status).to.equal(404);
    });
  });
}
