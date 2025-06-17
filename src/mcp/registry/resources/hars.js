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

export function createHarResource(harController) {
  if (!harController) {
    return {};
  }

  return {
    getHar: createProxyResource({
      name: 'getHar',
      description: '\n'
      + '<use_case>Retrieve Har Report for a URL.</use_case>\n'
      + '<important_notes>\n'
      + '</important_notes>\n'
      + '',
      uriTemplate: 'spacecat-data://hars/{url}/{deviceType}',
      fetchFn: ({
        url, deviceType,
      }) => harController.getHar({
        params: { url, deviceType },
      }),
      notFoundMessage: ({ url }) => `Hars of ${url} not found`,
    }),
  };
}

/* c8 ignore end */
