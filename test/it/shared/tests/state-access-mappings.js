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
  MANAGED_BRAND_ID,
  UNMANAGED_BRAND_ID,
  UNMANAGED_MAPPING_ID,
} from '../seed-ids.js';

/**
 * Asserts a value is a parseable ISO 8601 timestamp. Unlike the shared
 * `expectISOTimestamp` helper (which requires a `Z` suffix), this accepts the
 * `+00:00` offset form that PostgREST returns for `timestamptz` columns — the
 * state-access-mapping DTO passes those values through unmodified.
 *
 * @param {*} value - the value to check
 * @param {string} label - field label for assertion messages
 */
function expectIsoTimestamp(value, label = 'timestamp') {
  expect(value, label).to.be.a('string');
  expect(Number.isNaN(Date.parse(value)), `${label} should be a valid ISO 8601 timestamp`)
    .to.equal(false);
}

// State-layer access mappings are created fresh by these tests (the controller
// does not validate resource existence), so no pre-seeded rows are required.
// Literal UUIDs below identify the ReBAC resources being granted.
const BRAND_RESOURCE_ID = 'b1111111-1111-4111-8111-111111111111';
const BRAND_RESOURCE_ID_2 = 'b2222222-2222-4222-8222-222222222222';
const SITE_RESOURCE_ID = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';

// Canonical IMS user idents (subject_id for subject_type='user').
const USER_SUBJECT = 'grantee123@AdobeID';

const LLMO_CAPS = ['llmo/can_view', 'llmo/can_configure'];
const LLMO_CAPS_UPDATED = ['llmo/can_view', 'llmo/can_deploy', 'llmo/can_configure'];

const BASE = '/state/access-mappings';
const HISTORY = '/state/access-mappings/history';

/**
 * Asserts that an object has the state-access-mapping DTO shape (camelCase).
 *
 * @param {object} m - the mapping DTO
 */
function expectMappingDto(m) {
  expect(m).to.be.an('object');
  expect(m.id).to.be.a('string');
  expect(m.subjectType).to.be.oneOf(['user', 'org']);
  expect(m.subjectId).to.be.a('string');
  expect(m.resourceType).to.be.a('string');
  expect(m.resourceId).to.be.a('string');
  expect(m.imsOrgId).to.be.a('string');
  expect(m.product).to.be.a('string');
  expect(m.grantedCapabilities).to.be.an('array');
  expectIsoTimestamp(m.createdAt, 'createdAt');
}

