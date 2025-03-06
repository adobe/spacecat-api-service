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

import SchemaBuilder from '../base/schema.builder.js';

import Role from './role.model.js';
import RoleCollection from './role.collection.js';
import Organization from '../organization/organization.model.js';

/*
Schema Doc: https://electrodb.dev/en/modeling/schema/
Attribute Doc: https://electrodb.dev/en/modeling/attributes/
Indexes Doc: https://electrodb.dev/en/modeling/indexes/
 */

const schema = new SchemaBuilder(Role, RoleCollection)
  // .addReference('has_many', 'Acls')
  .addAttribute('imsOrgId', {
    type: 'string',
    required: true,
    validate: (value) => Organization.IMS_ORG_ID_REGEX.test(value),
  })
  .addAttribute('identity', {
    type: 'string',
    required: true,
  })
  .addAttribute('name', {
    type: 'string',
    required: true,
  })
  .addIndex(
    { composite: ['imsOrgId'] },
    { composite: ['identity'] },
  );

export default schema.build();
