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

export function createHarTools(harController) {
  if (!harController) {
    return {};
  }

  const createHarTool = createProxyTool({
    annotations: {
      title: 'Get Har Report by URL',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      '\n<use_case>Retrieve HAR Report for a given URL.</use_case>\n'
      + '',
    inputSchema: z
      .object({
        url: z.string().describe('The full encoded url to get data for, including path if needed'),
        deviceType: z.string().describe('The device type that the Har should be generated for, e.g. desktop, mobile'),
      })
      .strict(),
    fetchFn: ({
      url, deviceType,
    }) => harController.getHar({
      params: { url, deviceType },
    }),
    notFoundMessage: ({ url }) => `No Har found for ${url}`,
  });

  return {
    getHar: createHarTool,
  };
}

/* c8 ignore end */
