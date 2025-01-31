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

import { isObject, isValidUrl } from '@adobe/spacecat-shared-utils';

import { validate as uuidValidate } from 'uuid';

import SchemaBuilder from '../base/schema.builder.js';
import SiteCandidate from './site-candidate.model.js';
import SiteCandidateCollection from './site-candidate.collection.js';

/*
Schema Doc: https://electrodb.dev/en/modeling/schema/
Attribute Doc: https://electrodb.dev/en/modeling/attributes/
Indexes Doc: https://electrodb.dev/en/modeling/indexes/
 */

const schema = new SchemaBuilder(SiteCandidate, SiteCandidateCollection)
  .addReference('belongs_to', 'Site')
  .addAttribute('siteId', {
    type: 'string',
    validate: (value) => !value || uuidValidate(value),
  })
  .addAttribute('baseURL', {
    type: 'string',
    required: true,
    validate: (value) => isValidUrl(value),
  })
  .addAttribute('hlxConfig', {
    type: 'any',
    required: true,
    default: {},
    validate: (value) => isObject(value),
  })
  .addAttribute('source', {
    type: Object.values(SiteCandidate.SITE_CANDIDATE_SOURCES),
    required: true,
  })
  .addAttribute('status', {
    type: Object.values(SiteCandidate.SITE_CANDIDATE_STATUS),
    required: true,
  })
  .addAttribute('updatedBy', {
    type: 'string',
  })
  .addAllIndex(['baseURL']);

export default schema.build();
