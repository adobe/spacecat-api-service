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
import { unwrapControllerResponse, withRpcErrorBoundary } from '../utils/jsonrpc.js';

/**
 * Build the registry for the current request based on already-constructed
 * controllers.  Doing so avoids re-instantiating controllers inside tool
 * handlers and allows unit tests to supply stubs easily.
 *
 * @param {object} deps – bag of dependencies.
 * @param {object} deps.sitesController – instance of the Sites controller.
 * @returns {{ tools: Record<string,object>, resources: object, prompts: object }}
 */
export function buildRegistry({ sitesController } = {}) {
  /* --------------------- echo ---------------------- */
  const echoTool = {
    description: 'Echoes back the input string',
    inputSchema: z.object({
      message: z.string().describe('Message to echo back'),
    }).strict(),
    handler: async ({ message }) => ({
      content: [{ type: 'text', text: String(message) }],
    }),
  };

  /* -------------------- getSite -------------------- */
  const getSiteTool = sitesController ? {
    description: 'Returns site details for the given UUID.',
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The UUID of the site to fetch'),
    }).strict(),
    handler: async ({ siteId }) => withRpcErrorBoundary(async () => {
      const response = await sitesController.getByID({ params: { siteId } });
      const payload = await unwrapControllerResponse(response, {
        notFoundMessage: `Site ${siteId} not found`,
        context: { siteId },
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    }, { siteId }),
  } : undefined;

  const tools = {
    echo: echoTool,
    ...(getSiteTool ? { getSite: getSiteTool } : {}),
  };

  return {
    tools,
    resources: {},
    prompts: {},
  };
}

export default { buildRegistry };

/* c8 ignore end */
