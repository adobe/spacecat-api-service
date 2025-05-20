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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadRegistry } from './registry/index.js';

/*  A singleton SDK server – reused across requests (cold-start friendly). */
let sdkServer;
let sdkServerInitPromise = null;

export async function getSdkServer(context) {
  if (sdkServer) return sdkServer;

  if (sdkServerInitPromise) {
    return sdkServerInitPromise;
  }

  sdkServerInitPromise = (async () => {
    const registry = await loadRegistry(context);
    const { resources, prompts } = registry;

    if (resources && Object.keys(resources).length > 0) {
      throw new Error('MCP resources wiring not yet implemented');
    }

    if (prompts && Object.keys(prompts).length > 0) {
      throw new Error('MCP prompts wiring not yet implemented');
    }

    const server = new McpServer({
      name: 'SpaceCat-API',
      version: '1.0.0',
    });

    /* ----------  register tools  ---------- */
    for (const [name, def] of Object.entries(registry.tools)) {
      server.registerTool(
        name,
        {
          description: def.description,
          inputSchema: def.inputSchema.shape,
          outputSchema: def.outputSchema ? def.outputSchema.shape : undefined,
          annotations: def.annotations,
        },
        def.handler,
      );
    }

    /* resources / prompts can be mapped the same way later */

    sdkServer = server;
    sdkServerInitPromise = null;
    return server;
  })();

  return sdkServerInitPromise;
}

/* c8 ignore end */
