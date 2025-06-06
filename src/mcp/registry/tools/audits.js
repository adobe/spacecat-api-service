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

export function createAuditTools(auditsController) {
  if (!auditsController) {
    return {};
  }

  /* ------------- getAuditByBaseURL ---------------- */
  const getLatestAuditBySiteIdAndTypeTool = createProxyTool({
    annotations: {
      title: 'Get Latest Audit By Site ID and Type',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: '\n'
      + '<use_case>Use this tool to obtain the latest audit results of a given audit type for a site you know its ID of.</use_case>\n'
      + '<important_notes>'
      + '1. You may need another tool to obtain site information that yields the site\'s ID.\n'
      + '2. The audit type must be one of the supported types. Ask the user to provide it.\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      auditType: z.string().describe('The type of the audit to fetch'),
      siteId: z.string().uuid().describe('The UUID of the site to fetch'),
    }).strict(),
    fetchFn: ({ auditType, siteId }) => auditsController.getLatestForSite({
      params: { auditType, siteId },
    }),
    notFoundMessage: ({ siteId }) => `Audit with base URL ${siteId} not found`,
  });

  /* ------------- getAllAuditsByBaseURL ---------------- */
  const getAllAuditsBySiteIdAndTypeTool = createProxyTool({
    annotations: {
      title: 'Get All Audits By Site ID and Type',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: '\n'
      + '<use_case>Use this tool to obtain all audit results of a given audit type for a site you know its ID of.</use_case>\n'
      + '<important_notes>'
      + '1. You may need another tool to obtain site information that yields the site\'s ID.\n'
      + '2. The audit type must be one of the supported types. Ask the user to provide it.\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      auditType: z.string().describe('The type of the audit to fetch'),
      siteId: z.string().uuid().describe('The UUID of the site to fetch'),
    }).strict(),
    fetchFn: ({ auditType, siteId }) => auditsController.getAllForSite({
      params: { auditType, siteId },
    }),
    notFoundMessage: ({ siteId }) => `Audit with base URL ${siteId} not found`,
  });

  return {
    getLatestAuditBySiteIdAndType: getLatestAuditBySiteIdAndTypeTool,
    getAllAuditsBySiteIdAndType: getAllAuditsBySiteIdAndTypeTool,
  };
}

/* c8 ignore end */
