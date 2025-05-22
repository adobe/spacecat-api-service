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

export function createSiteResources(sitesController) {
  if (!sitesController) {
    return {};
  }

  return {
    site: createProxyResource({
      name: 'site',
      description: 'Returns site details for the given UUID.',
      uriTemplate: 'sites://{siteId}',
      fetchFn: ({ siteId }) => sitesController.getByID({ params: { siteId } }),
      notFoundMessage: ({ siteId }) => `Site ${siteId} not found`,
    }),
    siteByBaseURL: createProxyResource({
      name: 'siteByBaseURL',
      description: 'Returns site details for the given base URL (plain URL, not base64-encoded).',
      uriTemplate: 'sites://baseurl/{baseURL}',
      fetchFn: ({ baseURL }) => {
        const encoded = Buffer.from(baseURL, 'utf-8').toString('base64');
        return sitesController.getByBaseURL({ params: { baseURL: encoded } });
      },
      notFoundMessage: ({ baseURL }) => `Site with base URL ${baseURL} not found`,
    }),
  };
}

/* c8 ignore end */
