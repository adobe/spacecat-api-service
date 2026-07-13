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
    setLastUsedAt: sinon.stub().returnsThis(),
    setErrorMessage: sinon.stub().returnsThis(),
    save: sinon.stub().resolves(),
    ...overrides,
  };
}

function makeTicket(overrides = {}) {
  return {
    getId: () => TICKET_ID,
    getOrganizationId: () => ORG_ID,
    getTaskManagementConnectionId: () => CONN_ID,
    getConnectionId: () => undefined,
    getExternalTicketId: () => 'PROJ-42',
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

function makeOrg(overrides = {}) {
  return {
    getId: () => ORG_ID,
    getImsOrgId: () => 'test-ims-org-id',
    ...overrides,
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
      allByOpportunityId: sinon.stub().resolves([]),
      findById: sinon.stub().resolves(null),
      findByOpportunityId: sinon.stub().resolves(null),
      create: sinon.stub().resolves(makeTicket()),
      ...overrides.Ticket,
    },
    TicketSuggestion: {
      allByTicketId: sinon.stub().resolves([]),
      allByTicketIds: sinon.stub().resolves([]),
      allBySuggestionIds: sinon.stub().resolves([]),
      findBySuggestionId: sinon.stub().resolves(null),
      create: sinon.stub().resolves(),
      ...overrides.TicketSuggestion,
    },
    Suggestion: {
      findById: sinon.stub().resolves(null),
      batchGetByKeys: sinon.stub().callsFake((keys) => Promise.resolve({
        data: keys.map((k) => makeSuggestion({ getId: () => k.suggestionId })),
        unprocessed: [],
      })),
      ...overrides.Suggestion,
    },
    Organization: {
      findById: sinon.stub().resolves(makeOrg()),
      ...overrides.Organization,
    },
    IdempotencyKey: {
      findActiveKey: sinon.stub().resolves(null),
      create: sinon.stub().resolves({
        setStatus: sinon.stub().returnsThis(),
        setResponse: sinon.stub().returnsThis(),
        save: sinon.stub().resolves(),
        remove: sinon.stub().resolves(),
      }),
      ...overrides.IdempotencyKey,
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
    // AccessControlUtil.fromContext() requires pathInfo.headers and attributes.authInfo.
    // Default to an admin identity so hasAccess() returns true without any DB lookups.
    pathInfo: { method: 'GET', suffix: '/', headers: {} },
    attributes: { authInfo: { isAdmin: () => true, getType: () => 'api_key' } },
    ...rest,
  };
}

describe('TaskManagementController', () => {
  let TaskManagementController;

  beforeEach(async () => {
    TaskManagementController = (await esmock('../../src/controllers/task-management.js', {
      '@aws-sdk/client-secrets-manager': {
        SecretsManagerClient: class {
          // eslint-disable-next-line class-methods-use-this
          send() { return Promise.resolve({}); }
        },
        GetSecretValueCommand: class {},
        PutSecretValueCommand: class {},
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
    })).default;
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

    it('throws when Organization missing', () => {
      const ctx = makeContext();
      delete ctx.dataAccess.Organization;
      expect(() => TaskManagementController(ctx))
        .to.throw('Organization collection not available');
    });

    it('throws when IdempotencyKey missing', () => {
      const ctx = makeContext();
      delete ctx.dataAccess.IdempotencyKey;
      expect(() => TaskManagementController(ctx))
        .to.throw('IdempotencyKey collection not available');
    });

    it('returns controller with all methods', () => {
      const ctrl = TaskManagementController(makeContext());
      expect(ctrl).to.have.all.keys(
        'listConnections',
        'getConnection',
        'listTickets',
        'getTicketBySuggestion',
        'listTicketsByOpportunity',
        'createTicket',
        'listProjects',
        'listIssueTypes',
      );
    });
  });

  // ─── listConnections ────────────────────────────────────────────────────────

  describe('listConnections', () => {
    it('returns 400 for invalid organizationId', async () => {
      const { listConnections } = TaskManagementController(makeContext());
      const res = await listConnections({ params: { organizationId: 'bad-uuid' }, request: { url: 'http://localhost/' } });
      expect(res.status).to.equal(400);
    });

    it('returns 404 when organization not found', async () => {
      const ctx = makeContext({ dataAccess: { Organization: { findById: sinon.stub().resolves(null) } } });
      const { listConnections } = TaskManagementController(ctx);
      const res = await listConnections({ params: { organizationId: ORG_ID }, request: { url: 'http://localhost/' } });
      expect(res.status).to.equal(404);
    });

    it('returns 403 when caller lacks access to organization', async () => {
      const ForbiddenCtrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': { TicketClientFactory: { create: sinon.stub() } },
        '../../src/support/access-control-util.js': {
          default: {
            fromContext: sinon.stub().returns({ hasAccess: sinon.stub().resolves(false) }),
          },
        },
      })).default;
      const { listConnections } = ForbiddenCtrl(makeContext());
      const res = await listConnections({ params: { organizationId: ORG_ID }, request: { url: 'http://localhost/' } });
      expect(res.status).to.equal(403);
    });

    it('returns 500 on collection error', async () => {
      const ctx = makeContext();
      ctx.dataAccess.TaskManagementConnection.allByOrganizationId.rejects(new Error('db error'));
      const { listConnections } = TaskManagementController(ctx);
      const res = await listConnections({ params: { organizationId: ORG_ID }, request: { url: 'http://localhost/' } });
      expect(res.status).to.equal(500);
    });

    it('returns empty array when no connections', async () => {
      const { listConnections } = TaskManagementController(makeContext());
      const res = await listConnections({ params: { organizationId: ORG_ID }, request: { url: 'http://localhost/' } });
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
      const res = await listConnections({ params: { organizationId: ORG_ID }, request: { url: 'http://localhost/' } });
      expect(res.status).to.equal(200);
      const [first] = await res.json();
      expect(first.id).to.equal(CONN_ID);
      expect(first.displayName).to.equal('My Jira Site');
      expect(first.instanceUrl).to.equal('https://mysiteurl.atlassian.net');
      expect(first.connectedBy).to.equal('ims-user-1');
    });

    // ── Branch 1: provider filter NOT applied when qs.provider is falsy ──────────
    it('returns all connections when provider query param is absent', async () => {
      const conn1 = makeConnection();
      const conn2 = makeConnection({ getProvider: () => 'servicenow' });
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            allByOrganizationId: sinon.stub().resolves([conn1, conn2]),
          },
        },
      });
      const { listConnections } = TaskManagementController(ctx);
      const res = await listConnections({
        params: { organizationId: ORG_ID },
        request: { url: 'http://localhost/' }, // no provider key — falsy path
      });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.have.lengthOf(2);
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
      const res = await listConnections({ params: { organizationId: ORG_ID }, request: { url: 'http://localhost/?provider=jira_cloud' } });
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

    it('returns 404 when organization not found', async () => {
      const ctx = makeContext({ dataAccess: { Organization: { findById: sinon.stub().resolves(null) } } });
      const { getConnection } = TaskManagementController(ctx);
      const res = await getConnection({ params: { organizationId: ORG_ID, connectionId: CONN_ID } });
      expect(res.status).to.equal(404);
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

  // ─── listTickets ─────────────────────────────────────────────────────────────

  describe('listTickets', () => {
    it('returns 400 for invalid organizationId', async () => {
      const { listTickets } = TaskManagementController(makeContext());
      const res = await listTickets({ params: { organizationId: 'bad' } });
      expect(res.status).to.equal(400);
    });

    it('returns 404 when organization not found', async () => {
      const ctx = makeContext({ dataAccess: { Organization: { findById: sinon.stub().resolves(null) } } });
      const { listTickets } = TaskManagementController(ctx);
      const res = await listTickets({ params: { organizationId: ORG_ID } });
      expect(res.status).to.equal(404);
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
      const bridge = {
        getTicketId: () => TICKET_ID,
        getSuggestionId: () => SUGGESTION_ID,
      };
      const ctx = makeContext({
        dataAccess: {
          Ticket: { allByOrganizationId: sinon.stub().resolves([ticket]) },
          TicketSuggestion: { allByTicketIds: sinon.stub().resolves([bridge]) },
        },
      });
      const { listTickets } = TaskManagementController(ctx);
      const res = await listTickets({ params: { organizationId: ORG_ID } });
      expect(res.status).to.equal(200);
      const [t] = await res.json();
      expect(t.id).to.equal(TICKET_ID);
      expect(t.suggestions).to.deep.equal([SUGGESTION_ID]);
    });

    it('returns tickets with empty suggestions when bridge load fails', async () => {
      const ticket = makeTicket();
      const ctx = makeContext({
        dataAccess: {
          Ticket: { allByOrganizationId: sinon.stub().resolves([ticket]) },
          TicketSuggestion: { allByTicketIds: sinon.stub().rejects(new Error('bridge error')) },
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

    it('returns 404 when organization not found', async () => {
      const ctx = makeContext({ dataAccess: { Organization: { findById: sinon.stub().resolves(null) } } });
      const { getTicketBySuggestion } = TaskManagementController(ctx);
      const res = await getTicketBySuggestion({ params: { organizationId: ORG_ID, suggestionId: SUGGESTION_ID } });
      expect(res.status).to.equal(404);
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

    it('returns 404 when organization not found', async () => {
      const ctx = makeContext({ dataAccess: { Organization: { findById: sinon.stub().resolves(null) } } });
      const { listTicketsByOpportunity } = TaskManagementController(ctx);
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(404);
    });

    it('returns 500 on ticket lookup error', async () => {
      const ctx = makeContext({
        dataAccess: { Ticket: { allByOpportunityId: sinon.stub().rejects(new Error('db error')) } },
      });
      const { listTicketsByOpportunity } = TaskManagementController(ctx);
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(500);
    });

    it('returns empty array when no tickets found', async () => {
      const { listTicketsByOpportunity } = TaskManagementController(makeContext());
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal([]);
    });

    it('returns all matching tickets with suggestions via TicketSuggestion model', async () => {
      const ticket = makeTicket();
      const bridgeRow = { getTicketId: () => TICKET_ID, getSuggestionId: () => SUGGESTION_ID };
      const ctx = makeContext({
        dataAccess: {
          Ticket: { allByOpportunityId: sinon.stub().resolves([ticket]) },
          TicketSuggestion: { allByTicketIds: sinon.stub().resolves([bridgeRow]) },
        },
      });
      const { listTicketsByOpportunity } = TaskManagementController(ctx);
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(200);
      const [t] = await res.json();
      expect(t.id).to.equal(TICKET_ID);
      expect(t.suggestions).to.deep.equal([SUGGESTION_ID]);
    });

    it('returns multiple tickets for same opportunity', async () => {
      const TICKET_ID_2 = 'dddddddd-eeee-ffff-0000-aaaaaaaaaaaa';
      const ticket1 = makeTicket();
      const ticket2 = makeTicket({ getId: () => TICKET_ID_2 });
      const ctx = makeContext({
        dataAccess: {
          Ticket: { allByOpportunityId: sinon.stub().resolves([ticket1, ticket2]) },
          TicketSuggestion: { allByTicketIds: sinon.stub().resolves([]) },
        },
      });
      const { listTicketsByOpportunity } = TaskManagementController(ctx);
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.have.length(2);
      expect(body.map((t) => t.id)).to.deep.equal([TICKET_ID, TICKET_ID_2]);
    });

    it('returns tickets with empty suggestions when bridge load fails', async () => {
      const ticket = makeTicket();
      const ctx = makeContext({
        dataAccess: {
          Ticket: { allByOpportunityId: sinon.stub().resolves([ticket]) },
          TicketSuggestion: { allByTicketIds: sinon.stub().rejects(new Error('bridge err')) },
        },
      });
      const { listTicketsByOpportunity } = TaskManagementController(ctx);
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(200);
      const [t] = await res.json();
      expect(t.suggestions).to.deep.equal([]);
    });

    it('filters out tickets belonging to a different organization', async () => {
      const matchingTicket = makeTicket();
      const otherOrgTicket = makeTicket({
        getId: () => 'ffffffff-0000-0000-0000-000000000000',
        getOrganizationId: () => 'bbbbbbbb-0000-0000-0000-000000000000',
      });
      const ctx = makeContext({
        dataAccess: {
          Ticket: { allByOpportunityId: sinon.stub().resolves([matchingTicket, otherOrgTicket]) },
          TicketSuggestion: { allByTicketIds: sinon.stub().resolves([]) },
        },
      });
      const { listTicketsByOpportunity } = TaskManagementController(ctx);
      const res = await listTicketsByOpportunity({ params: { organizationId: ORG_ID, opportunityId: OPPORTUNITY_ID } });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.have.length(1);
      expect(body[0].id).to.equal(TICKET_ID);
    });
  });

  // ─── createTicket ─────────────────────────────────────────────────────────────

  describe('createTicket', () => {
    function makeReqCtx(overrides = {}) {
      // When overrides.data is provided it completely replaces the default body
      // so individual tests can omit fields (e.g. no summary) without the default leaking in.
      const data = overrides.data !== undefined
        ? overrides.data
        : {
          summary: 'Fix the thing', projectKey: 'PROJ', connectionId: CONN_ID, opportunityId: OPPORTUNITY_ID,
        };
      return {
        params: { organizationId: ORG_ID, provider: PROVIDER, ...(overrides.params ?? {}) },
        data,
        pathInfo: { headers: {}, ...(overrides.pathInfo ?? {}) },
        attributes: {
          authInfo: {
            getProfile: () => ({ email: 'ims-user-1@example.com' }),
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

    it('returns 400 when provider is unsupported', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({ params: { organizationId: ORG_ID, provider: 'linear' } }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('Unsupported provider');
    });

    it('returns 404 when organization not found', async () => {
      const ctx = makeContext({ dataAccess: { Organization: { findById: sinon.stub().resolves(null) } } });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(404);
    });

    it('returns 400 when connectionId is missing', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({ data: { summary: 'Fix', projectKey: 'PROJ' } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when body has no summary', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({ data: { projectKey: 'PROJ', connectionId: CONN_ID } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when neither opportunityId nor suggestionIds is provided', async () => {
      const { createTicket } = TaskManagementController(makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(makeConnection()) } },
      }));
      const res = await createTicket(makeReqCtx({ data: { summary: 'Fix', projectKey: 'P', connectionId: CONN_ID } }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('opportunityId or suggestionIds');
    });

    it('returns 400 when body has no projectKey', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({ data: { summary: 'Fix it', connectionId: CONN_ID } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 for grouped mode with no suggestionIds', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'P', mode: 'grouped', connectionId: CONN_ID,
        },
      }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('requires at least one suggestionId');
    });

    it('returns 400 for unknown mode (message lists supported modes)', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'P', mode: 'batch', connectionId: CONN_ID,
        },
      }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('individual');
      expect(body.message).to.include('grouped');
    });

    it('returns 400 when attachment provided in individual batch mode (N>1 suggestions)', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const content = Buffer.from('hello').toString('base64');
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix',
          projectKey: 'P',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2],
          attachments: [{ content, mimeType: 'text/plain', filename: 'note.txt' }],
        },
      }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('individual batch mode');
    });

    it('returns 400 when suggestionIds exceeds max for individual mode (>15)', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const suggestionIds = Array.from({ length: 16 }, (_, i) => `id-${i}`);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'P', mode: 'individual', connectionId: CONN_ID, suggestionIds,
        },
      }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('at most 15');
      expect(body.message).to.include("'individual'");
    });

    it('returns 400 when suggestionIds exceeds max for grouped mode (>1500)', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const suggestionIds = Array.from({ length: 1501 }, (_, i) => `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'P', mode: 'grouped', connectionId: CONN_ID, suggestionIds,
        },
      }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('at most 1500');
      expect(body.message).to.include("'grouped'");
    });

    it('returns 404 when no active connection found', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(404);
    });

    it('returns 409 with connection_reauth_required when connection requires reauth', async () => {
      const conn = makeConnection({ getStatus: () => 'requires_reauth' });
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.message).to.equal('connection_reauth_required');
    });

    it('returns 404 when connection is disabled (non-active, non-reauth status)', async () => {
      const conn = makeConnection({ getStatus: () => 'disabled' });
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(404);
    });

    it('returns 500 on connection load error', async () => {
      const ctx = makeContext();
      ctx.dataAccess.TaskManagementConnection.findById.rejects(new Error('db'));
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('returns 409 when any suggestionId is already ticketed', async () => {
      const conn = makeConnection();
      const bridgeRow = { getSuggestionId: () => SUGGESTION_ID };
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
          TicketSuggestion: { allBySuggestionIds: sinon.stub().resolves([bridgeRow]) },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'PROJ', connectionId: CONN_ID, suggestionIds: [SUGGESTION_ID],
        },
      }));
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.message).to.include('already ticketed');
    });

    it('returns 500 when TicketSuggestion bridge lookup throws', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
          TicketSuggestion: { allBySuggestionIds: sinon.stub().rejects(new Error('db error')) },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'PROJ', connectionId: CONN_ID, suggestionIds: [SUGGESTION_ID],
        },
      }));
      expect(res.status).to.equal(500);
    });

    it('returns 409 when Jira client throws 401', async () => {
      const conn = makeConnection();
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      const ticketClientStub = { createTicket: sinon.stub().rejects(err) };
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
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

        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns(ticketClientStub) },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(409);
      expect(conn.markRequiresReauth).to.not.have.been.called;
    });

    it('returns 409 when OAuthCredentialManager throws requires re-authorization', async () => {
      const conn = makeConnection();
      const err = new Error('OAuth token refresh failed — connection requires re-authorization');
      const ticketClientStub = { createTicket: sinon.stub().rejects(err) };
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },

        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns(ticketClientStub) },
        },
      })).default;

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
      })).default;

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
        },
      });
      const { createTicket } = Ctrl(ctx);
      await createTicket(makeReqCtx());
      expect(capturedConnObj.instanceUrl).to.equal('https://mysiteurl.atlassian.net');
    });

    it('passes priority, dueDate, components, and parent through to ticketClient.createTicket', async () => {
      const conn = makeConnection();
      const createTicketStub = sinon.stub().resolves({
        ticketId: 'P-1', ticketKey: 'P-1', ticketUrl: 'https://x.net/P-1', ticketStatus: 'To Do',
      });
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },

        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns({ createTicket: createTicketStub }) },
        },
      })).default;

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
          Ticket: { create: sinon.stub().resolves(makeTicket()) },
          TicketSuggestion: { create: sinon.stub().resolves() },
        },
      });
      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix bug',
          projectKey: 'ASO',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID],
          priority: 'High',
          dueDate: '2026-12-31',
          components: ['Frontend', 'API'],
          parent: 'ASO-42',
        },
      }));
      expect(res.status).to.equal(201);
      const callArgs = createTicketStub.firstCall.args[0];
      expect(callArgs.priority).to.equal('High');
      expect(callArgs.dueDate).to.equal('2026-12-31');
      expect(callArgs.components).to.deep.equal(['Frontend', 'API']);
      expect(callArgs.parent).to.equal('ASO-42');
    });

    it('passes field pass-through in grouped mode', async () => {
      const conn = makeConnection();
      const createTicketStub = sinon.stub().resolves({
        ticketId: 'P-1', ticketKey: 'P-1', ticketUrl: 'https://x.net/P-1', ticketStatus: 'To Do',
      });
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },

        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns({ createTicket: createTicketStub }) },
        },
      })).default;

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
          Ticket: { create: sinon.stub().resolves(makeTicket()) },
          TicketSuggestion: { create: sinon.stub().resolves() },
        },
      });
      const { createTicket } = Ctrl(ctx);
      const s2 = '22222222-2222-2222-2222-222222222222';
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped',
          projectKey: 'ASO',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID, s2],
          priority: 'Low',
          dueDate: '2027-01-15',
          components: ['Backend'],
          parent: 'ASO-100',
        },
      }));
      expect(res.status).to.equal(201);
      const callArgs = createTicketStub.firstCall.args[0];
      expect(callArgs.priority).to.equal('Low');
      expect(callArgs.dueDate).to.equal('2027-01-15');
      expect(callArgs.components).to.deep.equal(['Backend']);
      expect(callArgs.parent).to.equal('ASO-100');
    });

    it('passes field pass-through in batch mode', async () => {
      const conn = makeConnection();
      const createTicketStub = sinon.stub().resolves({
        ticketId: 'P-1', ticketKey: 'P-1', ticketUrl: 'https://x.net/P-1', ticketStatus: 'To Do',
      });
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },

        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns({ createTicket: createTicketStub }) },
        },
      })).default;

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
          Ticket: { create: sinon.stub().resolves(makeTicket()) },
          TicketSuggestion: { create: sinon.stub().resolves() },
        },
      });
      const { createTicket } = Ctrl(ctx);
      const s2 = '33333333-3333-3333-3333-333333333333';
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Batch',
          projectKey: 'ASO',
          connectionId: CONN_ID,
          mode: 'individual',
          suggestionIds: [SUGGESTION_ID, s2],
          priority: 'Medium',
          components: ['Infra'],
        },
      }));
      expect(res.status).to.equal(207);
      const callArgs = createTicketStub.firstCall.args[0];
      expect(callArgs.priority).to.equal('Medium');
      expect(callArgs.components).to.deep.equal(['Infra']);
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

        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns({ createTicket: sinon.stub().rejects(err) }) },
        },
      })).default;

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
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
            findById: sinon.stub().resolves(conn),
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
      })).default;

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
            findById: sinon.stub().resolves(conn),
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
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix it', projectKey: 'PROJ', connectionId: CONN_ID, suggestionIds: [SUGGESTION_ID], opportunityId: OPPORTUNITY_ID,
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
            findById: sinon.stub().resolves(conn),
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
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'P', connectionId: CONN_ID, suggestionIds: [SUGGESTION_ID],
        },
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
            findById: sinon.stub().resolves(conn),
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
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'P', connectionId: CONN_ID, suggestionIds: [SUGGESTION_ID],
        },
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
            findById: sinon.stub().resolves(conn),
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
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(201);
      expect(bridgeCreate).to.not.have.been.called;
    });

    // ── Idempotency-Key enforcement ─────────────────────────────────────────

    it('returns 500 when idempotency key lookup fails', async () => {
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(makeConnection()) },
          IdempotencyKey: {
            findActiveKey: sinon.stub().rejects(new Error('db unavailable')),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('returns cached response when idempotency key is completed', async () => {
      const cachedBody = { id: TICKET_ID, ticketKey: 'PROJ-1' };
      const cachedEntry = {
        getStatus: () => 'completed',
        getResponse: () => ({ statusCode: 201, body: cachedBody }),
        getId: () => 'idem-1',
        getCreatedAt: () => '2026-01-01T00:00:00Z',
      };
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(makeConnection()) },
          IdempotencyKey: { findActiveKey: sinon.stub().resolves(cachedEntry) },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body.id).to.equal(TICKET_ID);
    });

    it('returns 409 when idempotency key is processing', async () => {
      const processingEntry = {
        getStatus: () => 'processing',
        getResponse: () => null,
        getId: () => 'idem-1',
        getCreatedAt: () => '2026-01-01T00:00:00Z',
      };
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(makeConnection()) },
          IdempotencyKey: { findActiveKey: sinon.stub().resolves(processingEntry) },
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
      const cachedEntry = {
        getStatus: () => 'failed',
        getResponse: () => ({ statusCode: 500, body: cachedBody }),
        getId: () => 'idem-1',
        getCreatedAt: () => '2026-01-01T00:00:00Z',
      };
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(makeConnection()) },
          IdempotencyKey: { findActiveKey: sinon.stub().resolves(cachedEntry) },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('returns 409 when idempotency key insert hits unique constraint race', async () => {
      const conn = makeConnection();
      const uniqueError = new Error('duplicate key value violates unique constraint');
      uniqueError.code = '23505';
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
          IdempotencyKey: {
            findActiveKey: sinon.stub().resolves(null),
            create: sinon.stub().rejects(uniqueError),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.message).to.include('already in flight');
    });

    it('returns 500 when idempotency key insert fails with non-constraint error', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
          IdempotencyKey: {
            findActiveKey: sinon.stub().resolves(null),
            create: sinon.stub().rejects(new Error('connection reset')),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('treats expired idempotency key as absent (proceeds to create)', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      expect(res.status).to.equal(201);
    });

    // ── Explicit connectionId resolution ────────────────────────────────────

    it('resolves explicit connectionId and creates ticket', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix it',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(201);
    });

    it('returns 404 when explicit connectionId is not found', async () => {
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(null),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix it',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(404);
    });

    it('returns 400 when explicit connectionId is not a valid UUID', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix it',
          projectKey: 'PROJ',
          connectionId: 'not-a-uuid',
        },
      }));
      expect(res.status).to.equal(400);
    });

    // ── Suggestion existence validation ────────────────────────────────────

    it('returns 404 when primarySuggestionId is not found', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
          Suggestion: {
            findById: sinon.stub().resolves(null),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix it', projectKey: 'PROJ', connectionId: CONN_ID, suggestionIds: [SUGGESTION_ID],
        },
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
            findById: sinon.stub().resolves(conn),
          },
          Suggestion: {
            findById: sinon.stub().rejects(new Error('db error')),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix it', projectKey: 'PROJ', connectionId: CONN_ID, suggestionIds: [SUGGESTION_ID],
        },
      }));
      expect(res.status).to.equal(500);
    });

    // ── Attachment validation (spec §30) ───────────────────────────────────────

    it('returns 400 when attachment is missing content', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'PROJ', connectionId: CONN_ID, attachments: [{ mimeType: 'image/png', filename: 'a.png' }],
        },
      }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('attachment must have');
    });

    it('returns 400 when attachment is missing mimeType', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'PROJ', connectionId: CONN_ID, attachments: [{ content: Buffer.from('x').toString('base64'), filename: 'a.png' }],
        },
      }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when attachment is missing filename', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'PROJ', connectionId: CONN_ID, attachments: [{ content: Buffer.from('x').toString('base64'), mimeType: 'image/png' }],
        },
      }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when attachment content is empty after decoding', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      // base64 of empty string decodes to zero bytes
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'PROJ', connectionId: CONN_ID, attachments: [{ content: '', mimeType: 'image/png', filename: 'a.png' }],
        },
      }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when attachment exceeds 3 MB', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const oversized = Buffer.alloc(3 * 1024 * 1024 + 1, 0x00);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix', projectKey: 'PROJ', connectionId: CONN_ID, attachments: [{ content: oversized.toString('base64'), mimeType: 'image/png', filename: 'big.png' }],
        },
      }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('exceeds maximum size');
    });

    it('returns 400 when attachment mimeType is not in allowlist', async () => {
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          attachments: [{ content: Buffer.from('x').toString('base64'), mimeType: 'application/javascript', filename: 'evil.js' }],
        },
      }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('mimeType');
    });

    it('does not reject attachment with path traversal filename (sanitized, not blocked)', async () => {
      // Path traversal in filename is sanitized server-side — the request itself must not 400.
      // The sanitized name is forwarded to the ticket client which applies its own sanitization.
      // Use an invalid mimeType to short-circuit before any Jira call — we only test that the
      // filename itself does not cause a 400 at the shape-validation step.
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          attachments: [{ content: Buffer.from('x').toString('base64'), mimeType: 'application/octet-stream', filename: '../../../etc/passwd' }],
        },
      }));
      // Blocked by MIME allowlist (400), not by filename shape — confirms filename did not trigger its own rejection
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('mimeType');
    });

    it('creates ticket with attachment and returns 201', async () => {
      const conn = makeConnection();
      const ticket = makeTicket();
      const uploadStub = sinon.stub().resolves();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
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
      })).default;

      const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix it',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID],
          attachments: [{ content: validPng.toString('base64'), mimeType: 'image/png', filename: 'screenshot.png' }],
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
            findById: sinon.stub().resolves(conn),
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
      })).default;

      const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix it',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID],
          attachments: [{ content: validPng.toString('base64'), mimeType: 'image/png', filename: 'screenshot.png' }],
        },
      }));

      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body).to.have.property('attachmentWarning');
      expect(body.attachmentWarning).to.include('attachment upload failed');
    });

    // ── Grouped mode happy path ─────────────────────────────────────────────

    it('grouped mode creates one ticket linked to all suggestionIds, returns 201', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const conn = makeConnection();
      const ticket = makeTicket();
      const bridgeCreate = sinon.stub().resolves();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
          Ticket: { create: sinon.stub().resolves(ticket) },
          TicketSuggestion: { create: bridgeCreate },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const createTicketStub = sinon.stub().resolves({
        ticketId: 'PROJ-42', ticketKey: 'PROJ-42', ticketUrl: 'https://x.net/PROJ-42', ticketStatus: 'To Do',
      });
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },

        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ createTicket: createTicketStub }),
          },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped fix',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID, sid2],
          opportunityId: OPPORTUNITY_ID,
        },
      }));

      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body.id).to.equal(TICKET_ID);
      expect(body.suggestionIds).to.deep.equal([SUGGESTION_ID, sid2]);
      expect(body).to.not.have.property('linkWarnings');
      expect(createTicketStub).to.have.been.calledOnce;
      expect(bridgeCreate).to.have.been.calledTwice;
    });

    // ── Individual batch happy path (N>1 → 207 Multi-Status) ────────────────

    it('individual batch mode creates N tickets, returns 207 with per-suggestion results', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const conn = makeConnection();
      const ticket1 = makeTicket();
      const ticket2 = makeTicket({
        getId: () => 'ffffffff-aaaa-bbbb-cccc-dddddddddddd',
        getTicketKey: () => 'PROJ-43',
        getTicketUrl: () => 'https://mysite.atlassian.net/browse/PROJ-43',
      });

      const ticketCreate = sinon.stub();
      ticketCreate.onFirstCall().resolves(ticket1);
      ticketCreate.onSecondCall().resolves(ticket2);

      const bridgeCreate = sinon.stub().resolves();
      const suggestionFindById = sinon.stub();
      suggestionFindById.withArgs(SUGGESTION_ID).resolves(makeSuggestion());
      suggestionFindById.withArgs(sid2).resolves(makeSuggestion({ getId: () => sid2 }));

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
          Ticket: { create: ticketCreate },
          TicketSuggestion: { create: bridgeCreate },
          Suggestion: { findById: suggestionFindById },
        },
      });

      const jiraCreateTicket = sinon.stub();
      jiraCreateTicket.onFirstCall().resolves({
        ticketId: 'PROJ-42', ticketKey: 'PROJ-42', ticketUrl: 'https://x.net/PROJ-42', ticketStatus: 'To Do',
      });
      jiraCreateTicket.onSecondCall().resolves({
        ticketId: 'PROJ-43', ticketKey: 'PROJ-43', ticketUrl: 'https://x.net/PROJ-43', ticketStatus: 'To Do',
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },

        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ createTicket: jiraCreateTicket }),
          },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix both',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2],
          opportunityId: OPPORTUNITY_ID,
        },
      }));

      expect(res.status).to.equal(207);
      const body = await res.json();
      expect(body.results).to.have.lengthOf(2);
      expect(body.results[0].status).to.equal(201);
      expect(body.results[0].suggestionId).to.equal(SUGGESTION_ID);
      expect(body.results[0].ticket).to.have.property('ticketKey');
      expect(body.results[1].status).to.equal(201);
      expect(body.results[1].suggestionId).to.equal(sid2);
      expect(jiraCreateTicket).to.have.been.calledTwice;
      expect(bridgeCreate).to.have.been.calledTwice;
    });

    // ── Branch 2: TicketSuggestion.allByTicketId throws inside listTickets map ──
    // (covered under createTicket section for proximity; branch lives in listTickets)

    // ── Branch 3: attachments field is not an array — coerced to [] ─────────────
    it('treats non-array attachments as empty — proceeds without attachment', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      // Pass attachments as a plain object (not an array) — should be coerced to []
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'No array attachments',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          attachments: { content: 'abc', mimeType: 'image/png', filename: 'x.png' },
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      // Proceeds normally — non-array is treated as "no attachment"
      expect(res.status).to.equal(201);
    });

    // ── Branch 4: attachment content decodes to empty buffer — returns 400 ──────
    // Node's Buffer.from does NOT throw on invalid base64 — it silently skips bad
    // chars and may return an empty buffer. '====' (padding only) decodes to 0 bytes.
    it('returns 400 when attachment content decodes to empty buffer', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Bad base64',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          // '====' is 4 padding chars with no data — decodes to 0 bytes, passes hasText
          attachments: [{ content: '====', mimeType: 'image/png', filename: 'x.png' }],
        },
      }));
      // decoded.length === 0 branch (line 540-542)
      expect(res.status).to.equal(400);
    });

    // ── Branch 5: Suggestion.batchGetByKeys throws in grouped mode ─────────────
    it('returns 500 when Suggestion.batchGetByKeys throws in grouped mode', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: {
            findById: sinon.stub().resolves(makeSuggestion()),
            batchGetByKeys: sinon.stub().rejects(new Error('DB timeout')),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped ticket',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(500);
      const body = await res.json();
      expect(body.message).to.equal('Failed to validate suggestion');
    });

    // ── Branch 6: markIdempotencyDone update fails — only warns, does not throw ─
    it('logs warn but still returns 201 when idempotency done-update fails', async () => {
      const conn = makeConnection();

      const idempotencyEntry = {
        setStatus: sinon.stub().returnsThis(),
        setResponse: sinon.stub().returnsThis(),
        save: sinon.stub().rejects(new Error('PG update error')),
        remove: sinon.stub().resolves(),
      };

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
          TicketSuggestion: { allBySuggestionIds: sinon.stub().resolves([]) },
          IdempotencyKey: {
            findActiveKey: sinon.stub().resolves(null),
            create: sinon.stub().resolves(idempotencyEntry),
          },
        },
      });

      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx());
      // Response succeeds — warn-only path does not bubble the error
      expect(res.status).to.equal(201);
      expect(ctx.log.warn).to.have.been.calledWithMatch(
        sinon.match.object,
        'Failed to cache completed response in idempotency lock',
      );
    });

    // ── Branch 6b: markIdempotencyFailed delete fails — only warns, returns 409 ─
    it('logs warn but still returns 409 when markIdempotencyFailed delete fails', async () => {
      const conn = makeConnection();

      // Single idempotency insert succeeds; ticket creation throws GRANT_REVOKED
      // which triggers markIdempotencyFailed; the delete rejects but error is swallowed.
      const idempotencyEntry = {
        setStatus: sinon.stub().returnsThis(),
        setResponse: sinon.stub().returnsThis(),
        save: sinon.stub().resolves(),
        remove: sinon.stub().rejects(new Error('PG delete failed')),
      };

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
          TicketSuggestion: { allBySuggestionIds: sinon.stub().resolves([]) },
          IdempotencyKey: {
            findActiveKey: sinon.stub().resolves(null),
            create: sinon.stub().resolves(idempotencyEntry),
          },
        },
      });

      // esmock the ticket client to throw GRANT_REVOKED so we reach markIdempotencyFailed + 409
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().rejects(Object.assign(new Error('grant revoked'), { code: 'GRANT_REVOKED' })),
            }),
          },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grant revoked + idem delete fail',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      // markIdempotencyFailed delete error is swallowed — 409 still returned
      expect(res.status).to.equal(409);
      expect(ctx.log.warn).to.have.been.called;
    });

    // ── Branch 9: per-item Suggestion not found in individual batch mode ─────────
    it('individual batch: records 404 for suggestion not found mid-loop', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const conn = makeConnection();
      const ticket1 = makeTicket();

      const ticketCreate = sinon.stub().resolves(ticket1);
      const bridgeCreate = sinon.stub().resolves();
      // First suggestion (primarySuggestionId) resolves; second is not found
      const suggestionFindById = sinon.stub();
      suggestionFindById.withArgs(SUGGESTION_ID).resolves(makeSuggestion());
      suggestionFindById.withArgs(sid2).resolves(null);

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: ticketCreate },
          TicketSuggestion: { create: bridgeCreate },
          Suggestion: { findById: suggestionFindById },
        },
      });

      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Batch partial miss',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(207);
      const body = await res.json();
      expect(body.results).to.have.lengthOf(2);
      expect(body.results[0].status).to.equal(201);
      expect(body.results[1].status).to.equal(404);
      expect(body.results[1].error).to.include('not found');
    });

    // ── Branch 10a: batch reauth short-circuits remaining items ─────────────────
    it('individual batch: short-circuits remaining suggestions after 401 token expiry', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const sid3 = 'dddddddd-eeee-ffff-aaaa-dddddddddddd';
      const conn = makeConnection();
      const reauthErr = Object.assign(new Error('Unauthorized'), { status: 401 });

      const suggestionFindById = sinon.stub();
      suggestionFindById.resolves(makeSuggestion());

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: suggestionFindById },
        },
      });

      const jiraCreateTicket = sinon.stub().rejects(reauthErr);
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns({ createTicket: jiraCreateTicket }) },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Batch reauth',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2, sid3],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(207);
      const body = await res.json();
      // All 3 suggestions should be in results — first fails with reauth, remaining are short-circuited
      expect(body.results).to.have.lengthOf(3);
      body.results.forEach((r) => {
        expect(r.status).to.equal(409);
        expect(r.error).to.equal('token_refresh_required');
      });
      // markRequiresReauth is NOT called for 401 (token expiry path)
      expect(conn.markRequiresReauth).to.not.have.been.called;
      // Jira called only once — breaks out of loop
      expect(jiraCreateTicket).to.have.been.calledOnce;
    });

    // ── Branch 10b: markRequiresReauth rejects in individual batch mode ──────────
    // markRequiresReauth() failure is swallowed via .catch() — the batch still
    // short-circuits and returns 207 with connection_reauth_required for all items.
    // Uses 2 suggestions to exercise the batch loop (length > 1 required).
    it('individual batch: returns 207 when markRequiresReauth throws (DB error swallowed)', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbc';
      const conn = makeConnection({
        markRequiresReauth: sinon.stub().rejects(new Error('DB down')),
      });
      const reauthErr = Object.assign(new Error('Grant revoked'), { code: 'GRANT_REVOKED' });

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ createTicket: sinon.stub().rejects(reauthErr) }),
          },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      // markRequiresReauth rejection is caught via .catch() — createTicket resolves normally.
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Reauth reject',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(207);
      const body = await res.json();
      expect(body.results).to.have.lengthOf(2);
      body.results.forEach((r) => {
        expect(r.status).to.equal(409);
        expect(r.error).to.equal('connection_reauth_required');
      });
      // markRequiresReauth was attempted once (for first suggestion) and failed silently
      expect(conn.markRequiresReauth).to.have.been.calledOnce;
    });

    it('individual batch: short-circuits remaining suggestions after grant revocation', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const sid3 = 'dddddddd-eeee-ffff-aaaa-dddddddddddd';
      const conn = makeConnection();
      const grantRevokedErr = Object.assign(new Error('Grant revoked'), { code: 'GRANT_REVOKED' });

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const jiraCreateTicket = sinon.stub().rejects(grantRevokedErr);
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns({ createTicket: jiraCreateTicket }) },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Batch grant revoked',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2, sid3],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(207);
      const body = await res.json();
      expect(body.results).to.have.lengthOf(3);
      body.results.forEach((r) => {
        expect(r.status).to.equal(409);
        expect(r.error).to.equal('connection_reauth_required');
      });
      expect(conn.markRequiresReauth).to.have.been.calledOnce;
      expect(jiraCreateTicket).to.have.been.calledOnce;
    });

    // ── Branch 11: connection.save() fails after Jira error in grouped mode ──────
    it('grouped mode: logs warn but still returns 500 when connection.save fails after Jira error', async () => {
      const conn = makeConnection({
        setErrorMessage: sinon.stub().returnsThis(),
        save: sinon.stub().rejects(new Error('save failed')),
      });

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().rejects(new Error('Jira upstream error')),
            }),
          },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped save fail',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      // connection.save() rejection is swallowed via .catch() — primary response is 500 from Jira failure
      expect(res.status).to.equal(500);
      expect(conn.save).to.have.been.called;
    });

    // ── Branch 12: connection.save() fails post-creation in grouped mode ─────────
    it('grouped mode: logs warn but still returns 201 when lastUsedAt save fails', async () => {
      const conn = makeConnection({
        setLastUsedAt: sinon.stub().returnsThis(),
        setErrorMessage: sinon.stub().returnsThis(),
        save: sinon.stub().rejects(new Error('save failed')),
      });
      const ticket = makeTicket();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: sinon.stub().resolves(ticket) },
          TicketSuggestion: { create: sinon.stub().resolves() },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped lastUsedAt fail',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      // save() rejection is swallowed via .catch() — ticket is created successfully
      expect(res.status).to.equal(201);
      expect(conn.save).to.have.been.called;
      expect(ctx.log.warn).to.have.been.called;
    });

    // ── Branch 13: isDuplicate branch in grouped bridge loop ─────────────────────
    it('grouped mode: records linkWarning (not error) when TicketSuggestion.create hits unique constraint', async () => {
      const conn = makeConnection();
      const ticket = makeTicket();
      const uniqueErr = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: sinon.stub().resolves(ticket) },
          TicketSuggestion: { create: sinon.stub().rejects(uniqueErr) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped dup bridge',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(201);
      const body = await res.json();
      // Duplicate bridge rows surface as linkWarnings, not errors
      expect(body.linkWarnings).to.be.an('array').with.lengthOf(1);
      expect(body.linkWarnings[0]).to.include('already been linked');
    });

    // ── Branch 14 (single mode) / Branch 1 (listConnections): covered below ─────

    // ── Branch 14: connection.save() fails in single-ticket post-creation ────────
    it('single mode: logs warn but still returns 201 when lastUsedAt save fails', async () => {
      const conn = makeConnection({
        setLastUsedAt: sinon.stub().returnsThis(),
        setErrorMessage: sinon.stub().returnsThis(),
        save: sinon.stub().rejects(new Error('save failed')),
      });
      const ticket = makeTicket();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: sinon.stub().resolves(ticket) },
          TicketSuggestion: { create: sinon.stub().resolves() },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const { createTicket } = TaskManagementController(ctx);
      // Single-ticket mode: one suggestionId only
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Single lastUsedAt fail',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      // save() rejection is swallowed via .catch() — ticket is created successfully
      expect(res.status).to.equal(201);
      expect(conn.save).to.have.been.called;
      expect(ctx.log.warn).to.have.been.called;
    });

    // ── Lines 518-522: attachments.length > 1 → 400 ─────────────────────────────
    it('returns 400 when more than one attachment is provided', async () => {
      const content = Buffer.from('hello').toString('base64');
      const att = { content, mimeType: 'image/png', filename: 'file.png' };
      const { createTicket } = TaskManagementController(makeContext());
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Fix',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          attachments: [att, att],
        },
      }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('at most 1 item');
    });

    // ── Lines 641-642: Suggestion not found in grouped mode → 404 ───────────────
    it('grouped mode: returns 404 when batchGetByKeys returns empty for suggestionId', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: {
            findById: sinon.stub().resolves(null),
            batchGetByKeys: sinon.stub().resolves({ data: [], unprocessed: [] }),
          },
        },
      });
      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped ticket',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(404);
      const body = await res.json();
      expect(body.message).to.include('not found');
    });

    // ── Lines 820-823: Suggestion.findById throws in individual batch mode → 500 in results
    it('individual batch: records 500 when Suggestion.findById throws mid-loop', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const conn = makeConnection();
      const ticket1 = makeTicket();

      const suggestionFindById = sinon.stub();
      suggestionFindById.withArgs(SUGGESTION_ID).resolves(makeSuggestion());
      suggestionFindById.withArgs(sid2).rejects(new Error('DB timeout in batch'));

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: sinon.stub().resolves(ticket1) },
          TicketSuggestion: { create: sinon.stub().resolves() },
          Suggestion: { findById: suggestionFindById },
        },
      });

      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Batch suggestion throw',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(207);
      const body = await res.json();
      const failedItem = body.results.find((r) => r.suggestionId === sid2);
      expect(failedItem.status).to.equal(500);
      expect(failedItem.error).to.equal('Failed to validate suggestion');
    });

    // ── Lines 862-864: Non-reauth batch Jira error → 500 in results ─────────────
    it('individual batch: records 500 when ticketClient.createTicket throws generic error', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const conn = makeConnection();
      const ticket1 = makeTicket();

      const suggestionFindById = sinon.stub();
      suggestionFindById.withArgs(SUGGESTION_ID).resolves(makeSuggestion());
      suggestionFindById.withArgs(sid2).resolves(makeSuggestion({ getId: () => sid2 }));

      const ticketCreate = sinon.stub().resolves(ticket1);

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: ticketCreate },
          TicketSuggestion: { create: sinon.stub().resolves() },
          Suggestion: { findById: suggestionFindById },
        },
      });

      const genericErr = new Error('Jira service unavailable');
      const jiraCreateTicket = sinon.stub();
      jiraCreateTicket.onFirstCall().resolves({
        ticketId: 'PROJ-1', ticketKey: 'PROJ-1', ticketUrl: 'https://x.net/PROJ-1', ticketStatus: 'To Do',
      });
      jiraCreateTicket.onSecondCall().rejects(genericErr);

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns({ createTicket: jiraCreateTicket }) },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Batch generic jira error',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(207);
      const body = await res.json();
      const failedItem = body.results.find((r) => r.suggestionId === sid2);
      expect(failedItem.status).to.equal(500);
      expect(failedItem.error).to.equal('Failed to create ticket');
    });

    // ── Lines 883-884, 887-888: Ticket.create throws in individual batch → 500 ───
    it('individual batch: records 500 when Ticket.create throws after Jira succeeds', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const conn = makeConnection();
      const ticket1 = makeTicket();

      const suggestionFindById = sinon.stub();
      suggestionFindById.withArgs(SUGGESTION_ID).resolves(makeSuggestion());
      suggestionFindById.withArgs(sid2).resolves(makeSuggestion({ getId: () => sid2 }));

      const ticketCreate = sinon.stub();
      ticketCreate.onFirstCall().resolves(ticket1);
      ticketCreate.onSecondCall().rejects(new Error('DB write failed'));

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: ticketCreate },
          TicketSuggestion: { create: sinon.stub().resolves() },
          Suggestion: { findById: suggestionFindById },
        },
      });

      const jiraCreateTicket = sinon.stub().resolves({
        ticketId: 'PROJ-1', ticketKey: 'PROJ-1', ticketUrl: 'https://x.net/PROJ-1', ticketStatus: 'To Do',
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns({ createTicket: jiraCreateTicket }) },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Batch ticket persist fail',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(207);
      const body = await res.json();
      const failedItem = body.results.find((r) => r.suggestionId === sid2);
      expect(failedItem.status).to.equal(500);
      expect(failedItem.error).to.equal('Ticket created but could not be saved');
    });

    // ── Lines 918-925: TicketSuggestion.create throws 23505 in batch → 409 ───────
    it('individual batch: records 409 when TicketSuggestion.create hits unique constraint', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const conn = makeConnection();
      const ticket1 = makeTicket();
      const ticket2 = makeTicket({ getId: () => 'ffffffff-aaaa-bbbb-cccc-dddddddddddd' });

      const suggestionFindById = sinon.stub();
      suggestionFindById.withArgs(SUGGESTION_ID).resolves(makeSuggestion());
      suggestionFindById.withArgs(sid2).resolves(makeSuggestion({ getId: () => sid2 }));

      const ticketCreate = sinon.stub();
      ticketCreate.onFirstCall().resolves(ticket1);
      ticketCreate.onSecondCall().resolves(ticket2);

      const dupErr = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      const bridgeCreate = sinon.stub();
      bridgeCreate.onFirstCall().resolves();
      bridgeCreate.onSecondCall().rejects(dupErr);

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: ticketCreate },
          TicketSuggestion: { create: bridgeCreate },
          Suggestion: { findById: suggestionFindById },
        },
      });

      const jiraCreateTicket = sinon.stub().resolves({
        ticketId: 'PROJ-1', ticketKey: 'PROJ-1', ticketUrl: 'https://x.net/PROJ-1', ticketStatus: 'To Do',
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns({ createTicket: jiraCreateTicket }) },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Batch bridge dup',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(207);
      const body = await res.json();
      const dupItem = body.results.find((r) => r.suggestionId === sid2);
      expect(dupItem.status).to.equal(409);
      expect(dupItem.error).to.include('already been ticketed');
    });

    // ── Lines 918-925 (Case B): TicketSuggestion.create throws generic error in batch → 500
    it('individual batch: records 500 when TicketSuggestion.create throws non-unique error', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const conn = makeConnection();
      const ticket1 = makeTicket();
      const ticket2 = makeTicket({ getId: () => 'ffffffff-aaaa-bbbb-cccc-dddddddddddd' });

      const suggestionFindById = sinon.stub();
      suggestionFindById.withArgs(SUGGESTION_ID).resolves(makeSuggestion());
      suggestionFindById.withArgs(sid2).resolves(makeSuggestion({ getId: () => sid2 }));

      const ticketCreate = sinon.stub();
      ticketCreate.onFirstCall().resolves(ticket1);
      ticketCreate.onSecondCall().resolves(ticket2);

      const bridgeCreate = sinon.stub();
      bridgeCreate.onFirstCall().resolves();
      bridgeCreate.onSecondCall().rejects(new Error('DB connection lost'));

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: ticketCreate },
          TicketSuggestion: { create: bridgeCreate },
          Suggestion: { findById: suggestionFindById },
        },
      });

      const jiraCreateTicket = sinon.stub().resolves({
        ticketId: 'PROJ-1', ticketKey: 'PROJ-1', ticketUrl: 'https://x.net/PROJ-1', ticketStatus: 'To Do',
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: { create: sinon.stub().returns({ createTicket: jiraCreateTicket }) },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Batch bridge generic error',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(207);
      const body = await res.json();
      const failedItem = body.results.find((r) => r.suggestionId === sid2);
      expect(failedItem.status).to.equal(500);
      expect(failedItem.error).to.equal('Ticket created but suggestion link could not be saved');
    });

    // ── Line 937: connection.save() rejects in batch (no success) → still 207 ───
    it('individual batch: logs warn and still returns 207 when connection.save rejects', async () => {
      const sid2 = 'dddddddd-eeee-ffff-aaaa-cccccccccccc';
      const conn = makeConnection({
        setLastUsedAt: sinon.stub().returnsThis(),
        setErrorMessage: sinon.stub().returnsThis(),
        save: sinon.stub().rejects(new Error('save failed')),
      });

      const suggestionFindById = sinon.stub();
      suggestionFindById.withArgs(SUGGESTION_ID).resolves(makeSuggestion());
      suggestionFindById.withArgs(sid2).resolves(null);

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: sinon.stub().resolves(makeTicket()) },
          TicketSuggestion: { create: sinon.stub().resolves() },
          Suggestion: { findById: suggestionFindById },
        },
      });

      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Batch save fail',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID, sid2],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(207);
      expect(conn.save).to.have.been.called;
      expect(ctx.log.warn).to.have.been.called;
    });

    // ── Lines 967-972: Grouped mode reauth → 409 ─────────────────────────────────
    it('grouped mode: returns 409 when ticketClient.createTicket throws 401', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const reauthErr = Object.assign(new Error('Unauthorized'), { status: 401 });
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ createTicket: sinon.stub().rejects(reauthErr) }),
          },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped reauth',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.message).to.include('expired');
      expect(conn.markRequiresReauth).to.not.have.been.called;
    });

    it('grouped mode: returns 409 and marks reauth when ticketClient.createTicket throws GRANT_REVOKED', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const grantRevokedErr = Object.assign(new Error('Grant revoked'), { code: 'GRANT_REVOKED' });
      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ createTicket: sinon.stub().rejects(grantRevokedErr) }),
          },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped grant revoked',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.message).to.include('reconnect');
      expect(conn.markRequiresReauth).to.have.been.calledOnce;
    });

    // ── Lines 999-1009: Grouped mode Ticket.create throws → 500 ─────────────────
    it('grouped mode: returns 500 when Ticket.create throws after Jira createTicket succeeds', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: sinon.stub().rejects(new Error('DB write failed')) },
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
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().resolves({
                ticketId: 'PROJ-99', ticketKey: 'PROJ-99', ticketUrl: 'https://x.net/PROJ-99', ticketStatus: 'To Do',
              }),
            }),
          },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped ticket persist fail',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(500);
      const body = await res.json();
      expect(body.message).to.equal('Ticket created but could not be saved');
    });

    // ── Lines 1046-1048: Grouped bridge non-duplicate error → 201 + linkWarnings ─
    it('grouped mode: returns 201 with linkWarnings when TicketSuggestion.create throws generic error', async () => {
      const conn = makeConnection();
      const ticket = makeTicket();
      const genericErr = new Error('DB connection lost');
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Ticket: { create: sinon.stub().resolves(ticket) },
          TicketSuggestion: { create: sinon.stub().rejects(genericErr) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const { createTicket } = TaskManagementController(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped generic bridge error',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body.linkWarnings).to.be.an('array').with.lengthOf(1);
      expect(body.linkWarnings[0]).to.include('Failed to link suggestion');
    });

    // ── Lines 1055-1064: Attachment upload fails in grouped mode → 201 + warning ─
    it('grouped mode: returns 201 with attachmentWarning when uploadAttachment throws', async () => {
      const conn = makeConnection();
      const ticket = makeTicket();
      const content = Buffer.from('hello world').toString('base64');

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
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
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().resolves({
                ticketId: 'PROJ-55', ticketKey: 'PROJ-55', ticketUrl: 'https://x.net/PROJ-55', ticketStatus: 'To Do',
              }),
              uploadAttachment: sinon.stub().rejects(new Error('S3 upload failed')),
            }),
          },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Grouped with attachment',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          mode: 'grouped',
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
          attachments: [{ content, mimeType: 'text/plain', filename: 'note.txt' }],
        },
      }));
      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body).to.have.property('attachmentWarning');
      expect(body.attachmentWarning).to.include('attachment upload failed');
    });

    // ── Line 1109: Single mode generic Jira error + connection.save rejects → 500 + warn
    it('single mode: logs warn and returns 500 when Jira throws generic error and connection.save rejects', async () => {
      const conn = makeConnection({
        setErrorMessage: sinon.stub().returnsThis(),
        save: sinon.stub().rejects(new Error('save failed')),
      });

      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: { findById: sinon.stub().resolves(conn) },
          Suggestion: { findById: sinon.stub().resolves(makeSuggestion()) },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              createTicket: sinon.stub().rejects(new Error('Jira internal error')),
            }),
          },
        },
      })).default;

      const { createTicket } = Ctrl(ctx);
      const res = await createTicket(makeReqCtx({
        data: {
          summary: 'Single save fail on error',
          projectKey: 'PROJ',
          connectionId: CONN_ID,
          suggestionIds: [SUGGESTION_ID],
          opportunityId: OPPORTUNITY_ID,
        },
      }));
      expect(res.status).to.equal(500);
      expect(conn.save).to.have.been.called;
      expect(ctx.log.warn).to.have.been.called;
    });
  });

  // ─── listProjects ────────────────────────────────────────────────────────────

  describe('listProjects', () => {
    function makeReqCtx(overrides = {}) {
      return {
        params: { organizationId: ORG_ID, connectionId: CONN_ID, ...(overrides.params ?? {}) },
      };
    }

    it('returns 400 for invalid organizationId', async () => {
      const { listProjects } = TaskManagementController(makeContext());
      const res = await listProjects(makeReqCtx({ params: { organizationId: 'bad', connectionId: CONN_ID } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 for invalid connectionId', async () => {
      const { listProjects } = TaskManagementController(makeContext());
      const res = await listProjects(makeReqCtx({ params: { organizationId: ORG_ID, connectionId: 'not-a-uuid' } }));
      expect(res.status).to.equal(400);
    });

    it('returns 404 when organization not found', async () => {
      const ctx = makeContext({ dataAccess: { Organization: { findById: sinon.stub().resolves(null) } } });
      const { listProjects } = TaskManagementController(ctx);
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(404);
    });

    it('returns 404 when no active connection found', async () => {
      const { listProjects } = TaskManagementController(makeContext());
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(404);
    });

    it('returns 409 with connection_reauth_required when connection requires reauth', async () => {
      const conn = makeConnection({ getStatus: () => 'requires_reauth' });
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { listProjects } = TaskManagementController(ctx);
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.message).to.equal('connection_reauth_required');
    });

    it('returns 404 when connection is disabled (non-active, non-reauth status)', async () => {
      const conn = makeConnection({ getStatus: () => 'disabled' });
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { listProjects } = TaskManagementController(ctx);
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(404);
    });

    it('returns 500 on connection load error', async () => {
      const ctx = makeContext();
      ctx.dataAccess.TaskManagementConnection.findById.rejects(new Error('db'));
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
            findById: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },

        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              listProjects: sinon.stub().resolves(projects),
            }),
          },
        },
      })).default;

      const { listProjects } = Ctrl(ctx);
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.projects).to.deep.equal(projects);
    });

    it('returns 409 and does not mark reauth when Jira client returns 401', async () => {
      const conn = makeConnection();
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },

        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ listProjects: sinon.stub().rejects(err) }),
          },
        },
      })).default;

      const { listProjects } = Ctrl(ctx);
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(409);
      expect(conn.markRequiresReauth).to.not.have.been.called;
    });

    it('returns 409 and marks reauth when Jira client throws GRANT_REVOKED', async () => {
      const conn = makeConnection();
      const err = Object.assign(new Error('Grant revoked'), { code: 'GRANT_REVOKED' });
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ listProjects: sinon.stub().rejects(err) }),
          },
        },
      })).default;

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
            findById: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },

        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ listProjects: sinon.stub().rejects(new Error('timeout')) }),
          },
        },
      })).default;

      const { listProjects } = Ctrl(ctx);
      const res = await listProjects(makeReqCtx());
      expect(res.status).to.equal(500);
    });
  });

  describe('listIssueTypes', () => {
    const PROJECT_ID = '10001';

    function makeReqCtx(overrides = {}) {
      const qs = 'queryStringParameters' in overrides
        ? overrides.queryStringParameters
        : { projectId: PROJECT_ID };
      const url = new URL('http://localhost/');
      for (const [k, v] of Object.entries(qs)) {
        url.searchParams.set(k, v);
      }
      return {
        params: { organizationId: ORG_ID, connectionId: CONN_ID, ...(overrides.params ?? {}) },
        request: { url: url.toString() },
      };
    }

    it('returns 400 for invalid organizationId', async () => {
      const { listIssueTypes } = TaskManagementController(makeContext());
      const res = await listIssueTypes(makeReqCtx({ params: { organizationId: 'bad', connectionId: CONN_ID } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 for invalid connectionId', async () => {
      const { listIssueTypes } = TaskManagementController(makeContext());
      const res = await listIssueTypes(makeReqCtx({ params: { organizationId: ORG_ID, connectionId: 'not-a-uuid' } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when projectId is missing', async () => {
      const { listIssueTypes } = TaskManagementController(makeContext());
      const res = await listIssueTypes(makeReqCtx({ queryStringParameters: {} }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when projectId is not numeric', async () => {
      const { listIssueTypes } = TaskManagementController(makeContext());
      const res = await listIssueTypes(makeReqCtx({ queryStringParameters: { projectId: 'PROJ' } }));
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('numeric');
    });

    it('returns 404 when organization not found', async () => {
      const ctx = makeContext({ dataAccess: { Organization: { findById: sinon.stub().resolves(null) } } });
      const { listIssueTypes } = TaskManagementController(ctx);
      const res = await listIssueTypes(makeReqCtx());
      expect(res.status).to.equal(404);
    });

    it('returns 404 when no active connection found', async () => {
      const { listIssueTypes } = TaskManagementController(makeContext());
      const res = await listIssueTypes(makeReqCtx());
      expect(res.status).to.equal(404);
    });

    it('returns 409 with connection_reauth_required when connection requires reauth', async () => {
      const conn = makeConnection({ getStatus: () => 'requires_reauth' });
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { listIssueTypes } = TaskManagementController(ctx);
      const res = await listIssueTypes(makeReqCtx());
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.message).to.equal('connection_reauth_required');
    });

    it('returns 404 when connection is disabled (non-active, non-reauth status)', async () => {
      const conn = makeConnection({ getStatus: () => 'disabled' });
      const ctx = makeContext({
        dataAccess: { TaskManagementConnection: { findById: sinon.stub().resolves(conn) } },
      });
      const { listIssueTypes } = TaskManagementController(ctx);
      const res = await listIssueTypes(makeReqCtx());
      expect(res.status).to.equal(404);
    });

    it('returns 500 on connection load error', async () => {
      const ctx = makeContext();
      ctx.dataAccess.TaskManagementConnection.findById.rejects(new Error('db'));
      const { listIssueTypes } = TaskManagementController(ctx);
      const res = await listIssueTypes(makeReqCtx());
      expect(res.status).to.equal(500);
    });

    it('returns 200 with issue type list', async () => {
      const conn = makeConnection();
      const issueTypes = [{ id: '10001', name: 'Story' }, { id: '10002', name: 'Bug' }];
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({
              listIssueTypes: sinon.stub().resolves(issueTypes),
            }),
          },
        },
      })).default;

      const { listIssueTypes } = Ctrl(ctx);
      const res = await listIssueTypes(makeReqCtx());
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.issueTypes).to.deep.equal(issueTypes);
    });

    it('returns 409 and does not mark reauth when Jira client returns 401', async () => {
      const conn = makeConnection();
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ listIssueTypes: sinon.stub().rejects(err) }),
          },
        },
      })).default;

      const { listIssueTypes } = Ctrl(ctx);
      const res = await listIssueTypes(makeReqCtx());
      expect(res.status).to.equal(409);
      expect(conn.markRequiresReauth).to.not.have.been.called;
    });

    it('returns 409 and marks reauth when Jira client throws GRANT_REVOKED', async () => {
      const conn = makeConnection();
      const err = Object.assign(new Error('Grant revoked'), { code: 'GRANT_REVOKED' });
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ listIssueTypes: sinon.stub().rejects(err) }),
          },
        },
      })).default;

      const { listIssueTypes } = Ctrl(ctx);
      const res = await listIssueTypes(makeReqCtx());
      expect(res.status).to.equal(409);
      expect(conn.markRequiresReauth).to.have.been.calledOnce;
    });

    it('returns 500 on generic list issue types error', async () => {
      const conn = makeConnection();
      const ctx = makeContext({
        dataAccess: {
          TaskManagementConnection: {
            findById: sinon.stub().resolves(conn),
          },
        },
      });

      const Ctrl = (await esmock('../../src/controllers/task-management.js', {
        '@aws-sdk/client-secrets-manager': {
          SecretsManagerClient: class {
            // eslint-disable-next-line class-methods-use-this
            send() { return Promise.resolve({}); }
          },
        },
        '@adobe/spacecat-shared-ticket-client': {
          TicketClientFactory: {
            create: sinon.stub().returns({ listIssueTypes: sinon.stub().rejects(new Error('timeout')) }),
          },
        },
      })).default;

      const { listIssueTypes } = Ctrl(ctx);
      const res = await listIssueTypes(makeReqCtx());
      expect(res.status).to.equal(500);
    });
  });
});
