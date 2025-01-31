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

import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import { Config, DEFAULT_CONFIG, validateConfiguration } from '../site/config.js';
import SchemaBuilder from '../base/schema.builder.js';
import Organization from './organization.model.js';
import OrganizationCollection from './organization.collection.js';

/*
Schema Doc: https://electrodb.dev/en/modeling/schema/
Attribute Doc: https://electrodb.dev/en/modeling/attributes/
Indexes Doc: https://electrodb.dev/en/modeling/indexes/
 */

const schema = new SchemaBuilder(Organization, OrganizationCollection)
  // this will add an attribute 'organizationId' as well as an index 'byOrganizationId'
  .addReference('has_many', 'Sites')
  .addAttribute('config', {
    type: 'any',
    required: true,
    default: DEFAULT_CONFIG,
    validate: (value) => isNonEmptyObject(validateConfiguration(value)),
    get: (value) => Config(value),
  })
  .addAttribute('name', {
    type: 'string',
    required: true,
  })
  .addAttribute('imsOrgId', {
    type: 'string',
    default: 'default',
  })
  .addAttribute('fulfillableItems', {
    type: 'any',
    validate: (value) => !value || isNonEmptyObject(value),
  })
  .addAllIndex(['imsOrgId']);

export default schema.build();
