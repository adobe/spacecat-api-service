/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { hasText } from '@adobe/spacecat-shared-utils';

import AuthInfo from '../auth-info.js';
import AbstractHandler from './abstract.js';

const ADMIN_ENDPOINTS = [
  'GET /trigger',
  'POST /sites',
  'POST /event/fulfillment',
  'POST /slack/channels/invite-by-user-id',
];

/**
 * Handler for legacy API key authentication. This handler is used to authenticate requests
 * that contain a legacy API key in the `x-api-key` header.
 */
export default class LegacyApiKeyHandler extends AbstractHandler {
  constructor(log) {
    super('legacyApiKey', log);
  }

  async checkAuth(request, context) {
    const expectedUserApiKey = context.env?.USER_API_KEY;
    const expectedAdminApiKey = context.env?.ADMIN_API_KEY;

    if (!hasText(expectedUserApiKey) || !hasText(expectedAdminApiKey)) {
      this.log('API keys were not configured', 'error');
      return null;
    }

    const apiKeyFromHeader = context.pathInfo?.headers['x-api-key'];

    if (!hasText(apiKeyFromHeader)) {
      return null;
    }

    const isRouteAdminOnly = ADMIN_ENDPOINTS.includes(context.pathInfo.route);
    const isApiKeyValid = isRouteAdminOnly
      ? apiKeyFromHeader === expectedAdminApiKey
      : apiKeyFromHeader === expectedUserApiKey || apiKeyFromHeader === expectedAdminApiKey;

    if (isApiKeyValid) {
      const profile = isRouteAdminOnly ? { user_id: 'admin' } : { user_id: 'legacy-user' };
      return new AuthInfo()
        .withAuthenticated(true)
        .withProfile(profile)
        .withType(this.name);
    }

    return null;
  }
}
