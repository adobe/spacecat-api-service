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
} from '@aws-sdk/client-s3';

import {
  ORG_1_ID,
  ENTITLEMENT_2_ID, // ASO, PAID — under ORG_1
  SITE_2_ID, // ORG_1, externalOwnerId=p50513 / externalSiteId=e440257, NOT ASO-enrolled
} from '../seed-ids.js';

// Must match buildEnv() in test/it/env.js.
const OVERLAYS_BUCKET = 'spacecat-dev-aso-overlays';
const API_KEY = 'it-aso-overlay-key';
const OVERLAY_BODY = 'example.com/old https://www.example.com/new\n';

const MINIO_PORT = process.env.IT_MINIO_PORT || '9100';
const POSTGREST_PORT = process.env.IT_POSTGREST_PORT || '3300';
const POSTGREST_URL = `http://localhost:${POSTGREST_PORT}`;

// Dedicated throwaway fixtures, seeded/torn down inside this suite so the global
// count-asserted seed (sites/orgs/enrollments) is never perturbed. Both are AEM
// CS sites under ORG_1 (which holds the ASO entitlement) and enrolled in it.
//   - ENTITLED: has an overlay object in S3   → 200
//   - NO_OBJECT: entitled+enrolled, no object → 404
const ENTITLED = {
  siteId: 'a50a0000-0000-4000-b000-0000000a5001',
  enrollmentId: 'a50e0000-0000-4000-b000-0000000a5e01',
  programId: '770001',
  environmentId: '880001',
};
const NO_OBJECT = {
  siteId: 'a50a0000-0000-4000-b000-0000000a5002',
  enrollmentId: 'a50e0000-0000-4000-b000-0000000a5e02',
  programId: '770002',
  environmentId: '880002',
};
const ENTITLED_SERVICE = `cm-p${ENTITLED.programId}-e${ENTITLED.environmentId}`;
const NO_OBJECT_SERVICE = `cm-p${NO_OBJECT.programId}-e${NO_OBJECT.environmentId}`;
// Resolves to SITE_2 (ORG_1 IS ASO-entitled, but SITE_2 is NOT enrolled) → 404.
const NOT_ENROLLED_SERVICE = 'cm-p50513-e440257';
// Resolves to no site at all → 404 (the anti-enumeration property).
const UNKNOWN_SERVICE = 'cm-p999999-e999999';

function s3() {
  return new S3Client({
    region: 'us-east-1',
    endpoint: `http://localhost:${MINIO_PORT}`,
    forcePathStyle: true,
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  });
}

async function seedOverlayObject() {
  const client = s3();
  try {
    await client.send(new HeadBucketCommand({ Bucket: OVERLAYS_BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: OVERLAYS_BUCKET }));
  }
  await client.send(new PutObjectCommand({
    Bucket: OVERLAYS_BUCKET,
    Key: `config/${ENTITLED_SERVICE}/redirects.txt`,
    Body: OVERLAY_BODY,
    ContentType: 'text/plain',
  }));
}

