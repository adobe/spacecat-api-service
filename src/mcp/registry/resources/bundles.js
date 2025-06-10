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
import { getAllBundles } from '../../../utils/bundles.js';

export function createBundleResources() {
  return {
    getAllBundles: createProxyResource({
      name: 'getAllBundles',
      description: '\n'
      + '<use_case>Retrieve Core Web Vitals (CWV) and engagement metrics using rum-distiller bundles for a given site or page.</use_case>\n'
      + '<important_notes>\n'
      + '• aggregation must be one of: pageviews, visits, bounces, organic, earned, lcp, cls, inp, ttfb, engagement.\n'
      + '• If the URL contains a non-empty path (e.g. "/product/123"), results are scoped to that path only.\n'
      + '• Data is collected from the daily rum-distiller bundles across the specified date range.\n'
      + '</important_notes>\n'
      + '',
      uriTemplate: 'spacecat-data://bundles/{url}/{domainkey}/{startdate}/{enddate}/{aggregation}',
      fetchFn: ({
        url, domainkey, startdate, enddate, aggregation,
      }) => getAllBundles({
        params: {
          url, domainkey, startdate, enddate, aggregation,
        },
      }),
      notFoundMessage: ({ url }) => `Bundles of ${url} not found`,
    }),
  };
}

/* c8 ignore end */
