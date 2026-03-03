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

import { expect } from 'chai';
import routeRequiredCapabilities from '../../src/routes/required-capabilities.js';

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
});
