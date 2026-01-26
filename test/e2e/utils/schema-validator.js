/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/**
 * Schema Validator Utility
 *
 * Validates API response bodies against OpenAPI schemas using AJV.
 * Schemas are loaded once at startup and validators are cached for performance.
 *
 * Usage:
 *   // Initialize once before all tests (e.g., in mocha's global before hook)
 *   await initSchemaValidator();
 *
 *   // Validate response bodies
 *   const result = validateSchema(responseBody, 'Organization');
 *   if (!result.valid) {
 *     console.error(result.errors);
 *   }
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';

let spec = null;
let ajv = null;
const validatorCache = new Map();

/**
 * Returns whether the validator has been initialized.
 *
 * @returns {boolean} True if initialized
 */
function isInitialized() {
  return ajv !== null && spec !== null;
}

/**
 * Initializes the schema validator by loading and dereferencing the OpenAPI spec.
 * Must be called once before any validation, typically in a global before() hook.
 *
 * @param {string} specPath - Path to the OpenAPI spec file
 * @returns {Promise<Object>} The dereferenced OpenAPI spec
 */
export async function initSchemaValidator(specPath = './docs/openapi/api.yaml') {
  if (isInitialized()) {
    return spec;
  }

  spec = await SwaggerParser.dereference(specPath);
  ajv = new Ajv({ allErrors: true, verbose: true, strict: false });
  addFormats(ajv);
  return spec;
}

/**
 * Validates data against a named schema from the OpenAPI spec.
 * Validators are compiled once and cached for subsequent calls.
 *
 * @param {Object} data - The data to validate (typically API response body)
 * @param {string} schemaName - The schema name from OpenAPI components/schemas
 * @returns {{valid: boolean, errors: Array|null}} Validation result
 * @throws {Error} If schema not found or validator not initialized
 */
export function validateSchema(data, schemaName) {
  if (!ajv || !spec) {
    throw new Error('Schema validator not initialized. Call initSchemaValidator() first.');
  }

  if (!validatorCache.has(schemaName)) {
    const schema = spec.components?.schemas?.[schemaName];
    if (!schema) {
      throw new Error(`Schema "${schemaName}" not found in OpenAPI spec components/schemas`);
    }
    validatorCache.set(schemaName, ajv.compile(schema));
  }

  const validator = validatorCache.get(schemaName);
  const valid = validator(data);

  return {
    valid,
    errors: valid ? null : validator.errors,
  };
}

/**
 * Formats validation errors into a human-readable string.
 *
 * @param {Array} errors - AJV validation errors
 * @returns {string} Formatted error message
 */
export function formatValidationErrors(errors) {
  if (!errors || errors.length === 0) {
    return '';
  }

  return errors
    .map((e) => `${e.instancePath || '(root)'}: ${e.message}`)
    .join('\n');
}
