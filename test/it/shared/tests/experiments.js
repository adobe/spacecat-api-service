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
import {
  SITE_1_ID,
  SITE_2_ID,
  SITE_3_ID,
  EXP_1_EXP_ID,
  EXP_2_EXP_ID,
  NON_EXISTENT_SITE_ID,
} from '../seed-ids.js';

const BASE = `/sites/${SITE_1_ID}/experiments`;
const DENIED_BASE = `/sites/${SITE_3_ID}/experiments`;

/**
 * Asserts that an object has the ExperimentDto shape.
 */
function expectExperimentDto(experiment) {
  expect(experiment).to.be.an('object');
  expect(experiment.siteId).to.be.a('string');
  expect(experiment.expId).to.be.a('string');
  expect(experiment.url).to.be.a('string');
  expect(experiment.status).to.be.a('string');
  expect(experiment.variants).to.be.an('array');
}

/**
 * Shared Experiment endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function experimentTests(getHttpClient, resetData) {
  describe('Experiments', () => {
    describe('GET /sites/:siteId/experiments', () => {
      before(() => resetData());

      it('user: returns experiments for site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(BASE);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        res.body.forEach((e) => expectExperimentDto(e));

        const expIds = res.body.map((e) => e.expId).sort();
        expect(expIds).to.deep.equal([EXP_1_EXP_ID, EXP_2_EXP_ID]);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(DENIED_BASE);
        expect(res.status).to.equal(403);
      });

      it('user: returns empty for site with no experiments', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_2_ID}/experiments`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 400 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${NON_EXISTENT_SITE_ID}/experiments`);
        expect(res.status).to.equal(400);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/sites/not-a-uuid/experiments');
        expect(res.status).to.equal(400);
      });
    });
  });
}
