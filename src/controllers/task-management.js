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
// eslint-disable-next-line import/no-unresolved
import { TicketClientFactory } from '@adobe/spacecat-shared-ticket-client';

import {
  STATUS_BAD_REQUEST,
  STATUS_CREATED,
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_NOT_FOUND,
  STATUS_NO_CONTENT,
  STATUS_OK,
} from '../utils/constants.js';

const STATUS_CONFLICT = 409;

// Secret path mirrors the format in TicketClientFactory.buildSecretPath so the
// same SM entry is addressed whether we are creating a client or deleting one.
// Both IDs are UUID-validated before interpolation (path traversal prevention).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildSecretPath(organizationId, connectionId) {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(connectionId)) {
    throw new Error('Invalid path segment: organizationId and connectionId must be UUIDs');
  }
  return `/mysticat/${process.env.NODE_ENV}/task-management/${organizationId}/${connectionId}`;
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
    metadata: conn.getMetadata(),
    createdAt: conn.getCreatedAt?.(),
    updatedAt: conn.getUpdatedAt?.(),
  };
}

/**
 * Serializes a Ticket entity to a plain response object.
 */
function serializeTicket(ticket) {
  return {
    id: ticket.getId(),
    organizationId: ticket.getOrganizationId(),
    ticketId: ticket.getTicketId(),
    ticketKey: ticket.getTicketKey(),
    ticketUrl: ticket.getTicketUrl(),
    ticketStatus: ticket.getTicketStatus(),
    ticketProvider: ticket.getTicketProvider(),
    opportunityId: ticket.getOpportunityId?.() ?? null,
    createdBy: ticket.getCreatedBy(),
  };
}

