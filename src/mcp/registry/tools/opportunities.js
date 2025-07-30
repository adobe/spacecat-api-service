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

export function createOpportunityTools(opportunitiesController, context) {
  if (!opportunitiesController) {
    return {};
  }

  /* ------------- getAllOpportunitiesForSite ---------------- */
  const getAllOpportunitiesForSiteTool = createProxyTool({
    annotations: {
      title: 'Get All Opportunities for Site',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: '\n'
      + '<use_case>Use this tool to obtain all opportunities for a specific site. Returns opportunities with details like type, status, title, description, and guidance for improvement.</use_case>\n'
      + '<important_notes>'
      + '1. You may need another tool to obtain site information that yields the site\'s ID.\n'
      + '2. The site ID must be a valid UUID.\n'
      + '3. Returns opportunities which represent potential improvements or issues found during audits.\n'
      + '4. Each opportunity includes runbook information and actionable guidance.\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The UUID of the site to fetch opportunities for'),
    }).strict(),
    fetchFn: ({ siteId }) => opportunitiesController.getAllForSite({
      ...context,
      params: { siteId },
    }),
    notFoundMessage: ({ siteId }) => `Opportunities for site ${siteId} not found`,
  });

  /* ------------- getOpportunitiesByStatus ---------------- */
  const getOpportunitiesByStatusTool = createProxyTool({
    annotations: {
      title: 'Get Opportunities by Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: '\n'
      + '<use_case>Use this tool to obtain opportunities for a specific site filtered by status. Useful for finding opportunities in specific states like "new", "in-progress", "resolved", etc.</use_case>\n'
      + '<important_notes>'
      + '1. You may need another tool to obtain site information that yields the site\'s ID.\n'
      + '2. The site ID must be a valid UUID.\n'
      + '3. Common status values include: "new", "acknowledged", "resolved", "ignored".\n'
      + '4. Status filtering helps prioritize opportunities based on their current state.\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The UUID of the site to fetch opportunities for'),
      status: z.string().describe('The status to filter opportunities by (e.g., "new", "acknowledged", "resolved", "ignored")'),
    }).strict(),
    fetchFn: ({ siteId, status }) => opportunitiesController.getByStatus({
      ...context,
      params: { siteId, status },
    }),
    notFoundMessage: ({ siteId, status }) => `Opportunities for site ${siteId} with status ${status} not found`,
  });

  /* ------------- getOpportunityById ---------------- */
  const getOpportunityByIdTool = createProxyTool({
    annotations: {
      title: 'Get Opportunity by ID',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: '\n'
      + '<use_case>Use this tool to obtain details of a specific opportunity by its ID. Returns comprehensive information including title, description, guidance, runbook, and associated audit data.</use_case>\n'
      + '<important_notes>'
      + '1. You may need another tool to obtain site information that yields the site\'s ID.\n'
      + '2. Both site ID and opportunity ID must be valid UUIDs.\n'
      + '3. The opportunity must belong to the specified site.\n'
      + '4. Returns detailed guidance and actionable steps for addressing the opportunity.\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The UUID of the site that owns the opportunity'),
      opportunityId: z.string().uuid().describe('The UUID of the opportunity to fetch'),
    }).strict(),
    fetchFn: ({ siteId, opportunityId }) => opportunitiesController.getByID({
      ...context,
      params: { siteId, opportunityId },
    }),
    notFoundMessage: ({ siteId, opportunityId }) => `Opportunity ${opportunityId} for site ${siteId} not found`,
  });

  return {
    getAllOpportunitiesForSite: getAllOpportunitiesForSiteTool,
    getOpportunitiesByStatus: getOpportunitiesByStatusTool,
    getOpportunityById: getOpportunityByIdTool,
  };
}

/* c8 ignore end */
