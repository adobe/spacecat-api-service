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
  CONN_1_ID,
  CONN_2_ID,
  NON_EXISTENT_CONN_ID,
  TICKET_1_ID,
  TICKET_2_ID,
  NON_EXISTENT_TICKET_ID,
  TASK_MGMT_SUGGESTION_ID,
  OPPTY_1_ID,
} from '../seed-ids.js';

function expectConnectionDto(conn) {
  expect(conn).to.be.an('object');
  expect(conn.id).to.be.a('string');
  expect(conn.organizationId).to.be.a('string');
  expect(conn.provider).to.be.a('string');
  expect(conn.status).to.be.a('string');
  expect(conn.displayName).to.be.a('string');
  expect(conn.instanceUrl).to.be.a('string');
}

function expectTicketDto(ticket) {
  expect(ticket).to.be.an('object');
  expect(ticket.id).to.be.a('string');
  expect(ticket.organizationId).to.be.a('string');
  expect(ticket.ticketKey).to.be.a('string');
  expect(ticket.ticketUrl).to.be.a('string');
  expect(ticket.ticketProvider).to.be.a('string');
}

/**
 * Shared task-management endpoint tests.
 *
 * Covers:
 *   - GET  /organizations/:orgId/task-management/connections
 *   - GET  /organizations/:orgId/task-management/connections/:connId
 *   - GET  /organizations/:orgId/task-management/tickets
 *   - GET  /organizations/:orgId/suggestions/:suggestionId/ticket
 *   - GET  /organizations/:orgId/opportunities/:opportunityId/tickets
 *   - POST /organizations/:orgId/task-management/:provider/tickets (validation paths only)
 *   - GET  /organizations/:orgId/task-management/connections/:connId/projects (validation only)
 *   - GET  /organizations/:orgId/task-management/connections/:connId/issue-types (validation only)
 *
 * @param {() => object} getHttpClient
 * @param {() => Promise<void>} resetData
 */
