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

import { z } from 'zod';
import { createProxyTool } from '../../../utils/jsonrpc.js';

export function createSuggestionTools(suggestionsController, context) {
  if (!suggestionsController) {
    return {};
  }

  /* ------------- getAllSuggestionsForOpportunity ---------------- */
  const getAllSuggestionsForOpportunityTool = createProxyTool({
    annotations: {
      title: 'Get All Suggestions for Opportunity',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: '\n'
      + '<use_case>Use this tool to obtain all suggestions for a specific opportunity. Returns actionable suggestions with details like type, rank, data, KPI deltas, and status.</use_case>\n'
      + '<important_notes>'
      + '1. You may need another tool to obtain site and opportunity information that yields the required IDs.\n'
      + '2. Both site ID and opportunity ID must be valid UUIDs.\n'
      + '3. The opportunity must belong to the specified site.\n'
      + '4. Returns suggestions which are specific actionable recommendations for addressing opportunities.\n'
      + '5. Each suggestion includes rank (priority), data (specific details), and kpiDeltas (expected impact).\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The UUID of the site that owns the opportunity'),
      opportunityId: z.string().uuid().describe('The UUID of the opportunity to fetch suggestions for'),
    }).strict(),
    fetchFn: ({ siteId, opportunityId }) => suggestionsController.getAllForOpportunity({
      ...context,
      params: { siteId, opportunityId },
    }),
    notFoundMessage: ({ siteId, opportunityId }) => `Suggestions for opportunity ${opportunityId} in site ${siteId} not found`,
  });

  /* ------------- getSuggestionsByStatus ---------------- */
  const getSuggestionsByStatusTool = createProxyTool({
    annotations: {
      title: 'Get Suggestions by Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: '\n'
      + '<use_case>Use this tool to obtain suggestions for a specific opportunity filtered by status. Useful for finding suggestions in specific states like "new", "approved", "implemented", etc.</use_case>\n'
      + '<important_notes>'
      + '1. You may need another tool to obtain site and opportunity information that yields the required IDs.\n'
      + '2. Both site ID and opportunity ID must be valid UUIDs.\n'
      + '3. The opportunity must belong to the specified site.\n'
      + '4. Common status values include: "new", "approved", "rejected", "implemented".\n'
      + '5. Status filtering helps prioritize suggestions based on their implementation state.\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The UUID of the site that owns the opportunity'),
      opportunityId: z.string().uuid().describe('The UUID of the opportunity to fetch suggestions for'),
      status: z.string().describe('The status to filter suggestions by (e.g., "new", "approved", "rejected", "implemented")'),
    }).strict(),
    fetchFn: ({ siteId, opportunityId, status }) => suggestionsController.getByStatus({
      ...context,
      params: { siteId, opportunityId, status },
    }),
    notFoundMessage: ({ siteId, opportunityId, status }) => `Suggestions for opportunity ${opportunityId} in site ${siteId} with status ${status} not found`,
  });

  /* ------------- getSuggestionById ---------------- */
  const getSuggestionByIdTool = createProxyTool({
    annotations: {
      title: 'Get Suggestion by ID',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: '\n'
      + '<use_case>Use this tool to obtain details of a specific suggestion by its ID. Returns comprehensive information including type, rank, data, KPI deltas, and implementation status.</use_case>\n'
      + '<important_notes>'
      + '1. You may need another tool to obtain site and opportunity information that yields the required IDs.\n'
      + '2. Site ID, opportunity ID, and suggestion ID must all be valid UUIDs.\n'
      + '3. The suggestion must belong to the specified opportunity and site.\n'
      + '4. Returns detailed suggestion data including expected KPI impact and specific implementation details.\n'
      + '5. Rank indicates the priority/importance of this suggestion relative to others.\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The UUID of the site that owns the opportunity'),
      opportunityId: z.string().uuid().describe('The UUID of the opportunity that owns the suggestion'),
      suggestionId: z.string().uuid().describe('The UUID of the suggestion to fetch'),
    }).strict(),
    fetchFn: ({ siteId, opportunityId, suggestionId }) => suggestionsController.getByID({
      ...context,
      params: { siteId, opportunityId, suggestionId },
    }),
    notFoundMessage: ({ siteId, opportunityId, suggestionId }) => `Suggestion ${suggestionId} for opportunity ${opportunityId} in site ${siteId} not found`,
  });

  return {
    getAllSuggestionsForOpportunity: getAllSuggestionsForOpportunityTool,
    getSuggestionsByStatus: getSuggestionsByStatusTool,
    getSuggestionById: getSuggestionByIdTool,
  };
}

/* c8 ignore end */
