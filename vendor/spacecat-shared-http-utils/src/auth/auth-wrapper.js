/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { Response } from '@adobe/fetch';

import { isObject } from '@adobe/spacecat-shared-utils';
import AuthenticationManager from './authentication-manager.js';
import { checkScopes } from './check-scopes.js';

const ANONYMOUS_ENDPOINTS = [
  'GET /slack/events',
  'POST /slack/events',
];

export function authWrapper(fn, opts = {}) {
  let authenticationManager;

  return async (request, context) => {
    const { log, pathInfo: { method, suffix } } = context;

    const route = `${method.toUpperCase()} ${suffix}`;

    if (ANONYMOUS_ENDPOINTS.includes(route)
        || route.startsWith('POST /hooks/site-detection/')
        || method.toUpperCase() === 'OPTIONS') {
      return fn(request, context);
    }

    if (!authenticationManager) {
      if (!Array.isArray(opts.authHandlers)) {
        log.error('Invalid auth handlers');
        return new Response('Server error', { status: 500 });
      }

      authenticationManager = AuthenticationManager.create(opts.authHandlers, log);
    }

    try {
      const authInfo = await authenticationManager.authenticate(request, context);

      // Add a helper function to the context for checking scoped API keys.
      // authInfo is available at context.attributes.authInfo.
      if (!isObject(context.auth)) {
        context.auth = {
          checkScopes: (scopes) => checkScopes(scopes, authInfo, log),
        };
      }
    } catch {
      return new Response('Unauthorized', { status: 401 });
    }

    return fn(request, context);
  };
}