export default function taskManagementTests(getHttpClient, resetData) {
  describe('Task Management', () => {
    // ── GET /organizations/:orgId/task-management/connections ─────────────────

    describe('GET /organizations/:orgId/task-management/connections', () => {
      before(() => resetData());

      it('admin: lists connections for org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);
        expectConnectionDto(res.body[0]);
        expect(res.body[0].id).to.equal(CONN_1_ID);
      });

      it('user: returns 403 for org the user does not belong to', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${ORG_2_ID}/task-management/connections`);
        expect(res.status).to.equal(403);
      });

      it('admin: returns 404 for non-existent org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${NON_EXISTENT_ORG_ID}/task-management/connections`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid organizationId', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/organizations/not-a-uuid/task-management/connections');
        expect(res.status).to.equal(400);
      });

      it('admin: filters connections by provider query param', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections?provider=jira_cloud`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);
        expect(res.body[0].provider).to.equal('jira_cloud');
      });

      it('admin: returns empty array for unknown provider filter', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections?provider=unknown`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });
    });

    // ── GET /organizations/:orgId/task-management/connections/:connId ─────────

    describe('GET /organizations/:orgId/task-management/connections/:connId', () => {
      before(() => resetData());

      it('admin: returns connection by id', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections/${CONN_1_ID}`);
        expect(res.status).to.equal(200);
        expectConnectionDto(res.body);
        expect(res.body.id).to.equal(CONN_1_ID);
        expect(res.body.organizationId).to.equal(ORG_1_ID);
      });

      it('returns 404 when connection belongs to a different org', async () => {
        const http = getHttpClient();
        // CONN_2 belongs to ORG_2 — requesting it under ORG_1 must 404
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections/${CONN_2_ID}`);
        expect(res.status).to.equal(404);
      });

      it('returns 404 for non-existent connection', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections/${NON_EXISTENT_CONN_ID}`);
        expect(res.status).to.equal(404);
      });
    });

    // ── GET /organizations/:orgId/task-management/tickets ────────────────────

    describe('GET /organizations/:orgId/task-management/tickets', () => {
      before(() => resetData());

      it('admin: lists tickets for org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/tickets`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        res.body.forEach((t) => expectTicketDto(t));
        const ids = res.body.map((t) => t.id);
        expect(ids).to.include(TICKET_1_ID);
        expect(ids).to.include(TICKET_2_ID);
      });

      it('admin: ORG_2 returns empty array (no tickets seeded for ORG_2)', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_2_ID}/task-management/tickets`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 403 for org the user does not belong to', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${ORG_2_ID}/task-management/tickets`);
        expect(res.status).to.equal(403);
      });

      it('TICKET_1 response includes its suggestion bridge', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/tickets`);
        expect(res.status).to.equal(200);
        const ticket1 = res.body.find((t) => t.id === TICKET_1_ID);
        expect(ticket1).to.exist;
        expect(ticket1.suggestions).to.be.an('array').that.includes(TASK_MGMT_SUGGESTION_ID);
      });
    });

    // ── GET /organizations/:orgId/suggestions/:suggestionId/ticket ────────────

    describe('GET /organizations/:orgId/suggestions/:suggestionId/ticket', () => {
      before(() => resetData());

      it('admin: returns ticket for a linked suggestion', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/suggestions/${TASK_MGMT_SUGGESTION_ID}/ticket`);
        expect(res.status).to.equal(200);
        expectTicketDto(res.body);
        expect(res.body.id).to.equal(TICKET_1_ID);
      });

      it('returns 404 for a suggestion with no ticket', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/suggestions/${NON_EXISTENT_TICKET_ID}/ticket`);
        expect(res.status).to.equal(404);
      });
    });

    // ── GET /organizations/:orgId/opportunities/:opportunityId/tickets ─────────

    describe('GET /organizations/:orgId/opportunities/:opportunityId/tickets', () => {
      before(() => resetData());

      it('admin: returns all tickets for an opportunity', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/opportunities/${OPPTY_1_ID}/tickets`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        const ids = res.body.map((t) => t.id);
        expect(ids).to.include(TICKET_1_ID);
        expect(ids).to.include(TICKET_2_ID);
      });

      it('admin: ORG_2 gets empty array for OPPTY_1 (cross-org filter)', async () => {
        // OPPTY_1's tickets belong to ORG_1; querying via ORG_2 must return []
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_2_ID}/opportunities/${OPPTY_1_ID}/tickets`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('returns empty array when opportunity has no tickets', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/opportunities/${NON_EXISTENT_TICKET_ID}/tickets`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });
    });

    // ── POST /organizations/:orgId/task-management/:provider/tickets ──────────
    // Validation paths only — no live Jira call is made for these cases.

    describe('POST /organizations/:orgId/task-management/:provider/tickets (validation)', () => {
      before(() => resetData());

      it('returns 400 when summary is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          `/organizations/${ORG_1_ID}/task-management/jira_cloud/tickets`,
          { projectKey: 'PROJ', connectionId: CONN_1_ID },
        );
        expect(res.status).to.equal(400);
      });

      it('returns 400 when projectKey is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          `/organizations/${ORG_1_ID}/task-management/jira_cloud/tickets`,
          { summary: 'Fix issue', connectionId: CONN_1_ID },
        );
        expect(res.status).to.equal(400);
      });

      it('returns 400 when connectionId is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          `/organizations/${ORG_1_ID}/task-management/jira_cloud/tickets`,
          { summary: 'Fix issue', projectKey: 'PROJ' },
        );
        expect(res.status).to.equal(400);
      });

      it('returns 400 for unsupported provider', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          `/organizations/${ORG_1_ID}/task-management/unknown_provider/tickets`,
          { summary: 'Fix issue', projectKey: 'PROJ', connectionId: CONN_1_ID },
        );
        expect(res.status).to.equal(400);
      });

      it('returns 404 when connection does not exist', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          `/organizations/${ORG_1_ID}/task-management/jira_cloud/tickets`,
          { summary: 'Fix issue', projectKey: 'PROJ', connectionId: NON_EXISTENT_CONN_ID },
        );
        expect(res.status).to.equal(404);
      });

      it('returns 403 when user does not have access to org', async () => {
        const http = getHttpClient();
        const res = await http.user.post(
          `/organizations/${ORG_2_ID}/task-management/jira_cloud/tickets`,
          { summary: 'Fix issue', projectKey: 'PROJ', connectionId: CONN_2_ID },
        );
        expect(res.status).to.equal(403);
      });

      it('returns 400 for invalid attachment mimeType', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          `/organizations/${ORG_1_ID}/task-management/jira_cloud/tickets`,
          {
            summary: 'Fix issue',
            projectKey: 'PROJ',
            connectionId: CONN_1_ID,
            attachments: [{
              content: Buffer.from('x').toString('base64'),
              mimeType: 'application/javascript',
              filename: 'evil.js',
            }],
          },
        );
        expect(res.status).to.equal(400);
        expect(res.body.message).to.include('mimeType');
      });
    });

    // ── GET /organizations/:orgId/task-management/connections/:connId/projects ─
    // Validation + auth paths only — no live Jira call for these cases.

    describe('GET /connections/:connId/projects (validation)', () => {
      before(() => resetData());

      it('returns 400 for invalid connectionId', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections/not-a-uuid/projects`);
        expect(res.status).to.equal(400);
      });

      it('returns 404 for non-existent connection', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections/${NON_EXISTENT_CONN_ID}/projects`);
        expect(res.status).to.equal(404);
      });

      it('returns 404 when connection belongs to a different org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections/${CONN_2_ID}/projects`);
        expect(res.status).to.equal(404);
      });
    });

    // ── GET /organizations/:orgId/task-management/connections/:connId/issue-types
    // Validation paths only.

    describe('GET /connections/:connId/issue-types (validation)', () => {
      before(() => resetData());

      it('returns 400 when projectId is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections/${CONN_1_ID}/issue-types`);
        expect(res.status).to.equal(400);
      });

      it('returns 400 when projectId is not numeric', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections/${CONN_1_ID}/issue-types?projectId=PROJ`);
        expect(res.status).to.equal(400);
      });

      it('returns 404 for non-existent connection', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/task-management/connections/${NON_EXISTENT_CONN_ID}/issue-types?projectId=10001`);
        expect(res.status).to.equal(404);
      });
    });
  });
}
