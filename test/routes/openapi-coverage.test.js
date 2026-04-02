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

/* eslint-env mocha */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { expect } from 'chai';
import YAML from 'yaml';
import { INTERNAL_ROUTES } from '../../src/routes/required-capabilities.js';
import { UNDOCUMENTED_ROUTES, PHANTOM_OPENAPI_ROUTES } from '../../src/routes/undocumented-routes.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(testDir, '../..');
const openApiDir = join(rootDir, 'docs/openapi');

/**
 * Known parameter name differences between Express routes and OpenAPI paths.
 * Key: Express param name (without colon), Value: OpenAPI param name (without braces).
 */
const PARAM_NAME_MAP = {
  baseURL: 'base64BaseUrl',
  url: 'base64Url',
  id: 'apiKeyId',
};

/**
 * Converts an Express-style route to OpenAPI format.
 * 'GET /sites/:siteId' -> 'GET /sites/{siteId}'
 * Also applies known parameter name normalizations.
 */
function toOpenApiFormat(route) {
  return route.replace(/:([^/]+)/g, (_, paramName) => {
    const mapped = PARAM_NAME_MAP[paramName] || paramName;
    return `{${mapped}}`;
  });
}

/**
 * Normalizes all path parameters to {_} for structural comparison.
 * 'GET /sites/{siteId}' -> 'GET /sites/{_}'
 */
function normalizeParams(route) {
  return route.replace(/\{[^}]+\}/g, '{_}');
}

/**
 * Extracts route keys from src/routes/index.js using regex.
 * Same approach proven in required-capabilities.test.js.
 */
function extractCodeRoutes() {
  const routesPath = join(rootDir, 'src/routes/index.js');
  const content = readFileSync(routesPath, 'utf8');
  const routeDefMatch = content.match(/const routeDefinitions = \{([\s\S]*?)\};/);
  if (!routeDefMatch) {
    throw new Error('Could not find routeDefinitions in routes/index.js');
  }
  const routeKeys = [...routeDefMatch[1].matchAll(/'([A-Z]+\s[^']+)'/g)].map((m) => m[1]);
  if (routeKeys.length <= 100) {
    throw new Error('Regex failed to extract routes from routes/index.js - format may have changed');
  }
  return routeKeys;
}

/**
 * Decodes a JSON Pointer fragment (used in $ref anchors).
 * ~1 -> /, ~0 -> ~
 */
