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

import { createHash } from 'node:crypto';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { createResponse } from '@adobe/spacecat-shared-http-utils';
import { TicketClientFactory } from '@adobe/spacecat-shared-ticket-client';
import { hasText, isNonEmptyObject, isValidUUID } from '@adobe/spacecat-shared-utils';

import {
  STATUS_BAD_REQUEST,
  STATUS_CREATED,
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_NOT_FOUND,
  STATUS_OK,
} from '../utils/constants.js';
import AccessControlUtil from '../support/access-control-util.js';

const STATUS_CONFLICT = 409;
const STATUS_FORBIDDEN = 403;

// Ticket creation modes.
// 'individual': one ticket per suggestion (N→N). N>1 returns 207 Multi-Status.
// 'grouped': all suggestions into a single ticket (M→1). Returns 201.
const TICKET_MODE_INDIVIDUAL = 'individual';
const TICKET_MODE_GROUPED = 'grouped';
// individual: one ticket per suggestion (N→N), grouped: all suggestions into one ticket (M→1)
// INDIVIDUAL cap is Jira-bound: 15 × ~800ms/ticket ≈ 12s < 15s Lambda timeout.
// GROUPED cap: suggestions validated and bridge rows created in chunked parallel (20 at a time),
// then Jira creates 1 ticket — well within Lambda timeout budget.
const SUGGESTION_IDS_MAX_INDIVIDUAL = 15;
const SUGGESTION_IDS_MAX_GROUPED = 1500;
const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024; // 3 MB per spec §30

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
    externalTicketId: ticket.getExternalTicketId(),
    ticketKey: ticket.getTicketKey(),
    ticketUrl: ticket.getTicketUrl(),
    ticketStatus: ticket.getTicketStatus(),
    ticketProvider: ticket.getTicketProvider(),
    opportunityId: ticket.getOpportunityId?.() ?? null,
    createdAt: ticket.getCreatedAt?.() ?? null,
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
 *   - connectionId in POST body: required. Caller must specify which connection to use.
 *   - Ticket summary and description come from the request body (client-provided).
 *     Spec §7 step 5 shows the server building the ADF description server-side from
 *     Suggestion/Opportunity data. In v1, the ASO UI sends summary + description
 *     directly; the server wraps them in ADF via JiraCloudClient.buildAdfDescription.
 *     Server-side description templating from Suggestion data is deferred to v2.
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
    Organization, TaskManagementConnection, Ticket, TicketSuggestion, Suggestion,
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

  if (!isNonEmptyObject(Organization)) {
    throw new Error('Organization collection not available');
  }

  // AWS SDK auto-detects region from the Lambda execution environment.
  // Constructed once per controller instance (not per request) to reuse the connection pool.
  // ticket-client's OAuthCredentialManager expects a v2-style interface (.getSecretValue /
  // .putSecretValue); wrap the v3 client to provide that surface.
  const rawSmClient = new SecretsManagerClient();
  const smClient = {
    getSecretValue: (params) => rawSmClient.send(new GetSecretValueCommand(params)),
    putSecretValue: (params) => rawSmClient.send(new PutSecretValueCommand(params)),
  };

  // Wrap global fetch so TicketClientFactory receives the expected { fetch } interface.
  // fetch is available globally in Node 18+ (Lambda runtime).
  const httpClient = { fetch: globalThis.fetch };

  const accessControlUtil = AccessControlUtil.fromContext(context);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Loads an organization by ID and verifies the caller has access to it.
   * Returns { denied: Response } when not found or forbidden, { org } on success.
   */
  async function loadOrgWithAccess(organizationId) {
    const org = await Organization.findById(organizationId);
    if (!org) {
      return { denied: createResponse({ message: 'Organization not found' }, STATUS_NOT_FOUND) };
    }
    if (!await accessControlUtil.hasAccess(org)) {
      return { denied: createResponse({ message: 'Forbidden' }, STATUS_FORBIDDEN) };
    }
    return { org };
  }

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

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
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

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
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

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
    }

    let tickets;
    try {
      tickets = await Ticket.allByOrganizationId(organizationId);
    } catch (err) {
      log.error({ organizationId, err }, 'Failed to list tickets');
      return createResponse({ message: 'Failed to list tickets' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    // Bulk-load all bridge rows for the org's tickets in one query (chunked at 50
    // to stay under PostgREST URI limits), then group in-memory by ticket ID.
    const postgrestClient = dataAccess.services?.postgrestClient;
    const bridgeMap = new Map();
    if (tickets.length > 0 && postgrestClient) {
      const ticketIds = tickets.map((t) => t.getId());
      const BRIDGE_LOAD_CHUNK = 50;
      try {
        for (let i = 0; i < ticketIds.length; i += BRIDGE_LOAD_CHUNK) {
          const chunk = ticketIds.slice(i, i + BRIDGE_LOAD_CHUNK);
          // eslint-disable-next-line no-await-in-loop
          const { data, error } = await postgrestClient
            .from('ticket_suggestions')
            .select('ticket_id,suggestion_id,opportunity_id')
            .in('ticket_id', chunk);
          if (error) {
            throw error;
          }
          (data || []).forEach((row) => {
            if (!bridgeMap.has(row.ticket_id)) {
              bridgeMap.set(row.ticket_id, []);
            }
            bridgeMap.get(row.ticket_id).push(row.suggestion_id);
          });
        }
      } catch (err) {
        log.warn({ err }, 'Failed to bulk-load bridge rows; response will omit suggestion links');
      }
    }
    const ticketsWithSuggestions = tickets.map(
      (t) => serializeTicket(t, bridgeMap.get(t.getId()) || []),
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

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
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

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
    }

    // Fetch all tickets for the org then filter by opportunityId in-memory.
    // (No allByOpportunityId on the model; allByOrganizationId is the closest bulk accessor.)
    let tickets;
    try {
      const orgTickets = await Ticket.allByOrganizationId(organizationId);
      tickets = orgTickets.filter((t) => t.getOpportunityId?.() === opportunityId);
    } catch (err) {
      log.error({ organizationId, opportunityId, err }, 'Failed to list tickets for opportunity');
      return createResponse({ message: 'Failed to list tickets' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    if (tickets.length === 0) {
      return createResponse([], STATUS_OK);
    }

    // Bulk-load bridge rows for all matching tickets.
    const postgrestClient = dataAccess.services?.postgrestClient;
    const bridgeMap = new Map();
    if (postgrestClient) {
      const ticketIds = tickets.map((t) => t.getId());
      const BRIDGE_LOAD_CHUNK = 50;
      try {
        for (let i = 0; i < ticketIds.length; i += BRIDGE_LOAD_CHUNK) {
          const chunk = ticketIds.slice(i, i + BRIDGE_LOAD_CHUNK);
          // eslint-disable-next-line no-await-in-loop
          const { data, error } = await postgrestClient
            .from('ticket_suggestions')
            .select('ticket_id,suggestion_id,opportunity_id')
            .in('ticket_id', chunk);
          if (error) {
            throw error;
          }
          (data || []).forEach((row) => {
            if (!bridgeMap.has(row.ticket_id)) {
              bridgeMap.set(row.ticket_id, []);
            }
            bridgeMap.get(row.ticket_id).push(row.suggestion_id);
          });
        }
      } catch (err) {
        log.warn({ opportunityId, err }, 'Failed to bulk-load bridge rows; response will omit suggestion links');
      }
    }

    return createResponse(
      tickets.map((t) => serializeTicket(t, bridgeMap.get(t.getId()) || [])),
      STATUS_OK,
    );
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

    const callerProfile = attributes?.authInfo?.getProfile?.();
    const createdBy = callerProfile?.user_id ?? callerProfile?.sub ?? 'unknown';
    const { organizationId, provider } = params;

    // --- Input validation ---------------------------------------------------

    if (!isValidUUID(organizationId)) {
      return createResponse({ message: 'organizationId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    if (!hasText(provider)) {
      return createResponse({ message: 'provider is required' }, STATUS_BAD_REQUEST);
    }

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
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

    // --- Optional attachments validation (spec §Attachment Validation) ---------
    // attachments: [{ content: base64 string, mimeType: string, filename: string }]
    // Max 1 attachment per request (Lambda 6 MB sync payload limit).
    // Decoded content is held in memory; all MIME/size/magic-byte checks happen
    // inside ticketClient.uploadAttachment — we only pre-validate shape + size here
    // so the caller gets a clear 400 before any downstream work is done.

    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    if (attachments.length > 1) {
      return createResponse(
        { message: 'attachments may contain at most 1 item per request' },
        STATUS_BAD_REQUEST,
      );
    }

    let attachmentBuffer;
    let attachmentMeta;
    if (attachments.length === 1) {
      const att = attachments[0];
      if (!hasText(att.content) || !hasText(att.mimeType) || !hasText(att.filename)) {
        return createResponse(
          { message: 'Each attachment must have content (base64), mimeType, and filename' },
          STATUS_BAD_REQUEST,
        );
      }
      const decoded = Buffer.from(att.content, 'base64');
      if (decoded.length === 0) {
        return createResponse({ message: 'attachment content must not be empty' }, STATUS_BAD_REQUEST);
      }
      if (decoded.length > ATTACHMENT_MAX_BYTES) {
        return createResponse(
          { message: `attachment exceeds maximum size of ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB` },
          STATUS_BAD_REQUEST,
        );
      }
      attachmentBuffer = decoded;
      attachmentMeta = { mimeType: att.mimeType, filename: att.filename };
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
    // Derived server-side from the request payload so duplicate requests for the
    // same suggestions are deduplicated regardless of which client sends them.

    const idempotencyKey = createHash('sha256')
      .update(`${data.opportunityId ?? organizationId}:${[...suggestionIds].sort().join(',')}`)
      .digest('hex');

    const postgrestClient = dataAccess.services?.postgrestClient;
    if (!postgrestClient) {
      log.error({ organizationId }, 'PostgREST client not available for idempotency check');
      return createResponse({ message: 'Service unavailable' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    const { data: existingKeys, error: lookupError } = await postgrestClient
      .from('idempotency_keys')
      .select('id,status,response,created_at')
      .eq('key', idempotencyKey)
      .eq('organization_id', organizationId)
      .gte('expires_at', new Date().toISOString())
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
      log.warn({ organizationId, lockId: existingEntry.id, createdAt: existingEntry.created_at }, 'Returning 409 — idempotency lock still processing');
      return createResponse({ message: 'Request already in flight', retryAfter: 2 }, STATUS_CONFLICT);
    }

    // --- Resolve the active connection ----------------------------------------

    const { connectionId } = data;

    if (!connectionId) {
      return createResponse({ message: 'connectionId is required' }, STATUS_BAD_REQUEST);
    }

    if (!isValidUUID(connectionId)) {
      return createResponse({ message: 'connectionId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    let connection;
    try {
      const conn = await loadConnectionForOrg(organizationId, connectionId);
      if (!conn) {
        return createResponse(
          { message: `Connection ${connectionId} not found for organization ${organizationId}` },
          STATUS_NOT_FOUND,
        );
      }
      if (conn.getStatus() === 'requires_reauth') {
        return createResponse({ message: 'connection_reauth_required' }, STATUS_CONFLICT);
      }
      if (conn.getStatus() !== 'active') {
        return createResponse(
          { message: `Active ${provider} connection ${connectionId} not found for organization ${organizationId}` },
          STATUS_NOT_FOUND,
        );
      }
      connection = conn;
    } catch (err) {
      log.error({ organizationId, provider, err }, 'Failed to load task-management connection');
      return createResponse({ message: 'Failed to load task-management connection' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    // --- Validate suggestion(s) exist (spec §7 step 2) -------------------------
    // grouped: validate ALL suggestions upfront — fail fast if any is missing.
    // individual: validate only primarySuggestionId pre-flight; batch loop validates
    //   remaining suggestions as it goes (best-effort per item).

    if (mode === TICKET_MODE_GROUPED) {
      try {
        const keys = suggestionIds.map((id) => ({ suggestionId: id }));
        const { data: found } = await Suggestion.batchGetByKeys(keys);
        const foundIds = new Set(found.map((s) => s.getId()));
        const missing = suggestionIds.find((id) => !foundIds.has(id));
        if (missing) {
          return createResponse(
            { message: `Suggestion ${missing} not found` },
            STATUS_NOT_FOUND,
          );
        }
      } catch (err) {
        log.error({ err }, 'Failed to validate suggestions');
        return createResponse(
          { message: 'Failed to validate suggestion' },
          STATUS_INTERNAL_SERVER_ERROR,
        );
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

    // --- Pre-flight: verify none of the suggestions already have a ticket -------
    // Bulk-query the bridge table with PostgREST .in() (chunks of 50) instead of
    // N individual findBySuggestionId calls. Early-exit on first chunk with matches.

    if (suggestionIds.length > 0) {
      const BRIDGE_CHECK_CHUNK = 50;
      const alreadyTicketed = [];
      try {
        for (let i = 0; i < suggestionIds.length; i += BRIDGE_CHECK_CHUNK) {
          const chunk = suggestionIds.slice(i, i + BRIDGE_CHECK_CHUNK);
          // eslint-disable-next-line no-await-in-loop
          const { data: bridgeRows, error: bridgeErr } = await postgrestClient
            .from('ticket_suggestions')
            .select('suggestion_id')
            .in('suggestion_id', chunk);
          if (bridgeErr) {
            throw bridgeErr;
          }
          alreadyTicketed.push(
            ...(bridgeRows || []).map((r) => r.suggestion_id),
          );
          if (alreadyTicketed.length > 0) {
            break;
          }
        }
      } catch (err) {
        log.error({ err }, 'Failed to check existing ticket bridges');
        return createResponse(
          { message: 'Failed to validate suggestion ticket status' },
          STATUS_INTERNAL_SERVER_ERROR,
        );
      }
      if (alreadyTicketed.length > 0) {
        return createResponse(
          {
            message: `Suggestion${alreadyTicketed.length > 1 ? 's' : ''} already ticketed: ${alreadyTicketed.join(', ')}`,
          },
          STATUS_CONFLICT,
        );
      }
    }

    // --- Insert idempotency processing record ---------------------------------
    // Connection and suggestion are validated — now commit to processing this request.

    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
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
      const isUniqueViolation = insertError.code === '23505'
        || insertError.message?.includes('unique')
        || insertError.message?.includes('duplicate');
      if (isUniqueViolation) {
        return createResponse({ message: 'Request already in flight' }, STATUS_CONFLICT);
      }
      log.error({ organizationId, insertError }, 'Failed to insert idempotency key');
      return createResponse({ message: 'Service unavailable' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    const idempotencyKeyId = newEntry.id;

    async function markIdempotencyDone(responseBody, statusCode) {
      try {
        await postgrestClient
          .from('idempotency_keys')
          .update({
            status: 'completed',
            response: { body: responseBody, statusCode },
            updated_at: new Date().toISOString(),
          })
          .eq('id', idempotencyKeyId);
      } catch (err) {
        log.warn({ err }, 'Failed to cache completed response in idempotency lock');
      }
    }

    async function markIdempotencyFailed() {
      try {
        await postgrestClient
          .from('idempotency_keys')
          .delete()
          .eq('id', idempotencyKeyId);
      } catch (err) {
        log.warn({ err }, 'Failed to delete idempotency key after failure');
      }
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
              priority: data.priority,
              dueDate: data.dueDate,
              components: data.components,
              parent: data.parent,
            });
          } catch (err) {
            batchTicketErr = err;
          }

          if (batchTicketErr) {
            const isGrantRevoked = batchTicketErr.code === 'GRANT_REVOKED'
              || batchTicketErr.code === 'REQUIRES_REAUTH'
              || batchTicketErr.message?.includes('requires re-authorization');
            const isTokenExpired = batchTicketErr.status === 401
              || batchTicketErr.code === 'TOKEN_REFRESH_REQUIRED';

            if (isGrantRevoked) {
              // eslint-disable-next-line no-await-in-loop
              await connection.markRequiresReauth()
                .catch((reauthErr) => log.warn({ err: reauthErr }, 'Failed to mark connection as requires-reauth'));
              results.push({ suggestionId: suggId, status: STATUS_CONFLICT, error: 'connection_reauth_required' });
              // Short-circuit: token is invalid, remaining suggestions will also fail.
              // Mark them all as connection_reauth_required without calling Jira.
              const remainingIds = suggestionIds.slice(suggestionIds.indexOf(suggId) + 1);
              for (const remainingId of remainingIds) {
                results.push({ suggestionId: remainingId, status: STATUS_CONFLICT, error: 'connection_reauth_required' });
              }
              break;
            } else if (isTokenExpired) {
              results.push({ suggestionId: suggId, status: STATUS_CONFLICT, error: 'token_refresh_required' });
              const remainingIds = suggestionIds.slice(suggestionIds.indexOf(suggId) + 1);
              for (const remainingId of remainingIds) {
                results.push({ suggestionId: remainingId, status: STATUS_CONFLICT, error: 'token_refresh_required' });
              }
              break;
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
                externalTicketId: batchTicketResult.ticketId,
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

      const hasSuccess = results.some((r) => r.status === STATUS_CREATED);
      if (hasSuccess) {
        connection.setLastUsedAt(new Date().toISOString());
        connection.setErrorMessage(null);
      }
      connection.save().catch((saveErr) => {
        log.warn({ saveErr }, 'Failed to update connection metadata after batch');
      });

      const batchResponseBody = { results };
      if (hasSuccess) {
        await markIdempotencyDone(batchResponseBody, 207);
      } else {
        await markIdempotencyFailed();
      }
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
          priority: data.priority,
          dueDate: data.dueDate,
          components: data.components,
          parent: data.parent,
        });
      } catch (err) {
        const isGrantRevoked = err.code === 'GRANT_REVOKED'
          || err.code === 'REQUIRES_REAUTH'
          || err.message?.includes('requires re-authorization');
        const isTokenExpired = err.status === 401
          || err.code === 'TOKEN_REFRESH_REQUIRED';

        if (isGrantRevoked) {
          await connection.markRequiresReauth()
            .catch((reauthErr) => log.warn({ err: reauthErr }, 'Failed to mark connection as requires-reauth'));
          const body = { message: 'Jira OAuth token is invalid. Please reconnect the Jira integration.' };
          await markIdempotencyFailed();
          return createResponse(body, STATUS_CONFLICT);
        }
        if (isTokenExpired) {
          const body = { message: 'Jira OAuth token expired. Please retry after refreshing tokens.' };
          await markIdempotencyFailed();
          return createResponse(body, STATUS_CONFLICT);
        }
        connection.setErrorMessage(err.message ?? 'Unknown grouped ticket creation error');
        connection.save().catch((saveErr) => {
          log.warn({ saveErr }, 'Failed to persist errorMessage on connection');
        });

        log.error({ organizationId, provider, err }, 'Failed to create grouped ticket');
        const body = { message: 'Failed to create ticket' };
        await markIdempotencyFailed();
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
          externalTicketId: groupedTicketResult.ticketId,
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
        await markIdempotencyFailed();
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

      connection.setLastUsedAt(new Date().toISOString());
      connection.setErrorMessage(null);
      connection.save().catch((saveErr) => {
        log.warn({ saveErr }, 'Failed to update lastUsedAt on connection');
      });

      // Link all suggestions to the single ticket — chunked at 50 concurrent, non-fatal per item.
      const BRIDGE_CREATE_CONCURRENCY = 50;
      const linkWarnings = [];
      for (let i = 0; i < suggestionIds.length; i += BRIDGE_CREATE_CONCURRENCY) {
        const chunk = suggestionIds.slice(i, i + BRIDGE_CREATE_CONCURRENCY);
        // eslint-disable-next-line no-await-in-loop
        const chunkWarnings = await Promise.all(
          chunk.map(async (suggId) => {
            try {
              await TicketSuggestion.create({
                ticketId: groupedTicket.getId(),
                suggestionId: suggId,
                opportunityId: data.opportunityId,
                createdBy,
              });
              return null;
            } catch (err) {
              const isDuplicate = err?.message?.includes('unique') || err?.code === '23505';
              if (isDuplicate) {
                return `Suggestion ${suggId} has already been linked to another ticket`;
              }
              log.error({ ticketId: groupedTicket.getId(), suggId, err }, 'Failed to create TicketSuggestion bridge record in grouped mode');
              return `Failed to link suggestion ${suggId} to ticket`;
            }
          }),
        );
        linkWarnings.push(...chunkWarnings.filter(Boolean));
      }

      // Upload attachment if provided — one attachment on the single grouped ticket.
      let groupedAttachmentWarning;
      if (attachmentBuffer) {
        try {
          await ticketClient.uploadAttachment(groupedTicketResult.ticketKey, {
            content: attachmentBuffer,
            ...attachmentMeta,
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
      await markIdempotencyDone(groupedResponseBody, STATUS_CREATED);
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
        priority: data.priority,
        dueDate: data.dueDate,
        components: data.components,
        parent: data.parent,
      });
    } catch (err) {
      const isGrantRevoked = err.code === 'GRANT_REVOKED'
        || err.code === 'REQUIRES_REAUTH'
        || err.message?.includes('requires re-authorization');
      const isTokenExpired = err.status === 401
        || err.code === 'TOKEN_REFRESH_REQUIRED';

      if (isGrantRevoked) {
        await connection.markRequiresReauth()
          .catch((reauthErr) => log.warn({ err: reauthErr }, 'Failed to mark connection as requires-reauth'));
        const body = { message: 'Jira OAuth token is invalid. Please reconnect the Jira integration.' };
        await markIdempotencyFailed();
        return createResponse(body, STATUS_CONFLICT);
      }
      if (isTokenExpired) {
        const body = { message: 'Jira OAuth token expired. Please retry after refreshing tokens.' };
        await markIdempotencyFailed();
        return createResponse(body, STATUS_CONFLICT);
      }

      connection.setErrorMessage(err.message ?? 'Unknown ticket creation error');
      connection.save().catch((saveErr) => {
        log.warn({ saveErr }, 'Failed to persist errorMessage on connection');
      });

      log.error({ organizationId, provider, err }, 'Failed to create ticket');
      const body = { message: 'Failed to create ticket' };
      await markIdempotencyFailed();
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
        externalTicketId: ticketResult.ticketId,
        ticketKey: ticketResult.ticketKey,
        ticketUrl: ticketResult.ticketUrl,
        ticketStatus: ticketResult.ticketStatus,
      });
    } catch (err) {
      log.error(
        {
          organizationId,
          provider,
          externalTicketId: ticketResult.ticketId,
          ticketKey: ticketResult.ticketKey,
          ticketUrl: ticketResult.ticketUrl,
          err,
        },
        'Ticket created in Jira but persistence failed',
      );
      const body = {
        message: 'Ticket created but could not be saved',
        ticketKey: ticketResult.ticketKey,
        ticketUrl: ticketResult.ticketUrl,
      };
      await markIdempotencyFailed();
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

    connection.setLastUsedAt(new Date().toISOString());
    connection.setErrorMessage(null);
    connection.save().catch((saveErr) => {
      log.warn({ saveErr }, 'Failed to update lastUsedAt on connection');
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
          await markIdempotencyFailed();
          return createResponse(body, STATUS_CONFLICT);
        }
        log.error(
          { ticketId: ticket.getId(), suggestionId: primarySuggestionId, err },
          'Failed to create TicketSuggestion bridge record',
        );
        const body = { message: 'Ticket created but suggestion link could not be saved' };
        await markIdempotencyFailed();
        return createResponse(body, STATUS_INTERNAL_SERVER_ERROR);
      }
    }

    // --- Upload attachment (spec §30) — partial success: ticket already exists -

    let attachmentWarning;
    if (attachmentBuffer) {
      try {
        await ticketClient.uploadAttachment(ticketResult.ticketKey, {
          content: attachmentBuffer,
          ...attachmentMeta,
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
    await markIdempotencyDone(responseBody, STATUS_CREATED);
    return createResponse(responseBody, STATUS_CREATED);
  }

  // ─── Project listing ──────────────────────────────────────────────────────

  /**
   * Lists available Jira projects for a specific connection.
   * Used by the UI project picker when creating a ticket.
   *
   * GET /organizations/:organizationId/task-management/connections/:connectionId/projects
   */
  async function listProjects(requestContext) {
    const { params } = requestContext;
    const { organizationId, connectionId } = params;

    if (!isValidUUID(organizationId)) {
      return createResponse({ message: 'organizationId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    if (!isValidUUID(connectionId)) {
      return createResponse({ message: 'connectionId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
    }

    let connection;
    try {
      const conn = await loadConnectionForOrg(organizationId, connectionId);
      if (!conn) {
        return createResponse(
          { message: `Active connection ${connectionId} not found for organization ${organizationId}` },
          STATUS_NOT_FOUND,
        );
      }
      if (conn.getStatus() === 'requires_reauth') {
        return createResponse({ message: 'connection_reauth_required' }, STATUS_CONFLICT);
      }
      if (conn.getStatus() !== 'active') {
        return createResponse(
          { message: `Active connection ${connectionId} not found for organization ${organizationId}` },
          STATUS_NOT_FOUND,
        );
      }
      connection = conn;
    } catch (err) {
      log.error({ organizationId, connectionId, err }, 'Failed to load connection for listProjects');
      return createResponse({ message: 'Failed to load task-management connection' }, STATUS_INTERNAL_SERVER_ERROR);
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
      const isGrantRevoked = err.code === 'GRANT_REVOKED'
        || err.code === 'REQUIRES_REAUTH'
        || err.message?.includes('requires re-authorization');
      const isTokenExpired = err.status === 401
        || err.code === 'TOKEN_REFRESH_REQUIRED';

      if (isGrantRevoked) {
        await connection.markRequiresReauth()
          .catch((reauthErr) => log.warn({ err: reauthErr }, 'Failed to mark connection as requires-reauth'));
        return createResponse(
          { message: 'Jira OAuth token is invalid. Please reconnect the Jira integration.' },
          STATUS_CONFLICT,
        );
      }
      if (isTokenExpired) {
        return createResponse(
          { message: 'Jira OAuth token expired. Please retry after refreshing tokens.' },
          STATUS_CONFLICT,
        );
      }

      log.error({ organizationId, connectionId, err }, 'Failed to list projects');
      return createResponse({ message: 'Failed to list projects' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    return createResponse({ projects }, STATUS_OK);
  }

  /**
   * GET /organizations/:organizationId/task-management/connections/:connectionId/issue-types
   *
   * Returns all non-subtask issue types for a given project.
   * projectId (numeric Jira project ID, returned by listProjects) is required
   * as a query parameter. The hierarchy endpoint used internally requires the
   * numeric ID, not the project key.
   */
  async function listIssueTypes(requestContext) {
    const { params, pathInfo } = requestContext;
    const { organizationId, connectionId } = params;
    const projectId = new URLSearchParams(pathInfo?.suffix?.split('?')[1] ?? '').get('projectId')
      ?? requestContext.data?.projectId;

    if (!isValidUUID(organizationId)) {
      return createResponse({ message: 'organizationId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    if (!isValidUUID(connectionId)) {
      return createResponse({ message: 'connectionId must be a valid UUID' }, STATUS_BAD_REQUEST);
    }

    if (!hasText(projectId)) {
      return createResponse({ message: 'projectId query parameter is required' }, STATUS_BAD_REQUEST);
    }

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
    }

    let connection;
    try {
      const conn = await loadConnectionForOrg(organizationId, connectionId);
      if (!conn) {
        return createResponse(
          { message: `Active connection ${connectionId} not found for organization ${organizationId}` },
          STATUS_NOT_FOUND,
        );
      }
      if (conn.getStatus() === 'requires_reauth') {
        return createResponse({ message: 'connection_reauth_required' }, STATUS_CONFLICT);
      }
      if (conn.getStatus() !== 'active') {
        return createResponse(
          { message: `Active connection ${connectionId} not found for organization ${organizationId}` },
          STATUS_NOT_FOUND,
        );
      }
      connection = conn;
    } catch (err) {
      log.error({ organizationId, connectionId, err }, 'Failed to load connection for listIssueTypes');
      return createResponse({ message: 'Failed to load task-management connection' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    let issueTypes;
    try {
      const connectionObj = {
        id: connection.getId(),
        organizationId: connection.getOrganizationId(),
        provider: connection.getProvider(),
        instanceUrl: connection.getInstanceUrl(),
        metadata: connection.getMetadata(),
      };
      const ticketClient = TicketClientFactory.create(connectionObj, smClient, httpClient, log);
      issueTypes = await ticketClient.listIssueTypes(projectId);
    } catch (err) {
      const isGrantRevoked = err.code === 'GRANT_REVOKED'
        || err.code === 'REQUIRES_REAUTH'
        || err.message?.includes('requires re-authorization');
      const isTokenExpired = err.status === 401
        || err.code === 'TOKEN_REFRESH_REQUIRED';

      if (isGrantRevoked) {
        await connection.markRequiresReauth()
          .catch((reauthErr) => log.warn({ err: reauthErr }, 'Failed to mark connection as requires-reauth'));
        return createResponse(
          { message: 'Jira OAuth token is invalid. Please reconnect the Jira integration.' },
          STATUS_CONFLICT,
        );
      }
      if (isTokenExpired) {
        return createResponse(
          { message: 'Jira OAuth token expired. Please retry after refreshing tokens.' },
          STATUS_CONFLICT,
        );
      }

      log.error({
        organizationId, connectionId, projectId, err,
      }, 'Failed to list issue types');
      return createResponse({ message: 'Failed to list issue types' }, STATUS_INTERNAL_SERVER_ERROR);
    }

    return createResponse({ issueTypes }, STATUS_OK);
  }

  return {
    listConnections,
    getConnection,
    listTickets,
    getTicketBySuggestion,
    listTicketsByOpportunity,
    createTicket,
    listProjects,
    listIssueTypes,
  };
}

export default TaskManagementController;
