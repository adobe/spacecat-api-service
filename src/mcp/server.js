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

import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/*  A singleton SDK server – reused across requests (cold-start friendly). */
let sdkServer;
let sdkServerInitPromise = null;

export async function getSdkServer(registry) {
  if (sdkServer) {
    return sdkServer;
  }

  if (sdkServerInitPromise) {
    return sdkServerInitPromise;
  }

  if (!registry) {
    throw new Error('Registry must be provided on first call to getSdkServer()');
  }

  sdkServerInitPromise = (async () => {
    const { prompts = {} } = registry;

    if (isNonEmptyObject(prompts)) {
      throw new Error('MCP prompts wiring not yet implemented');
    }

    const server = new McpServer({
      name: 'SpaceCat-MCP',
      version: '1.0.0',
    });

    // Register all tools and resources with the server
    registry.registerWithServer(server);

    sdkServer = server;
    sdkServerInitPromise = null;
    return server;
  })();

  return sdkServerInitPromise;
}

/* c8 ignore end */
