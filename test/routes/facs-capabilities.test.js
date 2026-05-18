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

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'chai';

import routeFacsCapabilities from '../../src/routes/facs-capabilities.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, '..', '..');

/**
 * Reads `src/routes/index.js` and returns the set of every `'METHOD /path'` literal
 * declared as a route key. Implementation mirrors the regex used elsewhere to lock
 * the route surface (e.g. `test/routes/index.test.js`).
 */
function loadAllDeclaredRoutes() {
  const source = readFileSync(join(projectRoot, 'src/routes/index.js'), 'utf8');
  const re = /'((?:GET|POST|PATCH|PUT|DELETE) \/[^']*)'/g;
  const out = new Set();
  for (const m of source.matchAll(re)) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Pins the structural contract `facsWrapper` (in `@adobe/spacecat-shared-http-utils`)
 * depends on, plus the coverage invariant against `src/routes/index.js`:
 *
 *   - top level has exactly two keys: `INTERNAL_ROUTES` (array) and `PRODUCTS_ROUTES` (object)
 *   - `INTERNAL_ROUTES` is an array of unique `'METHOD /path'` strings
 *   - `PRODUCTS_ROUTES` keys are uppercase product codes; each value is an object
 *   - each product route key is `'METHOD /path'`
 *   - each product permission value is `'<product>/<action>'` whose prefix equals
 *     the enclosing product key (case-insensitive)
 *   - every route in either bucket exists in `src/routes/index.js` (no stale entries)
 *   - for any populated product P:
 *       routes(P) ∪ INTERNAL_ROUTES = all declared routes
 *       routes(P) ∩ INTERNAL_ROUTES = ∅
 */
describe('routeFacsCapabilities', () => {
  const METHOD_PATH_RE = /^(GET|POST|PATCH|PUT|DELETE) \/.+$/;
  const PERMISSION_RE = /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/;

  let allDeclaredRoutes;
  before(() => {
    allDeclaredRoutes = loadAllDeclaredRoutes();
  });

  describe('top-level shape', () => {
    it('exposes exactly INTERNAL_ROUTES and PRODUCTS_ROUTES', () => {
      expect(routeFacsCapabilities).to.have.all.keys('INTERNAL_ROUTES', 'PRODUCTS_ROUTES');
    });

    it('INTERNAL_ROUTES is an array', () => {
      expect(routeFacsCapabilities.INTERNAL_ROUTES).to.be.an('array');
    });

    it('PRODUCTS_ROUTES is an object', () => {
      expect(routeFacsCapabilities.PRODUCTS_ROUTES).to.be.an('object');
    });
  });

  describe('INTERNAL_ROUTES', () => {
    it('contains unique route strings', () => {
      const arr = routeFacsCapabilities.INTERNAL_ROUTES;
      expect(new Set(arr).size, 'INTERNAL_ROUTES has duplicate entries')
        .to.equal(arr.length);
    });

    it('each entry follows the "METHOD /path" shape', () => {
      routeFacsCapabilities.INTERNAL_ROUTES.forEach((route) => {
        expect(route).to.match(METHOD_PATH_RE);
      });
    });

    it('every entry exists in src/routes/index.js (no stale routes)', () => {
      const stale = routeFacsCapabilities.INTERNAL_ROUTES
        .filter((route) => !allDeclaredRoutes.has(route));
      expect(stale, `stale INTERNAL_ROUTES not found in src/routes/index.js: ${stale.join(', ')}`)
        .to.deep.equal([]);
    });
  });

  describe('PRODUCTS_ROUTES', () => {
    it('keys are uppercase product codes', () => {
      Object.keys(routeFacsCapabilities.PRODUCTS_ROUTES).forEach((product) => {
        expect(product, `product key '${product}' must be uppercase`)
          .to.equal(product.toUpperCase());
      });
    });

    it('declares the Phase 1 products LLMO, ASO, ACO', () => {
      expect(routeFacsCapabilities.PRODUCTS_ROUTES).to.have.all.keys('LLMO', 'ASO', 'ACO');
    });

    it('each product value is an object (possibly empty)', () => {
      Object.entries(routeFacsCapabilities.PRODUCTS_ROUTES).forEach(([product, subMap]) => {
        expect(subMap, `${product} sub-map`).to.be.an('object');
      });
    });

    it('each route key follows the "METHOD /path" shape', () => {
      Object.entries(routeFacsCapabilities.PRODUCTS_ROUTES).forEach(([product, subMap]) => {
        Object.keys(subMap).forEach((route) => {
          expect(route, `${product} route '${route}'`).to.match(METHOD_PATH_RE);
        });
      });
    });

    it('each permission value is a "<product>/<action>" string scoped to its product', () => {
      Object.entries(routeFacsCapabilities.PRODUCTS_ROUTES).forEach(([product, subMap]) => {
        Object.entries(subMap).forEach(([route, permission]) => {
          expect(permission, `${product} ${route}`)
            .to.be.a('string').and.match(PERMISSION_RE);
          const [prefix] = permission.split('/');
          expect(
            prefix,
            `permission '${permission}' for ${product} ${route} must be prefixed with the product code`,
          ).to.equal(product.toLowerCase());
        });
      });
    });

    it('every product route exists in src/routes/index.js (no stale routes)', () => {
      Object.entries(routeFacsCapabilities.PRODUCTS_ROUTES).forEach(([product, subMap]) => {
        const stale = Object.keys(subMap).filter((route) => !allDeclaredRoutes.has(route));
        expect(stale, `stale ${product} routes not found in src/routes/index.js: ${stale.join(', ')}`)
          .to.deep.equal([]);
      });
    });
  });

  describe('invariant: routes(product) ∪ INTERNAL_ROUTES = all routes', () => {
    it('INTERNAL_ROUTES is disjoint from every product sub-map', () => {
      const internalSet = new Set(routeFacsCapabilities.INTERNAL_ROUTES);
      Object.entries(routeFacsCapabilities.PRODUCTS_ROUTES).forEach(([product, subMap]) => {
        const overlap = Object.keys(subMap).filter((route) => internalSet.has(route));
        expect(overlap, `${product} routes overlap with INTERNAL_ROUTES: ${overlap.join(', ')}`)
          .to.deep.equal([]);
      });
    });

    it('every populated product P satisfies routes(P) ∪ INTERNAL_ROUTES = all declared routes', () => {
      const internalSet = new Set(routeFacsCapabilities.INTERNAL_ROUTES);
      Object.entries(routeFacsCapabilities.PRODUCTS_ROUTES).forEach(([product, subMap]) => {
        const productRoutes = Object.keys(subMap);
        if (productRoutes.length === 0) {
          // ASO/ACO are stubs pending MAC policy — invariant kicks in once populated.
          return;
        }
        const covered = new Set([...productRoutes, ...internalSet]);
        const missing = [...allDeclaredRoutes].filter((route) => !covered.has(route));
        expect(
          missing,
          `${product} is missing ${missing.length} routes that are not in INTERNAL_ROUTES: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`,
        ).to.deep.equal([]);
      });
    });
  });
});
