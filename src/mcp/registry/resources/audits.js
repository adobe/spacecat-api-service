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

export function createAuditResources(auditsController) {
  if (!auditsController) {
    return {};
  }

  return {
    auditBySiteIdAndType: createProxyResource({
      name: 'auditBySiteIdAndType',
      description: 'Returns audit details for the given site ID and audit type.',
      uriTemplate: 'spacecat-data://audits/latest/{auditType}/{siteId}',
      fetchFn: ({ auditType, siteId }) => auditsController.getLatestForSite({
        params: { auditType, siteId },
      }),
      notFoundMessage: ({ auditType, siteId }) => `Audit of ${auditType} for site ${siteId} not found`,
    }),
  };
}

/* c8 ignore end */
