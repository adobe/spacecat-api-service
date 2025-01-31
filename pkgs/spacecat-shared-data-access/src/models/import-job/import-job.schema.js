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
  isInteger,
  isIsoDate,
  isNumber,
  isObject,
  isValidUrl,
} from '@adobe/spacecat-shared-utils';

import SchemaBuilder from '../base/schema.builder.js';
import ImportJob from './import-job.model.js';
import ImportJobCollection from './import-job.collection.js';

const ImportOptionTypeValidator = {
  [ImportJob.ImportOptions.ENABLE_JAVASCRIPT]: (value) => {
    if (value !== true && value !== false) {
      throw new Error(`Invalid value for ${ImportJob.ImportOptions.ENABLE_JAVASCRIPT}: ${value}`);
    }
  },
  [ImportJob.ImportOptions.PAGE_LOAD_TIMEOUT]: (value) => {
    if (!isInteger(value) || value < 0) {
      throw new Error(`Invalid value for ${ImportJob.ImportOptions.PAGE_LOAD_TIMEOUT}: ${value}`);
    }
  },
};

const validateOptions = (options) => {
  if (!isObject(options)) {
    throw new Error(`Invalid options: ${options}`);
  }

  const invalidOptions = Object.keys(options).filter(
    (key) => !Object.values(ImportJob.ImportOptions)
      .some((value) => value.toLowerCase() === key.toLowerCase()),
  );

  if (invalidOptions.length > 0) {
    throw new Error(`Invalid options: ${invalidOptions}`);
  }

  // validate each option for it's expected data type
  Object.keys(options).forEach((key) => {
    if (ImportOptionTypeValidator[key]) {
      ImportOptionTypeValidator[key](options[key]);
    }
  });

  return true;
};

/*
Schema Doc: https://electrodb.dev/en/modeling/schema/
Attribute Doc: https://electrodb.dev/en/modeling/attributes/
Indexes Doc: https://electrodb.dev/en/modeling/indexes/
 */

const schema = new SchemaBuilder(ImportJob, ImportJobCollection)
  .addReference('has_many', 'ImportUrls')
  .addAttribute('baseURL', {
    type: 'string',
    required: true,
    validate: (value) => isValidUrl(value),
  })
  .addAttribute('duration', {
    type: 'number',
    default: 0,
    validate: (value) => !value || isNumber(value),
  })
  .addAttribute('endedAt', {
    type: 'string',
    validate: (value) => !value || isIsoDate(value),
  })
  .addAttribute('failedCount', {
    type: 'number',
    default: 0,
    validate: (value) => !value || isInteger(value),
  })
  .addAttribute('hasCustomHeaders', {
    type: 'boolean',
    default: false,
  })
  .addAttribute('hasCustomImportJs', {
    type: 'boolean',
    default: false,
  })
  .addAttribute('hashedApiKey', {
    type: 'string',
    required: true,
  })
  .addAttribute('importQueueId', {
    type: 'string',
  })
  .addAttribute('initiatedBy', {
    type: 'map',
    properties: {
      apiKeyName: { type: 'string' },
      imsOrgId: { type: 'string' },
      imsUserId: { type: 'string' },
      userAgent: { type: 'string' },
    },
  })
  .addAttribute('options', {
    type: 'any',
    validate: (value) => !value || validateOptions(value),
  })
  .addAttribute('redirectCount', {
    type: 'number',
    default: 0,
    validate: (value) => !value || isInteger(value),
  })
  .addAttribute('status', {
    type: Object.values(ImportJob.ImportJobStatus),
    required: true,
  })
  .addAttribute('startedAt', {
    type: 'string',
    required: true,
    readOnly: true,
    default: () => new Date().toISOString(),
    validate: (value) => isIsoDate(value),
  })
  .addAttribute('successCount', {
    type: 'number',
    default: 0,
    validate: (value) => !value || isInteger(value),
  })
  .addAttribute('urlCount', {
    type: 'number',
    default: 0,
    validate: (value) => !value || isInteger(value),
  })
  .addAllIndex(['startedAt'])
  .addIndex(
    { composite: ['status'] },
    { composite: ['updatedAt'] },
  );

export default schema.build();
