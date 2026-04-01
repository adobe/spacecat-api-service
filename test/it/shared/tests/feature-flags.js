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
  ORG_1_ID,
  ORG_2_ID,
  NON_EXISTENT_ORG_ID,
} from '../seed-ids.js';
import { readFeatureFlag } from '../../../../src/support/feature-flags-storage.js';

/**
 * PUT helper — the shared HTTP client does not expose a put() method,
 * so we build the request manually.
 */
async function putFlag(baseUrl, adminToken, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      'x-product': 'ASO',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsedBody = null;
  if (text) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }
  return { status: res.status, body: parsedBody };
}

/**
 * Shared Feature Flags endpoint + readFeatureFlag storage tests.
 *
 * @param {() => object} getHttpClient
 * @param {() => Promise<void>} resetData
 * @param {() => object} getPostgrestClient
 * @param {() => { baseUrl: string, adminToken: string }} getServerInfo
 */
export default function featureFlagsTests(
  getHttpClient,
  resetData,
  getPostgrestClient,
  getServerInfo,
) {
  describe('Feature Flags', () => {
    before(() => resetData());

    // ── PUT /organizations/:orgId/feature-flags/:product/:flagName ──

    describe('PUT /organizations/:orgId/feature-flags/:product/:flagName', () => {
      it('admin: creates a feature flag with value true', async () => {
        const { baseUrl, adminToken } = getServerInfo();
        const res = await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/llmo/brandalf`,
          { value: true },
        );
        expect(res.status).to.be.oneOf([200, 201]);
        expect(res.body).to.be.an('object');
        expect(res.body.flagName).to.equal('brandalf');
        expect(res.body.product).to.equal('LLMO');
        expect(res.body.flagValue).to.equal(true);
      });

      it('admin: disables a feature flag via DELETE', async () => {
        const http = getHttpClient();
        const res = await http.admin.delete(
          `/organizations/${ORG_1_ID}/feature-flags/llmo/brandalf`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.flagName).to.equal('brandalf');
        expect(res.body.flagValue).to.equal(false);

        // Verify via direct DB read
        const postgrestClient = getPostgrestClient();
        const dbValue = await readFeatureFlag({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'brandalf',
          postgrestClient,
        });
        expect(dbValue).to.equal(false);
      });

      it('returns 400 for invalid product', async () => {
        const { baseUrl, adminToken } = getServerInfo();
        const res = await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/INVALID/some_flag`,
          { value: true },
        );
        expect(res.status).to.equal(400);
      });

      it('returns 400 for invalid flag name', async () => {
        const { baseUrl, adminToken } = getServerInfo();
        const res = await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/llmo/InvalidName`,
          { value: true },
        );
        expect(res.status).to.equal(400);
      });
    });

    // ── GET /organizations/:orgId/feature-flags?product=LLMO ──

    describe('GET /organizations/:orgId/feature-flags?product=LLMO', () => {
      before(async () => {
        const { baseUrl, adminToken } = getServerInfo();
        await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/llmo/brandalf`,
          { value: true },
        );
      });

      it('admin: lists feature flags for an org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/feature-flags?product=LLMO`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array');

        const brandalf = res.body.find((f) => f.flagName === 'brandalf');
        expect(brandalf).to.exist;
        expect(brandalf.flagValue).to.equal(true);
        expect(brandalf.product).to.equal('LLMO');
      });

      it('admin: returns empty array for org with no flags', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_2_ID}/feature-flags?product=LLMO`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('returns 400 when product query param is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/feature-flags`);
        expect(res.status).to.equal(400);
      });

      it('returns 404 for non-existent org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${NON_EXISTENT_ORG_ID}/feature-flags?product=LLMO`);
        expect(res.status).to.equal(404);
      });

      it('user: returns 403 for non-admin user on denied org', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${ORG_2_ID}/feature-flags?product=LLMO`);
        expect(res.status).to.equal(403);
      });
    });

    // ── readFeatureFlag storage helper (direct DB test) ──

    describe('readFeatureFlag (storage helper against real DB)', () => {
      before(async () => {
        const { baseUrl, adminToken } = getServerInfo();
        await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/llmo/brandalf`,
          { value: true },
        );
      });

      it('reads true when flag is set to true', async () => {
        const postgrestClient = getPostgrestClient();
        const result = await readFeatureFlag({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'brandalf',
          postgrestClient,
        });
        expect(result).to.equal(true);
      });

      it('reads false after flag is disabled via DELETE', async () => {
        // Disable via DELETE
        const http = getHttpClient();
        await http.admin.delete(
          `/organizations/${ORG_1_ID}/feature-flags/llmo/brandalf`,
        );

        const postgrestClient = getPostgrestClient();
        const result = await readFeatureFlag({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'brandalf',
          postgrestClient,
        });
        expect(result).to.equal(false);
      });

      it('returns null when flag does not exist for org', async () => {
        const postgrestClient = getPostgrestClient();
        const result = await readFeatureFlag({
          organizationId: ORG_2_ID,
          product: 'LLMO',
          flagName: 'brandalf',
          postgrestClient,
        });
        expect(result).to.be.null;
      });

      it('returns null when flag name does not exist', async () => {
        const postgrestClient = getPostgrestClient();
        const result = await readFeatureFlag({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'nonexistent_flag',
          postgrestClient,
        });
        expect(result).to.be.null;
      });
    });
  });
}
