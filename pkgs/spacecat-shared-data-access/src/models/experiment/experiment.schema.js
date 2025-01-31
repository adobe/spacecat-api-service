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

import {
  isIsoDate, isNonEmptyObject, isString, isValidUrl,
} from '@adobe/spacecat-shared-utils';

import SchemaBuilder from '../base/schema.builder.js';
import Experiment from './experiment.model.js';
import ExperimentCollection from './experiment.collection.js';

/*
Schema Doc: https://electrodb.dev/en/modeling/schema/
Attribute Doc: https://electrodb.dev/en/modeling/attributes/
Indexes Doc: https://electrodb.dev/en/modeling/indexes/
 */

const schema = new SchemaBuilder(Experiment, ExperimentCollection)
  .addReference('belongs_to', 'Site', ['expId', 'url', 'updatedAt'])
  .addAttribute('conversionEventName', {
    type: 'string',
    validate: (value) => !value || isString(value),
  })
  .addAttribute('conversionEventValue', {
    type: 'string',
    validate: (value) => !value || isString(value),
  })
  .addAttribute('endDate', {
    type: 'string',
    validate: (value) => !value || isIsoDate(value),
  })
  .addAttribute('expId', {
    type: 'string',
    required: true,
  })
  .addAttribute('name', { type: 'string' })
  .addAttribute('startDate', {
    type: 'string',
    validate: (value) => !value || isIsoDate(value),
  })
  .addAttribute('status', {
    type: ['ACTIVE', 'INACTIVE'],
    required: true,
  })
  .addAttribute('type', {
    type: 'string',
    validate: (value) => !value || isString(value),
  })
  .addAttribute('url', {
    type: 'string',
    required: true,
    validate: (value) => isValidUrl(value),
  })
  .addAttribute('updatedBy', {
    type: 'string',
    required: true,
    default: Experiment.DEFAULT_UPDATED_BY,
  })
  .addAttribute('variants', {
    type: 'list',
    items: {
      type: 'any',
      validate: (value) => isNonEmptyObject(value),
    },
    required: true,
  });

export default schema.build();
