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

export function createSiteTools(sitesController, context) {
  if (!sitesController) {
    return {};
  }

  /* -------------------- getSite by UUID -------------------- */
  const getSiteTool = createProxyTool({
    annotations: {
      title: 'Get Site by ID',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: '\n'
      + '<use_case>Use this tool to obtain the details of a site you know its ID of.</use_case>\n'
      + '<important_notes>'
      + '1. You may need a tool to obtain site information by its base URL if you don\'t have the ID; or ask the user for it.\n'
      + '2. The site ID must be a valid UUID.\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The UUID of the site to fetch'),
    }).strict(),
    fetchFn: ({ siteId }) => sitesController.getByID({ params: { siteId } }),
    notFoundMessage: ({ siteId }) => `Site ${siteId} not found`,
  });

  /* ------------- getSiteByBaseURL ---------------- */
  const getSiteByBaseURLTool = createProxyTool({
    annotations: {
      title: 'Get Site by Base URL',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: '\n'
      + '<use_case>Use this tool to obtain the details of a site you know its base URL of.</use_case>\n'
      + '<important_notes>'
      + '1. The base URL must be a valid URL (e.g., https://example.com). The tool will handle encoding internally.\n'
      + '2. You may need to ask the user for the base URL.\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      baseURL: z.string().url().describe('The base URL of the site to fetch'),
    }).strict(),
    fetchFn: ({ baseURL }) => {
      const encoded = Buffer.from(baseURL, 'utf-8').toString('base64');
      return sitesController.getByBaseURL({ params: { baseURL: encoded } });
    },
    notFoundMessage: ({ baseURL }) => `Site with base URL ${baseURL} not found`,
  });

  /* ------------- getSiteMetricsBySource ---------------- */
  const getSiteMetricsBySourceTool = createProxyTool({
    name: 'getSiteMetricsBySource',
    description: '\n'
      + '<use_case>Use this tool to obtain the metrics of a site by its ID, metric type, and source.</use_case>\n'
      + '<important_notes>'
      + '1. You may need a tool or resource template to obtain site information that yields the site\'s ID.\n'
      + '2. The metric must be one of the supported metrics, and the source must be a valid source identifier.\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The ID of the site'),
      metric: z
        .enum(['organic-keywords', 'organic-keywords-nonbranded', 'organic-traffic', 'all-traffic'])
        .describe('The metric to retrieve. For ahrefs source: organic-keywords, organic-keywords-nonbranded, organic-traffic. For rum source: all-traffic'),
      source: z.enum(['ahrefs', 'rum']).describe('The source of the metrics. Supported sources: ahrefs, rum'),
    }).strict(),
    fetchFn: ({ siteId, metric, source }) => sitesController.getSiteMetricsBySource(
      { ...context, params: { siteId, metric, source } },
    ),
    notFoundMessage: ({ siteId, metric, source }) => `Metrics for site ${siteId}, metric ${metric}, and source ${source} not found`,
  });
  return {
    getSite: getSiteTool,
    getSiteByBaseURL: getSiteByBaseURLTool,
    getSiteMetricsBySource: getSiteMetricsBySourceTool,
  };
}

/* c8 ignore end */