function decodeJsonPointer(fragment) {
  return fragment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Resolves a nested YAML value by following a slash-separated key path.
 * Handles both direct keys and JSON Pointer encoded keys.
 */
function resolveAnchor(parsed, anchor) {
  // First try direct key lookup (most common case)
  if (parsed[anchor]) return parsed[anchor];

  // Try JSON Pointer path traversal for nested anchors like 'paths/~1sites~1{siteId}'
  const parts = anchor.split('/');
  let current = parsed;
  for (const part of parts) {
    const decoded = decodeJsonPointer(part);
    if (current == null || typeof current !== 'object') return null;
    current = current[decoded];
  }
  return current;
}

/**
 * Extracts all METHOD + path combinations from the OpenAPI spec.
 * Reads api.yaml, follows $ref pointers to domain files, and extracts HTTP methods.
 */
function extractOpenApiRoutes() {
  const apiYaml = readFileSync(join(openApiDir, 'api.yaml'), 'utf8');
  const spec = YAML.parse(apiYaml);
  const routes = [];
  const httpMethods = ['get', 'post', 'put', 'patch', 'delete'];

  for (const [pathTemplate, ref] of Object.entries(spec.paths)) {
    const refStr = ref.$ref;
    if (!refStr) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const [file, anchor] = refStr.split('#/');
    const filePath = join(openApiDir, file);

    let fileContent;
    try {
      fileContent = readFileSync(filePath, 'utf8');
    } catch {
      throw new Error(
        `OpenAPI $ref file not found: ${filePath} (path ${pathTemplate})`,
      );
    }

    const parsed = YAML.parse(fileContent);
    const pathDef = resolveAnchor(parsed, anchor);
    if (!pathDef) {
      throw new Error(
        `Missing anchor '${anchor}' in ${file} (path ${pathTemplate})`,
      );
    }

    const methods = httpMethods.filter((m) => pathDef[m]);
    for (const method of methods) {
      routes.push(`${method.toUpperCase()} ${pathTemplate}`);
    }
  }

  return routes;
}

// Pre-compute at module load time (outside mocha timeout)
const codeRoutes = extractCodeRoutes();
const openApiRoutes = extractOpenApiRoutes();

describe('OpenAPI coverage', () => {
  it('every code route must be documented in OpenAPI or listed as undocumented/internal', () => {
    const openApiSet = new Set(openApiRoutes.map(normalizeParams));
    const internalSet = new Set(
      INTERNAL_ROUTES.map((r) => normalizeParams(toOpenApiFormat(r))),
    );
    const undocumentedSet = new Set(
      UNDOCUMENTED_ROUTES.map((r) => normalizeParams(toOpenApiFormat(r))),
    );

    const missing = codeRoutes
      .map(toOpenApiFormat)
      .map(normalizeParams)
      .filter((r) => !openApiSet.has(r) && !internalSet.has(r) && !undocumentedSet.has(r));

    expect(
      missing,
      `Code route(s) not documented in OpenAPI and not in UNDOCUMENTED_ROUTES or INTERNAL_ROUTES:\n${missing.join('\n')}`,
    ).to.have.lengthOf(0);
  });

  it('every OpenAPI path must have a corresponding code route or be listed as phantom', () => {
    const codeSet = new Set(codeRoutes.map((r) => normalizeParams(toOpenApiFormat(r))));
    const phantomSet = new Set(PHANTOM_OPENAPI_ROUTES.map(normalizeParams));

    const orphaned = openApiRoutes
      .map(normalizeParams)
      .filter((r) => !codeSet.has(r) && !phantomSet.has(r));

    expect(
      orphaned,
      `OpenAPI path(s) with no corresponding code route and not in PHANTOM_OPENAPI_ROUTES:\n${orphaned.join('\n')}`,
    ).to.have.lengthOf(0);
  });

  it('UNDOCUMENTED_ROUTES entries must all correspond to actual code routes', () => {
    const codeSet = new Set(codeRoutes.map((r) => normalizeParams(toOpenApiFormat(r))));

    const stale = UNDOCUMENTED_ROUTES
      .map((r) => normalizeParams(toOpenApiFormat(r)))
      .filter((r) => !codeSet.has(r));

    expect(
      stale,
      `UNDOCUMENTED_ROUTES entries with no matching code route (remove stale entries):\n${stale.join('\n')}`,
    ).to.have.lengthOf(0);
  });

  it('UNDOCUMENTED_ROUTES entries must not already be documented in OpenAPI', () => {
    const openApiSet = new Set(openApiRoutes.map(normalizeParams));

    const alreadyDocumented = UNDOCUMENTED_ROUTES
      .map((r) => normalizeParams(toOpenApiFormat(r)))
      .filter((r) => openApiSet.has(r));

    expect(
      alreadyDocumented,
      `UNDOCUMENTED_ROUTES entries that are already in OpenAPI (remove from allowlist):\n${alreadyDocumented.join('\n')}`,
    ).to.have.lengthOf(0);
  });

  it('PHANTOM_OPENAPI_ROUTES entries must all exist in the OpenAPI spec', () => {
    const openApiSet = new Set(openApiRoutes.map(normalizeParams));

    const stale = PHANTOM_OPENAPI_ROUTES
      .map(normalizeParams)
      .filter((r) => !openApiSet.has(r));

    expect(
      stale,
      `PHANTOM_OPENAPI_ROUTES entries not found in OpenAPI spec (remove stale entries):\n${stale.join('\n')}`,
    ).to.have.lengthOf(0);
  });

  describe('ratchet', () => {
    // This ceiling must only decrease over time as routes get documented.
    // Increase it only if intentionally adding new undocumented routes.
    const UNDOCUMENTED_CEILING = 61;
    const PHANTOM_CEILING = 12;

    it(`UNDOCUMENTED_ROUTES count must not exceed ${UNDOCUMENTED_CEILING}`, () => {
      expect(
        UNDOCUMENTED_ROUTES.length,
        `UNDOCUMENTED_ROUTES has ${UNDOCUMENTED_ROUTES.length} entries (ceiling: ${UNDOCUMENTED_CEILING}). `
        + 'If you added new routes, document them in OpenAPI instead of adding to this list. '
        + 'If you documented existing routes, lower the ceiling.',
      ).to.be.at.most(UNDOCUMENTED_CEILING);
    });

    it(`PHANTOM_OPENAPI_ROUTES count must not exceed ${PHANTOM_CEILING}`, () => {
      expect(
        PHANTOM_OPENAPI_ROUTES.length,
        `PHANTOM_OPENAPI_ROUTES has ${PHANTOM_OPENAPI_ROUTES.length} entries (ceiling: ${PHANTOM_CEILING}). `
        + 'If you added new OpenAPI paths, ensure they have a code route. '
        + 'If you removed phantom paths, lower the ceiling.',
      ).to.be.at.most(PHANTOM_CEILING);
    });
  });
});
