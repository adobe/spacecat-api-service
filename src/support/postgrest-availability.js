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

import { createResponse } from '@adobe/spacecat-shared-http-utils';

/**
 * PostgREST availability guard.
 *
 * Returns a 503 `Response` when `context.dataAccess.services.postgrestClient`
 * is not wired into the request context (typical when a deployment hasn't
 * been configured with `DATA_SERVICE_PROVIDER=postgres`), or `null` when
 * the client is available and PostgREST calls can proceed safely.
 *
 * Callers should use the conventional `return guard;` idiom:
 *
 * ```js
 * const guard = requirePostgrest(context, {
 *   errorMessage: 'V2 customer config requires Postgres (DATA_SERVICE_PROVIDER=postgres)',
 * });
 * if (guard) return guard;
 * // … safe to call context.dataAccess.services.postgrestClient.from(...)
 * ```
 *
 * The `errorMessage` is per-call so each consumer can surface a message
 * scoped to its feature (V2 brand config, FACS state-layer, future
 * PostgREST-backed surfaces). The 503 status and Content-Type are fixed.
 *
 * Extracted from `controllers/brands.js` (where it lived as a private
 * nested function with 20 call sites) and `support/facs-access-mappings.js`
 * (where a near-duplicate `requirePostgrestForFacsMappings` mirrored the
 * shape) so a single check lives in one place. The convenience aliases
 * below preserve the original call-site shapes used across both consumers.
 *
 * @param {object} context - Universal request context.
 * @param {{ errorMessage: string }} opts
 * @returns {Response|null}
 */
export function requirePostgrest(context, { errorMessage }) {
  const postgrestClient = context?.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    return createResponse({ message: errorMessage }, 503);
  }
  return null;
}

/**
 * V2 customer-config error message used by `controllers/brands.js` (20+
 * call sites). Kept as a named convenience so the V2 controller can stay
 * concise without re-declaring the string at every guard.
 *
 * @param {object} context
 * @returns {Response|null}
 */
export function requirePostgrestForV2Config(context) {
  return requirePostgrest(context, {
    errorMessage: 'V2 customer config requires Postgres (DATA_SERVICE_PROVIDER=postgres)',
  });
}

/**
 * FACS state-layer error message used by the management endpoints.
 *
 * @param {object} context
 * @returns {Response|null}
 */
export function requirePostgrestForFacsMappings(context) {
  return requirePostgrest(context, {
    errorMessage: 'FACS state-layer endpoints require Postgres (DATA_SERVICE_PROVIDER=postgres)',
  });
}
