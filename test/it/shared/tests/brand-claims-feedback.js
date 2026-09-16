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
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

import {
  BRAND_1_ID,
  SITE_1_ID,
  SITE_3_ID,
} from '../seed-ids.js';

const BUCKET = 'spacecat-it-test';
const MINIO_PORT = process.env.IT_MINIO_PORT || '9100';
const PATH = (siteId) => `/sites/${siteId}/llmo/brand-claims/feedback`;

function s3() {
  return new S3Client({
    region: 'us-east-1',
    endpoint: `http://localhost:${MINIO_PORT}`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
    },
  });
}

export default function brandClaimsFeedbackTests(getHttpClient, resetData) {
  describe('POST /sites/:siteId/llmo/brand-claims/feedback', () => {
    const eventIds = [];

    beforeEach(() => resetData());
    after(async () => {
      await Promise.all(eventIds.map(({ key }) => s3().send(new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: key,
      })).catch(() => {})));
    });

    it('stores feedback for an authorized viewer', async () => {
      const eventId = crypto.randomUUID();
      const http = getHttpClient();
      const res = await http.user.post(PATH(SITE_1_ID), {
        eventId,
        brandId: BRAND_1_ID,
        rating: 'up',
        comment: 'This report helped prioritize our next steps.',
      });

      expect(res.status).to.equal(202);
      expect(res.body.id).to.equal(eventId);

      const today = new Date().toISOString().slice(0, 10);
      const prefix = `product_feedback/brand_claims/up/paid/${today}/`;
      const listed = await s3().send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
      }));
      const key = listed.Contents?.find((item) => item.Key?.endsWith(`_${eventId}.json`))?.Key;
      expect(key).to.be.a('string');
      eventIds.push({ key });
      const object = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      const record = JSON.parse(await object.Body.transformToString());
      expect(record).to.include({
        recordType: 'product_feedback',
        surface: 'brand_claims',
        id: eventId,
        rating: 'up',
        siteId: SITE_1_ID,
        brandId: BRAND_1_ID,
      });
      expect(record.abv_id).to.match(/^abv_[a-f0-9]{12}$/);
    });

    it('rejects a site outside the caller organization', async () => {
      const http = getHttpClient();
      const res = await http.user.post(PATH(SITE_3_ID), {
        eventId: crypto.randomUUID(),
        brandId: BRAND_1_ID,
        rating: 'down',
      });
      expect(res.status).to.equal(403);
    });

    it('rejects malformed feedback', async () => {
      const http = getHttpClient();
      const res = await http.user.post(PATH(SITE_1_ID), {
        eventId: 'not-a-uuid',
        brandId: BRAND_1_ID,
        rating: 'neutral',
      });
      expect(res.status).to.equal(400);
    });
  });
}
