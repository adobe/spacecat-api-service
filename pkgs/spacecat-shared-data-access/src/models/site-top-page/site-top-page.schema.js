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

import { isInteger, isIsoDate, isValidUrl } from '@adobe/spacecat-shared-utils';

import { validate as uuidValidate } from 'uuid';

import SchemaBuilder from '../base/schema.builder.js';
import SiteTopPage from './site-top-page.model.js';
import SiteTopPageCollection from './site-top-page.collection.js';

/*
Schema Doc: https://electrodb.dev/en/modeling/schema/
Attribute Doc: https://electrodb.dev/en/modeling/attributes/
Indexes Doc: https://electrodb.dev/en/modeling/indexes/
 */

const schema = new SchemaBuilder(SiteTopPage, SiteTopPageCollection)
  .addReference('belongs_to', 'Site', ['source', 'geo', 'traffic'])
  .addAttribute('siteId', {
    type: 'string',
    required: true,
    validate: (value) => uuidValidate(value),
  })
  .addAttribute('url', {
    type: 'string',
    required: true,
    validate: (value) => isValidUrl(value),
  })
  .addAttribute('traffic', {
    type: 'number',
    required: true,
    validate: (value) => isInteger(value),
  })
  .addAttribute('source', {
    type: 'string',
    required: true,
  })
  .addAttribute('topKeyword', {
    type: 'string',
  })
  .addAttribute('geo', {
    type: 'string',
    required: false,
    default: SiteTopPage.DEFAULT_GEO,
  })
  .addAttribute('importedAt', {
    type: 'string',
    required: true,
    default: () => new Date().toISOString(),
    validate: (value) => isIsoDate(value),
  });

export default schema.build();
