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

import { hasText, isNumber, isObject } from '@adobe/spacecat-shared-utils';
import { validate as validateUUID } from 'uuid';

import { ValidationError } from '../errors/index.js';

/**
 * Checks if a value is nullable and if the value is null or undefined.
 * @param {any} value - The value to check.
 * @param {boolean} nullable - Whether the value is nullable.
 * @return {boolean} True if the value is nullable and null or undefined, false otherwise.
 */
const checkNullable = (value, nullable) => nullable && (value === null || value === undefined);

/**
 * Checks if a value is of a given type.
 * Supported types are 'string', 'number', 'boolean', 'object', and 'uuid'.
 * @param {any} value
 * @param {string} type
 * @return {boolean} True if the value is of the given type, false otherwise.
 */
const checkType = (value, type) => {
  switch (type) {
    case 'any':
      return isObject(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'map':
      return isObject(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    default:
      throw new ValidationError(`Unsupported type: ${type}`);
  }
};

/**
 * Validates that a given property of any type is not null or undefined.
 * @param {String} propertyName - Name of the property being validated.
 * @param {any} value - The value to validate.
 * @param {String} entityName - Name of the entity containing this property.
 * @param {boolean} [nullable] - Whether the value is nullable. Defaults to false.
 * @throws Will throw an error if the value is null or undefined.
 */
export const guardAny = (propertyName, value, entityName, nullable = false) => {
  if (!checkNullable(value, nullable) && (value === undefined || value === null)) {
    throw new ValidationError(`Validation failed in ${entityName}: ${propertyName} is required`);
  }
};

/**
 * Validates that a given property is a boolean.
 * @param {String} propertyName - Name of the property being validated.
 * @param {any} value - The value to validate.
 * @param {String} entityName - Name of the entity containing this property.
 * @param {boolean} [nullable] - Whether the value is nullable. Defaults to false.
 * @throws Will throw an error if the value is not a valid boolean.
 */
export const guardBoolean = (propertyName, value, entityName, nullable = false) => {
  if (checkNullable(value, nullable)) return;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`Validation failed in ${entityName}: ${propertyName} must be a boolean`);
  }
};

export const guardArray = (propertyName, value, entityName, type = 'string', nullable = false) => {
  if (checkNullable(value, nullable)) return;
  if (!Array.isArray(value)) {
    throw new ValidationError(`Validation failed in ${entityName}: ${propertyName} must be an array`);
  }
  if (!value.every((v) => checkType(v, type))) {
    throw new ValidationError(`Validation failed in ${entityName}: ${propertyName} must contain items of type ${type}`);
  }
};

/**
 * Validates that a given property is a set (unique array) of a given type (defaults to string).
 * @param {String} propertyName - Name of the property being validated.
 * @param {any} value - The value to validate.
 * @param {String} entityName - Name of the entity containing this property.
 * @param {String} [type] - The type of the items in the set. Defaults to 'string'.
 * @param {boolean} [nullable] - Whether the value is nullable. Defaults to false.
 * @throws Will throw an error if the value is not a valid set (unique array) of a given type.
 */
export const guardSet = (propertyName, value, entityName, type = 'string', nullable = false) => {
  if (checkNullable(value, nullable)) return;
  if (!Array.isArray(value) || new Set(value).size !== value.length) {
    throw new ValidationError(`Validation failed in ${entityName}: ${propertyName} must be a unique array (set)`);
  }
  if (!value.every((v) => checkType(v, type))) {
    throw new ValidationError(`Validation failed in ${entityName}: ${propertyName} must contain items of type ${type}`);
  }
};

/**
 * Validates that a given property is a string.
 * @param {String} propertyName - Name of the property being validated.
 * @param {any} value - The value to validate.
 * @param {String} entityName - Name of the entity containing this property.
 * @param {boolean} [nullable] - Whether the value is nullable. Defaults to false.
 * @throws Will throw an error if the value is not a valid string.
 */
export const guardString = (propertyName, value, entityName, nullable = false) => {
  if (checkNullable(value, nullable)) return;
  if (!hasText(value)) {
    throw new ValidationError(`Validation failed in ${entityName}: ${propertyName} is required`);
  }
};

/**
 * Validates that a given property is of an enum type.
 * @param {String} propertyName - Name of the property being validated.
 * @param {any} value - The value to validate.
 * @param {Array<String>} enumValues - Allowed enum values.
 * @param {String} entityName - Name of the entity containing this property.
 * @param {boolean} [nullable] - Whether the value is nullable. Defaults to false.
 * @throws Will throw an error if the value is not a valid enum value.
 */
export const guardEnum = (propertyName, value, enumValues, entityName, nullable = false) => {
  if (checkNullable(value, nullable)) return;
  if (!enumValues.includes(value)) {
    throw new ValidationError(`Validation failed in ${entityName}: ${propertyName} must be one of ${enumValues}`);
  }
};

/**
 * Validates that a given property is a valid ID.
 * @param {String} propertyName - Name of the property being validated.
 * @param {any} value - The value to validate.
 * @param {String} entityName - Name of the entity containing this property.
 * @param {boolean} [nullable] - Whether the value is nullable. Defaults to false.
 * @throws Will throw an error if the value is not a valid ID.
 */
export const guardId = (propertyName, value, entityName, nullable = false) => {
  if (checkNullable(value, nullable)) return;
  if (!validateUUID(value)) {
    throw new ValidationError(`Validation failed in ${entityName}: ${propertyName} must be a valid UUID`);
  }
};

/**
 * Validates that a given property is a map (object).
 * @param {String} propertyName - Name of the property being validated.
 * @param {any} value - The value to validate.
 * @param {String} entityName - Name of the entity containing this property.
 * @param {boolean} [nullable] - Whether the value is nullable. Defaults to false.
 * @throws Will throw an error if the value is not a valid map (object).
 */
export const guardMap = (propertyName, value, entityName, nullable = false) => {
  if (checkNullable(value, nullable)) return;
  if (!isObject(value)) {
    throw new ValidationError(`Validation failed in ${entityName}: ${propertyName} must be an object`);
  }
};

/**
 * Validates that a given property is a number.
 * @param {String} propertyName - Name of the property being validated.
 * @param {any} value - The value to validate.
 * @param {String} entityName - Name of the entity containing this property.
 * @param {boolean} [nullable] - Whether the value is nullable. Defaults to false.
 * @throws Will throw an error if the value is not a valid number.
 */
export const guardNumber = (propertyName, value, entityName, nullable = false) => {
  if (checkNullable(value, nullable)) return;
  if (!isNumber(value)) {
    throw new ValidationError(`Validation failed in ${entityName}: ${propertyName} must be a number`);
  }
};