/**
 * Shared StateAccessMappings endpoint tests.
 *
 * Exercises the full PostgREST round-trip for the hybrid-model state layer:
 * create / list / patch (including empty-to-remove-access) / history, plus
 * validation and the active-duplicate → 409 semantics. The `admin` persona is
 * used throughout because it is an
 * internal identity that bypasses `facsWrapper` — the controller logic and
 * the real `facs_access_mappings` table are what's under test here, not the
 * capability gate (covered by the facsWrapper unit suite).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function stateAccessMappingsTests(getHttpClient, resetData) {
  describe('StateAccessMappings', () => {
    describe('lifecycle: create → list → patch → empty', () => {
      before(() => resetData());

      let created;

      it('POST creates a user-scoped binding (201)', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(BASE, {
          subjectType: 'user',
          subjectId: USER_SUBJECT,
          resourceType: 'brand',
          resourceId: BRAND_RESOURCE_ID,
          grantedCapabilities: LLMO_CAPS,
        });
        expect(res.status).to.equal(201);
        expectMappingDto(res.body);
        expect(res.body.subjectType).to.equal('user');
        expect(res.body.subjectId).to.equal(USER_SUBJECT);
        expect(res.body.resourceType).to.equal('brand');
        expect(res.body.resourceId).to.equal(BRAND_RESOURCE_ID);
        expect(res.body.product).to.equal('LLMO');
        expect(res.body.grantedCapabilities).to.have.members(LLMO_CAPS);
        expect(res.body.revokedAt).to.equal(null);
        created = res.body;
      });

      it('GET lists the binding filtered by resource', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `${BASE}?resourceType=brand&resourceId=${BRAND_RESOURCE_ID}`,
        );
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        expect(res.body.items).to.be.an('array').with.lengthOf(1);
        expect(res.body.items[0].id).to.equal(created.id);
        expect(res.body).to.have.property('cursor');
      });

      it('GET lists the binding filtered by subject', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `${BASE}?subjectType=user&subjectId=${encodeURIComponent(USER_SUBJECT)}`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.items).to.be.an('array').with.lengthOf(1);
        expect(res.body.items[0].id).to.equal(created.id);
      });

      it('POST a duplicate active binding returns 409 with the existing id', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(BASE, {
          subjectType: 'user',
          subjectId: USER_SUBJECT,
          resourceType: 'brand',
          resourceId: BRAND_RESOURCE_ID,
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(res.status).to.equal(409);
        expect(res.body.id).to.equal(created.id);
      });

      it('PATCH replaces the granted capabilities (200)', async () => {
        const http = getHttpClient();
        const res = await http.admin.patch(`${BASE}/${created.id}`, {
          grantedCapabilities: LLMO_CAPS_UPDATED,
        });
        expect(res.status).to.equal(200);
        expect(res.body.id).to.equal(created.id);
        expect(res.body.grantedCapabilities).to.have.members(LLMO_CAPS_UPDATED);
      });

      it('GET reflects the patched capabilities', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `${BASE}?resourceType=brand&resourceId=${BRAND_RESOURCE_ID}`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.items[0].grantedCapabilities).to.have.members(LLMO_CAPS_UPDATED);
      });

      it('PATCH with an empty array is rejected (400) — emptying is done via DELETE', async () => {
        const http = getHttpClient();
        const res = await http.admin.patch(`${BASE}/${created.id}`, {
          grantedCapabilities: [],
        });
        expect(res.status).to.equal(400);
      });

      it('DELETE empties the granted capabilities (binding stays active, grants nothing)', async () => {
        const http = getHttpClient();
        const res = await http.admin.delete(`${BASE}/${created.id}`);
        expect(res.status).to.equal(200);
        expect(res.body.id).to.equal(created.id);
        expect(res.body.grantedCapabilities).to.be.an('array').with.lengthOf(0);
        expect(res.body.revokedAt).to.equal(null);
      });

      it('GET (active) still returns the emptied binding with no capabilities', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `${BASE}?resourceType=brand&resourceId=${BRAND_RESOURCE_ID}`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.items).to.be.an('array').with.lengthOf(1);
        expect(res.body.items[0].id).to.equal(created.id);
        expect(res.body.items[0].grantedCapabilities).to.be.an('array').with.lengthOf(0);
      });

      it('GET history returns the active binding', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `${HISTORY}?resourceType=brand&resourceId=${BRAND_RESOURCE_ID}`,
        );
        expect(res.status).to.equal(200);
        const row = res.body.items.find((m) => m.id === created.id);
        expect(row, 'binding present in history').to.be.an('object');
        expect(row.revokedAt).to.equal(null);
      });
    });

    describe('can_view baseline auto-injection', () => {
      before(() => resetData());

      it('POST without can_view persists can_view alongside the requested capability', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(BASE, {
          subjectType: 'user',
          subjectId: USER_SUBJECT,
          resourceType: 'brand',
          resourceId: BRAND_RESOURCE_ID_2,
          grantedCapabilities: ['llmo/can_configure'],
        });
        expect(res.status).to.equal(201);
        expect(res.body.grantedCapabilities).to.have.members([
          'llmo/can_configure',
          'llmo/can_view',
        ]);
      });

      it('GET round-trips the auto-injected can_view from the DB', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `${BASE}?resourceType=brand&resourceId=${BRAND_RESOURCE_ID_2}`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.items).to.be.an('array').with.lengthOf(1);
        expect(res.body.items[0].grantedCapabilities).to.have.members([
          'llmo/can_configure',
          'llmo/can_view',
        ]);
      });
    });

    describe('org-scoped binding', () => {
      before(() => resetData());

      it('POST org-scoped binding requires subjectId === caller org (403 otherwise)', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(BASE, {
          subjectType: 'org',
          subjectId: 'SOMEOTHERORG@AdobeOrg',
          resourceType: 'brand',
          resourceId: BRAND_RESOURCE_ID_2,
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(res.status).to.equal(403);
      });

      it('POST org-scoped binding succeeds when subjectId equals the caller org id', async () => {
        const http = getHttpClient();
        // Derive the caller's canonical org id by reading it back off a
        // user-scoped create (robust to the normalizeImsOrgId rule).
        const userRes = await http.admin.post(BASE, {
          subjectType: 'user',
          subjectId: USER_SUBJECT,
          resourceType: 'brand',
          resourceId: BRAND_RESOURCE_ID_2,
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(userRes.status).to.equal(201);
        const callerOrgId = userRes.body.imsOrgId;

        const res = await http.admin.post(BASE, {
          subjectType: 'org',
          subjectId: callerOrgId,
          resourceType: 'brand',
          resourceId: BRAND_RESOURCE_ID_2,
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(res.status).to.equal(201);
        expect(res.body.subjectType).to.equal('org');
        expect(res.body.subjectId).to.equal(callerOrgId);
      });
    });

    describe('validation', () => {
      before(() => resetData());

      it('POST returns 400 when the body is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(BASE, undefined);
        expect(res.status).to.equal(400);
      });

      it('POST returns 400 for an invalid subjectType', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(BASE, {
          subjectType: 'group',
          subjectId: USER_SUBJECT,
          resourceType: 'brand',
          resourceId: BRAND_RESOURCE_ID,
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(res.status).to.equal(400);
      });

      it("POST returns 400 when a 'user' subjectId is not canonical (<ident>@<authSrc>)", async () => {
        const http = getHttpClient();
        const res = await http.admin.post(BASE, {
          subjectType: 'user',
          subjectId: 'no-at-sign',
          resourceType: 'brand',
          resourceId: BRAND_RESOURCE_ID,
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(res.status).to.equal(400);
      });

      it('POST returns 400 for a resourceType not valid for the product', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(BASE, {
          subjectType: 'user',
          subjectId: USER_SUBJECT,
          resourceType: 'site', // not an LLMO resource type
          resourceId: BRAND_RESOURCE_ID,
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(res.status).to.equal(400);
      });

      it('POST returns 400 for a capability outside the product catalog', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(BASE, {
          subjectType: 'user',
          subjectId: USER_SUBJECT,
          resourceType: 'brand',
          resourceId: BRAND_RESOURCE_ID,
          grantedCapabilities: ['llmo/can_teleport'],
        });
        expect(res.status).to.equal(400);
      });

      it('POST returns 400 for a capability with the wrong product prefix', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(BASE, {
          subjectType: 'user',
          subjectId: USER_SUBJECT,
          resourceType: 'brand',
          resourceId: BRAND_RESOURCE_ID,
          grantedCapabilities: ['aso/can_view'],
        });
        expect(res.status).to.equal(400);
      });

      it('POST returns 400 when x-product is absent / unknown', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          BASE,
          {
            subjectType: 'user',
            subjectId: USER_SUBJECT,
            resourceType: 'brand',
            resourceId: BRAND_RESOURCE_ID,
            grantedCapabilities: ['llmo/can_view'],
          },
          { 'x-product': 'not-a-product' },
        );
        expect(res.status).to.equal(400);
      });

      it('GET returns 400 when neither subject nor resource filter is supplied', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(BASE);
        expect(res.status).to.equal(400);
      });

      it('PATCH returns 400 for an invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.patch(`${BASE}/not-a-uuid`, {
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(res.status).to.equal(400);
      });

      it('PATCH returns 404 for an unknown id', async () => {
        const http = getHttpClient();
        const res = await http.admin.patch(`${BASE}/${BRAND_RESOURCE_ID}`, {
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(res.status).to.equal(404);
      });
    });

    describe('audit-trail emit: create / patch write audit events', () => {
      // The api-service IT PostgREST client authenticates as `postgrest_writer`
      // (POSTGREST_API_KEY = POSTGREST_WRITER_JWT), which holds INSERT on the
      // append-only `facs_access_mapping_audit_events` table, so the emit lands.
      // The admin persona's tenant is ORG_1's IMS org, so events are readable
      // through ORG_1's audit-logs endpoint. We filter by the fresh mappingId to
      // isolate from the seeded audit rows.
      const AUDIT_BASE = `/organizations/${ORG_1_ID}/permission/audit-logs`;
      const AUDIT_RESOURCE_ID = 'a1d17000-0000-4000-8000-000000000001';
      let mappingId;

      before(() => resetData());

      it('POST create emits an allow/create audit event', async () => {
        const http = getHttpClient();
        const created = await http.admin.post(BASE, {
          subjectType: 'user',
          subjectId: USER_SUBJECT,
          resourceType: 'brand',
          resourceId: AUDIT_RESOURCE_ID,
          grantedCapabilities: LLMO_CAPS,
        });
        expect(created.status).to.equal(201);
        mappingId = created.body.id;

        const res = await http.admin.get(`${AUDIT_BASE}?mappingId=${mappingId}`);
        expect(res.status).to.equal(200);
        expect(res.body.items).to.be.an('array').with.lengthOf(1);
        const e = res.body.items[0];
        expect(e.operation).to.equal('create');
        expect(e.outcome).to.equal('allow');
        expect(e.mappingId).to.equal(mappingId);
        expect(e.resourceId).to.equal(AUDIT_RESOURCE_ID);
        expect(e.product).to.equal('LLMO');
        expect(e.actorId).to.be.a('string');
      });

      it('PATCH emits an allow/update_capabilities audit event', async () => {
        const http = getHttpClient();
        const patched = await http.admin.patch(`${BASE}/${mappingId}`, {
          grantedCapabilities: LLMO_CAPS_UPDATED,
        });
        expect(patched.status).to.equal(200);

        const res = await http.admin.get(
          `${AUDIT_BASE}?mappingId=${mappingId}&operation=update_capabilities`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.items).to.be.an('array').with.lengthOf(1);
        expect(res.body.items[0].outcome).to.equal('allow');
        expect(res.body.items[0].grantedCapabilities).to.have.members(LLMO_CAPS_UPDATED);
      });
    });

    describe('flow 8.3: resource-scoped state-layer manager (brandManager persona)', () => {
      // brandManager holds state-layer llmo/can_manage_users on MANAGED_BRAND_ID
      // only (seeded), with an empty JWT facs_permissions set. It must be able to
      // manage users on MANAGED_BRAND_ID but nowhere else, and may never grant
      // can_manage_users (FACS-only).
      before(() => resetData());

      const AUDIT_BASE = `/organizations/${ORG_1_ID}/permission/audit-logs`;
      let managedMappingId;

      it('POST creates a binding on the resource it manages (201)', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.post(BASE, {
          subjectType: 'user',
          subjectId: 'workspace-user@AdobeID',
          resourceType: 'brand',
          resourceId: MANAGED_BRAND_ID,
          grantedCapabilities: ['llmo/can_view', 'llmo/can_configure'],
        });
        expect(res.status).to.equal(201);
        expect(res.body.resourceId).to.equal(MANAGED_BRAND_ID);
        managedMappingId = res.body.id;
      });

      it('POST 403s on a resource it does NOT manage', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.post(BASE, {
          subjectType: 'user',
          subjectId: 'workspace-user@AdobeID',
          resourceType: 'brand',
          resourceId: UNMANAGED_BRAND_ID,
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(res.status).to.equal(403);
      });

      it('POST 403s when granting can_manage_users (FACS-only)', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.post(BASE, {
          subjectType: 'user',
          subjectId: 'workspace-user@AdobeID',
          resourceType: 'brand',
          resourceId: MANAGED_BRAND_ID,
          grantedCapabilities: ['llmo/can_manage_users'],
        });
        expect(res.status).to.equal(403);
      });

      it('GET lists bindings scoped to the managed resource (200)', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.get(
          `${BASE}?resourceType=brand&resourceId=${MANAGED_BRAND_ID}`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.items).to.be.an('array');
        expect(res.body.items.length).to.be.greaterThan(0);
      });

      it('GET 403s on an org-wide (subject-only) read', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.get(
          `${BASE}?subjectType=user&subjectId=${encodeURIComponent('workspace-user@AdobeID')}`,
        );
        expect(res.status).to.equal(403);
      });

      it('GET 403s reading a resource it does not manage', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.get(
          `${BASE}?resourceType=brand&resourceId=${UNMANAGED_BRAND_ID}`,
        );
        expect(res.status).to.equal(403);
      });

      it('PATCH edits a binding on the managed resource (200)', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.patch(`${BASE}/${managedMappingId}`, {
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(res.status).to.equal(200);
      });

      it('PATCH 403s on a binding belonging to an unmanaged resource', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.patch(`${BASE}/${UNMANAGED_MAPPING_ID}`, {
          grantedCapabilities: ['llmo/can_view'],
        });
        expect(res.status).to.equal(403);
      });

      it('PATCH-empty is rejected (400) — emptying is done via DELETE', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.patch(`${BASE}/${managedMappingId}`, {
          grantedCapabilities: [],
        });
        expect(res.status).to.equal(400);
      });

      it('DELETE empties access on the managed binding (200)', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.delete(`${BASE}/${managedMappingId}`);
        expect(res.status).to.equal(200);
        expect(res.body.grantedCapabilities).to.be.an('array').with.lengthOf(0);
        expect(res.body.revokedAt).to.equal(null);
      });

      it('DELETE 403s on a binding belonging to an unmanaged resource', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.delete(`${BASE}/${UNMANAGED_MAPPING_ID}`);
        expect(res.status).to.equal(403);
      });

      it('GET audit-logs 403s (org-wide read is FACS-only)', async () => {
        const http = getHttpClient();
        const res = await http.brandManager.get(AUDIT_BASE);
        expect(res.status).to.equal(403);
      });
    });

    describe('ASO product (site-scoped)', () => {
      before(() => resetData());

      it('POST creates a site-scoped ASO binding when x-product=aso', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          BASE,
          {
            subjectType: 'user',
            subjectId: USER_SUBJECT,
            resourceType: 'site',
            resourceId: SITE_RESOURCE_ID,
            grantedCapabilities: ['aso/can_view', 'aso/can_edit'],
          },
          { 'x-product': 'aso' },
        );
        expect(res.status).to.equal(201);
        expect(res.body.product).to.equal('ASO');
        expect(res.body.resourceType).to.equal('site');
        expect(res.body.grantedCapabilities).to.have.members(['aso/can_view', 'aso/can_edit']);
      });
    });
  });
}
