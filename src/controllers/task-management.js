/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import {
  DeleteSecretCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { createResponse } from '@adobe/spacecat-shared-http-utils';
import { hasText, isNonEmptyObject, isValidUUID } from '@adobe/spacecat-shared-utils';

import {
  STATUS_BAD_REQUEST,
  STATUS_CREATED,
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_NOT_FOUND,
  STATUS_NO_CONTENT,
  STATUS_OK,
} from '../utils/constants.js';

// @adobe/spacecat-shared-ticket-client is not yet published (unmerged PR #1701).
// Top-level await + catch lets the module load in test/utils.js (bare import of
// src/index.js) before the package is installed. esmock intercepts the import
// during individual test setup and injects the mock factory via its loader hook.
let TicketClientFactory;
try {
  // eslint-disable-next-line import/no-unresolved
  ({ TicketClientFactory } = await import('@adobe/spacecat-shared-ticket-client'));
} catch {
  // Package not yet installed — createTicket() gates on this and returns 503
  TicketClientFactory = null;
}

const STATUS_CONFLICT = 409;

// Ticket creation modes per spec. 'grouped' is v2-only — return 400 in v1.
const TICKET_MODE_INDIVIDUAL = 'individual';
const TICKET_MODE_GROUPED = 'grouped';
const SUGGESTION_IDS_MAX = 10;

// Secret path mirrors TicketClientFactory.buildSecretPath — both IDs UUID-validated
// before interpolation to prevent path traversal.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildSecretPath(organizationId, connectionId) {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(connectionId)) {
    throw new Error('Invalid path segment: organizationId and connectionId must be UUIDs');
  }
  return `/mysticat/task-management/${organizationId}/${connectionId}`;
}

/**
 * Serializes a TaskManagementConnection entity to a plain response object.
 * Intentionally omits OAuth secrets — those live in AWS Secrets Manager.
 */
function serializeConnection(conn) {
  return {
    id: conn.getId(),
    organizationId: conn.getOrganizationId(),
    provider: conn.getProvider(),
    status: conn.getStatus(),
    displayName: conn.getDisplayName?.(),
    instanceUrl: conn.getInstanceUrl?.(),
    connectedBy: conn.getConnectedBy?.(),
    metadata: conn.getMetadata(),
    createdAt: conn.getCreatedAt?.(),
    updatedAt: conn.getUpdatedAt?.(),
  };
}

/**
 * Serializes a Ticket entity to a plain response object.
 * connectionId is included per the spec response shape.
 *
 * @param {object} ticket
 * @param {Array<{suggestionId: string, opportunityId: string}>} [suggestions]
 */
function serializeTicket(ticket, suggestions) {
  const out = {
    id: ticket.getId(),
    organizationId: ticket.getOrganizationId(),
    connectionId: ticket.getTaskManagementConnectionId?.() ?? ticket.getConnectionId?.(),
    ticketId: ticket.getTicketId(),
    ticketKey: ticket.getTicketKey(),
    ticketUrl: ticket.getTicketUrl(),
    ticketStatus: ticket.getTicketStatus(),
    ticketProvider: ticket.getTicketProvider(),
    opportunityId: ticket.getOpportunityId?.() ?? null,
    createdBy: ticket.getCreatedBy(),
    statusSyncedAt: null, // v1: always null; populated by v2 webhook sync
  };

  // List endpoints include the suggestions bridge array per spec response shape.
  // Creation endpoint uses the scalar suggestionId for backward compat.
  if (suggestions !== undefined) {
    out.suggestions = suggestions;
  }

  return out;
}

/**
 * TaskManagementController — manages Jira connections and tickets for an organization.
 *
 * Routes:
 *   GET    /organizations/:organizationId/task-management/connections
 *   GET    /organizations/:organizationId/task-management/connections/:connectionId
 *   DELETE /organizations/:organizationId/task-management/connections/:connectionId
 *   GET    /organizations/:organizationId/task-management/tickets
 *   GET    /organizations/:organizationId/suggestions/:suggestionId/ticket
 *   GET    /organizations/:organizationId/opportunities/:opportunityId/tickets
 *   POST   /organizations/:organizationId/task-management/:provider/tickets
 *
 * v1 scope — intentional deviations from the architecture spec (PR #150):
 *   - Idempotency-Key: accepted but response cache not yet implemented.
 *     The idempotency_keys table exists; full cache enforcement is v2.
 *   - suggestionIds: only the first element is processed per request.
 *     Multi-suggestion batch creation (207 Multi-Status) is v2.
 *   - connectionId in POST body: connection resolved by org + provider path params;
 *     explicit connectionId selection is v2 (multiple connections per org).
 *   - DELETE does not revoke the Atlassian-side OAuth token in v1.
 *   - List endpoints have no pagination in v1 (volume negligible at current scale).
 *
 * @param {object} context - Universal serverless function context.
 * @param {object} context.dataAccess - Data access layer (models).
 * @param {import('pino').Logger} context.log - Logger.
 * @returns {object} Controller with connection and ticket methods.
 */
