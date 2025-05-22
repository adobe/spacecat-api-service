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
    description: 'Returns site details for the given UUID.',
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
    description: 'Returns site details for the given base URL (plain URL, not base64-encoded).',
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
    description: 'Returns site metrics for the given site ID, metric, and source. The following sources are supported: "ahrefs" and "rum". For the "ahrefs" source, the following metrics are supported: "organic-keywords" and "organic-traffic". For the "rum" source, the following metrics are supported: "all-traffic".',
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The ID of the site'),
      metric: z.enum(['organic-keywords', 'organic-traffic', 'all-traffic']).describe('The metric to retrieve. For ahrefs source: organic-keywords, organic-traffic. For rum source: all-traffic'),
      source: z.enum(['ahrefs', 'rum']).describe('The source of the metrics. Supported sources: ahrefs, rum'),
    }).strict(),
    fetchFn: ({ siteId, metric, source }) => sitesController.getSiteMetricsBySource(
      { params: { siteId, metric, source } },
      context,
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
