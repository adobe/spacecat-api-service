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

import { createAuditResources } from './registry/resources/audits.js';
import { createSiteResources } from './registry/resources/sites.js';
import { createScrapeContentResources } from './registry/resources/scrape-content.js';
import { createOpportunityResources } from './registry/resources/opportunities.js';
import { createSiteTools } from './registry/tools/sites.js';
import { createAuditTools } from './registry/tools/audits.js';
import { createScrapeContentTools } from './registry/tools/scrape-content.js';
import { createOpportunityTools } from './registry/tools/opportunities.js';
import utilTools from './registry/tools/utils.js';

/**
 * Build the registry for the current request based on already-constructed
 * controllers.  Doing so avoids re-instantiating controllers inside tool
 * handlers and allows unit tests to supply stubs easily.
 *
 * @param {object} deps – bag of dependencies.
 * @param {object} deps.auditsController – instance of the Audits controller.
 * @param {object} deps.sitesController – instance of the Sites controller.
 * @param {object} deps.scrapeController – instance of the Scrape controller.
 * @param {object} deps.opportunitiesController – instance of the Opportunities controller.
 * @param {object} deps.context – the context object.
 * @returns {{ tools: Record<string,object>, resources: object, prompts: object }}
 */
export default function buildRegistry({
  auditsController,
  sitesController,
  scrapeController,
  opportunitiesController,
  context,
} = {}) {
  const tools = {
    ...utilTools,
    ...createAuditTools(auditsController),
    ...createSiteTools(sitesController, context),
    ...createScrapeContentTools(scrapeController, context),
    ...createOpportunityTools(opportunitiesController, context),
  };

  const resources = {
    ...createAuditResources(auditsController),
    ...createSiteResources(sitesController, context),
    ...createScrapeContentResources(scrapeController, context),
    ...createOpportunityResources(opportunitiesController, context),
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
