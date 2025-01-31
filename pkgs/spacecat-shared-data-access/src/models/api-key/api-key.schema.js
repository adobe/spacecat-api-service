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

/* c8 ignore start */

import { isIsoDate, isValidUrl } from '@adobe/spacecat-shared-utils';

import SchemaBuilder from '../base/schema.builder.js';
import ApiKey from './api-key.model.js';
import ApiKeyCollection from './api-key.collection.js';

/*
Schema Doc: https://electrodb.dev/en/modeling/schema/
Attribute Doc: https://electrodb.dev/en/modeling/attributes/
Indexes Doc: https://electrodb.dev/en/modeling/indexes/
 */

const schema = new SchemaBuilder(ApiKey, ApiKeyCollection)
  .addAttribute('hashedApiKey', {
    type: 'string',
    required: true,
  })
  .addAttribute('imsUserId', {
    type: 'string',
    default: 'default',
  })
  .addAttribute('imsOrgId', {
    type: 'string',
    default: 'default',
  })
  .addAttribute('name', {
    type: 'string',
    required: true,
  })
  .addAttribute('deletedAt', {
    type: 'string',
    validate: (value) => !value || isIsoDate(value),
  })
  .addAttribute('expiresAt', {
    type: 'string',
    validate: (value) => !value || isIsoDate(value),
  })
  .addAttribute('revokedAt', {
    type: 'string',
    validate: (value) => !value || isIsoDate(value),
  })
  .addAttribute('scopes', {
    type: 'list',
    required: true,
    items: {
      type: 'map',
      properties: {
        actions: {
          type: 'list',
          items: {
            type: 'string',
          },
        },
        domains: {
          type: 'list',
          items: {
            type: 'string',
            validate: (value) => isValidUrl(value),
          },
        },
        name: { type: ApiKey.SCOPE_NAMES },
      },
    },
  })
  .addIndex(
    { composite: ['hashedApiKey'] },
    { composite: ['updatedAt'] },
  )
  .addIndex(
    { composite: ['imsOrgId', 'imsUserId'] },
    { composite: ['updatedAt'] },
  );

export default schema.build();