function TaskManagementController(context) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }

  const { dataAccess, log } = context;

  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const {
    TaskManagementConnection, Ticket, TicketSuggestion,
  } = dataAccess;

  if (!isNonEmptyObject(TaskManagementConnection)) {
    throw new Error('TaskManagementConnection collection not available');
  }

  if (!isNonEmptyObject(Ticket)) {
    throw new Error('Ticket collection not available');
  }

  if (!isNonEmptyObject(TicketSuggestion)) {
    throw new Error('TicketSuggestion collection not available');
  }

  // AWS SDK auto-detects region from the Lambda execution environment.
  // Constructed once per controller instance (not per request) to reuse the connection pool.
  const smClient = new SecretsManagerClient();

  // Wrap global fetch so TicketClientFactory receives the expected { fetch } interface.
  // fetch is available globally in Node 18+ (Lambda runtime).
  const httpClient = { fetch: globalThis.fetch };

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Loads a connection by ID and verifies it belongs to the given organization.
   * Returns null when not found or org mismatch (both map to 404 to avoid
   * leaking whether a connectionId exists in a different org).
   */
  async function loadConnectionForOrg(organizationId, connectionId) {
    const conn = await TaskManagementConnection.findById(connectionId);
    if (!conn || conn.getOrganizationId() !== organizationId) {
      return null;
    }
    return conn;
  }

  // ─── Connection handlers ───────────────────────────────────────────────────

  /**
   * Lists all task-management connections for an organization.
   *
   * GET /organizations/:organizationId/task-management/connections
   * Query: ?provider= (optional filter)
   */
  async function listConnections(requestContext) {
    const { params, queryStringParameters: qs } = requestContext;
    const { organizationId } = params;

    if (!isValidUUID(organizationId)) {
      return createResponse({ message: 'organizationId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    let connections;
    try {
      connections = await TaskManagementConnection.allByOrganizationId(organizationId);
    } catch (err) {
      log.error({ organizationId, err }, 'Failed to list task-management connections');
      return createResponse({ message: 'Failed to list connections' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    const filtered = qs?.provider
      ? connections.filter((c) => c.getProvider() === qs.provider)
      : connections;

    return createResponse(filtered.map(serializeConnection), STATUS_OK);
  }

  /**
   * Returns a single task-management connection.
   *
   * GET /organizations/:organizationId/task-management/connections/:connectionId
   */
  async function getConnection(requestContext) {
    const { params } = requestContext;
    const { organizationId, connectionId } = params;

    if (!isValidUUID(organizationId)) {
      return createResponse({ message: 'organizationId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    if (!isValidUUID(connectionId)) {
      return createResponse({ message: 'connectionId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    let connection;
    try {
      connection = await loadConnectionForOrg(organizationId, connectionId);
    } catch (err) {
      log.error({ organizationId, connectionId, err }, 'Failed to load task-management connection');
      return createResponse({ message: 'Failed to load connection' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    if (!connection) {
      return createResponse({ message: `Connection ${connectionId} not found` }, STATUS_NOT_FOUND);
    }

    return createResponse(serializeConnection(connection), STATUS_OK);
  }

  /**
   * Deletes a task-management connection and its OAuth secret from AWS Secrets Manager.
   *
   * DELETE /organizations/:organizationId/task-management/connections/:connectionId
   *
   * v1 accepted risk: does not revoke the Atlassian-side OAuth token.
   * Secret uses a 7-day recovery window so ops can restore accidentally deleted connections.
   */
  async function deleteConnection(requestContext) {
    const { params } = requestContext;
    const { organizationId, connectionId } = params;

    if (!isValidUUID(organizationId)) {
      return createResponse({ message: 'organizationId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    if (!isValidUUID(connectionId)) {
      return createResponse({ message: 'connectionId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    let connection;
    try {
      connection = await loadConnectionForOrg(organizationId, connectionId);
    } catch (err) {
      log.error({ organizationId, connectionId, err }, 'Failed to load connection for deletion');
      return createResponse({ message: 'Failed to load connection' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    if (!connection) {
      return createResponse({ message: `Connection ${connectionId} not found` }, STATUS_NOT_FOUND);
    }

    try {
      const secretId = buildSecretPath(organizationId, connectionId);
      await smClient.send(new DeleteSecretCommand({
        SecretId: secretId,
        RecoveryWindowInDays: 7,
      }));
    } catch (err) {
      if (err.name !== 'ResourceNotFoundException') {
        log.error({ organizationId, connectionId, err }, 'Failed to delete OAuth secret');
        return createResponse({ message: 'Failed to delete connection secret' }, STATUS_INTERNAL_SERVER_ERROR);
      }
      log.warn({ organizationId, connectionId }, 'OAuth secret already absent — proceeding with DB deletion');
    }

    try {
      await connection.remove();
    } catch (err) {
      log.error({ organizationId, connectionId, err }, 'OAuth secret deleted but DB record removal failed');
      return createResponse(
        { message: 'Connection secret deleted but DB record could not be removed' },
        STATUS_INTERNAL_SERVER_ERROR,
      );
    }

    return createResponse({}, STATUS_NO_CONTENT);
  }

  // ─── Ticket read handlers ──────────────────────────────────────────────────

  /**
   * Lists all tickets created for an organization.
   *
   * GET /organizations/:organizationId/task-management/tickets
   *
   * Response shape: array of ticket objects with `suggestions` bridge array.
   */
  async function listTickets(requestContext) {
    const { params } = requestContext;
    const { organizationId } = params;

    if (!isValidUUID(organizationId)) {
      return createResponse({ message: 'organizationId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    let tickets;
    try {
      tickets = await Ticket.allByOrganizationId(organizationId);
    } catch (err) {
      log.error({ organizationId, err }, 'Failed to list tickets');
      return createResponse({ message: 'Failed to list tickets' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    // Load bridge rows in parallel — one allByTicketId call per ticket.
    const ticketsWithSuggestions = await Promise.all(
      tickets.map(async (ticket) => {
        let suggestions = [];
        try {
          const bridges = await TicketSuggestion.allByTicketId(ticket.getId());
          suggestions = bridges.map((b) => ({
            suggestionId: b.getSuggestionId(),
            opportunityId: b.getOpportunityId(),
          }));
        } catch {
          // Bridge load failure does not fail the list — return empty array.
        }
        return serializeTicket(ticket, suggestions);
      }),
    );

    return createResponse(ticketsWithSuggestions, STATUS_OK);
  }

  /**
   * Returns the single ticket linked to a suggestion via the TicketSuggestion bridge.
   *
   * GET /organizations/:organizationId/suggestions/:suggestionId/ticket
   *
   * Returns 404 when no ticket has been created for this suggestion.
   */
  async function getTicketBySuggestion(requestContext) {
    const { params } = requestContext;
    const { organizationId, suggestionId } = params;

    if (!isValidUUID(organizationId)) {
      return createResponse({ message: 'organizationId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    if (!hasText(suggestionId)) {
      return createResponse({ message: 'suggestionId is required' }, STATUS_BAD_REQUEST);
    }

    let bridge;
    try {
      bridge = await TicketSuggestion.findBySuggestionId(suggestionId);
    } catch (err) {
      log.error({ organizationId, suggestionId, err }, 'Failed to look up TicketSuggestion');
      return createResponse({ message: 'Failed to look up ticket' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    if (!bridge) {
      return createResponse(
        { message: `No ticket found for suggestion ${suggestionId}` },
        STATUS_NOT_FOUND,
      );
    }

    let ticket;
    try {
      ticket = await Ticket.findById(bridge.getTicketId());
    } catch (err) {
      log.error({ organizationId, ticketId: bridge.getTicketId(), err }, 'Failed to load ticket');
      return createResponse({ message: 'Failed to load ticket' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    if (!ticket || ticket.getOrganizationId() !== organizationId) {
      return createResponse(
        { message: `No ticket found for suggestion ${suggestionId}` },
        STATUS_NOT_FOUND,
      );
    }

    return createResponse(
      {
        ...serializeTicket(ticket),
        suggestionId,
        opportunityId: bridge.getOpportunityId(),
        connectionId: ticket.getTaskManagementConnectionId?.() ?? ticket.getConnectionId?.(),
        createdBy: ticket.getCreatedBy(),
        createdAt: ticket.getCreatedAt?.(),
      },
      STATUS_OK,
    );
  }

  /**
   * Lists all tickets for all suggestions under an opportunity.
   *
   * GET /organizations/:organizationId/opportunities/:opportunityId/tickets
   *
   * Response shape: array of ticket objects with `suggestions` bridge array.
   */
  async function listTicketsByOpportunity(requestContext) {
    const { params } = requestContext;
    const { organizationId, opportunityId } = params;

    if (!isValidUUID(organizationId)) {
      return createResponse({ message: 'organizationId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    if (!hasText(opportunityId)) {
      return createResponse({ message: 'opportunityId is required' }, STATUS_BAD_REQUEST);
    }

    // v1: one ticket per opportunity (optional FK via Ticket.opportunityId).
    // TicketSuggestion has no index on opportunityId — query via the Ticket FK directly.
    // v2 will relax the 1:1 constraint when multi-suggestion grouped tickets land.
    let ticket;
    try {
      ticket = await Ticket.findByOpportunityId(opportunityId);
    } catch (err) {
      log.error({ organizationId, opportunityId, err }, 'Failed to find ticket for opportunity');
      return createResponse({ message: 'Failed to list tickets' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    if (!ticket || ticket.getOrganizationId() !== organizationId) {
      return createResponse([], STATUS_OK);
    }

    // Load bridge rows for the ticket (may be 0 when no suggestions linked in v1).
    let suggestions = [];
    try {
      const bridges = await TicketSuggestion.allByTicketId(ticket.getId());
      suggestions = bridges.map((b) => ({
        suggestionId: b.getSuggestionId(),
        opportunityId: b.getOpportunityId(),
      }));
    } catch {
      // Bridge load failure does not fail the list — return empty suggestions array.
    }

    return createResponse([serializeTicket(ticket, suggestions)], STATUS_OK);
  }

  // ─── Ticket creation ──────────────────────────────────────────────────────

  /**
   * Creates a Jira ticket for an opportunity and persists the result.
   *
   * POST /organizations/:organizationId/task-management/:provider/tickets
   *
   * Expected request body:
   * ```json
   * {
   *   "projectKey":    "string (required)",
   *   "summary":       "string (required)",
   *   "description":   "string (optional, plain text)",
   *   "issueType":     "string (optional, defaults to 'Task')",
   *   "labels":        ["string"] (optional),
   *   "mode":          "'individual' (default) | 'grouped' (returns 400 in v1)",
   *   "suggestionIds": ["uuid"] — max 10; v1 processes only the first element,
   *   "opportunityId": "uuid (optional)"
   * }
   * ```
   *
   * Idempotency-Key header: accepted but response cache not yet active in v1.
   * The idempotency_keys table is in place; full cache enforcement is v2.
   * The DB UNIQUE (connection_id, ticket_key) constraint prevents duplicate tickets.
   */
  async function createTicket(requestContext) {
    const { params, data, attributes } = requestContext;

    const createdBy = attributes?.authInfo?.getProfile()?.getImsUserId() ?? 'unknown';
    const { organizationId, provider } = params;

    // --- Input validation ---------------------------------------------------

    if (!isValidUUID(organizationId)) {
      return createResponse({ message: 'organizationId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    if (!hasText(provider)) {
      return createResponse({ message: 'provider is required' }, STATUS_BAD_REQUEST);
    }

    if (!isNonEmptyObject(data) || !hasText(data.summary)) {
      return createResponse({ message: 'Request body with summary is required' }, STATUS_BAD_REQUEST);
    }

    if (!hasText(data.projectKey)) {
      return createResponse({ message: 'projectKey is required' }, STATUS_BAD_REQUEST);
    }

    // mode — 'grouped' is v2-only; return 400 in v1 so clients are explicitly informed.
    const mode = data.mode ?? TICKET_MODE_INDIVIDUAL;
    if (mode === TICKET_MODE_GROUPED) {
      return createResponse(
        { message: "mode 'grouped' is not supported in v1. Use 'individual' (default)." },
        STATUS_BAD_REQUEST,
      );
    }
    if (mode !== TICKET_MODE_INDIVIDUAL) {
      return createResponse(
        { message: `Invalid mode '${mode}'. Supported values: 'individual'.` },
        STATUS_BAD_REQUEST,
      );
    }

    // suggestionIds — accept both array (spec) and singular form (compat).
    const suggestionIdsRaw = data.suggestionIds ?? (data.suggestionId ? [data.suggestionId] : []);
    const suggestionIds = Array.isArray(suggestionIdsRaw) ? suggestionIdsRaw : [];

    if (suggestionIds.length > SUGGESTION_IDS_MAX) {
      return createResponse(
        { message: `suggestionIds must contain at most ${SUGGESTION_IDS_MAX} items` },
        STATUS_BAD_REQUEST,
      );
    }

    const primarySuggestionId = suggestionIds[0];

    // --- Resolve the active connection ----------------------------------------

    let connection;
    try {
      connection = await TaskManagementConnection
        .findActiveByOrganizationAndProvider(organizationId, provider);
    } catch (err) {
      log.error({ organizationId, provider, err }, 'Failed to load task-management connection');
      return createResponse({ message: 'Failed to load task-management connection' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    if (!connection) {
      return createResponse(
        { message: `No active ${provider} connection found for organization ${organizationId}` },
        STATUS_NOT_FOUND,
      );
    }

    // --- Create the ticket via the provider client ----------------------------

    let ticketResult;
    try {
      const connectionObj = {
        id: connection.getId(),
        organizationId: connection.getOrganizationId(),
        provider: connection.getProvider(),
        // instanceUrl is required by TicketClientFactory — it merges it into config as siteUrl
        // for the JiraCloudClient SSRF-safe gateway URL construction.
        instanceUrl: connection.getInstanceUrl?.(),
        metadata: connection.getMetadata(),
      };
      const ticketClient = TicketClientFactory.create(connectionObj, smClient, httpClient, log);
      ticketResult = await ticketClient.createTicket({
        projectKey: data.projectKey,
        summary: data.summary,
        description: data.description ?? '',
        labels: data.labels ?? [],
        issueType: data.issueType ?? 'Task',
      });
    } catch (err) {
      // Detect both direct Jira API 401 (err.status) and OAuthCredentialManager's
      // refresh-token-revoked error (plain Error without .status, but with a
      // specific message). Both require marking the connection for re-auth and
      // surfacing a 409 so the UI can prompt the user to reconnect.
      const isReauthNeeded = err.status === 401
        || err.message?.includes('requires re-authorization');

      if (isReauthNeeded) {
        await connection.markRequiresReauth().catch((updateErr) => {
          log.warn({ updateErr }, 'Failed to mark connection as requires_reauth after auth failure');
        });
        return createResponse(
          { message: 'Jira OAuth token is invalid. Please reconnect the Jira integration.' },
          STATUS_CONFLICT,
        );
      }

      log.error({ organizationId, provider, err }, 'Failed to create ticket');
      return createResponse({ message: 'Failed to create ticket' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    // --- Persist the ticket record --------------------------------------------

    let ticket;
    try {
      ticket = await Ticket.create({
        organizationId,
        taskManagementConnectionId: connection.getId(),
        ticketProvider: provider,
        createdBy,
        opportunityId: data.opportunityId ?? undefined,
        ticketId: ticketResult.ticketId,
        ticketKey: ticketResult.ticketKey,
        ticketUrl: ticketResult.ticketUrl,
      });
    } catch (err) {
      log.error(
        {
          organizationId,
          provider,
          ticketId: ticketResult.ticketId,
          ticketKey: ticketResult.ticketKey,
          ticketUrl: ticketResult.ticketUrl,
          err,
        },
        'Ticket created in Jira but persistence failed',
      );
      return createResponse({ message: 'Ticket created but could not be saved' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    // Emit structured audit event per spec §Logging & Audit Events.
    log.info('Ticket created successfully', {
      eventType: 'ticket.created',
      orgId: organizationId,
      connectionId: connection.getId(),
      provider,
      ticketKey: ticketResult.ticketKey,
      suggestionIds: suggestionIds.length > 0 ? suggestionIds : undefined,
      opportunityId: data.opportunityId ?? undefined,
      imsActor: createdBy,
      projectKey: data.projectKey,
      issueType: data.issueType ?? 'Task',
    });

    // --- Create the TicketSuggestion bridge row --------------------------------

    if (primarySuggestionId) {
      try {
        await TicketSuggestion.create({
          ticketId: ticket.getId(),
          suggestionId: primarySuggestionId,
          opportunityId: data.opportunityId ?? undefined,
          createdBy,
        });
      } catch (err) {
        const isDuplicate = err?.message?.includes('unique') || err?.code === '23505';
        if (isDuplicate) {
          return createResponse(
            { message: `Suggestion ${primarySuggestionId} has already been ticketed` },
            STATUS_CONFLICT,
          );
        }
        log.error(
          { ticketId: ticket.getId(), suggestionId: primarySuggestionId, err },
          'Failed to create TicketSuggestion bridge record',
        );
        return createResponse(
          { message: 'Ticket created but suggestion link could not be saved' },
          STATUS_INTERNAL_SERVER_ERROR,
        );
      }
    }

    return createResponse(
      {
        ...serializeTicket(ticket),
        suggestionId: primarySuggestionId ?? undefined,
      },
      STATUS_CREATED,
    );
  }

  return {
    listConnections,
    getConnection,
    deleteConnection,
    listTickets,
    getTicketBySuggestion,
    listTicketsByOpportunity,
    createTicket,
  };
}

export default TaskManagementController;
