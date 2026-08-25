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

export const TicketDto = {
  /**
   * Converts a Ticket entity to a plain response object.
   * connectionId is included per the spec response shape.
   *
   * @param {object} ticket
   * @param {Array<{suggestionId: string, opportunityId: string}>} [suggestions]
   */
  toJSON(ticket, suggestions) {
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
  },
};
