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

export function createBundlesTools(bundleController) {
  if (!bundleController) {
    return {};
  }

  const createRUMBundlesStatsTool = createProxyTool({
    annotations: {
      title: 'Get RUM Bundle Stats by URL and Date Range',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      '\n<use_case>Retrieve Core Web Vitals (CWV) and engagement metrics using rum-distiller bundles for a given site or page.</use_case>\n'
      + '<important_notes>\n'
      + '• aggregation must be one of: pageviews, visits, bounces, organic, earned, lcp, cls, inp, ttfb, engagement.\n'
      + '• If the URL contains a non-empty path (e.g. "/product/123"), results are scoped to that path only.\n'
      + '• Data is collected from the daily rum-distiller bundles across the specified date range.\n'
      + '</important_notes>\n',
    inputSchema: z
      .object({
        url: z.string().url().describe('The full URL to get data for, including path if needed'),
        domainkey: z.string().describe('The domain key used for authorization and bundle access'),
        startdate: z.string().describe('Start date in YYYY-MM-DD format'),
        enddate: z.string().describe('End date in YYYY-MM-DD format'),
        aggregation: z
          .enum([
            'pageviews',
            'visits',
            'bounces',
            'organic',
            'earned',
            'lcp',
            'cls',
            'inp',
            'ttfb',
            'engagement',
          ])
          .describe('The metric to extract from the rum bundle data'),
      })
      .strict(),
    fetchFn: ({
      url, domainkey, startdate, enddate, aggregation,
    }) => bundleController.getAllBundles({
      params: {
        url, domainkey, startdate, enddate, aggregation,
      },
    }),
    notFoundMessage: ({ url }) => `No RUM bundle stats found for ${url}`,
  });

  return {
    getBundleStats: createRUMBundlesStatsTool,
  };
}

/* c8 ignore end */
