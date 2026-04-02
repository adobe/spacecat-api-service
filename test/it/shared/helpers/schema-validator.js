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
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(testDir, '../../../..');

/**
 * OpenAPI-specific keywords that are not part of JSON Schema and must be stripped
 * before AJV compilation to keep strict mode enabled.
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
  const output = execSync(
    `npx @redocly/cli bundle "${apiYamlPath}" --format json`,
    { cwd: rootDir, encoding: 'utf8', timeout: 30000 },
  );
  bundledSpec = JSON.parse(output);
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
 * Retrieves the response schema for a given method, path, and status code.
 *
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} openApiPath - OpenAPI path template (e.g., '/sites/{siteId}')
 * @param {string} statusCode - HTTP status code (e.g., '200')
 * @returns {object|null} The JSON Schema for the response body, or null if not defined
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
 * Validates a response body against the declared OpenAPI schema.
 *
 * @param {string} method - HTTP method
 * @param {string} openApiPath - OpenAPI path template
 * @param {string} statusCode - HTTP status code as string
 * @param {*} body - The response body to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateResponseSchema(method, openApiPath, statusCode, body) {
  // Skip validation for empty bodies
  if (body == null) return { valid: true, errors: [] };

  const schema = getSchemaForResponse(method, openApiPath, statusCode);
  if (!schema) {
    // No schema defined for this response — nothing to validate
    return { valid: true, errors: [] };
  }

  const cacheKey = `${method}:${openApiPath}:${statusCode}`;
  let validate = validatorCache.get(cacheKey);

  if (!validate) {
    const cleaned = stripOpenApiKeywords(schema);
    const ajvInstance = getAjv();
    try {
      validate = ajvInstance.compile(cleaned);
    } catch (err) {
      return {
        valid: false,
        errors: [`Schema compilation failed for ${cacheKey}: ${err.message}`],
      };
    }
    validatorCache.set(cacheKey, validate);
  }

  // For array responses, validate the body directly
  // For object responses, validate the body directly
  const valid = validate(body);

  if (valid) return { valid: true, errors: [] };

  const errors = validate.errors.map((err) => {
    const path = err.instancePath || '(root)';
    return `${path}: ${err.message} (${JSON.stringify(err.params)})`;
  });

  return { valid: false, errors };
}
