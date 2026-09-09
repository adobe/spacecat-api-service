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
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

import {
  SITE_1_ID, // ORG_1, LLMO-enabled — seeded with week folders
  SITE_2_ID, // ORG_1, LLMO-enabled — no S3 objects (empty-list case)
  SITE_3_ID, // ORG_2, LLMO-enabled — forbidden for the ORG_1 `user` persona
  NON_EXISTENT_SITE_ID,
} from '../seed-ids.js';

// Must match S3_BUCKET_NAME in test/it/env.js (the bucket brand-claims presigns).
const BUCKET = 'spacecat-it-test';
const MINIO_PORT = process.env.IT_MINIO_PORT || '9100';
const PATH = (siteId) => `/sites/${siteId}/llmo/brand-claims/weeks`;
const SEEDED_WEEKS = ['2026-W15', '2026-W16', '2026-W17'];

function s3() {
  return new S3Client({
    region: 'us-east-1',
    endpoint: `http://localhost:${MINIO_PORT}`,
    forcePathStyle: true,
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  });
}

function weekKey(siteId, week) {
  return `brand_claims/llmo/${siteId}/${week}/data.json.gz`;
}

async function seedWeeks() {
  const client = s3();
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
  await Promise.all(SEEDED_WEEKS.map((week) => client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: weekKey(SITE_1_ID, week),
    Body: '{}',
    ContentType: 'application/gzip',
  }))));
}

async function cleanupWeeks() {
  const client = s3();
  await Promise.all(SEEDED_WEEKS.map((week) => client
    .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: weekKey(SITE_1_ID, week) }))
    .catch(() => {}))); // best-effort teardown
}

/**
 * Shared tests for the Brand Claims weeks listing endpoint:
 *   GET /sites/:siteId/llmo/brand-claims/weeks
 *
 * Exercises the full request lifecycle (site lookup + LLMO access control) against
 * real PostgreSQL, and the S3 listing itself against the MinIO-backed bucket that
 * brand-claims presigns from. Week folders are seeded under SITE_1's prefix; SITE_2
 * (also ORG_1, LLMO-enabled) has none, covering the empty-list path.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function brandClaimsWeeksTests(getHttpClient, resetData) {
  describe('GET /sites/:siteId/llmo/brand-claims/weeks', () => {
    before(() => seedWeeks());
    after(() => cleanupWeeks());
    beforeEach(() => resetData());

    it('lists the available weeks newest first', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(PATH(SITE_1_ID));

      expect(res.status).to.equal(200);
      expect(res.body.siteId).to.equal(SITE_1_ID);
      expect(res.body.weeks).to.deep.equal(['2026-W17', '2026-W16', '2026-W15']);
      expect(res.body.count).to.equal(3);
    });

    it('honors the limit query parameter', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`${PATH(SITE_1_ID)}?limit=2`);

      expect(res.status).to.equal(200);
      expect(res.body.weeks).to.deep.equal(['2026-W17', '2026-W16']);
      expect(res.body.count).to.equal(2);
    });

    it('returns an empty list for a site with no runs', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(PATH(SITE_2_ID));

      expect(res.status).to.equal(200);
      expect(res.body.weeks).to.deep.equal([]);
      expect(res.body.count).to.equal(0);
    });

    it('returns 404 for a non-existent site', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(PATH(NON_EXISTENT_SITE_ID));
      expect(res.status).to.equal(404);
    });

    it('returns 400 for an invalid site UUID', async () => {
      const http = getHttpClient();
      const res = await http.admin.get('/sites/not-a-uuid/llmo/brand-claims/weeks');
      expect(res.status).to.equal(400);
    });

    it('returns 403 for a site the caller cannot access', async () => {
      // SITE_3 belongs to ORG_2; the `user` persona (ORG_1) has no access.
      const http = getHttpClient();
      const res = await http.user.get(PATH(SITE_3_ID));
      expect(res.status).to.equal(403);
    });
  });
}
