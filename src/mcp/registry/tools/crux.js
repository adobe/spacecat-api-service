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

import { z } from 'zod';
import { withRpcErrorBoundary } from '../../../utils/jsonrpc.js';

export function createCruxTools(cruxClient) {
  const getCRUXDataByURLTool = {
    annotations: {
      title: 'Get CRUX Data By URL',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: '\n'
      + '<use_case>Use this tool to obtain the Chrome User Experience Report data for a page based on it\'s URL. This data is useful to understand the performance of the page, and whether it meets Core Web Vitals thresholds.</use_case>\n'
      + '<important_notes>'
      + '1. The URL must be a valid URL. Ask the user to provide it.\n'
      + '2. The form factor must be one of the supported types. Ask the user to provide it.\n'
      + '</important_notes>\n'
      + '',
    inputSchema: z.object({
      url: z.string().url().describe('The URL of the page'),
      formFactor: z.enum(['desktop', 'mobile']).describe('The form factor'),
    }),
    handler: async (args) => withRpcErrorBoundary(async () => {
      const { url, formFactor } = args;
      const cruxData = await cruxClient.fetchCruxData({ url, formFactor });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(cruxData),
        }],
      };
    }, args),
  };

  return {
    getCRUXDataByURL: getCRUXDataByURLTool,
  };
}
