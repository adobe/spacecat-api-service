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
import routeRequiredCapabilities, { INTERNAL_ROUTES } from '../../src/routes/required-capabilities.js';

const testDir = dirname(fileURLToPath(import.meta.url));

const ALLOWED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ALLOWED_ACTIONS = ['read', 'write'];
const PATH_REGEX = /^\/[a-zA-Z0-9\-_/.:]+(\/[a-zA-Z0-9\-_/.:])*$/;

describe('routeRequiredCapabilities', () => {
  const entries = Object.entries(routeRequiredCapabilities);

  it('should not be empty', () => {
    expect(entries.length).to.be.greaterThan(0);
  });

  entries.forEach(([key, value]) => {
    describe(`"${key}"`, () => {
      const parts = key.split(' ');

      it('key should have exactly two parts: METHOD and path', () => {
        expect(parts).to.have.lengthOf(2, `Expected "<METHOD> <path>" but got "${key}"`);
      });

      it(`should have an allowed HTTP method (${ALLOWED_HTTP_METHODS.join(', ')})`, () => {
        const [method] = parts;
        expect(ALLOWED_HTTP_METHODS).to.include(method, `Invalid HTTP method "${method}" in "${key}"`);
      });

      it('should have a path starting with /', () => {
        const [, path] = parts;
        expect(path).to.match(/^\//, `Path must start with "/" in "${key}"`);
      });

      it('should have a correctly formatted path', () => {
        const [, path] = parts;
        expect(path).to.match(PATH_REGEX, `Path "${path}" contains invalid characters in "${key}"`);
      });

      it('should have a value in the format "entity:action"', () => {
        const valueParts = value.split(':');
        expect(valueParts).to.have.lengthOf(2, `Expected "entity:action" but got "${value}" for "${key}"`);
      });

      it('should have a non-empty entity name', () => {
        const [entity] = value.split(':');
        expect(entity).to.have.length.greaterThan(0, `Entity name is empty for "${key}"`);
      });

      it(`should have an allowed action (${ALLOWED_ACTIONS.join(', ')})`, () => {
        const [, action] = value.split(':');
        expect(ALLOWED_ACTIONS).to.include(action, `Invalid action "${action}" in value "${value}" for "${key}"`);
      });
    });
  });

  describe('route coverage', () => {
    it('every route from routes/index.js must be in routeRequiredCapabilities or INTERNAL_ROUTES', () => {
      const routesPath = join(testDir, '../../src/routes/index.js');
      const content = readFileSync(routesPath, 'utf8');
      const routeDefMatch = content.match(/const routeDefinitions = \{([\s\S]*?)\};/);
      if (!routeDefMatch) {
        throw new Error('Could not find routeDefinitions in routes/index.js');
      }
      const routeKeys = [...routeDefMatch[1].matchAll(/'([A-Z]+\s[^']+)'/g)].map((m) => m[1]);

      const inCapabilities = new Set(Object.keys(routeRequiredCapabilities));
      const internalSet = new Set(INTERNAL_ROUTES);

      const uncategorized = routeKeys.filter(
        (r) => !inCapabilities.has(r) && !internalSet.has(r),
      );

      expect(
        uncategorized,
        `New route(s) need to be added to either routeRequiredCapabilities or INTERNAL_ROUTES: ${uncategorized.join(', ')}`,
      ).to.have.lengthOf(0);
    });
  });
});
