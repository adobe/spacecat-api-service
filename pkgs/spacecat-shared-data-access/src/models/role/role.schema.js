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

import { hasText } from '@adobe/spacecat-shared-utils';
import SchemaBuilder from '../base/schema.builder.js';
import { validateIMSOrg } from '../role-member/role-member.schema.js';

import Role from './role.model.js';
import RoleCollection from './role.collection.js';

/*
Schema Doc: https://electrodb.dev/en/modeling/schema/
Attribute Doc: https://electrodb.dev/en/modeling/attributes/
Indexes Doc: https://electrodb.dev/en/modeling/indexes/
 */

const schema = new SchemaBuilder(Role, RoleCollection)
  .addAttribute('name', {
    type: 'string',
    required: true,
  })
  .addAttribute('imsOrgId', {
    type: 'string',
    required: true,
    validate: (value) => validateIMSOrg(value),
  })
  .addAttribute('acl', {
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
        path: {
          type: 'string',
          validate: (value) => hasText(value),
        },
      },
    },
  })
  .addIndex(
    { composite: ['imsOrgId'] },
    { composite: ['name'] },
  );

export default schema.build();
