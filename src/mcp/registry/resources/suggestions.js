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

/* c8 ignore start */

import { createProxyResource } from '../../../utils/jsonrpc.js';

export function createSuggestionResources(suggestionsController, context) {
  if (!suggestionsController) {
    return {};
  }

  return {
    suggestionsByOpportunityId: createProxyResource({
      name: 'suggestionsByOpportunityId',
      description: '\n'
        + '<use_case>Use this resource template to obtain all suggestions for a specific opportunity.</use_case>\n'
        + '<important_notes>'
        + '1. You may need a tool to obtain site and opportunity information that yields the required IDs.\n'
        + '2. Both site ID and opportunity ID must be valid UUIDs.\n'
        + '3. The opportunity must belong to the specified site.\n'
        + '4. Returns actionable suggestions with type, rank, data, and KPI deltas.\n'
        + '</important_notes>\n'
        + '',
      uriTemplate: 'spacecat-data://sites/{siteId}/opportunities/{opportunityId}/suggestions',
      fetchFn: ({ siteId, opportunityId }) => suggestionsController.getAllForOpportunity({
        ...context,
        params: { siteId, opportunityId },
      }),
      notFoundMessage: ({ siteId, opportunityId }) => `Suggestions for opportunity ${opportunityId} in site ${siteId} not found`,
    }),
    suggestionsByOpportunityIdAndStatus: createProxyResource({
      name: 'suggestionsByOpportunityIdAndStatus',
      description: '\n'
        + '<use_case>Use this resource template to obtain suggestions for an opportunity filtered by status.</use_case>\n'
        + '<important_notes>'
        + '1. You may need a tool to obtain site and opportunity information that yields the required IDs.\n'
        + '2. Both site ID and opportunity ID must be valid UUIDs.\n'
        + '3. The opportunity must belong to the specified site.\n'
        + '4. Common status values include: "new", "approved", "rejected", "implemented".\n'
        + '5. Useful for filtering suggestions by their implementation state.\n'
        + '</important_notes>\n'
        + '',
      uriTemplate: 'spacecat-data://sites/{siteId}/opportunities/{opportunityId}/suggestions/status/{status}',
      fetchFn: ({ siteId, opportunityId, status }) => suggestionsController.getByStatus({
        ...context,
        params: { siteId, opportunityId, status },
      }),
      notFoundMessage: ({ siteId, opportunityId, status }) => `Suggestions for opportunity ${opportunityId} in site ${siteId} with status ${status} not found`,
    }),
    suggestionBySiteIdOpportunityIdAndId: createProxyResource({
      name: 'suggestionBySiteIdOpportunityIdAndId',
      description: '\n'
        + '<use_case>Use this resource template to obtain details of a specific suggestion by its ID.</use_case>\n'
        + '<important_notes>'
        + '1. You may need a tool to obtain site and opportunity information that yields the required IDs.\n'
        + '2. Site ID, opportunity ID, and suggestion ID must all be valid UUIDs.\n'
        + '3. The suggestion must belong to the specified opportunity and site.\n'
        + '4. Returns comprehensive suggestion details including KPI deltas and implementation data.\n'
        + '</important_notes>\n'
        + '',
      uriTemplate: 'spacecat-data://sites/{siteId}/opportunities/{opportunityId}/suggestions/{suggestionId}',
      fetchFn: ({ siteId, opportunityId, suggestionId }) => suggestionsController.getByID({
        ...context,
        params: { siteId, opportunityId, suggestionId },
      }),
      notFoundMessage: ({ siteId, opportunityId, suggestionId }) => `Suggestion ${suggestionId} for opportunity ${opportunityId} in site ${siteId} not found`,
    }),
  };
}

/* c8 ignore end */
