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

// import { createSiteTools } from './registry/tools/sites.js';
import { createAuditResources } from './registry/resources/audits.js';
import { createSiteResources } from './registry/resources/sites.js';
import utilTools from './registry/tools/utils.js';

/**
 * Build the registry for the current request based on already-constructed
 * controllers.  Doing so avoids re-instantiating controllers inside tool
 * handlers and allows unit tests to supply stubs easily.
 *
 * @param {object} deps – bag of dependencies.
 * @param {object} deps.sitesController – instance of the Sites controller.
 * @returns {{ tools: Record<string,object>, resources: object, prompts: object }}
 */
export default function buildRegistry({
  auditsController,
  sitesController,
} = {}) {
  const tools = {
    ...utilTools,
    // ...createSiteTools(sitesController),
  };

  const resources = {
    ...createAuditResources(auditsController),
    ...createSiteResources(sitesController),
  };

  return {
    tools,
    resources,
    prompts: {},
    /**
     * Register all tools and resources with an MCP server instance.
     * @param {McpServer} server – the MCP server instance to register with.
     */
    registerWithServer(server) {
      /* ----------  register tools  ---------- */
      for (const [name, def] of Object.entries(this.tools)) {
        server.registerTool(
          name,
          {
            description: def.description,
            inputSchema: def.inputSchema ? def.inputSchema.shape : undefined,
            outputSchema: def.outputSchema ? def.outputSchema.shape : undefined,
            annotations: def.annotations,
          },
          def.handler,
        );
      }

      /* ----------  register resources  ---------- */
      for (const [name, def] of Object.entries(this.resources)) {
        server.resource(
          name,
          def.uriTemplate,
          def.metadata,
          def.provider,
        );
      }
    },
  };
}

/* c8 ignore end */
