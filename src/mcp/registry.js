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

import { echoTool } from './registry/tools/utils.js';
import { createSiteTools } from './registry/tools/sites.js';
import { createSiteResources } from './registry/resources/sites.js';

/**
 * Build the registry for the current request based on already-constructed
 * controllers.  Doing so avoids re-instantiating controllers inside tool
 * handlers and allows unit tests to supply stubs easily.
 *
 * @param {object} deps – bag of dependencies.
 * @param {object} deps.sitesController – instance of the Sites controller.
 * @returns {{ tools: Record<string,object>, resources: object, prompts: object }}
 */
export default function buildRegistry({ sitesController } = {}) {
  const tools = {
    echo: echoTool,
    ...createSiteTools(sitesController),
  };

  const resources = {
    ...createSiteResources(sitesController),
  };

  return {
    tools,
    resources,
    prompts: {},
  };
}

/* c8 ignore end */
