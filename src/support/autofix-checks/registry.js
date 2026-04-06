/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import contentApiAccessHandler from './handlers/content-api-access.js';
import codeRepoAccessHandler from './handlers/code-repo-access.js';

/**
 * Registry of autofix check handlers.
 *
 * Each handler is a (sync or async) function with the signature:
 *   (site, context, log) => { type: string, status: string, message: string }
 *
 * Statuses:
 *   PASSED  — check passed, deployment can proceed
 *   FAILED  — check failed, deployment should be blocked
 *   SKIPPED — check not applicable for this site/delivery type
 *   ERROR   — handler threw unexpectedly (controller catches and wraps)
 *
 * To add a new handler:
 *   1. Create a file in ./handlers/ following the existing patterns
 *   2. Import it here and add an entry to the registry map
 *
 * The key is the check type string that callers pass in the request body.
 */
const checkHandlerRegistry = {
  'content-api-access': contentApiAccessHandler,
  'code-repo-access': codeRepoAccessHandler,
};

export default checkHandlerRegistry;