/**
 * TaskManagementController — manages Jira connections and tickets for an organization.
 *
 * Routes:
 *   GET    /organizations/:organizationId/task-management/connections
 *   GET    /organizations/:organizationId/task-management/connections/:connectionId
 *   DELETE /organizations/:organizationId/task-management/connections/:connectionId
 *   GET    /organizations/:organizationId/task-management/tickets
 *   POST   /organizations/:organizationId/task-management/:provider/tickets
 *
 * v1 scope — intentional deviations from the architecture spec (PR #150):
 *   - Idempotency-Key header: accepted but not enforced (no 24h response cache).
 *     v1 relies on the DB UNIQUE (connection_id, ticket_key) constraint instead.
 *   - suggestionIds (array): only the first element is processed per request.
 *     Multi-suggestion batch creation (207 Multi-Status) is deferred to v2.
 *   - connectionId in POST body: connection resolved by org + provider path params;
 *     explicit connectionId selection is deferred to v2 (multiple connections per org).
 *   - DELETE does not revoke the Atlassian-side OAuth app authorization — v1 accepted risk.
 *   - List endpoints return all records without pagination — volume is negligible at v1 scale.
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

  const { TaskManagementConnection, Ticket, TicketSuggestion } = dataAccess;

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
   *
   * @param {string} organizationId
   * @param {string} connectionId
   * @returns {Promise<TaskManagementConnection|null>}
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
   *
   * Query params:
   *   provider (optional) — filter by provider key, e.g. 'jira_cloud'
   *
   * @param {object} requestContext
   * @returns {Promise<Response>} 200 with array of connection objects.
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

    // Optional client-side provider filter — the index already returns all providers
    // for the org; filtering in application code avoids an extra DB index for v1 scale.
    const filtered = qs?.provider
      ? connections.filter((c) => c.getProvider() === qs.provider)
      : connections;

    return createResponse(filtered.map(serializeConnection), STATUS_OK);
  }

  /**
   * Returns a single task-management connection.
   *
   * GET /organizations/:organizationId/task-management/connections/:connectionId
   *
   * @param {object} requestContext
   * @returns {Promise<Response>} 200 with connection object, or 404.
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
      return createResponse(
        { message: `Connection ${connectionId} not found` },
        STATUS_NOT_FOUND,
      );
    }

    return createResponse(serializeConnection(connection), STATUS_OK);
  }

  /**
   * Deletes a task-management connection and its OAuth secret from AWS Secrets Manager.
   *
   * DELETE /organizations/:organizationId/task-management/connections/:connectionId
   *
   * v1 accepted risk: does not revoke the Atlassian-side OAuth app authorization.
   * The Atlassian token remains valid until it expires or the user manually revokes it
   * via their Atlassian account. Revoking via Atlassian's revocation endpoint is a v2
   * enhancement (requires storing the refresh token temporarily and calling the revoke API).
   *
   * Secret deletion uses a 7-day recovery window (AWS default) so operations can
   * restore accidentally deleted connections without losing the OAuth token.
   *
   * @param {object} requestContext
   * @returns {Promise<Response>} 204 on success, or an error response.
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
      return createResponse(
        { message: `Connection ${connectionId} not found` },
        STATUS_NOT_FOUND,
      );
    }

    // Delete the OAuth secret first. If this fails we abort — better to leave
    // an orphaned SM entry than to delete the DB record and lose the ability to
    // identify and clean up the orphan later.
    try {
      const secretId = buildSecretPath(organizationId, connectionId);
      await smClient.send(new DeleteSecretCommand({
        SecretId: secretId,
        // 7-day recovery window allows ops to restore an accidentally deleted connection.
        RecoveryWindowInDays: 7,
      }));
    } catch (err) {
      // ResourceNotFoundException means the secret was already deleted (e.g. by ops).
      // Treat this as a soft success so the DB record can still be cleaned up.
      if (err.name !== 'ResourceNotFoundException') {
        log.error({ organizationId, connectionId, err }, 'Failed to delete OAuth secret');
        return createResponse({ message: 'Failed to delete connection secret' }, STATUS_INTERNAL_SERVER_ERROR);
      }
      log.warn({ organizationId, connectionId }, 'OAuth secret already absent — proceeding with DB deletion');
    }

    try {
      await connection.remove();
    } catch (err) {
      // Secret is already deleted — log the orphaned DB record so ops can clean it up.
      log.error({ organizationId, connectionId, err }, 'OAuth secret deleted but DB record removal failed');
      return createResponse({ message: 'Connection secret deleted but DB record could not be removed' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    return createResponse({}, STATUS_NO_CONTENT);
  }

  // ─── Ticket handlers ───────────────────────────────────────────────────────

  /**
   * Lists all tickets created for an organization.
   *
   * GET /organizations/:organizationId/task-management/tickets
   *
   * @param {object} requestContext
   * @returns {Promise<Response>} 200 with array of ticket objects.
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

    return createResponse(tickets.map(serializeTicket), STATUS_OK);
  }

  /**
   * Creates a Jira ticket for an opportunity and persists the result.
   *
   * POST /organizations/:organizationId/task-management/:provider/tickets
   *
   * Expected request body:
   * ```json
   * {
   *   "projectKey":    "string (required) — Jira project key, e.g. 'ASO'",
   *   "summary":       "string (required)",
   *   "description":   "string (optional, plain text — backend converts to ADF)",
   *   "issueType":     "string (optional, defaults to 'Task')",
   *   "labels":        ["string"] (optional),
   *   "suggestionIds": ["uuid"] (optional) — v1: only the first element is processed.
   *                    A TicketSuggestion bridge row is created when provided.
   *                    Multi-suggestion batch creation (207) is a v2 feature.
   *   "opportunityId": "uuid" (optional)
   * }
   * ```
   *
   * Idempotency-Key: the spec marks this header as required and specifies a 24-hour
   * response cache. v1 accepts the header but does not cache responses — the DB
   * UNIQUE (connection_id, ticket_key) constraint prevents exact duplicate tickets.
   *
   * @param {object} requestContext - The parsed request context.
   * @param {object} requestContext.params - Path parameters.
   * @param {string} requestContext.params.organizationId - Organization UUID.
   * @param {string} requestContext.params.provider - Provider key (e.g. 'jira_cloud').
   * @param {object} requestContext.data - Parsed request body.
   * @param {object} requestContext.attributes - Request-scoped attributes (authInfo, etc.).
   * @returns {Promise<Response>} 201 with ticket data, or an error response.
   */
  async function createTicket(requestContext) {
    const { params, data, attributes } = requestContext;

    // IMS user ID of the authenticated caller — stored on the Ticket for audit purposes.
    // Falls back to 'unknown' only when auth middleware is absent (e.g. local dev without JWT).
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

    // v1: only the first suggestionId is used. The spec field name is suggestionIds (array).
    // Accept both forms for forward-compat (caller may send singular or array).
    const suggestionIdsRaw = data.suggestionIds ?? (data.suggestionId ? [data.suggestionId] : []);
    const primarySuggestionId = Array.isArray(suggestionIdsRaw) ? suggestionIdsRaw[0] : undefined;

    // --- Resolve the active connection -------------------------------------
    // findActiveByOrganizationAndProvider returns null for both "not connected" and
    // "connection exists but is degraded" — both map to 404 so callers are directed
    // to the connection management UI without leaking connection state.

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

    // --- Create the ticket via the provider client ------------------------
    // TicketClientFactory.create expects: (connection, smClient, httpClient, log)
    // where connection is a plain object: { id, organizationId, provider, metadata }.
    // We extract those from the entity rather than passing the entity directly
    // so the ticket-client library stays decoupled from the data-access layer.

    let ticketResult;
    try {
      const connectionObj = {
        id: connection.getId(),
        organizationId: connection.getOrganizationId(),
        provider: connection.getProvider(),
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
      // If the token could not be refreshed mark the connection degraded so
      // the UI can prompt the user to reconnect without waiting for a GC run.
      if (err.status === 401) {
        await connection.markRequiresReauth().catch((updateErr) => {
          log.warn({ updateErr }, 'Failed to mark connection as requires_reauth after 401');
        });
        return createResponse(
          { message: 'Jira OAuth token is invalid. Please reconnect the Jira integration.' },
          STATUS_CONFLICT,
        );
      }

      log.error({ organizationId, provider, err }, 'Failed to create ticket');
      return createResponse({ message: 'Failed to create ticket' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    // --- Persist the ticket record ----------------------------------------

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
      // The ticket was created in Jira but we failed to persist it locally.
      // Log the provider identifiers so the record can be reconciled manually.
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

    // --- Create the TicketSuggestion bridge row (when suggestionId provided) --
    // Links the specific Suggestion to this Ticket for 1:1 enforcement.
    // The DB UNIQUE (suggestion_id) constraint prevents the same suggestion from
    // being ticketed twice. A conflict means the suggestion was already ticketed —
    // return 409 so the UI can show an appropriate message.

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
    createTicket,
  };
}

export default TaskManagementController;
