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

import { hasText, isIsoDate } from '@adobe/spacecat-shared-utils';
import AbstractHandler from './abstract.js';
import { hashWithSHA256 } from '../generate-hash.js';
import AuthInfo from '../auth-info.js';

/**
 * Handler to support API keys which include scope details. These API keys are stored in the data
 * layer and require context.dataAccess in order to authenticate each request.
 */
export default class ScopedApiKeyHandler extends AbstractHandler {
  constructor(log) {
    super('scopedApiKey', log);
  }

  async checkAuth(request, context) {
    const { dataAccess, pathInfo: { headers = {} } } = context;
    if (!dataAccess) {
      throw new Error('Data access is required');
    }

    const { ApiKey } = dataAccess;

    const apiKeyFromHeader = headers['x-api-key'];
    if (!hasText(apiKeyFromHeader)) {
      return null;
    }

    // Keys are stored by their hash, so we need to hash the key to look it up
    const hashedApiKey = hashWithSHA256(apiKeyFromHeader);
    const apiKeyEntity = await ApiKey.findByHashedApiKey(hashedApiKey);

    if (!apiKeyEntity) {
      this.log(`No API key entity found in the data layer for the provided API key: ${apiKeyFromHeader}`, 'error');
      return null;
    }
    this.log(`Valid API key entity found. Id: ${apiKeyEntity.getId()}, name: ${apiKeyEntity.getName()}, scopes: ${apiKeyEntity.getScopes()}`, 'debug');

    // We have an API key entity, and need to check if it's still valid
    const authInfo = new AuthInfo()
      .withProfile(apiKeyEntity) // Include the API key entity as the profile
      .withType(this.name);

    // Verify that the api key has not expired or been revoked
    const now = new Date().toISOString();
    if (isIsoDate(apiKeyEntity.getExpiresAt()) && apiKeyEntity.getExpiresAt() < now) {
      this.log(`API key has expired. Name: ${apiKeyEntity.getName()}, id: ${apiKeyEntity.getId()}`, 'error');
      return authInfo.withReason('API key has expired');
    }

    if (isIsoDate(apiKeyEntity.getRevokedAt()) && apiKeyEntity.getRevokedAt() < now) {
      this.log(`API key has been revoked. Name: ${apiKeyEntity.getName()} id: ${apiKeyEntity.getId()}`, 'error');
      return authInfo.withReason('API key has been revoked');
    }

    // API key is valid: return auth info with scope details from the API key entity
    return authInfo
      .withAuthenticated(true)
      .withScopes(apiKeyEntity.getScopes());
  }
}
