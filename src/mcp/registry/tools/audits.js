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
    description: 'Returns audit details for the given site ID and audit type.',
    inputSchema: z.object({
      auditType: z.string().describe('The type of the audit to fetch'),
      siteId: z.string().uuid().describe('The UUID of the site to fetch'),
    }).strict(),
    fetchFn: ({ auditType, siteId }) => auditsController.getLatestForSite({
      params: { auditType, siteId },
    }),
    notFoundMessage: ({ baseURL }) => `Audit with base URL ${baseURL} not found`,
  });

  return {
    getLatestAuditBySiteIdAndType: getLatestAuditBySiteIdAndTypeTool,
  };
}

/* c8 ignore end */
