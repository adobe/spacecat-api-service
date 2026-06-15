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
import { ORG_1_ID, NON_EXISTENT_ORG_ID } from '../seed-ids.js';

const BASE = `/organizations/${ORG_1_ID}/permission/audit-logs`;

/**
 * Shared tests for GET /organizations/:organizationId/permission/audit-logs.
 *
 * The seed (`facs-access-mapping-audit-events.js`) loads three LLMO audit rows
 * for ORG_1's IMS org. The `admin` persona is an internal identity that
 * bypasses facsWrapper and the controller's can_manage_users gate + tenant
 * check, so it reads the org's audit directly; the `user` persona (ORG_1, no
 * FACS permissions) exercises the capability gate.
 *
 * @param {() => object} getHttpClient
 * @param {() => Promise<void>} resetData
 */
export default function permissionAuditLogsTests(getHttpClient, resetData) {
  describe('PermissionAuditLogs', () => {
    describe('GET /organizations/:organizationId/permission/audit-logs', () => {
      before(() => resetData());

      it('admin: returns the org\'s LLMO audit events (org UUID resolved to IMS org)', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(BASE);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        expect(res.body.items).to.be.an('array').with.lengthOf(3);
        expect(res.body).to.have.property('cursor');
        const e = res.body.items[0];
        // camelCase DTO shape, actor distinct from binding subject.
        expect(e.actorId).to.be.a('string');
        expect(e.operation).to.be.oneOf(['create', 'update_capabilities', 'revoke']);
        expect(e.outcome).to.be.oneOf(['allow', 'deny', 'error']);
        expect(e.product).to.equal('LLMO');
        expect(e).to.have.property('bindingSubjectId');
      });

      it('admin: filters by outcome=deny', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`${BASE}?outcome=deny`);
        expect(res.status).to.equal(200);
        expect(res.body.items).to.be.an('array').with.lengthOf(1);
        expect(res.body.items[0].outcome).to.equal('deny');
        expect(res.body.items[0].denialReason).to.equal('duplicate');
      });

      it('admin: filters by operation=create', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`${BASE}?operation=create`);
        expect(res.status).to.equal(200);
        res.body.items.forEach((e) => expect(e.operation).to.equal('create'));
      });

      it('admin: returns 404 for a non-existent organization', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${NON_EXISTENT_ORG_ID}/permission/audit-logs`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for an invalid organization UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/organizations/not-a-uuid/permission/audit-logs');
        expect(res.status).to.equal(400);
      });

      // The non-admin can_manage_users gate (and cross-org isolation) is covered
      // deterministically in the controller unit tests. Driving it through the IT
      // would also traverse facsWrapper's LaunchDarkly gate, which is not
      // configured in the IT environment.
    });
  });
}
