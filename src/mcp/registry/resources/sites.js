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

export function createSiteResources(sitesController, context) {
  if (!sitesController) {
    return {};
  }

  return {
    site: createProxyResource({
      name: 'site',
      description: 'Returns site details for the given UUID.',
      uriTemplate: 'spacecat-data://sites/{siteId}',
      fetchFn: ({ siteId }) => sitesController.getByID({
        params: { siteId },
      }),
      notFoundMessage: ({ siteId }) => `Site ${siteId} not found`,
    }),
    siteByBaseURL: createProxyResource({
      name: 'siteByBaseURL',
      description: 'Returns site details for the given base URL (base64-encoded).',
      uriTemplate: 'spacecat-data://sites/by-base-url/{baseURLBase64}',
      fetchFn: ({ baseURLBase64 }) => sitesController.getByBaseURL({
        params: { baseURL: baseURLBase64 },
      }),
      notFoundMessage: ({ baseURLBase64 }) => `Site with base URL ${baseURLBase64} not found`,
    }),
    siteMetricsBySource: createProxyResource({
      name: 'siteMetricsBySource',
      description: 'Returns site metrics for the given site ID, metric, and source. The following sources are supported: "ahrefs" and "rum". For the "ahrefs" source, the following metrics are supported: "organic-keywords" and "organic-traffic". For the "rum" source, the following metrics are supported: "all-traffic".',
      uriTemplate: 'spacecat-data://sites/{siteId}/metrics/{metric}/{source}',
      fetchFn: ({ siteId, metric, source }) => sitesController.getSiteMetricsBySource(
        { params: { siteId, metric, source } },
        context,
      ),
      notFoundMessage: ({ siteId, metric, source }) => `Metrics for site ${siteId}, metric ${metric}, and source ${source} not found`,
    }),
  };
}

/* c8 ignore end */