async function pgInsert(table, row) {
  const res = await fetch(`${POSTGREST_URL}/${table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`Failed to seed ${table}: ${res.status} ${await res.text()}`);
  }
}

async function pgDelete(table, id) {
  await fetch(`${POSTGREST_URL}/${table}?id=eq.${id}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

function siteRow(fixture) {
  return {
    id: fixture.siteId,
    base_url: `https://overlay-${fixture.programId}.example.com`,
    organization_id: ORG_1_ID,
    delivery_type: 'aem_cs',
    is_live: true,
    name: `Overlay Fixture ${fixture.programId}`,
    is_sandbox: false,
    authoring_type: 'cs',
    delivery_config: {
      programId: fixture.programId,
      environmentId: fixture.environmentId,
    },
    external_owner_id: `p${fixture.programId}`,
    external_site_id: `e${fixture.environmentId}`,
    config: {},
  };
}

/**
 * Integration tests for the ASO redirect-overlay read path:
 *   GET /config/:service/redirects.txt
 *
 * AuthN is via the inbound X-ASO-API-Key (AsoOverlayKeyHandler). The controller
 * then AUTHORIZES per request: it resolves the cm-pXXX-eYYY service to a site via
 * the indexed external-id accessor, requires the site's org to hold an ASO
 * entitlement AND the site to be enrolled in it, and only then reads the overlay
 * object from S3 (MinIO) with the Lambda's own role. Every authz miss returns an
 * indistinguishable 404 so the endpoint cannot enumerate programs.
 *
 * @param {() => string} getBaseUrl - Getter returning the IT dev server base URL.
 */
export default function redirectsTests(getBaseUrl) {
  describe('ASO redirect overlay (GET /config/:service/redirects.txt)', () => {
    before(async () => {
      await seedOverlayObject();
      // Insert sites first, then their ASO enrollments (FK on site + entitlement).
      await pgInsert('sites', siteRow(ENTITLED));
      await pgInsert('sites', siteRow(NO_OBJECT));
      await pgInsert('site_enrollments', {
        id: ENTITLED.enrollmentId, site_id: ENTITLED.siteId, entitlement_id: ENTITLEMENT_2_ID,
      });
      await pgInsert('site_enrollments', {
        id: NO_OBJECT.enrollmentId, site_id: NO_OBJECT.siteId, entitlement_id: ENTITLEMENT_2_ID,
      });
    });

    after(async () => {
      await pgDelete('site_enrollments', ENTITLED.enrollmentId);
      await pgDelete('site_enrollments', NO_OBJECT.enrollmentId);
      await pgDelete('sites', ENTITLED.siteId);
      await pgDelete('sites', NO_OBJECT.siteId);
    });

    const get = (path, headers) => fetch(`${getBaseUrl()}${path}`, { headers });

    it('valid key + entitled+enrolled site + seeded overlay → 200 text/plain', async () => {
      const res = await get(
        `/config/${ENTITLED_SERVICE}/redirects.txt`,
        { 'x-aso-api-key': API_KEY },
      );
      expect(res.status).to.equal(200);
      expect(res.headers.get('content-type')).to.include('text/plain');
      expect(await res.text()).to.equal(OVERLAY_BODY);
    });

    // AEM CS preview pods send AEM_SERVICE=cm-pN-eN-prev; both the auth handler
    // and the controller must accept the suffix and resolve to the canonical
    // overlay. Runs the same fixture end-to-end via `-prev` to prove no leg of
    // the chain 401/400s the preview traffic before the strip happens.
    it('valid key + -prev suffix → 200 (resolves to canonical overlay)', async () => {
      const res = await get(
        `/config/${ENTITLED_SERVICE}-prev/redirects.txt`,
        { 'x-aso-api-key': API_KEY },
      );
      expect(res.status).to.equal(200);
      expect(res.headers.get('content-type')).to.include('text/plain');
      expect(await res.text()).to.equal(OVERLAY_BODY);
    });

    it('missing X-ASO-API-Key → 401', async () => {
      const res = await get(`/config/${ENTITLED_SERVICE}/redirects.txt`, {});
      expect(res.status).to.equal(401);
    });

    it('wrong X-ASO-API-Key → 401', async () => {
      const res = await get(
        `/config/${ENTITLED_SERVICE}/redirects.txt`,
        { 'x-aso-api-key': 'not-the-key' },
      );
      expect(res.status).to.equal(401);
    });

    it('valid key, service resolves to no site → 404 (no enumeration signal)', async () => {
      const res = await get(
        `/config/${UNKNOWN_SERVICE}/redirects.txt`,
        { 'x-aso-api-key': API_KEY },
      );
      expect(res.status).to.equal(404);
    });

    it('valid key, site resolves but is not ASO-enrolled → 404', async () => {
      // cm-p50513-e440257 → SITE_2 (ORG_1 is ASO-entitled, SITE_2 not enrolled).
      expect(SITE_2_ID).to.be.a('string'); // anchor: fixture used for this case
      const res = await get(
        `/config/${NOT_ENROLLED_SERVICE}/redirects.txt`,
        { 'x-aso-api-key': API_KEY },
      );
      expect(res.status).to.equal(404);
    });

    it('valid key, entitled+enrolled site but no overlay object → 404', async () => {
      const res = await get(
        `/config/${NO_OBJECT_SERVICE}/redirects.txt`,
        { 'x-aso-api-key': API_KEY },
      );
      expect(res.status).to.equal(404);
    });
  });
}
