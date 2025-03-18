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

import { hasText, isNonEmptyObject, isNumber } from '@adobe/spacecat-shared-utils';

import ValidationError from '../errors/validation.error.js';

function validateValue(context, keyName, value) {
  const { type } = context.schema.getAttribute(keyName);
  const validator = type === 'number' ? isNumber : hasText;

  if (!validator(value)) {
    throw new ValidationError(`${keyName} is required`);
  }
}

function parseAccessorArgs(context, requiredKeyNames, args) {
  const keys = {};
  for (let i = 0; i < requiredKeyNames.length; i += 1) {
    const keyName = requiredKeyNames[i];
    const keyValue = args[i];

    validateValue(context, keyName, keyValue);

    keys[keyName] = keyValue;
  }

  let options = {};

  if (args.length > requiredKeyNames.length) {
    options = args[requiredKeyNames.length];
  }

  return { keys, options };
}

function validateConfig(config) {
  if (!isNonEmptyObject(config)) {
    throw new Error('Config is required');
  }

  const {
    collection, context, name, requiredKeys,
  } = config;

  if (!isNonEmptyObject(collection)) {
    throw new Error('Collection is required');
  }

  if (!isNonEmptyObject(context)) {
    throw new Error('Context is required');
  }

  if (!hasText(name)) {
    throw new Error('Name is required');
  }

  if (!Array.isArray(requiredKeys)) {
    throw new Error('Required keys must be an array');
  }
}

/**
 * Create an accessor for a collection. The accessor can be used to query the collection.
 * @param {object} config - The accessor configuration.
 * @param {boolean} [config.all=false] - Whether to return all items in the collection.
 * @param {boolean} [config.byId=false] - Whether to return an item by ID.
 * @param {object} config.collection - The collection to query.
 * @param {object} config.context - The context to attach the accessor to.
 * @param {object} [config.foreignKey] - The foreign key to use when querying by ID.
 * @param {string} config.name - The name of the accessor.
 * @param {string[]} [config.requiredKeys] - The required keys for the accessor.
 * @throws {Error} - If the configuration is invalid.
 * @returns {void}
 */
export function createAccessor(config) { /* eslint-disable no-underscore-dangle */
  validateConfig(config);

  const {
    all = false,
    byId = false,
    collection,
    context,
    foreignKey,
    name,
    requiredKeys = [],
  } = config;
  if (!context._accessorCache) {
    Object.defineProperty(context, '_accessorCache', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: {},
    });
  }

  if (context[name]) {
    return;
  }

  const foreignKeys = {
    ...isNonEmptyObject(foreignKey) && { [foreignKey.name]: foreignKey.value },
  };

  // TODO Check here too!
  // This is used by collections
  const accessor = async (...args) => {
    const argsKey = args.length > 0 ? JSON.stringify(args) : '_';
    const cacheKey = `${name}:${argsKey}`;

    if (context._accessorCache[cacheKey] !== undefined) {
      return context._accessorCache[cacheKey];
    }

    let result;

    if (byId) {
      if (!hasText(foreignKey.value)) {
        result = null;
      } else {
        result = collection.findById(foreignKey.value);
      }
    } else {
      const { keys, options } = parseAccessorArgs(collection, requiredKeys, args);
      const allKeys = { ...foreignKeys, ...keys };

      result = all
        ? collection.allByIndexKeys(allKeys, options)
        : collection.findByIndexKeys(allKeys, options);
    }

    result = await result;
    context._accessorCache[cacheKey] = result;

    return result;
  };

  Object.defineProperty(
    context,
    name,
    {
      enumerable: false,
      configurable: false,
      writable: true,
      value: accessor,
    },
  );
}

export function createAccessors(configs) {
  configs.forEach((config) => {
    createAccessor(config);
  });
}
