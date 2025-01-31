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

import SchemaBuilder from '../base/schema.builder.js';
import Suggestion from './suggestion.model.js';
import SuggestionCollection from './suggestion.collection.js';

/*
Schema Doc: https://electrodb.dev/en/modeling/schema/
Attribute Doc: https://electrodb.dev/en/modeling/attributes/
Indexes Doc: https://electrodb.dev/en/modeling/indexes/
 */

const schema = new SchemaBuilder(Suggestion, SuggestionCollection)
  .addReference('belongs_to', 'Opportunity', ['status', 'rank'])
  .addAttribute('type', {
    type: Object.values(Suggestion.TYPES),
    required: true,
    readOnly: true,
  })
  .addAttribute('rank', {
    type: 'number',
    required: true,
  })
  .addAttribute('data', {
    type: 'any',
    required: true,
    validate: (value) => isNonEmptyObject(value),
  })
  .addAttribute('kpiDeltas', {
    type: 'any',
    validate: (value) => !value || isNonEmptyObject(value),
  })
  .addAttribute('status', {
    type: Object.values(Suggestion.STATUSES),
    required: true,
    default: Suggestion.STATUSES.NEW,
  });

export default schema.build();
