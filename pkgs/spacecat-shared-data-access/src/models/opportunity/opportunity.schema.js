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

import { isNonEmptyObject, isValidUrl } from '@adobe/spacecat-shared-utils';

import SchemaBuilder from '../base/schema.builder.js';
import Opportunity from './opportunity.model.js';
import OpportunityCollection from './opportunity.collection.js';

/*
Schema Doc: https://electrodb.dev/en/modeling/schema/
Attribute Doc: https://electrodb.dev/en/modeling/attributes/
Indexes Doc: https://electrodb.dev/en/modeling/indexes/
 */

const schema = new SchemaBuilder(Opportunity, OpportunityCollection)
  .addReference('belongs_to', 'Site', ['status', 'updatedAt'])
  .addReference('belongs_to', 'Audit', ['updatedAt'], { required: false })
  .addReference('belongs_to', 'LatestAudit', ['updatedAt'], { required: false })
  .addReference('has_many', 'Suggestions', ['updatedAt'], { removeDependents: true })
  .addAttribute('runbook', {
    type: 'string',
    validate: (value) => !value || isValidUrl(value),
  })
  .addAttribute('type', {
    type: 'string',
    readOnly: true,
    required: true,
  })
  .addAttribute('data', {
    type: 'any',
    validate: (value) => !value || isNonEmptyObject(value),
  })
  .addAttribute('origin', {
    type: Object.values(Opportunity.ORIGINS),
    required: true,
  })
  .addAttribute('title', {
    type: 'string',
    required: true,
  })
  .addAttribute('description', {
    type: 'string',
  })
  .addAttribute('status', {
    type: Object.values(Opportunity.STATUSES),
    required: true,
    default: 'NEW',
  })
  .addAttribute('guidance', {
    type: 'any',
    validate: (value) => !value || isNonEmptyObject(value),
  })
  .addAttribute('tags', {
    type: 'set',
    items: 'string',
  });

export default schema.build();
