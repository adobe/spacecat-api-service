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

import { hasText, isIsoDate } from '@adobe/spacecat-shared-utils';

import SchemaBuilder from '../base/schema.builder.js';
import KeyEvent from './key-event.model.js';
import KeyEventCollection from './key-event.collection.js';

/*
Schema Doc: https://electrodb.dev/en/modeling/schema/
Attribute Doc: https://electrodb.dev/en/modeling/attributes/
Indexes Doc: https://electrodb.dev/en/modeling/indexes/
 */

const schema = new SchemaBuilder(KeyEvent, KeyEventCollection)
  .addReference('belongs_to', 'Site', ['time'])
  .addAttribute('name', {
    type: 'string',
    required: true,
    validate: (value) => hasText(value),
  })
  .addAttribute('type', {
    type: Object.values(KeyEvent.KEY_EVENT_TYPES),
    required: true,
  })
  .addAttribute('time', {
    type: 'string',
    required: true,
    default: () => new Date().toISOString(),
    validate: (value) => isIsoDate(value),
  });

export default schema.build();
