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

  describe('internal vs capability partitioning', () => {
    // Structural invariant: a route is either gated by a capability (S2S consumers can call
    // it when granted) or listed as internal (S2S consumers are denied at the gate). Never
    // both. If the same route appears in both lists, the capability wins and the internal
    // listing becomes misleading documentation — the exact silent-broadening failure mode
    // this suite exists to prevent.
    it('INTERNAL_ROUTES and routeRequiredCapabilities must be disjoint', () => {
      const capabilityRoutes = new Set(Object.keys(routeRequiredCapabilities));
      const overlap = INTERNAL_ROUTES.filter((r) => capabilityRoutes.has(r));
      expect(
        overlap,
        `Routes listed as internal must not also be mapped to a capability: ${overlap.join(', ')}`,
      ).to.have.lengthOf(0);
    });

    // Pin specific route-to-placement decisions so a silent regression (e.g. granting a
    // broader capability to a platform-scoped route) fails loudly in review.
    it('keeps GET /monitoring/drs-bp-pg-audit in INTERNAL_ROUTES, not routeRequiredCapabilities', () => {
      const route = 'GET /monitoring/drs-bp-pg-audit';
      expect(
        INTERNAL_ROUTES,
        'DRS Brand Presence PG audit is admin-key only; bundling into audit:read would silently '
        + 'broaden that site-scoped capability to infra monitoring data.',
      ).to.include(route);
      expect(
        routeRequiredCapabilities,
        'DRS Brand Presence PG audit must not be mapped to an S2S capability until a dedicated '
        + 'resource-scoped capability (e.g. drsBrandPresenceAudit:read) is registered.',
      ).to.not.have.property(route);
    });

    describe('API key routes', () => {
      const API_KEY_ROUTES = [
        'POST /tools/api-keys',
        'DELETE /tools/api-keys/:id',
        'GET /tools/api-keys',
      ];

      it('are in INTERNAL_ROUTES (not exposed to S2S consumers)', () => {
        const internalSet = new Set(INTERNAL_ROUTES);
        API_KEY_ROUTES.forEach((route) => {
          expect(internalSet.has(route), `${route} must be in INTERNAL_ROUTES`).to.be.true;
        });
      });

      it('are not in routeRequiredCapabilities', () => {
        API_KEY_ROUTES.forEach((route) => {
          expect(routeRequiredCapabilities).to.not.have.property(route);
        });
      });
    });

    describe('sheet-data POST routes', () => {
      const SHEET_DATA_POST_ROUTES = [
        'POST /sites/:siteId/llmo/sheet-data/:dataSource',
        'POST /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource',
        'POST /sites/:siteId/llmo/sheet-data/:sheetType/:week/:dataSource',
      ];

      it('are mapped to site:read (not site:write)', () => {
        SHEET_DATA_POST_ROUTES.forEach((route) => {
          expect(routeRequiredCapabilities[route], `${route} must map to site:read`).to.equal('site:read');
        });
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
      expect(routeKeys.length).to.be.greaterThan(
        100,
        'Regex failed to extract routes from routes/index.js - format may have changed',
      );

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
