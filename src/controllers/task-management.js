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
import { getHeader } from '../support/http-headers.js';

// @adobe/spacecat-shared-ticket-client ships with PR #1701 (unmerged at time of writing).
// Dynamic import + ERR_MODULE_NOT_FOUND guard lets src/index.js load in test/utils.js
// (bare import chain) when the package is not yet installed locally. esmock intercepts
// the import in individual test setups via its ESM loader hook.
// Deployment: esbuild fails the bundle if the package is absent at build time, so
// "fail fast" is enforced at the CI build step. Any code path that reaches this fallback
// in a running Lambda throws a clear error rather than a silent NPE.
let TicketClientFactory;
try {
  // eslint-disable-next-line import/no-unresolved
  ({ TicketClientFactory } = await import('@adobe/spacecat-shared-ticket-client'));
} catch (err) {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') {
    // Package is installed but failed to load — propagate for fail-fast behaviour.
    throw err;
  }
  // Package not installed (dev / test env without PR #1701 applied).
  // Shape as an object that throws clearly on first use rather than a silent NPE.
  TicketClientFactory = {
    create() {
      throw new Error('@adobe/spacecat-shared-ticket-client is not installed');
    },
  };
}

const STATUS_CONFLICT = 409;

// Ticket creation modes.
// 'individual': one ticket per suggestion (N→N). N>1 returns 207 Multi-Status.
// 'grouped': all suggestions into a single ticket (M→1). Returns 201.
const TICKET_MODE_INDIVIDUAL = 'individual';
const TICKET_MODE_GROUPED = 'grouped';
// individual: one ticket per suggestion (N→N), grouped: all suggestions into one ticket (M→1)
const SUGGESTION_IDS_MAX_INDIVIDUAL = 10;
const SUGGESTION_IDS_MAX_GROUPED = 400;
const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024; // 3 MB per spec §30

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
 *   GET    /organizations/:organizationId/task-management/:provider/projects
 *
 * v1 scope — intentional deviations from the architecture spec (PR #150):
 *   - Ticket creation modes (individual + grouped) are BOTH implemented in v1
 *     contrary to the original scope which planned grouped as v2. The architecture
 *     reviewers asked for clarity on multi-suggestion semantics; the implementation
 *     resolves this by shipping both modes with explicit caps (individual: ≤10,
 *     grouped: ≤400) and full idempotency enforcement.
 *   - Attachment upload is included inline in POST /tickets (v1). The spec discussed
 *     attachments as an optional feature; they are implemented with a partial-success
 *     model: ticket creation succeeds even when attachment upload fails, with a
 *     warning in the response body.
 *   - Idempotency-Key header is enforced in v1 (not deferred). The idempotency_keys
 *     table (DB PR #720) is used with a 24-hour TTL. Status machine: processing →
 *     completed | failed. Duplicate requests return the cached response.
 *   - connectionId in POST body: accepted as an optional field. When provided, the
 *     specified connection is used directly. When absent, the single active connection
 *     for the org+provider is resolved automatically. The spec's mandatory 400 guard
 *     for multiple active connections is not needed in v1: the DB partial unique index
 *     on (org, provider, external_instance_id) WHERE status != 'disconnected' ensures
 *     at most one active connection per cloudId. Multi-workspace disambiguation (+ 400)
 *     is deferred to v2.
 *   - Ticket summary and description come from the request body (client-provided).
 *     Spec §7 step 5 shows the server building the ADF description server-side from
 *     Suggestion/Opportunity data. In v1, the ASO UI sends summary + description
 *     directly; the server wraps them in ADF via JiraCloudClient.buildAdfDescription.
 *     Server-side description templating from Suggestion data is deferred to v2.
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
    TaskManagementConnection, Ticket, TicketSuggestion, Suggestion,
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

  if (!isNonEmptyObject(Suggestion)) {
    throw new Error('Suggestion collection not available');
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
      // Soft-delete (design spec said hard row deletion; PR #1702 chose soft-delete instead).
      // Rationale: tickets.task_management_connection_id is a FK to this row — hard
      // delete would cascade-delete all associated tickets, destroying audit history.
      // `disconnected` status preserves the FK target while making the connection
      // ineligible for new ticket creation. The partial unique index on (org, provider,
      // external_instance_id) WHERE status != 'disconnected' allows re-connecting the
      // same Jira workspace after disconnection. GC job to tombstone old rows is a
      // spacecat-infrastructure backlog item (no Jira ticket yet).
      await connection.markDisconnected();
    } catch (err) {
      log.error({ organizationId, connectionId, err }, 'OAuth secret deleted but DB record soft-delete failed');
      return createResponse(
        { message: 'Connection secret deleted but DB record could not be updated' },
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
   *   "mode":          "'individual' (default) | 'grouped'",
   *   "suggestionIds": ["uuid"] — max 10; v1 processes only the first element,
   *   "opportunityId": "uuid (optional)"
   * }
   * ```
   *
   * Requires an `Idempotency-Key` request header (spec §Idempotent Ticket Creation).
   * Deduplication is enforced via the `idempotency_keys` table with a 24-hour window.
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

    // suggestionIds — accept both array (spec) and singular form (compat).
    const suggestionIdsRaw = data.suggestionIds ?? (data.suggestionId ? [data.suggestionId] : []);
    const suggestionIds = Array.isArray(suggestionIdsRaw) ? suggestionIdsRaw : [];

    const primarySuggestionId = suggestionIds[0];

    // mode — 'individual' (default, one ticket per suggestion) or 'grouped' (all suggestions
    // into one ticket). grouped requires at least one suggestionId.
    const mode = data.mode ?? TICKET_MODE_INDIVIDUAL;
    if (mode !== TICKET_MODE_INDIVIDUAL && mode !== TICKET_MODE_GROUPED) {
      return createResponse(
        { message: `Invalid mode '${mode}'. Supported values: 'individual', 'grouped'.` },
        STATUS_BAD_REQUEST,
      );
    }
    if (mode === TICKET_MODE_GROUPED && suggestionIds.length === 0) {
      return createResponse(
        { message: "mode 'grouped' requires at least one suggestionId" },
        STATUS_BAD_REQUEST,
      );
    }

    // Cap per mode: individual ≤10 (N tickets), grouped ≤400 (1 ticket).
    const suggestionIdsMax = mode === TICKET_MODE_GROUPED
      ? SUGGESTION_IDS_MAX_GROUPED
      : SUGGESTION_IDS_MAX_INDIVIDUAL;
    if (suggestionIds.length > suggestionIdsMax) {
      return createResponse(
        { message: `suggestionIds must contain at most ${suggestionIdsMax} items for mode '${mode}'` },
        STATUS_BAD_REQUEST,
      );
    }

    // --- Optional attachment validation (spec §30) ----------------------------
    // attachment: { content: base64 string, mimeType: string, filename: string }
    // Decoded content is held in memory; all MIME/size/magic-byte checks happen
    // inside ticketClient.uploadAttachment — we only pre-validate shape + size here
    // so the caller gets a clear 400 before any downstream work is done.

    let attachmentBuffer;
    if (data.attachment) {
      const att = data.attachment;
      if (!hasText(att.content) || !hasText(att.mimeType) || !hasText(att.filename)) {
        return createResponse(
          { message: 'attachment must have content (base64), mimeType, and filename' },
          STATUS_BAD_REQUEST,
        );
      }
      let decoded;
      try {
        decoded = Buffer.from(att.content, 'base64');
      } catch {
        return createResponse({ message: 'attachment.content must be valid base64' }, STATUS_BAD_REQUEST);
      }
      if (decoded.length === 0) {
        return createResponse({ message: 'attachment.content must not be empty' }, STATUS_BAD_REQUEST);
      }
      if (decoded.length > ATTACHMENT_MAX_BYTES) {
        return createResponse(
          { message: `attachment exceeds maximum size of ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB` },
          STATUS_BAD_REQUEST,
        );
      }
      attachmentBuffer = decoded;
    }

    // Attachment in individual batch mode (N>1 suggestions) is not supported — each ticket
    // would need its own attachment. Upload per-ticket via the attachment endpoint instead.
    if (attachmentBuffer && mode === TICKET_MODE_INDIVIDUAL && suggestionIds.length > 1) {
      return createResponse(
        { message: 'Attachments are not supported when creating multiple tickets (individual batch mode). Upload attachments per-ticket via the attachment endpoint.' },
        STATUS_BAD_REQUEST,
      );
    }

    // --- Idempotency-Key enforcement (spec §Idempotent Ticket Creation) --------

    const idempotencyKey = getHeader(requestContext, 'idempotency-key');
    if (!idempotencyKey) {
      return createResponse({ message: 'Idempotency-Key header is required' }, STATUS_BAD_REQUEST);
    }

    const postgrestClient = dataAccess.services?.postgrestClient;
    if (!postgrestClient) {
      log.error({ organizationId }, 'PostgREST client not available for idempotency check');
      return createResponse({ message: 'Service unavailable' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    const { data: existingKeys, error: lookupError } = await postgrestClient
      .from('idempotency_keys')
      .select('id,status,response')
      .eq('key', idempotencyKey)
      .eq('organization_id', organizationId)
      .limit(1);

    if (lookupError) {
      log.error({ organizationId, lookupError }, 'Failed to look up idempotency key');
      return createResponse({ message: 'Service unavailable' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    const existingEntry = existingKeys?.[0];
    if (existingEntry) {
      if (existingEntry.status === 'completed' || existingEntry.status === 'failed') {
        const cached = existingEntry.response;
        return createResponse(cached.body, cached.statusCode);
      }
      // status === 'processing'
      return createResponse({ message: 'Request already in flight' }, STATUS_CONFLICT);
    }

    // --- Resolve the active connection ----------------------------------------
    // See controller-level JSDoc for the v1 rationale on optional connectionId.

    const { connectionId: requestedConnectionId } = data;

    if (requestedConnectionId && !isValidUUID(requestedConnectionId)) {
      return createResponse({ message: 'connectionId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    let connection;
    try {
      if (requestedConnectionId) {
        // Explicit connection selection — caller knows exactly which workspace to use.
        const conn = await loadConnectionForOrg(organizationId, requestedConnectionId);
        if (!conn || conn.getProvider() !== provider || conn.getStatus() !== 'active') {
          return createResponse(
            { message: `Active ${provider} connection ${requestedConnectionId} not found for organization ${organizationId}` },
            STATUS_NOT_FOUND,
          );
        }
        connection = conn;
      } else {
        // Implicit resolution — find the single active connection for this org+provider.
        connection = await TaskManagementConnection
          .findActiveByOrganizationAndProvider(organizationId, provider);
        if (!connection) {
          return createResponse(
            { message: `No active ${provider} connection found for organization ${organizationId}` },
            STATUS_NOT_FOUND,
          );
        }
      }
    } catch (err) {
      log.error({ organizationId, provider, err }, 'Failed to load task-management connection');
      return createResponse({ message: 'Failed to load task-management connection' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    // --- Validate suggestion(s) exist (spec §7 step 2) -------------------------
    // grouped: validate ALL suggestions upfront — fail fast if any is missing.
    // individual: validate only primarySuggestionId pre-flight; batch loop validates
    //   remaining suggestions as it goes (best-effort per item).

    if (mode === TICKET_MODE_GROUPED) {
      for (const suggId of suggestionIds) {
        let sugg;
        try {
          // eslint-disable-next-line no-await-in-loop
          sugg = await Suggestion.findById(suggId);
        } catch (err) {
          log.error({ suggId, err }, 'Failed to look up suggestion');
          return createResponse({ message: 'Failed to validate suggestion' }, STATUS_INTERNAL_SERVER_ERROR);
        }
        if (!sugg) {
          return createResponse({ message: `Suggestion ${suggId} not found` }, STATUS_NOT_FOUND);
        }
      }
    } else if (primarySuggestionId) {
      let suggestion;
      try {
        suggestion = await Suggestion.findById(primarySuggestionId);
      } catch (err) {
        log.error({ primarySuggestionId, err }, 'Failed to look up suggestion');
        return createResponse({ message: 'Failed to validate suggestion' }, STATUS_INTERNAL_SERVER_ERROR);
      }
      if (!suggestion) {
        return createResponse(
          { message: `Suggestion ${primarySuggestionId} not found` },
          STATUS_NOT_FOUND,
        );
      }
    }

    // --- Insert idempotency processing record ---------------------------------
    // Connection and suggestion are validated — now commit to processing this request.

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data: newEntry, error: insertError } = await postgrestClient
      .from('idempotency_keys')
      .insert({
        key: idempotencyKey,
        organization_id: organizationId,
        endpoint: `POST /task-management/${provider}/tickets`,
        status: 'processing',
        expires_at: expiresAt,
      })
      .select('id')
      .single();

    if (insertError) {
      log.error({ organizationId, insertError }, 'Failed to insert idempotency key');
      return createResponse({ message: 'Service unavailable' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    const idempotencyKeyId = newEntry.id;

    async function markIdempotencyDone(statusCode, body) {
      await postgrestClient
        .from('idempotency_keys')
        .update({ status: 'completed', response: { statusCode, body } })
        .eq('id', idempotencyKeyId)
        .catch((err) => log.warn({ err }, 'Failed to mark idempotency key completed'));
    }

    async function markIdempotencyFailed(statusCode, body) {
      await postgrestClient
        .from('idempotency_keys')
        .update({ status: 'failed', response: { statusCode, body } })
        .eq('id', idempotencyKeyId)
        .catch((err) => log.warn({ err }, 'Failed to mark idempotency key failed'));
    }

    // --- Create the ticket via the provider client ----------------------------

    const connectionObj = {
      id: connection.getId(),
      organizationId: connection.getOrganizationId(),
      provider: connection.getProvider(),
      // instanceUrl is required by TicketClientFactory — it merges it into config as siteUrl
      // for the JiraCloudClient SSRF-safe gateway URL construction.
      instanceUrl: connection.getInstanceUrl(),
      metadata: connection.getMetadata(),
    };
    const ticketClient = TicketClientFactory.create(connectionObj, smClient, httpClient, log);

    // ─── Individual batch path: N suggestionIds → N Jira tickets ─────────────
    if (mode === TICKET_MODE_INDIVIDUAL && suggestionIds.length > 1) {
      const results = [];

      for (const suggId of suggestionIds) {
        // Validate suggestion (best-effort per item; first was already validated pre-flight)
        let batchSuggestionOk = true;
        if (suggId !== primarySuggestionId) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const sugg = await Suggestion.findById(suggId);
            if (!sugg) {
              results.push({ suggestionId: suggId, status: STATUS_NOT_FOUND, error: `Suggestion ${suggId} not found` });
              batchSuggestionOk = false;
            }
          } catch (err) {
            log.error({ suggId, err }, 'Failed to look up suggestion in batch');
            results.push({ suggestionId: suggId, status: STATUS_INTERNAL_SERVER_ERROR, error: 'Failed to validate suggestion' });
            batchSuggestionOk = false;
          }
        }

        if (batchSuggestionOk) {
          // Create Jira ticket for this suggestion
          let batchTicketResult;
          let batchTicketErr;
          try {
            // eslint-disable-next-line no-await-in-loop
            batchTicketResult = await ticketClient.createTicket({
              projectKey: data.projectKey,
              summary: data.summary,
              description: data.description ?? '',
              labels: data.labels ?? [],
              issueType: data.issueType ?? 'Task',
            });
          } catch (err) {
            batchTicketErr = err;
          }

          if (batchTicketErr) {
            const isReauthNeeded = batchTicketErr.status === 401
              || batchTicketErr.message?.includes('requires re-authorization');
            if (isReauthNeeded) {
              // eslint-disable-next-line no-await-in-loop
              await connection.markRequiresReauth().catch((updateErr) => {
                log.warn({ updateErr }, 'Failed to mark connection as requires_reauth in batch');
              });
              results.push({ suggestionId: suggId, status: STATUS_CONFLICT, error: 'Jira OAuth token is invalid. Please reconnect the Jira integration.' });
            } else {
              log.error({ suggId, err: batchTicketErr }, 'Failed to create ticket in batch');
              results.push({ suggestionId: suggId, status: STATUS_INTERNAL_SERVER_ERROR, error: 'Failed to create ticket' });
            }
          } else {
            // Persist Ticket entity
            let batchTicket;
            let persistErr;
            try {
              // eslint-disable-next-line no-await-in-loop
              batchTicket = await Ticket.create({
                organizationId,
                taskManagementConnectionId: connection.getId(),
                ticketProvider: provider,
                createdBy,
                opportunityId: data.opportunityId,
                ticketId: batchTicketResult.ticketId,
                ticketKey: batchTicketResult.ticketKey,
                ticketUrl: batchTicketResult.ticketUrl,
                ticketStatus: batchTicketResult.ticketStatus,
              });
            } catch (err) {
              persistErr = err;
            }

            if (persistErr) {
              log.error({ suggId, ticketKey: batchTicketResult.ticketKey, err: persistErr }, 'Ticket created in Jira but persistence failed in batch');
              results.push({ suggestionId: suggId, status: STATUS_INTERNAL_SERVER_ERROR, error: 'Ticket created but could not be saved' });
            } else {
              log.info('Ticket created successfully (batch)', {
                eventType: 'ticket.created',
                orgId: organizationId,
                connectionId: connection.getId(),
                provider,
                ticketKey: batchTicketResult.ticketKey,
                suggestionId: suggId,
                opportunityId: data.opportunityId,
                imsActor: createdBy,
                projectKey: data.projectKey,
                issueType: data.issueType ?? 'Task',
              });

              // Create TicketSuggestion bridge
              try {
                // eslint-disable-next-line no-await-in-loop
                await TicketSuggestion.create({
                  ticketId: batchTicket.getId(),
                  suggestionId: suggId,
                  opportunityId: data.opportunityId,
                  createdBy,
                });
                results.push({
                  suggestionId: suggId,
                  status: STATUS_CREATED,
                  ticket: serializeTicket(batchTicket),
                });
              } catch (err) {
                const isDuplicate = err?.message?.includes('unique') || err?.code === '23505';
                if (isDuplicate) {
                  results.push({ suggestionId: suggId, status: STATUS_CONFLICT, error: `Suggestion ${suggId} has already been ticketed` });
                } else {
                  log.error({ ticketId: batchTicket.getId(), suggId, err }, 'Failed to create TicketSuggestion bridge record in batch');
                  results.push({ suggestionId: suggId, status: STATUS_INTERNAL_SERVER_ERROR, error: 'Ticket created but suggestion link could not be saved' });
                }
              }
            }
          }
        }
      }

      const batchResponseBody = { results };
      await markIdempotencyDone(207, batchResponseBody);
      return createResponse(batchResponseBody, 207);
    }

    // ─── Grouped path: M suggestionIds → 1 Jira ticket ───────────────────────
    if (mode === TICKET_MODE_GROUPED) {
      let groupedTicketResult;
      try {
        groupedTicketResult = await ticketClient.createTicket({
          projectKey: data.projectKey,
          summary: data.summary,
          description: data.description ?? '',
          labels: data.labels ?? [],
          issueType: data.issueType ?? 'Task',
        });
      } catch (err) {
        const isReauthNeeded = err.status === 401 || err.message?.includes('requires re-authorization');
        if (isReauthNeeded) {
          await connection.markRequiresReauth().catch((updateErr) => {
            log.warn({ updateErr }, 'Failed to mark connection as requires_reauth');
          });
          const body = { message: 'Jira OAuth token is invalid. Please reconnect the Jira integration.' };
          await markIdempotencyFailed(STATUS_CONFLICT, body);
          return createResponse(body, STATUS_CONFLICT);
        }
        log.error({ organizationId, provider, err }, 'Failed to create grouped ticket');
        const body = { message: 'Failed to create ticket' };
        await markIdempotencyFailed(STATUS_INTERNAL_SERVER_ERROR, body);
        return createResponse(body, STATUS_INTERNAL_SERVER_ERROR);
      }

      let groupedTicket;
      try {
        groupedTicket = await Ticket.create({
          organizationId,
          taskManagementConnectionId: connection.getId(),
          ticketProvider: provider,
          createdBy,
          opportunityId: data.opportunityId,
          ticketId: groupedTicketResult.ticketId,
          ticketKey: groupedTicketResult.ticketKey,
          ticketUrl: groupedTicketResult.ticketUrl,
          ticketStatus: groupedTicketResult.ticketStatus,
        });
      } catch (err) {
        log.error(
          {
            organizationId, provider, ticketKey: groupedTicketResult.ticketKey, err,
          },
          'Grouped ticket created in Jira but persistence failed',
        );
        const body = { message: 'Ticket created but could not be saved' };
        await markIdempotencyFailed(STATUS_INTERNAL_SERVER_ERROR, body);
        return createResponse(body, STATUS_INTERNAL_SERVER_ERROR);
      }

      log.info('Grouped ticket created successfully', {
        eventType: 'ticket.created',
        orgId: organizationId,
        connectionId: connection.getId(),
        provider,
        ticketKey: groupedTicketResult.ticketKey,
        suggestionIds,
        opportunityId: data.opportunityId,
        imsActor: createdBy,
        projectKey: data.projectKey,
        issueType: data.issueType ?? 'Task',
      });

      // Link all suggestions to the single ticket — non-fatal on individual bridge failure.
      const linkWarnings = [];
      for (const suggId of suggestionIds) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await TicketSuggestion.create({
            ticketId: groupedTicket.getId(),
            suggestionId: suggId,
            opportunityId: data.opportunityId,
            createdBy,
          });
        } catch (err) {
          const isDuplicate = err?.message?.includes('unique') || err?.code === '23505';
          if (isDuplicate) {
            linkWarnings.push(`Suggestion ${suggId} has already been linked to another ticket`);
          } else {
            log.error({ ticketId: groupedTicket.getId(), suggId, err }, 'Failed to create TicketSuggestion bridge record in grouped mode');
            linkWarnings.push(`Failed to link suggestion ${suggId} to ticket`);
          }
        }
      }

      // Upload attachment if provided — one attachment on the single grouped ticket.
      let groupedAttachmentWarning;
      if (attachmentBuffer) {
        try {
          await ticketClient.uploadAttachment(groupedTicketResult.ticketKey, {
            content: attachmentBuffer,
            mimeType: data.attachment.mimeType,
            filename: data.attachment.filename,
          });
        } catch (err) {
          log.warn({ ticketKey: groupedTicketResult.ticketKey, err }, 'Grouped ticket created but attachment upload failed');
          groupedAttachmentWarning = 'Ticket created but attachment upload failed. Retry via the attachment endpoint.';
        }
      }

      const groupedResponseBody = {
        ...serializeTicket(groupedTicket),
        suggestionIds,
        ...(linkWarnings.length > 0 ? { linkWarnings } : {}),
        ...(groupedAttachmentWarning ? { attachmentWarning: groupedAttachmentWarning } : {}),
      };
      await markIdempotencyDone(STATUS_CREATED, groupedResponseBody);
      return createResponse(groupedResponseBody, STATUS_CREATED);
    }

    // ─── Single ticket path (individual, ≤1 suggestion) ──────────────────────

    let ticketResult;
    try {
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
        const body = { message: 'Jira OAuth token is invalid. Please reconnect the Jira integration.' };
        await markIdempotencyFailed(STATUS_CONFLICT, body);
        return createResponse(body, STATUS_CONFLICT);
      }

      log.error({ organizationId, provider, err }, 'Failed to create ticket');
      const body = { message: 'Failed to create ticket' };
      await markIdempotencyFailed(STATUS_INTERNAL_SERVER_ERROR, body);
      return createResponse(body, STATUS_INTERNAL_SERVER_ERROR);
    }

    // --- Persist the ticket record --------------------------------------------

    let ticket;
    try {
      ticket = await Ticket.create({
        organizationId,
        taskManagementConnectionId: connection.getId(),
        ticketProvider: provider,
        createdBy,
        opportunityId: data.opportunityId,
        ticketId: ticketResult.ticketId,
        ticketKey: ticketResult.ticketKey,
        ticketUrl: ticketResult.ticketUrl,
        ticketStatus: ticketResult.ticketStatus,
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
      const body = { message: 'Ticket created but could not be saved' };
      await markIdempotencyFailed(STATUS_INTERNAL_SERVER_ERROR, body);
      return createResponse(body, STATUS_INTERNAL_SERVER_ERROR);
    }

    // Emit structured audit event per spec §Logging & Audit Events.
    log.info('Ticket created successfully', {
      eventType: 'ticket.created',
      orgId: organizationId,
      connectionId: connection.getId(),
      provider,
      ticketKey: ticketResult.ticketKey,
      suggestionIds: suggestionIds.length > 0 ? suggestionIds : undefined,
      opportunityId: data.opportunityId,
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
          opportunityId: data.opportunityId,
          createdBy,
        });
      } catch (err) {
        const isDuplicate = err?.message?.includes('unique') || err?.code === '23505';
        if (isDuplicate) {
          const body = { message: `Suggestion ${primarySuggestionId} has already been ticketed` };
          await markIdempotencyFailed(STATUS_CONFLICT, body);
          return createResponse(body, STATUS_CONFLICT);
        }
        log.error(
          { ticketId: ticket.getId(), suggestionId: primarySuggestionId, err },
          'Failed to create TicketSuggestion bridge record',
        );
        const body = { message: 'Ticket created but suggestion link could not be saved' };
        await markIdempotencyFailed(STATUS_INTERNAL_SERVER_ERROR, body);
        return createResponse(body, STATUS_INTERNAL_SERVER_ERROR);
      }
    }

    // --- Upload attachment (spec §30) — partial success: ticket already exists -

    let attachmentWarning;
    if (attachmentBuffer) {
      try {
        await ticketClient.uploadAttachment(ticketResult.ticketKey, {
          content: attachmentBuffer,
          mimeType: data.attachment.mimeType,
          filename: data.attachment.filename,
        });
      } catch (err) {
        // Spec §Attachment failure handling: "partial success acceptable; retry via
        // attachment endpoint". Ticket is already created — do not roll back.
        log.warn(
          { ticketKey: ticketResult.ticketKey, err },
          'Ticket created but attachment upload failed',
        );
        attachmentWarning = 'Ticket created but attachment upload failed. Retry via the attachment endpoint.';
      }
    }

    const responseBody = {
      ...serializeTicket(ticket),
      suggestionId: primarySuggestionId ?? undefined,
      ...(attachmentWarning ? { attachmentWarning } : {}),
    };
    await markIdempotencyDone(STATUS_CREATED, responseBody);
    return createResponse(responseBody, STATUS_CREATED);
  }

  // ─── Project listing ──────────────────────────────────────────────────────

  /**
   * Lists available Jira projects for the active connection.
   * Used by the UI project picker when creating a ticket.
   *
   * GET /organizations/:organizationId/task-management/:provider/projects
   */
  async function listProjects(requestContext) {
    const { params } = requestContext;
    const { organizationId, provider } = params;

    if (!isValidUUID(organizationId)) {
      return createResponse({ message: 'organizationId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    if (!hasText(provider)) {
      return createResponse({ message: 'provider is required' }, STATUS_BAD_REQUEST);
    }

    let connection;
    try {
      connection = await TaskManagementConnection
        .findActiveByOrganizationAndProvider(organizationId, provider);
    } catch (err) {
      log.error({ organizationId, provider, err }, 'Failed to load connection for listProjects');
      return createResponse({ message: 'Failed to load task-management connection' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    if (!connection) {
      return createResponse(
        { message: `No active ${provider} connection found for organization ${organizationId}` },
        STATUS_NOT_FOUND,
      );
    }

    let projects;
    try {
      const connectionObj = {
        id: connection.getId(),
        organizationId: connection.getOrganizationId(),
        provider: connection.getProvider(),
        instanceUrl: connection.getInstanceUrl(),
        metadata: connection.getMetadata(),
      };
      const ticketClient = TicketClientFactory.create(connectionObj, smClient, httpClient, log);
      projects = await ticketClient.listProjects();
    } catch (err) {
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

      log.error({ organizationId, provider, err }, 'Failed to list projects');
      return createResponse({ message: 'Failed to list projects' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    return createResponse({ projects }, STATUS_OK);
  }

  return {
    listConnections,
    getConnection,
    deleteConnection,
    listTickets,
    getTicketBySuggestion,
    listTicketsByOpportunity,
    createTicket,
    listProjects,
  };
}

export default TaskManagementController;
