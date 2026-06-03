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

import { LegacyApiKeyHandler } from '@adobe/spacecat-shared-http-utils';

// Route prefixes whose callers cannot be migrated to S2S auth. Per the decision doc
// (platform/decisions/route-scoped-legacy-api-key-handler.md), these are the
// only routes this handler is authorised to authenticate.
// Prefix matching: a request matches if its METHOD + path equals the prefix
// or starts with the prefix followed by '/'.
const SCOPED_ROUTE_PREFIXES = [
  'POST /event/fulfillment',
  'POST /slack/channels/invite-by-user-id',
];

function isScopedRoute(method, suffix) {
  if (!method || !suffix) {
    return false;
  }
  const path = suffix.split('?')[0];
  const routeKey = `${method} ${path}`;
  return SCOPED_ROUTE_PREFIXES.some(
    (prefix) => routeKey === prefix || routeKey.startsWith(`${prefix}/`),
  );
}

/**
 * Route-scoped legacy API key handler for endpoints that cannot migrate to S2S.
 *
 * Per the decision doc (mysticat-architecture
 * `platform/decisions/route-scoped-legacy-api-key-handler.md`), two admin
 * endpoints are called by external systems that cannot be provisioned as IMS
 * S2S consumers: POST /event/fulfillment and POST /slack/channels/invite-by-user-id.
 * This subclass limits legacy API key auth to exactly those two routes and their
 * sub-paths (e.g. POST /event/fulfillment/xxxx). All other requests receive null
 * and fall through to the next handler in the chain.
 *
 * No constructor override — the parent class `LegacyApiKeyHandler` sets the
 * handler name to 'legacyApiKey', so authInfo.getType() returns 'legacyApiKey'
 * here too. Controllers that branch on auth type behave identically.
 */
export default class RouteScopedLegacyApiKeyHandler extends LegacyApiKeyHandler {
  async checkAuth(request, context) {
    const { method, suffix } = context?.pathInfo || {};
    if (!isScopedRoute(method, suffix)) {
      return null;
    }
    const routeKey = `${method} ${suffix.split('?')[0]}`;
    const result = await super.checkAuth(request, context);
    if (result) {
      context.log.info(`[legacyApiKey] request authenticated via route-scoped legacy API key handler [${routeKey}]`);
    }
    return result;
  }
}
