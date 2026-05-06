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

import { AdobeImsHandler } from '@adobe/spacecat-shared-http-utils';

const API_KEY_PATH_PREFIX = '/tools/api-keys';

/**
 * Returns true when the request path is exactly `/tools/api-keys` or any
 * descendant (`/tools/api-keys/<id>`). The boundary check (`=== prefix` or
 * `prefix + '/'`) prevents a hypothetical sibling route like
 * `/tools/api-keys-batch` from accidentally falling under this scope.
 */
function isApiKeyRoute(suffix) {
  if (typeof suffix !== 'string') {
    return false;
  }
  return suffix === API_KEY_PATH_PREFIX
    || suffix.startsWith(`${API_KEY_PATH_PREFIX}/`);
}

/**
 * Route-scoped IMS auth handler for the api-key controller.
 *
 * Per the IMS-to-JWT migration design (mysticat-architecture
 * `platform/decisions/ims-to-jwt-api-key-controller-migration.md`), IaaS-only
 * orgs cannot acquire a SpaceCat JWT session token because `/auth/login`
 * requires a product context (ASO `dx_aem_perf` or LLMO `dx_llmo`). Those orgs
 * may have neither product, but they still need to manage scoped API keys for
 * the Import-as-a-Service (IaaS) endpoints.
 *
 * This subclass keeps the IMS auth path open ONLY for the api-key endpoints
 * (`/tools/api-keys`, `/tools/api-keys/:id`) and returns null for any other
 * path so the request falls through to the next handler. Once the broader
 * Auto-Fix migration (ASO-607) lands and `AdobeImsHandler` is removed from
 * the global chain, this scoped handler keeps IaaS key management working
 * without re-introducing a global IMS auth backdoor.
 *
 * The path guard is a hardcoded prefix rather than a route-table lookup -
 * there are only three api-key routes, they are unlikely to change, and the
 * coupling to the routing layer is not worth the indirection.
 *
 * TODO(ASO-607): Once all IaaS callers have moved to JWT session tokens, this
 * file (and the corresponding entry in src/index.js AUTH_HANDLERS) should be
 * deleted. The success log below is the operational signal: if no requests
 * hit this branch over a sustained period, the handler is unused and safe to
 * remove.
 */
export default class ApiKeyImsHandler extends AdobeImsHandler {
  // No constructor - inherit AdobeImsHandler's. The handler-name backing
  // AbstractHandler is set to 'ims' by the parent constructor; the resulting
  // authInfo.getType() therefore reads 'ims', which is what the api-key
  // controller (and downstream code) expects.

  async checkAuth(request, context) {
    const suffix = context?.pathInfo?.suffix;
    if (!isApiKeyRoute(suffix)) {
      // Out-of-scope route - skip cleanly so the auth chain advances.
      return null;
    }
    const result = await super.checkAuth(request, context);
    if (result) {
      // Operational signal for the IMS-to-JWT migration end-state. Once this
      // log stops firing in production over a sustained window, the handler
      // (and its registration in AUTH_HANDLERS) can be deleted - see ASO-607.
      this.log('api-key request authenticated via scoped IMS handler - JWT migration pending', 'info');
    }
    return result;
  }
}
