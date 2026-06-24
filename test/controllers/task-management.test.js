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

/* eslint-disable max-classes-per-file, max-len */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

const ORG_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CONN_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const TICKET_ID = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa';
const SUGGESTION_ID = 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb';
const OPPORTUNITY_ID = 'eeeeeeee-ffff-aaaa-bbbb-cccccccccccc';
const PROVIDER = 'jira_cloud';

// Minimal fake connection
function makeConnection(overrides = {}) {
  return {
    getId: () => CONN_ID,
    getOrganizationId: () => ORG_ID,
    getProvider: () => PROVIDER,
    getStatus: () => 'active',
    getDisplayName: () => 'My Jira Site',
    getInstanceUrl: () => 'https://mysiteurl.atlassian.net',
    getConnectedBy: () => 'ims-user-1',
    getMetadata: () => ({ cloudId: '11111111-2222-3333-4444-555555555555' }),
    getCreatedAt: () => '2025-01-01T00:00:00Z',
    getUpdatedAt: () => '2025-01-01T00:00:00Z',
    markDisconnected: sinon.stub().resolves(),
    markRequiresReauth: sinon.stub().resolves(),
    ...overrides,
  };
}

function makeTicket(overrides = {}) {
  return {
    getId: () => TICKET_ID,
    getOrganizationId: () => ORG_ID,
    getTaskManagementConnectionId: () => CONN_ID,
    getConnectionId: () => undefined,
    getTicketId: () => 'PROJ-42',
    getTicketKey: () => 'PROJ-42',
    getTicketUrl: () => 'https://mysite.atlassian.net/browse/PROJ-42',
    getTicketStatus: () => 'open',
    getTicketProvider: () => PROVIDER,
    getOpportunityId: () => OPPORTUNITY_ID,
    getCreatedBy: () => 'ims-user-1',
    getCreatedAt: () => '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeBridge(overrides = {}) {
  return {
    getTicketId: () => TICKET_ID,
    getSuggestionId: () => SUGGESTION_ID,
    getOpportunityId: () => OPPORTUNITY_ID,
    ...overrides,
  };
}

function makeSuggestion(overrides = {}) {
  return {
    getId: () => SUGGESTION_ID,
    getOpportunityId: () => OPPORTUNITY_ID,
    ...overrides,
  };
}

function makePostgrestClient({
  lookupData = [],
  lookupError = null,
  insertData = { id: 'idem-key-id-111111' },
  insertError = null,
} = {}) {
  const limitStub = sinon.stub().resolves({ data: lookupData, error: lookupError });
  const eq2Stub = sinon.stub().returns({ limit: limitStub });
  const eq1Stub = sinon.stub().returns({ eq: eq2Stub });
  const selectStub = sinon.stub().returns({ eq: eq1Stub });

  const singleStub = sinon.stub().resolves({ data: insertData, error: insertError });
  const insertSelectStub = sinon.stub().returns({ single: singleStub });
  const insertStub = sinon.stub().returns({ select: insertSelectStub });

  const updateEqStub = sinon.stub().returns(Promise.resolve({ data: null, error: null }));
  const updateStub = sinon.stub().returns({ eq: updateEqStub });

  return {
    from: sinon.stub().returns({
      select: selectStub,
      insert: insertStub,
      update: updateStub,
    }),
  };
}

function makeDataAccess(overrides = {}) {
  return {
    TaskManagementConnection: {
      allByOrganizationId: sinon.stub().resolves([]),
      findById: sinon.stub().resolves(null),
      findActiveByOrganizationAndProvider: sinon.stub().resolves(null),
      ...overrides.TaskManagementConnection,
    },
    Ticket: {
      allByOrganizationId: sinon.stub().resolves([]),
      findById: sinon.stub().resolves(null),
      findByOpportunityId: sinon.stub().resolves(null),
      create: sinon.stub().resolves(makeTicket()),
      ...overrides.Ticket,
    },
    TicketSuggestion: {
      allByTicketId: sinon.stub().resolves([]),
      findBySuggestionId: sinon.stub().resolves(null),
      create: sinon.stub().resolves(),
      ...overrides.TicketSuggestion,
    },
    Suggestion: {
      findById: sinon.stub().resolves(null),
      ...overrides.Suggestion,
    },
    services: {
      postgrestClient: makePostgrestClient(),
      ...(overrides.services ?? {}),
    },
  };
}

function makeContext(overrides = {}) {
  // Extract dataAccess separately so ...rest doesn't overwrite the fully-constructed dataAccess.
  const { dataAccess: dataOverrides, ...rest } = overrides;
  return {
    dataAccess: makeDataAccess(dataOverrides ?? {}),
    log: {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    },
    ...rest,
  };
}

describe('TaskManagementController', () => {
  let TaskManagementController;
  let mockSmSend;

  beforeEach(async () => {
    mockSmSend = sinon.stub().resolves({});

    // @adobe/spacecat-shared-ticket-client is not yet published (unmerged PR #1701);
    // use isModuleNotFoundError:false so esmock provides the mock without needing the real package.
    TaskManagementController = (await esmock('../../src/controllers/task-management.js', {
      '@aws-sdk/client-secrets-manager': {
        SecretsManagerClient: class {
          // eslint-disable-next-line class-methods-use-this
          send(...args) { return mockSmSend(...args); }
        },
        DeleteSecretCommand: class {
          constructor(input) { this.input = input; }
        },
      },
      '@adobe/spacecat-shared-ticket-client': {
        TicketClientFactory: {
          create: sinon.stub().returns({
            createTicket: sinon.stub().resolves({
              ticketId: 'PROJ-42',
              ticketKey: 'PROJ-42',
              ticketUrl: 'https://mysite.atlassian.net/browse/PROJ-42',
              ticketStatus: 'To Do',
            }),
            uploadAttachment: sinon.stub().resolves(),
          }),
        },
      },
    }, {}, { isModuleNotFoundError: false })).default;
  });

  afterEach(() => {
    sinon.restore();
  });

  // ─── constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('throws when context missing', () => {
      expect(() => TaskManagementController(null)).to.throw('Context required');
    });

    it('throws when dataAccess missing', () => {
      expect(() => TaskManagementController({ log: { info: sinon.stub() } }))
        .to.throw('Data access required');
    });

    it('throws when TaskManagementConnection missing', () => {
      const ctx = makeContext();
      delete ctx.dataAccess.TaskManagementConnection;
      expect(() => TaskManagementController(ctx))
        .to.throw('TaskManagementConnection collection not available');
    });

    it('throws when Ticket missing', () => {
      const ctx = makeContext();
      delete ctx.dataAccess.Ticket;
      expect(() => TaskManagementController(ctx))
        .to.throw('Ticket collection not available');
    });

    it('throws when TicketSuggestion missing', () => {
      const ctx = makeContext();
      delete ctx.dataAccess.TicketSuggestion;
      expect(() => TaskManagementController(ctx))
        .to.throw('TicketSuggestion collection not available');
    });

    it('throws when Suggestion missing', () => {
      const ctx = makeContext();
      delete ctx.dataAccess.Suggestion;
      expect(() => TaskManagementController(ctx))
        .to.throw('Suggestion collection not available');
    });

    it('returns controller with all methods', () => {
      const ctrl = TaskManagementController(makeContext());
      expect(ctrl).to.have.all.keys(
        'listConnections',
        'getConnection',
        'deleteConnection',
        'listTickets',
        'getTicketBySuggestion',
        'listTicketsByOpportunity',
        'createTicket',
        'listProjects',
      );
    });
  });

  // ─── listConnections ────────────────────────────────────────────────────────

  describe('listConnections', () => {
    it('returns 400 for invalid organizationId', async () => {
      const { listConnections } = TaskManagementController(makeContext());
      const res = await listConnections({ params: { organizationId: 'bad-uuid' }, queryStringParameters: {} });
      expect(res.status).to.equal(400);
    });

    it('returns 500 on collection error', async () => {
      const ctx = makeContext();
      ctx.dataAccess.TaskManagementConnection.allByOrganizationId.rejects(new Error('db error'));
      const { listConnections } = TaskManagementController(ctx);
      const res = await listConnections({ params: { organizationId: ORG_ID }, queryStringParameters: {} });
      expect(res.status).to.equal(500);
    });

    it('returns empty array when no connections', async () => {
      const { listConnections } = TaskManagementController(makeContext());
      const res = await listConnections({ params: { organizationId: ORG_ID }, queryStringParameters: {} });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal([]);
    });

    it('returns serialized connections', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { allByOrganizationId: sinon.stub().resolves([conn]) } },
      });
      const { listConnections } = TaskManagementController(ctx);
      const res = await listConnections({ params: { organizationId: ORG_ID }, queryStringParameters: {} });
      expect(res.status).to.equal(200);
      const [first] = await res.json();
      expect(first.id).to.equal(CONN_ID);
      expect(first.displayName).to.equal('My Jira Site');
      expect(first.instanceUrl).to.equal('https://mysiteurl.atlassian.net');
      expect(first.connectedBy).to.equal('ims-user-1');
    });

    it('filters by provider query param', async () => {
      const conn1 = makeConnection({ getProvider: () => 'jira_cloud' });
      const conn2 = makeConnection({ getId: () => 'other-id', getProvider: () => 'github' });
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { allByOrganizationId: sinon.stub().resolves([conn1, conn2]) },
        },
      });
      const { listConnections } = TaskManagementController(ctx);
      const res = await listConnections({ params: { organizationId: ORG_ID }, queryStringParameters: { provider: 'jira_cloud' } });
      const body = await res.json();
      expect(body).to.have.length(1);
      expect(body[0].id).to.equal(CONN_ID);
    });
  });

  // ─── getConnection ──────────────────────────────────────────────────────────

  describe('getConnection', () => {
    it('returns 400 for invalid organizationId', async () => {
      const { getConnection } = TaskManagementController(makeContext());
      const res = await getConnection({ params: { organizationId: 'bad', connectionId: CONN_ID } });
      expect(res.status).to.equal(400);
    });

    it('returns 400 for invalid connectionId', async () => {
      const { getConnection } = TaskManagementController(makeContext());
      const res = await getConnection({ params: { organizationId: ORG_ID, connectionId: 'bad' } });
      expect(res.status).to.equal(400);
    });

    it('returns 404 when not found', async () => {
      const { getConnection } = TaskManagementController(makeContext());
      const res = await getConnection({ params: { organizationId: ORG_ID, connectionId: CONN_ID } });
      expect(res.status).to.equal(404);
    });

    it('returns 404 on org mismatch', async () => {
      const conn = makeConnection({ getOrganizationId: () => 'different-org-id-12345-aabb' });
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { getConnection } = TaskManagementController(ctx);
      const res = await getConnection({ params: { organizationId: ORG_ID, connectionId: CONN_ID } });
      expect(res.status).to.equal(404);
    });

    it('returns 500 on collection error', async () => {
      const ctx = makeContext();
      ctx.dataAccess.TaskManagementConnection.findById.rejects(new Error('db error'));
      const { getConnection } = TaskManagementController(ctx);
      const res = await getConnection({ params: { organizationId: ORG_ID, connectionId: CONN_ID } });
      expect(res.status).to.equal(500);
    });

    it('returns serialized connection', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { getConnection } = TaskManagementController(ctx);
      const res = await getConnection({ params: { organizationId: ORG_ID, connectionId: CONN_ID } });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.id).to.equal(CONN_ID);
      expect(body.instanceUrl).to.equal('https://mysiteurl.atlassian.net');
    });
  });

  // ─── deleteConnection ────────────────────────────────────────────────────────

  describe('deleteConnection', () => {
    it('returns 400 for invalid organizationId', async () => {
      const { deleteConnection } = TaskManagementController(makeContext());
      const res = await deleteConnection({ params: { organizationId: 'bad', connectionId: CONN_ID } });
      expect(res.status).to.equal(400);
    });

    it('returns 400 for invalid connectionId', async () => {
      const { deleteConnection } = TaskManagementController(makeContext());
      const res = await deleteConnection({ params: { organizationId: ORG_ID, connectionId: 'bad' } });
      expect(res.status).to.equal(400);
    });

    it('returns 404 when not found', async () => {
      const { deleteConnection } = TaskManagementController(makeContext());
      const res = await deleteConnection({ params: { organizationId: ORG_ID, connectionId: CONN_ID } });
      expect(res.status).to.equal(404);
    });

    it('returns 500 when SM delete fails (non-ResourceNotFoundException)', async () => {
      const err = Object.assign(new Error('access denied'), { name: 'AccessDeniedException' });
      mockSmSend.rejects(err);
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { deleteConnection } = TaskManagementController(ctx);
      const res = await deleteConnection({ params: { organizationId: ORG_ID, connectionId: CONN_ID } });
      expect(res.status).to.equal(500);
    });

    it('proceeds when SM secret already absent (ResourceNotFoundException)', async () => {
      const err = Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
      mockSmSend.rejects(err);
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { deleteConnection } = TaskManagementController(ctx);
      const res = await deleteConnection({ params: { organizationId: ORG_ID, connectionId: CONN_ID } });
      expect(res.status).to.equal(204);
      expect(conn.markDisconnected).to.have.been.calledOnce;
    });

    it('returns 500 when DB soft-delete fails after SM delete', async () => {
      const conn = makeConnection({ markDisconnected: sinon.stub().rejects(new Error('db error')) });
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { deleteConnection } = TaskManagementController(ctx);
      const res = await deleteConnection({ params: { organizationId: ORG_ID, connectionId: CONN_ID } });
      expect(res.status).to.equal(500);
    });

    it('deletes secret and DB record, returns 204', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { deleteConnection } = TaskManagementController(ctx);
      const res = await deleteConnection({ params: { organizationId: ORG_ID, connectionId: CONN_ID } });
      expect(res.status).to.equal(204);
      expect(mockSmSend).to.have.been.calledOnce;
      expect(conn.markDisconnected).to.have.been.calledOnce;
    });

    it('secret path uses no env segment', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { deleteConnection } = TaskManagementController(ctx);
      await deleteConnection({ params: { organizationId: ORG_ID, connectionId: CONN_ID } });
      const [cmd] = mockSmSend.firstCall.args;
      expect(cmd.input.SecretId).to.equal(`/mysticat/task-management/${ORG_ID}/${CONN_ID}`);
    });
  });

  // ─── listTickets ─────────────────────────────────────────────────────────────

  describe('listTickets', () => {
    it('returns 400 for invalid organizationId', async () => {
      const { listTickets } = TaskManagementController(makeContext());
      const res = await listTickets({ params: { organizationId: 'bad' } });
      expect(res.status).to.equal(400);
    });

    it('returns 500 on collection error', async () => {
      const ctx = makeContext();
      ctx.dataAccess.Ticket.allByOrganizationId.rejects(new Error('db error'));
      const { listTickets } = TaskManagementController(ctx);
      const res = await listTickets({ params: { organizationId: ORG_ID } });
      expect(res.status).to.equal(500);
    });

    it('returns empty array when no tickets', async () => {
      const { listTickets } = TaskManagementController(makeContext());
      const res = await listTickets({ params: { organizationId: ORG_ID } });
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal([]);
    });

    it('returns tickets with suggestions bridge', async () => {
      const ticket = makeTicket();
      const bridge = makeBridge();
      const ctx = makeContext({
        dataAccess: {
          Ticket: { allByOrganizationId: sinon.stub().resolves([ticket]) },
          TicketSuggestion: { allByTicketId: sinon.stub().resolves([bridge]) },
        },
      });
      const { listTickets } = TaskManagementController(ctx);
      const res = await listTickets({ params: { organizationId: ORG_ID } });
      expect(res.status).to.equal(200);
      const [t] = await res.json();
      expect(t.id).to.equal(TICKET_ID);
      expect(t.suggestions).to.deep.equal([{ suggestionId: SUGGESTION_ID, opportunityId: OPPORTUNITY_ID }]);
    });

    it('returns tickets with empty suggestions when bridge load fails', async () => {
      const ticket = makeTicket();
      const ctx = makeContext({
        dataAccess: {
          Ticket: { allByOrganizationId: sinon.stub().resolves([ticket]) },
          TicketSuggestion: { allByTicketId: sinon.stub().rejects(new Error('bridge error')) },
        },
      });
      const { listTickets } = TaskManagementController(ctx);
      const res = await listTickets({ params: { organizationId: ORG_ID } });
      expect(res.status).to.equal(200);
      const [t] = await res.json();
      expect(t.suggestions).to.deep.equal([]);
    });
  });

  // ─── getTicketBySuggestion ───────────────────────────────────────────────────

  describe('getTicketBySuggestion', () => {
    it('returns 400 for invalid organizationId', async () => {
      const { getTicketBySuggestion } = TaskManagementController(makeContext());
      const res = await getTicketBySuggestion({ params: { organizationId: 'bad', suggestionId: SUGGESTION_ID } });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when suggestionId is empty', async () => {
      const { getTicketBySuggestion } = TaskManagementController(makeContext());
      const res = await getTicketBySuggestion({ params: { organizationId: ORG_ID, suggestionId: '' } });
      expect(res.status).to.equal(400);
    });

    it('returns 404 when bridge not found', async () => {
      const { getTicketBySuggestion } = TaskManagementController(makeContext());
      const res = await getTicketBySuggestion({ params: { organizationId: ORG_ID, suggestionId: SUGGESTION_ID } });
      expect(res.status).to.equal(404);
    });

    it('returns 500 on bridge lookup error', async () => {
      const ctx = makeContext();
      ctx.dataAccess.TicketSuggestion.findBySuggestionId.rejects(new Error('db error'));
      const { getTicketBySuggestion } = TaskManagementController(ctx);
      const res = await getTicketBySuggestion({ params: { organizationId: ORG_ID, suggestionId: SUGGESTION_ID } });
      expect(res.status).to.equal(500);
    });

    it('returns 500 on ticket load error', async () => {
      const bridge = makeBridge();
      const ctx = makeContext({
        dataAccess: {
          TicketSuggestion: { findBySuggestionId: sinon.stub().resolves(bridge) },
          Ticket: { findById: sinon.stub().rejects(new Error('db error')) },
        },
      });
      const { getTicketBySuggestion } = TaskManagementController(ctx);
      const res = await getTicketBySuggestion({ params: { organizationId: ORG_ID, suggestionId: SUGGESTION_ID } });
      expect(res.status).to.equal(500);
    });

    it('returns 404 on org mismatch', async () => {
      const bridge = makeBridge();
      const ticket = makeTicket({ getOrganizationId: () => 'other-org-id-1234-aaaa-bbbbbbbbbbbb' });
      const ctx = makeContext({
        dataAccess: {
          TicketSuggestion: { findBySuggestionId: sinon.stub().resolves(bridge) },
          Ticket: { findById: sinon.stub().resolves(ticket) },
        },
      });
      const { getTicketBySuggestion } = TaskManagementController(ctx);
      const res = await getTicketBySuggestion({ params: { organizationId: ORG_ID, suggestionId: SUGGESTION_ID } });
      expect(res.status).to.equal(404);
    });

    it('returns ticket with suggestion info', async () => {
      const bridge = makeBridge();
      const ticket = makeTicket();
      const ctx = makeContext({
        dataAccess: {
          TicketSuggestion: { findBySuggestionId: sinon.stub().resolves(bridge) },
          Ticket: { findById: sinon.stub().resolves(ticket) },
        },
      });
      const { getTicketBySuggestion } = TaskManagementController(ctx);
      const res = await getTicketBySuggestion({ params: { organizationId: ORG_ID, suggestionId: SUGGESTION_ID } });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.id).to.equal(TICKET_ID);
      expect(body.suggestionId).to.equal(SUGGESTION_ID);
      expect(body.opportunityId).to.equal(OPPORTUNITY_ID);
    });
  });

  // ─── listTicketsByOpportunity ────────────────────────────────────────────────

  describe('listTicketsByOpportunity', () => {
    it('returns 400 for invalid organizationId', async () => {
      const { listTicketsByOpportunity } = TaskManagementController(makeContext());
      const res = await listTicketsByOpportunity({ params: { organizationId: 'bad', opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when opportunityId is empty', async () => {
      const { listTicketsByOpportunity } = TaskManagementController(makeContext());
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: '' } });
      expect(res.status).to.equal(400);
    });

    it('returns 500 on ticket lookup error', async () => {
      const ctx = makeContext();
      ctx.dataAccess.Ticket.findByOpportunityId.rejects(new Error('db error'));
      const { listTicketsByOpportunity } = TaskManagementController(ctx);
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(500);
    });

    it('returns empty array when no ticket found', async () => {
      const { listTicketsByOpportunity } = TaskManagementController(makeContext());
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal([]);
    });

    it('returns empty array on org mismatch', async () => {
      const ticket = makeTicket({ getOrganizationId: () => 'other-org-id-1234-aaaa-bbbbbbbbbbbb' });
      const ctx = makeContext({
        dataAccess: { Ticket: { findByOpportunityId: sinon.stub().resolves(ticket) } },
      });
      const { listTicketsByOpportunity } = TaskManagementController(ctx);
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal([]);
    });

    it('returns ticket with suggestions via Ticket.findByOpportunityId (not TicketSuggestion.allByOpportunityId)', async () => {
      const ticket = makeTicket();
      const bridge = makeBridge();
      const ctx = makeContext({
        dataAccess: {
          Ticket: { findByOpportunityId: sinon.stub().resolves(ticket) },
          TicketSuggestion: { allByTicketId: sinon.stub().resolves([bridge]) },
        },
      });
      const { listTicketsByOpportunity } = TaskManagementController(ctx);
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(200);
      const [t] = await res.json();
      expect(t.id).to.equal(TICKET_ID);
      expect(t.suggestions).to.deep.equal([{ suggestionId: SUGGESTION_ID, opportunityId: OPPORTUNITY_ID }]);
    });

    it('returns ticket with empty suggestions when bridge load fails', async () => {
      const ticket = makeTicket();
      const ctx = makeContext({
        dataAccess: {
          Ticket: { findByOpportunityId: sinon.stub().resolves(ticket) },
          TicketSuggestion: { allByTicketId: sinon.stub().rejects(new Error('bridge err')) },
        },
      });
      const { listTicketsByOpportunity } = TaskManagementController(ctx);
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(200);
      const [t] = await res.json();
      expect(t.suggestions).to.deep.equal([]);
    });
  });

  // ─── createTicket ─────────────────────────────────────────────────────────────

  describe('createTicket', () => {
    function makeReqCtx(overrides = {}) {
      // When overrides.data is provided it completely replaces the default body
      // so individual tests can omit fields (e.g. no summary) without the default leaking in.
      const data = overrides.data !== undefined
        ? overrides.data
        : { summary: 'Fix the thing', projectKey: 'PROJ' };
      return {
        params: { organizationId: ORG_ID, provider: PROVIDER, ...(overrides.params ?? {}) },
        data,
        pathInfo: { headers: { 'idempotency-key': 'test-idem-key-1' }, ...(overrides.pathInfo ?? {}) },
        attributes: {
          authInfo: {
            getProfile: () => ({ getImsUserId: () => 'ims-user-1' }),
          },
          ...(overrides.attributes ?? {}),
        },
      };
    }

    it('returns 400 for invalid organizationId', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({ params: { organizationId: 'bad', provider: PROVIDER } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when provider is empty', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({ params: { organizationId: ORG_ID, provider: '' } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when body has no summary', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({ data: { projectKey: 'PROJ' } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when body has no projectKey', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({ data: { summary: 'Fix it' } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 for grouped mode', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({ data: { summary: 'Fix', projectKey: 'P', mode: 'grouped' } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 for unknown mode', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({ data: { summary: 'Fix', projectKey: 'P', mode: 'batch' } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when suggestionIds exceeds max', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const suggestionIds = Array.from({ length: 11 }, (_, i) => `id-${i}`);
      const res = await createTicket(makeReqCtx({ data: { summary: 'Fix', projectKey: 'P', suggestionIds } }));
      expect(res.status).to.equal(400);
    });

    it('returns 404 when no active connection found', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(404);
    });

    it('returns 500 on connection load error', async () => {
      const ctx = makeContext();
      ctx.dataAccess.TaskManagementConnection.findActiveByOrganizationAndProvider.rejects(new Error('db'));
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('returns 409 when Jira client throws 401', async () => {
      const conn = makeConnection();
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      const ticketClientStub = { createTicket: sinon.stub().rejects(err) };
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
        },
      });

      // Re-mock TicketClientFactory for this test
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns(ticketClientStub) },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(409);
      expect(conn.markRequiresReauth).to.have.been.calledOnce;
    });

    it('returns 409 when OAuthCredentialManager throws requires re-authorization', async () => {
      const conn = makeConnection();
      const err = new Error('OAuth token refresh failed — connection requires re-authorization');
      const ticketClientStub = { createTicket: sinon.stub().rejects(err) };
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns(ticketClientStub) },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(409);
      expect(conn.markRequiresReauth).to.have.been.calledOnce;
    });

    it('passes instanceUrl to TicketClientFactory (required for JiraCloudClient)', async () => {
      const conn = makeConnection();
      let capturedConnObj;
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: (connObj) => {
              capturedConnObj = connObj;
              return {
                createTicket: sinon.stub().resolves({
                  ticketId: 'PROJ-1', ticketKey: 'PROJ-1', ticketUrl: 'https://x.atlassian.net/browse/PROJ-1', ticketStatus: 'To Do',
                }),
              };
            },
          },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
        },
      });
      const { createTicket } = Ctrl(ctx);
      await createTicket(makeReqCtx());
      expect(capturedConnObj.instanceUrl).to.equal('https://mysiteurl.atlassian.net');
    });

    it('returns 500 on generic ticket client error', async () => {
      const conn = makeConnection();
      const err = new Error('timeout');
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns({ createTicket: sinon.stub().rejects(err) }) },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
        },
      });
      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('returns 500 when Ticket.create fails', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
          Ticket: {
            create: sinon.stub().rejects(new Error('db error')),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().resolves({
                ticketId: 'P-1', ticketKey: 'P-1', ticketUrl: 'https://x.net/P-1', ticketStatus: 'To Do',
              }),
            }),
          },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('creates ticket and bridge, returns 201', async () => {
      const conn = makeConnection();
      const ticket = makeTicket();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
          Ticket: {
            create: sinon.stub().resolves(ticket),
          },
          TicketSuggestion: {
            create: sinon.stub().resolves(),
          },
          Suggestion: {
            findById: sinon.stub().resolves(makeSuggestion()),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().resolves({
                ticketId: 'PROJ-42', ticketKey: 'PROJ-42', ticketUrl: 'https://x.net/PROJ-42', ticketStatus: 'To Do',
              }),
            }),
          },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix it', projectKey: 'PROJ', suggestionIds: [SUGGESTION_ID], opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body.id).to.equal(TICKET_ID);
      expect(body.suggestionId).to.equal(SUGGESTION_ID);
      expect(ctx.dataAccess.TicketSuggestion.create).to.have.been.calledOnce;
    });

    it('returns 500 when TicketSuggestion.create fails with non-unique error', async () => {
      const conn = makeConnection();
      const ticket = makeTicket();
      const err = new Error('foreign key constraint violation');
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
          Ticket: { create: sinon.stub().resolves(ticket) },
          TicketSuggestion: { create: sinon.stub().rejects(err) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().resolves({
                ticketId: 'P-1', ticketKey: 'P-1', ticketUrl: 'https://x.net/P-1', ticketStatus: 'To Do',
              }),
            }),
          },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: { summary: 'Fix', projectKey: 'P', suggestionIds: [SUGGESTION_ID] },
      }));
      expect(res.status).to.equal(500);
    });

    it('returns 409 on duplicate TicketSuggestion (unique constraint)', async () => {
      const conn = makeConnection();
      const ticket = makeTicket();
      const err = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
          Ticket: { create: sinon.stub().resolves(ticket) },
          TicketSuggestion: { create: sinon.stub().rejects(err) },
          Suggestion: {
            findById: sinon.stub().resolves(makeSuggestion()),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().resolves({
                ticketId: 'P-1', ticketKey: 'P-1', ticketUrl: 'https://x.net/P-1', ticketStatus: 'To Do',
              }),
            }),
          },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: { summary: 'Fix', projectKey: 'P', suggestionIds: [SUGGESTION_ID] },
      }));
      expect(res.status).to.equal(409);
    });

    it('returns 201 without bridge when no suggestionIds provided', async () => {
      const conn = makeConnection();
      const ticket = makeTicket();
      const bridgeCreate = sinon.stub().resolves();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
          Ticket: { create: sinon.stub().resolves(ticket) },
          TicketSuggestion: { create: bridgeCreate },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().resolves({
                ticketId: 'P-1', ticketKey: 'P-1', ticketUrl: 'https://x.net/P-1', ticketStatus: 'To Do',
              }),
            }),
          },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(201);
      expect(bridgeCreate).to.not.have.been.called;
    });

    // ── Idempotency-Key enforcement ─────────────────────────────────────────

    it('returns 400 when Idempotency-Key header is missing', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({ pathInfo: { headers: {} } }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('Idempotency-Key');
    });

    it('returns 500 when postgrestClient unavailable', async () => {
      const ctx = makeContext({ dataAccess: { services: { postgrestClient: null } } });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('returns 500 when idempotency key lookup fails', async () => {
      const ctx = makeContext({
        dataAccess: {
          services: {
            postgrestClient: makePostgrestClient({
              lookupError: new Error('db unavailable'),
              lookupData: null,
            }),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('returns cached response when idempotency key is completed', async () => {
      const cachedBody = { id: TICKET_ID, ticketKey: 'PROJ-1' };
      const ctx = makeContext({
        dataAccess: {
          services: {
            postgrestClient: makePostgrestClient({
              lookupData: [{ id: 'idem-1', status: 'completed', response: { statusCode: 201, body: cachedBody } }],
            }),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body.id).to.equal(TICKET_ID);
    });

    it('returns 409 when idempotency key is processing', async () => {
      const ctx = makeContext({
        dataAccess: {
          services: {
            postgrestClient: makePostgrestClient({
              lookupData: [{ id: 'idem-1', status: 'processing', response: null }],
            }),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.message).to.include('already in flight');
    });

    it('returns cached error response when idempotency key is failed', async () => {
      const cachedBody = { message: 'Failed to create ticket' };
      const ctx = makeContext({
        dataAccess: {
          services: {
            postgrestClient: makePostgrestClient({
              lookupData: [{ id: 'idem-1', status: 'failed', response: { statusCode: 500, body: cachedBody } }],
            }),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('returns 500 when idempotency key insert fails', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
          services: {
            postgrestClient: makePostgrestClient({
              insertError: new Error('unique constraint'),
            }),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    // ── Suggestion existence validation ────────────────────────────────────

    it('returns 404 when primarySuggestionId is not found', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
          Suggestion: {
            findById: sinon.stub().resolves(null),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: { summary: 'Fix it', projectKey: 'PROJ', suggestionIds: [SUGGESTION_ID] },
      }));
      expect(res.status).to.equal(404);
      const body = await res.json();
      expect(body.message).to.include('not found');
    });

    it('returns 500 on Suggestion lookup error', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
          Suggestion: {
            findById: sinon.stub().rejects(new Error('db error')),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: { summary: 'Fix it', projectKey: 'PROJ', suggestionIds: [SUGGESTION_ID] },
      }));
      expect(res.status).to.equal(500);
    });

    // ── Attachment validation (spec §30) ───────────────────────────────────────

    it('returns 400 when attachment is missing content', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: { summary: 'Fix', projectKey: 'PROJ', attachment: { mimeType: 'image/png', filename: 'a.png' } },
      }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('attachment must have');
    });

    it('returns 400 when attachment is missing mimeType', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: { summary: 'Fix', projectKey: 'PROJ', attachment: { content: Buffer.from('x').toString('base64'), filename: 'a.png' } },
      }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when attachment is missing filename', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: { summary: 'Fix', projectKey: 'PROJ', attachment: { content: Buffer.from('x').toString('base64'), mimeType: 'image/png' } },
      }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when attachment content is empty after decoding', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      // base64 of empty string decodes to zero bytes
      const res = await createTicket(makeReqCtx({
        data: { summary: 'Fix', projectKey: 'PROJ', attachment: { content: '', mimeType: 'image/png', filename: 'a.png' } },
      }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when attachment exceeds 3 MB', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const oversized = Buffer.alloc(3 * 1024 * 1024 + 1, 0x00);
      const res = await createTicket(makeReqCtx({
        data: { summary: 'Fix', projectKey: 'PROJ', attachment: { content: oversized.toString('base64'), mimeType: 'image/png', filename: 'big.png' } },
      }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('exceeds maximum size');
    });

    it('creates ticket with attachment and returns 201', async () => {
      const conn = makeConnection();
      const ticket = makeTicket();
      const uploadStub = sinon.stub().resolves();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
          Ticket: { create: sinon.stub().resolves(ticket) },
          TicketSuggestion: { create: sinon.stub().resolves() },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().resolves({
                ticketId: 'PROJ-42', ticketKey: 'PROJ-42', ticketUrl: 'https://x.net/PROJ-42', ticketStatus: 'To Do',
              }),
              uploadAttachment: uploadStub,
            }),
          },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix it',
          projectKey: 'PROJ',
          suggestionIds: [SUGGESTION_ID],
          attachment: { content: validPng.toString('base64'), mimeType: 'image/png', filename: 'screenshot.png' },
        },
      }));

      expect(res.status).to.equal(201);
      expect(uploadStub).to.have.been.calledOnce;
      const body = await res.json();
      expect(body).to.not.have.property('attachmentWarning');
    });

    it('returns 201 with attachmentWarning when upload fails (partial success)', async () => {
      const conn = makeConnection();
      const ticket = makeTicket();
      const uploadStub = sinon.stub().rejects(new Error('Jira returned 403'));
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
          Ticket: { create: sinon.stub().resolves(ticket) },
          TicketSuggestion: { create: sinon.stub().resolves() },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().resolves({
                ticketId: 'PROJ-42', ticketKey: 'PROJ-42', ticketUrl: 'https://x.net/PROJ-42', ticketStatus: 'To Do',
              }),
              uploadAttachment: uploadStub,
            }),
          },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix it',
          projectKey: 'PROJ',
          suggestionIds: [SUGGESTION_ID],
          attachment: { content: validPng.toString('base64'), mimeType: 'image/png', filename: 'screenshot.png' },
        },
      }));

      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body).to.have.property('attachmentWarning');
      expect(body.attachmentWarning).to.include('attachment upload failed');
    });
  });

  // ─── listProjects ────────────────────────────────────────────────────────────

  describe('listProjects', () => {
    function makeReqCtx(overrides = {}) {
      return {
        params: { organizationId: ORG_ID, provider: PROVIDER, ...(overrides.params ?? {}) },
      };
    }

    it('returns 400 for invalid organizationId', async () => {
      const { listProjects } = TaskManagementController(makeContext());
      const res = await listProjects(makeReqCtx({ params: { organizationId: 'bad', provider: PROVIDER } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when provider is empty', async () => {
      const { listProjects } = TaskManagementController(makeContext());
      const res = await listProjects(makeReqCtx({ params: { organizationId: ORG_ID, provider: '' } }));
      expect(res.status).to.equal(400);
    });

    it('returns 404 when no active connection found', async () => {
      const { listProjects } = TaskManagementController(makeContext());
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(404);
    });

    it('returns 500 on connection load error', async () => {
      const ctx = makeContext();
      ctx.dataAccess.TaskManagementConnection.findActiveByOrganizationAndProvider
        .rejects(new Error('db'));
      const { listProjects } = TaskManagementController(ctx);
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('returns 200 with project list', async () => {
      const conn = makeConnection();
      const projects = [{ key: 'PROJ', name: 'My Project' }];
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              listProjects: sinon.stub().resolves(projects),
            }),
          },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const { listProjects } = Ctrl(ctx);
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.projects).to.deep.equal(projects);
    });

    it('returns 409 and marks reauth when Jira client returns 401', async () => {
      const conn = makeConnection();
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ listProjects: sinon.stub().rejects(err) }),
          },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const { listProjects } = Ctrl(ctx);
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(409);
      expect(conn.markRequiresReauth).to.have.been.calledOnce;
    });

    it('returns 500 on generic list projects error', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findActiveByOrganizationAndProvider: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
          DeleteSecretCommand: class { constructor(i) { this.input = i; } },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ listProjects: sinon.stub().rejects(new Error('timeout')) }),
          },
        },
      }, {}, { isModuleNotFoundError: false })).default;

      const { listProjects } = Ctrl(ctx);
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(500);
    });
  });
});
