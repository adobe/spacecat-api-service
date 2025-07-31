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

export function createOpportunityResources(opportunitiesController, context) {
  if (!opportunitiesController) {
    return {};
  }

  return {
    opportunitiesBySiteId: createProxyResource({
      name: 'opportunitiesBySiteId',
      description: '\n'
        + '<use_case>Use this resource template to obtain all opportunities for a site you know its ID of.</use_case>\n'
        + '<important_notes>'
        + '1. You may need a tool to obtain site information that yields the site\'s ID.\n'
        + '2. The site ID must be a valid UUID.\n'
        + '3. Returns all opportunities with details like type, status, title, and guidance.\n'
        + '</important_notes>\n'
        + '',
      uriTemplate: 'spacecat-data://sites/{siteId}/opportunities',
      fetchFn: ({ siteId }) => opportunitiesController.getAllForSite({
        ...context,
        params: { siteId },
      }),
      notFoundMessage: ({ siteId }) => `Opportunities for site ${siteId} not found`,
    }),
    opportunitiesBySiteIdAndStatus: createProxyResource({
      name: 'opportunitiesBySiteIdAndStatus',
      description: '\n'
        + '<use_case>Use this resource template to obtain opportunities for a site filtered by status.</use_case>\n'
        + '<important_notes>'
        + '1. You may need a tool to obtain site information that yields the site\'s ID.\n'
        + '2. The site ID must be a valid UUID.\n'
        + '3. Common status values include: "new", "acknowledged", "resolved", "ignored".\n'
        + '4. Useful for filtering opportunities by their current state.\n'
        + '</important_notes>\n'
        + '',
      uriTemplate: 'spacecat-data://sites/{siteId}/opportunities/status/{status}',
      fetchFn: ({ siteId, status }) => opportunitiesController.getByStatus({
        ...context,
        params: { siteId, status },
      }),
      notFoundMessage: ({ siteId, status }) => `Opportunities for site ${siteId} with status ${status} not found`,
    }),
    opportunityBySiteIdAndId: createProxyResource({
      name: 'opportunityBySiteIdAndId',
      description: '\n'
        + '<use_case>Use this resource template to obtain details of a specific opportunity by its ID.</use_case>\n'
        + '<important_notes>'
        + '1. You may need a tool to obtain site information that yields the site\'s ID.\n'
        + '2. Both site ID and opportunity ID must be valid UUIDs.\n'
        + '3. The opportunity must belong to the specified site.\n'
        + '4. Returns comprehensive opportunity details including guidance and runbook information.\n'
        + '</important_notes>\n'
        + '',
      uriTemplate: 'spacecat-data://sites/{siteId}/opportunities/{opportunityId}',
      fetchFn: ({ siteId, opportunityId }) => opportunitiesController.getByID({
        ...context,
        params: { siteId, opportunityId },
      }),
      notFoundMessage: ({ siteId, opportunityId }) => `Opportunity ${opportunityId} for site ${siteId} not found`,
    }),
  };
}

/* c8 ignore end */
