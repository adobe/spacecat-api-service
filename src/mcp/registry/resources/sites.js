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
      description: '\n'
        + '<use_case>Use this resource template to obtain the details of a site you know its ID of.</use_case>\n'
        + '<important_notes>'
        + '1. You may need a tool to obtain site information by its base URL if you don\'t have the ID; or ask the user for it.\n'
        + '2. The site ID must be a valid UUID.\n'
        + '</important_notes>\n'
        + '',
      uriTemplate: 'spacecat-data://sites/{siteId}',
      fetchFn: ({ siteId }) => sitesController.getByID({
        params: { siteId },
      }),
      notFoundMessage: ({ siteId }) => `Site ${siteId} not found`,
    }),
    siteByBaseURL: createProxyResource({
      name: 'siteByBaseURL',
      description: '\n'
        + '<use_case>Use this resource template to obtain the details of a site you know its base URL of.</use_case>\n'
        + '<important_notes>'
        + '1. The base URL must be a valid URL, and it must be base64-encoded before being used. You can use the base64 encoding tool for a known base URL.\n'
        + '2. You may need to ask the user for the base URL.\n'
        + '</important_notes>\n'
        + '',
      uriTemplate: 'spacecat-data://sites/by-base-url/{baseURLBase64}',
      fetchFn: ({ baseURLBase64 }) => sitesController.getByBaseURL({
        params: { baseURL: baseURLBase64 },
      }),
      notFoundMessage: ({ baseURLBase64 }) => `Site with base URL ${baseURLBase64} not found`,
    }),
    siteMetricsBySource: createProxyResource({
      name: 'siteMetricsBySource',
      description: '\n'
        + '<use_case>Use this resource template to obtain the metrics of a site by its ID, metric type, and source.</use_case>\n'
        + '<important_notes>'
        + '1. You may need a tool or resource template to obtain site information that yields the site\'s ID.\n'
        + '2. The metric must be one of the supported metrics, and the source must be a valid source identifier.\n'
        + '</important_notes>\n'
        + '',
      uriTemplate: 'spacecat-data://sites/{siteId}/metrics/{metric}/{source}',
      fetchFn: ({ siteId, metric, source }) => sitesController.getSiteMetricsBySource(
        { ...context, params: { siteId, metric, source } },
      ),
      notFoundMessage: ({ siteId, metric, source }) => `Metrics for site ${siteId}, metric ${metric}, and source ${source} not found`,
    }),
  };
}

/* c8 ignore end */
