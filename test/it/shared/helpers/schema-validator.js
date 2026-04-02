/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(testDir, '../../../..');

/**
 * OpenAPI-specific keywords that are not part of JSON Schema and must be stripped
 * before AJV compilation.
 */
const OPENAPI_KEYWORDS = [
  'example', 'examples', 'externalDocs', 'discriminator',
  'xml', 'deprecated', 'readOnly', 'writeOnly',
];

let bundledSpec = null;
let ajv = null;
const validatorCache = new Map();

/**
 * Bundles and caches the OpenAPI spec using @redocly/cli.
 * Called lazily on first use. Takes ~3s.
 */
function getBundledSpec() {
  if (bundledSpec) return bundledSpec;

  const apiYamlPath = join(rootDir, 'docs/openapi/api.yaml');
  const outPath = join(rootDir, 'docs/openapi/.bundled-api.json');
  execSync(
    `npx @redocly/cli bundle "${apiYamlPath}" --dereferenced --ext json -o "${outPath}"`,
    { cwd: rootDir, encoding: 'utf8', timeout: 30000 },
  );
  const content = readFileSync(outPath, 'utf8');
  bundledSpec = JSON.parse(content);
  return bundledSpec;
}

/**
 * Returns a configured AJV instance with format validators.
 */
function getAjv() {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

/**
 * Recursively strips OpenAPI-specific keywords from a schema object.
 * Returns a new object — does not mutate the input.
 */
function stripOpenApiKeywords(schema) {
  if (schema == null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(stripOpenApiKeywords);

  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !OPENAPI_KEYWORDS.includes(key) && !key.startsWith('x-'))
      .map(([key, value]) => [key, stripOpenApiKeywords(value)]),
  );
}

/**
 * Recursively injects `additionalProperties: false` into every object schema
 * that has `properties` defined but no explicit `additionalProperties` setting.
 * This enables strict validation that catches undocumented fields in responses.
 *
 * Skips schemas that already set `additionalProperties` (true, false, or schema),
 * and schemas without `properties` (e.g., free-form objects, maps).
 */
function injectStrictAdditionalProperties(schema) {
  if (schema == null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(injectStrictAdditionalProperties);

  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    result[key] = injectStrictAdditionalProperties(value);
  }

  if (
    result.type === 'object'
    && result.properties
    && !('additionalProperties' in result)
  ) {
    result.additionalProperties = false;
  }

  return result;
}

/**
 * Compiles and caches an AJV validator for a given schema.
 */
function compileValidator(cacheKey, schema, { strict = false } = {}) {
  const fullKey = strict ? `strict:${cacheKey}` : cacheKey;
  let validate = validatorCache.get(fullKey);

  if (!validate) {
    let cleaned = stripOpenApiKeywords(schema);
    if (strict) {
      cleaned = injectStrictAdditionalProperties(cleaned);
    }
    const ajvInstance = getAjv();
    try {
      validate = ajvInstance.compile(cleaned);
    } catch (err) {
      return {
        valid: false,
        errors: [`Schema compilation failed for ${fullKey}: ${err.message}`],
      };
    }
    validatorCache.set(fullKey, validate);
  }

  return validate;
}

/**
 * Runs an AJV validator against a body and formats errors.
 */
function runValidation(validate, body) {
  // compileValidator may return an error object instead of a function
  if (validate.valid === false) return validate;

  const valid = validate(body);
  if (valid) return { valid: true, errors: [] };

  const errors = validate.errors.map((err) => {
    const path = err.instancePath || '(root)';
    return `${path}: ${err.message} (${JSON.stringify(err.params)})`;
  });

  return { valid: false, errors };
}

/**
 * Retrieves the response schema for a given method, path, and status code.
 */
export function getSchemaForResponse(method, openApiPath, statusCode) {
  const spec = getBundledSpec();
  const pathDef = spec.paths?.[openApiPath];
  if (!pathDef) return null;

  const operation = pathDef[method.toLowerCase()];
  if (!operation) return null;

  const response = operation.responses?.[statusCode];
  if (!response) return null;

  return response.content?.['application/json']?.schema ?? null;
}

/**
 * Retrieves the request body schema for a given method and path.
 */
export function getSchemaForRequest(method, openApiPath) {
  const spec = getBundledSpec();
  const pathDef = spec.paths?.[openApiPath];
  if (!pathDef) return null;

  const operation = pathDef[method.toLowerCase()];
  if (!operation) return null;

  return operation.requestBody?.content?.['application/json']?.schema ?? null;
}

/**
 * Validates a response body against the declared OpenAPI schema.
 *
 * @param {string} method - HTTP method
 * @param {string} openApiPath - OpenAPI path template
 * @param {string} statusCode - HTTP status code as string
 * @param {*} body - The response body to validate
 * @param {object} [options]
 * @param {boolean} [options.strict=false] - When true, injects
 *   additionalProperties: false into all object schemas that don't
 *   explicitly set it. This catches undocumented fields in responses.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateResponseSchema(
  method,
  openApiPath,
  statusCode,
  body,
  { strict = false } = {},
) {
  if (body == null) return { valid: true, errors: [] };

  const schema = getSchemaForResponse(method, openApiPath, statusCode);
  if (!schema) return { valid: true, errors: [] };

  const cacheKey = `res:${method}:${openApiPath}:${statusCode}`;
  const validate = compileValidator(cacheKey, schema, { strict });

  return runValidation(validate, body);
}

/**
 * Validates a request body against the declared OpenAPI requestBody schema.
 *
 * @param {string} method - HTTP method
 * @param {string} openApiPath - OpenAPI path template
 * @param {*} body - The request body to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRequestSchema(method, openApiPath, body) {
  if (body == null) return { valid: true, errors: [] };

  const schema = getSchemaForRequest(method, openApiPath);
  if (!schema) return { valid: true, errors: [] };

  const cacheKey = `req:${method}:${openApiPath}`;
  const validate = compileValidator(cacheKey, schema);

  return runValidation(validate, body);
}
