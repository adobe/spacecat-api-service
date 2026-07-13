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

import { createHash } from 'node:crypto';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  badRequest,
  created,
  createResponse,
  forbidden,
  internalServerError,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { TicketClientFactory } from '@adobe/spacecat-shared-ticket-client';
import { hasText, isNonEmptyObject, isValidUUID } from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';
import { TaskManagementConnectionDto } from '../dto/task-management-connection.js';
import { TicketDto } from '../dto/ticket.js';

const STATUS_CREATED = 201;
const STATUS_NOT_FOUND = 404;
const STATUS_INTERNAL_SERVER_ERROR = 500;
const STATUS_CONFLICT = 409;
const STATUS_MULTI_STATUS = 207;

const SUPPORTED_PROVIDERS = new Set(['jira_cloud']);

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
// Must stay in sync with ATTACHMENT_ALLOWED_MIME_TYPES in jira-cloud-client.js
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/csv',
  'text/plain',
]);

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
 *     resolves this by shipping both modes with explicit caps (individual: ≤15,
 *     grouped: ≤1500) and full idempotency enforcement.
 *   - Attachment upload is included inline in POST /tickets (v1). The spec discussed
 *     attachments as an optional feature; they are implemented with a partial-success
 *     model: ticket creation succeeds even when attachment upload fails, with a
 *     warning in the response body.
 *   - Idempotency-Key header is enforced in v1 (not deferred). The idempotency_keys
 *     table (DB PR #720) is used with a 2-minute TTL (in-flight lock window only;
 *     bridge-row presence is the permanent deduplication guard after expiry).
 *     Status machine: processing → completed | failed. Duplicate requests return
 *     the cached response.
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
    Organization, TaskManagementConnection, Ticket, TicketSuggestion, Suggestion, IdempotencyKey,
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

  if (!isNonEmptyObject(IdempotencyKey)) {
    throw new Error('IdempotencyKey collection not available');
  }

  // SecretsManagerClient is constructed here for v1 simplicity.
  // ticket-client's OAuthCredentialManager requires .getSecretValue / .putSecretValue.
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
      return { denied: notFound('Organization not found') };
    }
    if (!await accessControlUtil.hasAccess(org)) {
      return { denied: forbidden('Forbidden') };
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

  /**
   * Constructs a TicketClient for the given connection.
   */
  function buildTicketClient(connection) {
    const connectionObj = {
      id: connection.getId(),
      organizationId: connection.getOrganizationId(),
      provider: connection.getProvider(),
      // instanceUrl is required by TicketClientFactory — it merges it into config as siteUrl
      // for the JiraCloudClient SSRF-safe gateway URL construction.
      instanceUrl: connection.getInstanceUrl(),
      metadata: connection.getMetadata(),
    };
    return TicketClientFactory.create(connectionObj, smClient, httpClient, log);
  }

  /**
   * Classifies a provider API error into one of two auth-failure categories.
   * Returns { isGrantRevoked, isTokenExpired }.
   */
  function classifyProviderError(err) {
    const isGrantRevoked = err.code === 'GRANT_REVOKED'
      || err.code === 'REQUIRES_REAUTH'
      || err.message?.includes('requires re-authorization');
    const isTokenExpired = err.status === 401
      || err.code === 'TOKEN_REFRESH_REQUIRED';
    return { isGrantRevoked, isTokenExpired };
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
      return badRequest('organizationId must be a valid UUID');
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
      return internalServerError('Failed to list connections');
    }

    const filtered = qs?.provider
      ? connections.filter((c) => c.getProvider() === qs.provider)
      : connections;

    return ok(filtered.map(TaskManagementConnectionDto.toJSON));
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
      return badRequest('organizationId must be a valid UUID');
    }

    if (!isValidUUID(connectionId)) {
      return badRequest('connectionId must be a valid UUID');
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
      return internalServerError('Failed to load connection');
    }

    if (!connection) {
      return notFound(`Connection ${connectionId} not found`);
    }

    return ok(TaskManagementConnectionDto.toJSON(connection));
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
      return badRequest('organizationId must be a valid UUID');
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
      return internalServerError('Failed to list tickets');
    }

    // Bulk-load all bridge rows for the org's tickets in one query, then group by ticket ID.
    const bridgeMap = new Map();
    if (tickets.length > 0) {
      const ticketIds = tickets.map((t) => t.getId());
      try {
        const bridges = await TicketSuggestion.allByTicketIds(ticketIds);
        for (const bridge of bridges) {
          const tid = bridge.getTicketId();
          if (!bridgeMap.has(tid)) {
            bridgeMap.set(tid, []);
          }
          bridgeMap.get(tid).push(bridge.getSuggestionId());
        }
      } catch (err) {
        log.warn({ err }, 'Failed to bulk-load bridge rows; response will omit suggestion links');
      }
    }
    const ticketsWithSuggestions = tickets.map(
      (t) => TicketDto.toJSON(t, bridgeMap.get(t.getId()) || []),
    );

    return ok(ticketsWithSuggestions);
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
      return badRequest('organizationId must be a valid UUID');
    }

    if (!hasText(suggestionId)) {
      return badRequest('suggestionId is required');
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
      return internalServerError('Failed to look up ticket');
    }

    if (!bridge) {
      return notFound(`No ticket found for suggestion ${suggestionId}`);
    }

    let ticket;
    try {
      ticket = await Ticket.findById(bridge.getTicketId());
    } catch (err) {
      log.error({ organizationId, ticketId: bridge.getTicketId(), err }, 'Failed to load ticket');
      return internalServerError('Failed to load ticket');
    }

    if (!ticket || ticket.getOrganizationId() !== organizationId) {
      return notFound(`No ticket found for suggestion ${suggestionId}`);
    }

    return ok({
      ...TicketDto.toJSON(ticket),
      suggestionId,
      opportunityId: bridge.getOpportunityId(),
      createdAt: ticket.getCreatedAt?.(),
    });
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
      return badRequest('organizationId must be a valid UUID');
    }

    if (!hasText(opportunityId)) {
      return badRequest('opportunityId is required');
    }

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
    }

    let tickets;
    try {
      tickets = await Ticket.allByOpportunityId(opportunityId);
    } catch (err) {
      log.error({ organizationId, opportunityId, err }, 'Failed to list tickets for opportunity');
      return internalServerError('Failed to list tickets');
    }

    if (tickets.length === 0) {
      return ok([]);
    }

    // Bulk-load bridge rows for all matching tickets, then group by ticket ID.
    const bridgeMap = new Map();
    try {
      const ticketIds = tickets.map((t) => t.getId());
      const bridges = await TicketSuggestion.allByTicketIds(ticketIds);
      for (const bridge of bridges) {
        const tid = bridge.getTicketId();
        if (!bridgeMap.has(tid)) {
          bridgeMap.set(tid, []);
        }
        bridgeMap.get(tid).push(bridge.getSuggestionId());
      }
    } catch (err) {
      log.warn({ opportunityId, err }, 'Failed to bulk-load bridge rows; response will omit suggestion links');
    }

    return ok(tickets.map((t) => TicketDto.toJSON(t, bridgeMap.get(t.getId()) || [])));
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
   * Deduplication is enforced via the `idempotency_keys` table with a 2-minute in-flight
 * lock window; bridge-row presence is the permanent deduplication guard after expiry.
   */
  async function createTicket(requestContext) {
    const { params, data, attributes } = requestContext;

    const callerProfile = attributes?.authInfo?.getProfile?.();
    const createdBy = callerProfile?.sub ?? 'unknown';
    const { organizationId, provider } = params;

    // --- Input validation ---------------------------------------------------

    if (!isValidUUID(organizationId)) {
      return badRequest('organizationId must be a valid UUID');
    }

    if (!hasText(provider)) {
      return badRequest('provider is required');
    }

    if (!SUPPORTED_PROVIDERS.has(provider)) {
      return badRequest(`Unsupported provider '${provider}'. Supported: ${[...SUPPORTED_PROVIDERS].join(', ')}`);
    }

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
    }

    if (!isNonEmptyObject(data) || !hasText(data.summary)) {
      return badRequest('Request body with summary is required');
    }

    if (!hasText(data.projectKey)) {
      return badRequest('projectKey is required');
    }

    // suggestionIds — accept both array (spec) and singular form (compat).
    const suggestionIdsRaw = data.suggestionIds ?? (data.suggestionId ? [data.suggestionId] : []);
    const suggestionIds = Array.isArray(suggestionIdsRaw) ? suggestionIdsRaw : [];

    const primarySuggestionId = suggestionIds[0];

    // mode — 'individual' (default, one ticket per suggestion) or 'grouped' (all suggestions
    // into one ticket). grouped requires at least one suggestionId.
    const mode = data.mode ?? TICKET_MODE_INDIVIDUAL;
    if (mode !== TICKET_MODE_INDIVIDUAL && mode !== TICKET_MODE_GROUPED) {
      return badRequest(`Invalid mode '${mode}'. Supported values: 'individual', 'grouped'.`);
    }
    if (mode === TICKET_MODE_GROUPED && suggestionIds.length === 0) {
      return badRequest("Mode 'grouped' requires at least one suggestionId");
    }

    // Cap per mode: individual ≤15 (N tickets), grouped ≤1500 (1 ticket).
    const suggestionIdsMax = mode === TICKET_MODE_GROUPED
      ? SUGGESTION_IDS_MAX_GROUPED
      : SUGGESTION_IDS_MAX_INDIVIDUAL;
    if (suggestionIds.length > suggestionIdsMax) {
      return badRequest(`suggestionIds must contain at most ${suggestionIdsMax} items for mode '${mode}'`);
    }

    // --- Optional attachments validation (spec §Attachment Validation) ---------
    // attachments: [{ content: base64 string, mimeType: string, filename: string }]
    // Max 1 attachment per request (Lambda 6 MB sync payload limit).
    // Decoded content is held in memory; all MIME/size/magic-byte checks happen
    // inside ticketClient.uploadAttachment — we only pre-validate shape + size here
    // so the caller gets a clear 400 before any downstream work is done.

    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    if (attachments.length > 1) {
      return badRequest('Attachments may contain at most 1 item per request');
    }

    let attachmentBuffer;
    let attachmentMeta;
    if (attachments.length === 1) {
      const att = attachments[0];
      if (!hasText(att.content) || !hasText(att.mimeType) || !hasText(att.filename)) {
        return badRequest('Each attachment must have content (base64), mimeType, and filename');
      }
      if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(att.mimeType)) {
        return badRequest(`Unsupported attachment mimeType '${att.mimeType}'. Allowed: ${[...ALLOWED_ATTACHMENT_MIME_TYPES].join(', ')}`);
      }
      // Strip path separators and control characters (mirrors jira-cloud-client sanitizeFilename).
      const sanitizedFilename = String(att.filename)
        .replace(/[/\\]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 255) || 'attachment';
      const decoded = Buffer.from(att.content, 'base64');
      if (decoded.length === 0) {
        return badRequest('Attachment content must not be empty');
      }
      if (decoded.length > ATTACHMENT_MAX_BYTES) {
        return badRequest(`attachment exceeds maximum size of ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB`);
      }
      attachmentBuffer = decoded;
      attachmentMeta = { mimeType: att.mimeType, filename: sanitizedFilename };
    }

    // Attachment in individual batch mode (N>1 suggestions) is not supported — each ticket
    // would need its own attachment. Upload per-ticket via the attachment endpoint instead.
    if (attachmentBuffer && mode === TICKET_MODE_INDIVIDUAL && suggestionIds.length > 1) {
      return badRequest('Attachments are not supported when creating multiple tickets (individual batch mode). Upload attachments per-ticket via the attachment endpoint.');
    }

    // --- Idempotency-Key enforcement (spec §Idempotent Ticket Creation) --------
    // Derived server-side from the request payload so duplicate requests for the
    // same suggestions are deduplicated regardless of which client sends them.

    const idempotencyKey = createHash('sha256')
      .update(`${data.opportunityId}:${[...suggestionIds].sort().join(',')}`)
      .digest('hex');

    let existingEntry;
    try {
      existingEntry = await IdempotencyKey.findActiveKey(idempotencyKey, organizationId);
    } catch (err) {
      log.error({ organizationId, err }, 'Failed to look up idempotency key');
      return internalServerError('Service unavailable');
    }

    if (existingEntry) {
      const status = existingEntry.getStatus();
      if (status === 'completed' || status === 'failed') {
        const cached = existingEntry.getResponse();
        return createResponse(cached.body, cached.statusCode);
      }
      // status === 'processing'
      log.warn({ organizationId, lockId: existingEntry.getId(), createdAt: existingEntry.getCreatedAt() }, 'Returning 409 — idempotency lock still processing');
      return createResponse({ message: 'Request already in flight', retryAfter: 2 }, STATUS_CONFLICT);
    }

    // --- Resolve the active connection ----------------------------------------

    const { connectionId } = data;

    if (!connectionId) {
      return badRequest('connectionId is required');
    }

    if (!isValidUUID(connectionId)) {
      return badRequest('connectionId must be a valid UUID');
    }

    let connection;
    try {
      const conn = await loadConnectionForOrg(organizationId, connectionId);
      if (!conn) {
        return notFound(`Connection ${connectionId} not found for organization ${organizationId}`);
      }
      if (conn.getStatus() === 'requires_reauth') {
        return createResponse({ message: 'connection_reauth_required' }, STATUS_CONFLICT);
      }
      if (conn.getStatus() !== 'active') {
        return notFound(`Active ${provider} connection ${connectionId} not found for organization ${organizationId}`);
      }
      connection = conn;
    } catch (err) {
      log.error({ organizationId, provider, err }, 'Failed to load task-management connection');
      return internalServerError('Failed to load task-management connection');
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
          return notFound(`Suggestion ${missing} not found`);
        }
      } catch (err) {
        log.error({ err }, 'Failed to validate suggestions');
        return internalServerError('Failed to validate suggestion');
      }
    } else if (primarySuggestionId) {
      let suggestion;
      try {
        suggestion = await Suggestion.findById(primarySuggestionId);
      } catch (err) {
        log.error({ primarySuggestionId, err }, 'Failed to look up suggestion');
        return internalServerError('Failed to validate suggestion');
      }
      if (!suggestion) {
        return notFound(`Suggestion ${primarySuggestionId} not found`);
      }
    }

    // --- Pre-flight: verify none of the suggestions already have a ticket -------

    if (suggestionIds.length > 0) {
      let alreadyTicketed;
      try {
        const bridges = await TicketSuggestion.allBySuggestionIds(suggestionIds);
        alreadyTicketed = bridges.map((b) => b.getSuggestionId());
      } catch (err) {
        log.error({ err }, 'Failed to check existing ticket bridges');
        return internalServerError('Failed to validate suggestion ticket status');
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
    let idempotencyKeyEntry;
    try {
      idempotencyKeyEntry = await IdempotencyKey.create({
        key: idempotencyKey,
        organizationId,
        endpoint: `POST /task-management/${provider}/tickets`,
        status: 'processing',
        expiresAt,
      });
    } catch (err) {
      const isUniqueViolation = err.message?.includes('unique')
        || err.message?.includes('duplicate')
        || err.code === '23505';
      if (isUniqueViolation) {
        return createResponse({ message: 'Request already in flight' }, STATUS_CONFLICT);
      }
      log.error({ organizationId, err }, 'Failed to insert idempotency key');
      return internalServerError('Service unavailable');
    }

    async function markIdempotencyDone(responseBody, statusCode) {
      try {
        await idempotencyKeyEntry
          .setStatus('completed')
          .setResponse({ body: responseBody, statusCode })
          .save();
      } catch (err) {
        log.warn({ err }, 'Failed to cache completed response in idempotency lock');
      }
    }

    async function markIdempotencyFailed() {
      try {
        await idempotencyKeyEntry.remove();
      } catch (err) {
        log.warn({ err }, 'Failed to delete idempotency key after failure');
      }
    }

    // --- Create the ticket via the provider client ----------------------------

    const ticketClient = buildTicketClient(connection);

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
            const { isGrantRevoked, isTokenExpired } = classifyProviderError(batchTicketErr);

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
                  ticket: TicketDto.toJSON(batchTicket),
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
      const allSuccess = results.every((r) => r.status === STATUS_CREATED);
      if (hasSuccess) {
        connection.setLastUsedAt(new Date().toISOString());
        connection.setErrorMessage(null);
      }
      connection.save().catch((saveErr) => {
        log.warn({ saveErr }, 'Failed to update connection metadata after batch');
      });

      const batchResponseBody = { mode, results };
      if (allSuccess) {
        // Only cache when all items succeeded — partial failures must remain retryable.
        await markIdempotencyDone(batchResponseBody, STATUS_MULTI_STATUS);
      } else {
        await markIdempotencyFailed();
      }
      return createResponse(batchResponseBody, STATUS_MULTI_STATUS);
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
        const { isGrantRevoked, isTokenExpired } = classifyProviderError(err);

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
        return internalServerError(body.message ?? 'Internal error');
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
        return internalServerError(body.message ?? 'Internal error');
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
        mode,
        ...TicketDto.toJSON(groupedTicket),
        suggestionIds,
        ...(linkWarnings.length > 0 ? { linkWarnings } : {}),
        ...(groupedAttachmentWarning ? { attachmentWarning: groupedAttachmentWarning } : {}),
      };
      await markIdempotencyDone(groupedResponseBody, STATUS_CREATED);
      return created(groupedResponseBody);
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
      const { isGrantRevoked, isTokenExpired } = classifyProviderError(err);

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
      return internalServerError(body.message ?? 'Internal error');
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
      return internalServerError(body.message ?? 'Internal error');
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
        return internalServerError(body.message ?? 'Internal error');
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
      mode,
      ...TicketDto.toJSON(ticket),
      suggestionId: primarySuggestionId ?? undefined,
      ...(attachmentWarning ? { attachmentWarning } : {}),
    };
    await markIdempotencyDone(responseBody, STATUS_CREATED);
    return created(responseBody);
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
      return badRequest('organizationId must be a valid UUID');
    }

    if (!isValidUUID(connectionId)) {
      return badRequest('connectionId must be a valid UUID');
    }

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
    }

    let connection;
    try {
      const conn = await loadConnectionForOrg(organizationId, connectionId);
      if (!conn) {
        return notFound(`Active connection ${connectionId} not found for organization ${organizationId}`);
      }
      if (conn.getStatus() === 'requires_reauth') {
        return createResponse({ message: 'connection_reauth_required' }, STATUS_CONFLICT);
      }
      if (conn.getStatus() !== 'active') {
        return notFound(`Active connection ${connectionId} not found for organization ${organizationId}`);
      }
      connection = conn;
    } catch (err) {
      log.error({ organizationId, connectionId, err }, 'Failed to load connection for listProjects');
      return internalServerError('Failed to load task-management connection');
    }

    let projects;
    try {
      const ticketClient = buildTicketClient(connection);
      projects = await ticketClient.listProjects();
    } catch (err) {
      const { isGrantRevoked, isTokenExpired } = classifyProviderError(err);

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
      return internalServerError('Failed to list projects');
    }

    return ok({ projects });
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
    const { params, queryStringParameters: qs } = requestContext;
    const { organizationId, connectionId } = params;
    const projectId = qs?.projectId ?? null;

    if (!isValidUUID(organizationId)) {
      return badRequest('organizationId must be a valid UUID');
    }

    if (!isValidUUID(connectionId)) {
      return badRequest('connectionId must be a valid UUID');
    }

    if (!hasText(projectId)) {
      return badRequest('projectId query parameter is required');
    }

    if (!/^\d+$/.test(projectId)) {
      return badRequest('projectId must be a numeric Jira project ID');
    }

    const { denied } = await loadOrgWithAccess(organizationId);
    if (denied) {
      return denied;
    }

    let connection;
    try {
      const conn = await loadConnectionForOrg(organizationId, connectionId);
      if (!conn) {
        return notFound(`Active connection ${connectionId} not found for organization ${organizationId}`);
      }
      if (conn.getStatus() === 'requires_reauth') {
        return createResponse({ message: 'connection_reauth_required' }, STATUS_CONFLICT);
      }
      if (conn.getStatus() !== 'active') {
        return notFound(`Active connection ${connectionId} not found for organization ${organizationId}`);
      }
      connection = conn;
    } catch (err) {
      log.error({ organizationId, connectionId, err }, 'Failed to load connection for listIssueTypes');
      return internalServerError('Failed to load task-management connection');
    }

    let issueTypes;
    try {
      const ticketClient = buildTicketClient(connection);
      issueTypes = await ticketClient.listIssueTypes(projectId);
    } catch (err) {
      const { isGrantRevoked, isTokenExpired } = classifyProviderError(err);

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
      return internalServerError('Failed to list issue types');
    }

    return ok({ issueTypes });
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
