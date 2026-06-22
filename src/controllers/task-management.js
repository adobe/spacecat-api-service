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

import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createResponse } from '@adobe/spacecat-shared-http-utils';
import { hasText, isNonEmptyObject, isValidUUID } from '@adobe/spacecat-shared-utils';
// eslint-disable-next-line import/no-unresolved
import { TicketClientFactory } from '@adobe/spacecat-shared-ticket-client';

import {
  STATUS_BAD_REQUEST,
  STATUS_CREATED,
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_NOT_FOUND,
} from '../utils/constants.js';

const STATUS_CONFLICT = 409;

/**
 * TaskManagementController — creates Jira tickets on behalf of an organization.
 *
 * Route: POST /organizations/:organizationId/task-management/:provider/tickets
 *
 * v1 scope (intentional simplifications vs. architecture spec):
 *   - No Idempotency-Key header enforcement (deferred to v2)
 *   - Connection resolved by org + provider URL params; spec also supports explicit
 *     connectionId in the body (deferred to v2 when multiple connections per org needed)
 *   - suggestionIds not required; v1 links tickets to an opportunityId directly
 *   - priority field deferred to v2 (JiraCloudClient maps it to a Jira field not yet configured)
 *
 * Flow:
 *   1. Validate inputs (organizationId, provider, required ticket fields).
 *   2. Load the active TaskManagementConnection for the org + provider.
 *      → 404 when no active connection exists (including degraded connections).
 *   3. Call the provider's ticket client to create the ticket.
 *      The client handles OAuth token refresh and Jira API communication.
 *   4. Persist a Ticket record with the returned provider identifiers.
 *   5. Return 201 with the persisted ticket data to the UI.
 *
 * @param {object} context - Universal serverless function context.
 * @param {object} context.dataAccess - Data access layer (models).
 * @param {import('pino').Logger} context.log - Logger.
 * @returns {object} Controller with a `createTicket` method.
 */
function TaskManagementController(context) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }

  const { dataAccess, log } = context;

  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { TaskManagementConnection, Ticket } = dataAccess;

  if (!isNonEmptyObject(TaskManagementConnection)) {
    throw new Error('TaskManagementConnection collection not available');
  }

  if (!isNonEmptyObject(Ticket)) {
    throw new Error('Ticket collection not available');
  }

  // AWS SDK auto-detects region from the Lambda execution environment.
  // Constructed once per controller instance (not per request) to reuse the connection pool.
  const smClient = new SecretsManagerClient();

  // Wrap global fetch so TicketClientFactory receives the expected { fetch } interface.
  // fetch is available globally in Node 18+ (Lambda runtime).
  const httpClient = { fetch: globalThis.fetch };

  /**
   * Creates a Jira ticket for an opportunity and persists the result.
   *
   * Expected request body:
   * ```json
   * {
   *   "projectKey":   "string (required) — Jira project key, e.g. 'ASO'",
   *   "summary":      "string (required)",
   *   "description":  "string (optional, plain text — backend converts to ADF)",
   *   "issueType":    "string (optional, defaults to 'Task')",
   *   "labels":       ["string"] (optional),
   *   "opportunityId": "uuid"  (optional)
   * }
   * ```
   *
   * @param {object} requestContext - The parsed request context.
   * @param {object} requestContext.params - Path parameters.
   * @param {string} requestContext.params.organizationId - Organization UUID.
   * @param {string} requestContext.params.provider - Provider key (e.g. 'jira_cloud').
   * @param {object} requestContext.data - Parsed request body.
   * @returns {Promise<Response>} 201 with ticket data, or an error response.
   */
  async function createTicket(requestContext) {
    const { params, data } = requestContext;
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

    return createResponse(
      {
        id: ticket.getId(),
        ticketId: ticket.getTicketId(),
        ticketKey: ticket.getTicketKey(),
        ticketUrl: ticket.getTicketUrl(),
        ticketStatus: ticket.getTicketStatus(),
        opportunityId: ticket.getOpportunityId(),
      },
      STATUS_CREATED,
    );
  }

  return { createTicket };
}

export default TaskManagementController;
