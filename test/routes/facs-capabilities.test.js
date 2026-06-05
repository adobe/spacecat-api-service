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
 * Routes that the capabilities map declares **ahead** of their registration
 * in `src/routes/index.js`. Now empty — H4 landed the controller + route
 * registration for the hybrid-model surface, so all routes referenced by
 * the capability map are live in `src/routes/index.js` and guarded by the
 * regular stale-route check.
 */
const FORWARD_DECLARED_ROUTES = new Set([]);

/**
 * Params that appear only inside forward-declared routes. Now empty — see
 * `FORWARD_DECLARED_ROUTES` above.
 */
const FORWARD_DECLARED_ROUTE_PARAMS = new Set([]);

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
 * depends on, plus the **union-equality** coverage invariant against
 * `src/routes/index.js`:
 *
 *   - top level has the hybrid-model keys: `INTERNAL_ROUTES` (array),
 *     `PRODUCTS_ROUTES` (object), `PRODUCTS_FACS_RESOURCE_PARAM_ALIASES`,
 *     `FACS_NON_RESOURCE_PARAMS`.
 *   - `INTERNAL_ROUTES` is an array of unique `'METHOD /path'` strings.
 *   - `PRODUCTS_ROUTES` keys are uppercase product codes; each value is an object.
 *   - each product route key is `'METHOD /path'`.
 *   - each product route value is a single `'<product>/<capability>'` string
 *     whose prefix equals the enclosing product key (case-insensitive).
 *   - every route in either bucket exists in `src/routes/index.js` (no
 *     stale entries), modulo `FORWARD_DECLARED_ROUTES`.
 *
 * Union-equality invariant:
 *
 *   (∪ PRODUCTS_ROUTES[*]) ⊎ INTERNAL_ROUTES = all declared routes
 *
 * Disjoint union — every declared route is owned either by at least one
 * product OR by INTERNAL_ROUTES, never both. Routes CAN appear under
 * multiple products simultaneously; we do NOT enforce pairwise-disjoint
 * product maps. The invariant applies once for the union, not per product.
 */
describe('routeFacsCapabilities', () => {
  const METHOD_PATH_RE = /^(GET|POST|PATCH|PUT|DELETE) \/.+$/;
  const CAPABILITY_RE = /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/;

  let allDeclaredRoutes;
  before(() => {
    allDeclaredRoutes = loadAllDeclaredRoutes();
  });

  describe('top-level shape', () => {
    it('exposes the hybrid-model keys', () => {
      // Hybrid model dropped PRODUCTS_FACS_ADMIN_PERMISSIONS and
      // PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS — universal grants now
      // flow through JWT.facs_permissions + state-layer org-scoped rows.
      expect(routeFacsCapabilities).to.have.all.keys(
        'INTERNAL_ROUTES',
        'PRODUCTS_ROUTES',
        'PRODUCTS_FACS_RESOURCE_PARAM_ALIASES',
        'FACS_NON_RESOURCE_PARAMS',
      );
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

    it('declares the products LLMO, ASO, ACO', () => {
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

    it('each route value is a single "<product>/<capability>" string scoped to its product', () => {
      Object.entries(routeFacsCapabilities.PRODUCTS_ROUTES).forEach(([product, subMap]) => {
        Object.entries(subMap).forEach(([route, value]) => {
          expect(value, `${product} ${route}`).to.be.a('string').and.match(CAPABILITY_RE);
          const [prefix] = value.split('/');
          expect(
            prefix,
            `capability '${value}' for ${product} ${route} must be prefixed with the product code`,
          ).to.equal(product.toLowerCase());
        });
      });
    });

    it('the LLMO capability catalog does not reference the removed `can_view_all`', () => {
      // Regression guard for the hybrid-model migration: `can_view_all` was
      // collapsed into `can_view` (org-wide grant now arrives via an
      // org-scoped state-layer row carrying granted_capabilities=['llmo/can_view']).
      const llmoCaps = new Set(Object.values(routeFacsCapabilities.PRODUCTS_ROUTES.LLMO));
      expect(llmoCaps.has('llmo/can_view_all'), 'llmo/can_view_all is removed in the hybrid model')
        .to.be.false;
    });

    it('uses the plural `can_manage_users` capability (hybrid-model catalog)', () => {
      // The previous revision used singular `can_manage_user`; the hybrid
      // model renamed it. Guard the rename so it doesn't silently regress.
      const llmoCaps = new Set(Object.values(routeFacsCapabilities.PRODUCTS_ROUTES.LLMO));
      expect(llmoCaps.has('llmo/can_manage_user'), 'singular llmo/can_manage_user was renamed')
        .to.be.false;
    });

    it('every product route exists in src/routes/index.js (no stale routes, modulo forward declarations)', () => {
      Object.entries(routeFacsCapabilities.PRODUCTS_ROUTES).forEach(([product, subMap]) => {
        const stale = Object.keys(subMap)
          .filter((route) => !allDeclaredRoutes.has(route))
          .filter((route) => !FORWARD_DECLARED_ROUTES.has(route));
        expect(stale, `stale ${product} routes not found in src/routes/index.js: ${stale.join(', ')}`)
          .to.deep.equal([]);
      });
    });
  });

  describe('invariant: (∪ PRODUCTS_ROUTES[*]) ⊎ INTERNAL_ROUTES = all routes', () => {
    it('INTERNAL_ROUTES is disjoint from every product sub-map', () => {
      const internalSet = new Set(routeFacsCapabilities.INTERNAL_ROUTES);
      Object.entries(routeFacsCapabilities.PRODUCTS_ROUTES).forEach(([product, subMap]) => {
        const overlap = Object.keys(subMap).filter((route) => internalSet.has(route));
        expect(overlap, `${product} routes overlap with INTERNAL_ROUTES: ${overlap.join(', ')}`)
          .to.deep.equal([]);
      });
    });

    it('the union of all product sub-maps plus INTERNAL_ROUTES equals all declared routes', () => {
      // Union-equality model: every declared route is owned by at least
      // one product OR by INTERNAL_ROUTES (disjoint union); routes MAY
      // appear under multiple products simultaneously (e.g. a site GET
      // surfaces under both LLMO and ASO). We do NOT enforce
      // pairwise-disjoint product maps — cross-product routes are
      // expected.
      const internalSet = new Set(routeFacsCapabilities.INTERNAL_ROUTES);
      const unionOfProducts = new Set();
      Object.values(routeFacsCapabilities.PRODUCTS_ROUTES).forEach((subMap) => {
        Object.keys(subMap).forEach((route) => unionOfProducts.add(route));
      });

      // No gaps: every declared route is owned somewhere.
      const covered = new Set([...unionOfProducts, ...internalSet]);
      const missing = [...allDeclaredRoutes].filter((route) => !covered.has(route));
      expect(
        missing,
        `routes declared in src/routes/index.js but not in any PRODUCTS_ROUTES sub-map or INTERNAL_ROUTES: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`,
      ).to.deep.equal([]);

      // No stale entries: every owned route exists in src/routes/index.js
      // (modulo forward declarations).
      const owned = [...unionOfProducts, ...internalSet];
      const extraneous = owned
        .filter((route) => !allDeclaredRoutes.has(route))
        .filter((route) => !FORWARD_DECLARED_ROUTES.has(route));
      expect(
        extraneous,
        `routes owned by PRODUCTS_ROUTES/INTERNAL_ROUTES but not declared in src/routes/index.js: ${extraneous.slice(0, 10).join(', ')}${extraneous.length > 10 ? '…' : ''}`,
      ).to.deep.equal([]);
    });
  });

  /**
   * PRODUCTS_CAPABILITIES catalog — the single source of truth for which
   * capability strings the codebase recognises per product. The
   * `PRODUCTS_ROUTES` value side must be a subset of this catalog (a route
   * cannot guard a capability the product doesn't recognise).
   */
  describe('PRODUCTS_CAPABILITIES catalog', () => {
    let PRODUCTS_CAPABILITIES;
    before(async () => {
      ({ PRODUCTS_CAPABILITIES } = await import('../../src/routes/facs-capabilities.js'));
    });

    it('exposes a per-product catalog with `<product>/<capability>` entries', () => {
      Object.entries(PRODUCTS_CAPABILITIES).forEach(([product, caps]) => {
        expect(product, `product key '${product}' must be uppercase`).to.equal(product.toUpperCase());
        expect(caps, `${product} catalog`).to.be.an('array').that.is.not.empty;
        caps.forEach((cap) => {
          expect(cap, `${product} capability '${cap}'`).to.be.a('string').and.match(CAPABILITY_RE);
          const [prefix] = cap.split('/');
          expect(prefix, `capability '${cap}' must be prefixed with the product code`)
            .to.equal(product.toLowerCase());
        });
        expect(new Set(caps).size, `${product} catalog has duplicates`).to.equal(caps.length);
      });
    });

    it('every PRODUCTS_ROUTES value belongs to its product\'s catalog', () => {
      Object.entries(routeFacsCapabilities.PRODUCTS_ROUTES).forEach(([product, subMap]) => {
        const catalog = new Set(PRODUCTS_CAPABILITIES[product] || []);
        const unknown = [...new Set(Object.values(subMap))].filter((cap) => !catalog.has(cap));
        expect(
          unknown,
          `${product} routes reference capabilities not in PRODUCTS_CAPABILITIES.${product}: ${unknown.join(', ')}`,
        ).to.deep.equal([]);
      });
    });
  });

  /**
   * Resource Identification — pins the structural contract for
   * `PRODUCTS_FACS_RESOURCE_PARAM_ALIASES` and the exhaustive classification
   * invariant against every `:param` in `src/routes/index.js` (see
   * mac-state-layer.md §"Resource Identification").
   */
  describe('PRODUCTS_FACS_RESOURCE_PARAM_ALIASES', () => {
    let allRouteParams;
    before(() => {
      const source = readFileSync(join(projectRoot, 'src/routes/index.js'), 'utf8');
      allRouteParams = new Set();
      // Extract `:param` segments from route patterns.
      const re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
      for (const m of source.matchAll(re)) {
        allRouteParams.add(m[1]);
      }
      // Include params from forward-declared routes too — they're real
      // params that will surface in `src/routes/index.js` once H4 lands.
      FORWARD_DECLARED_ROUTE_PARAMS.forEach((p) => allRouteParams.add(p));
    });

    function unionOfProductAliases() {
      return new Set(
        Object.values(routeFacsCapabilities.PRODUCTS_FACS_RESOURCE_PARAM_ALIASES)
          .flatMap((perProductResources) => Object.values(perProductResources).flat()),
      );
    }

    it('keys are uppercase product codes that exist in PRODUCTS_ROUTES', () => {
      const productKeys = Object.keys(routeFacsCapabilities.PRODUCTS_ROUTES);
      Object.keys(routeFacsCapabilities.PRODUCTS_FACS_RESOURCE_PARAM_ALIASES).forEach((p) => {
        expect(p, `product '${p}' must be uppercase`).to.equal(p.toUpperCase());
        expect(productKeys, `product '${p}' must also exist in PRODUCTS_ROUTES`).to.include(p);
      });
    });

    it('each product value is an object', () => {
      Object.values(routeFacsCapabilities.PRODUCTS_FACS_RESOURCE_PARAM_ALIASES).forEach((m) => {
        expect(m).to.be.an('object');
      });
    });

    it('each resource value is a non-empty array of strings', () => {
      Object.entries(routeFacsCapabilities.PRODUCTS_FACS_RESOURCE_PARAM_ALIASES)
        .forEach(([product, resourceMap]) => {
          Object.entries(resourceMap).forEach(([resource, aliases]) => {
            expect(aliases, `${product}.${resource} must be an array`).to.be.an('array');
            aliases.forEach((alias) => {
              expect(alias, `${product}.${resource} aliases must be strings`).to.be.a('string');
            });
          });
        });
    });

    it('within each product, no alias appears under more than one resource', () => {
      for (const [product, resourceMap] of Object.entries(
        routeFacsCapabilities.PRODUCTS_FACS_RESOURCE_PARAM_ALIASES,
      )) {
        const seen = new Map();
        for (const [resource, aliases] of Object.entries(resourceMap)) {
          for (const alias of aliases) {
            expect(
              seen.has(alias),
              `${product}: alias '${alias}' declared under both '${seen.get(alias)}' and '${resource}'`,
            ).to.be.false;
            seen.set(alias, resource);
          }
        }
      }
    });

    it('PRODUCTS_FACS_RESOURCE_PARAM_ALIASES and FACS_NON_RESOURCE_PARAMS are disjoint', () => {
      const claimedByAnyProduct = unionOfProductAliases();
      const nonResource = new Set(routeFacsCapabilities.FACS_NON_RESOURCE_PARAMS);
      const overlap = [...claimedByAnyProduct].filter((p) => nonResource.has(p));
      expect(
        overlap,
        `params claimed by a product AND in FACS_NON_RESOURCE_PARAMS (remove from the latter): ${overlap.join(', ')}`,
      ).to.deep.equal([]);
    });

    it('every alias claimed by any product corresponds to a real :param in src/routes/index.js', () => {
      const claimedByAnyProduct = unionOfProductAliases();
      const stale = [...claimedByAnyProduct].filter((alias) => !allRouteParams.has(alias));
      expect(
        stale,
        `stale aliases not found as :param in any route: ${stale.join(', ')}`,
      ).to.deep.equal([]);
    });

    it('every :param in src/routes/index.js is classified (resource OR non-resource)', () => {
      const claimedByAnyProduct = unionOfProductAliases();
      const nonResource = new Set(routeFacsCapabilities.FACS_NON_RESOURCE_PARAMS);
      const unclassified = [...allRouteParams].filter(
        (p) => !claimedByAnyProduct.has(p) && !nonResource.has(p),
      );
      expect(
        unclassified,
        `unclassified params (add to PRODUCTS_FACS_RESOURCE_PARAM_ALIASES.<product>.<resource> or FACS_NON_RESOURCE_PARAMS): ${unclassified.join(', ')}`,
      ).to.deep.equal([]);
    });

    it('FACS_NON_RESOURCE_PARAMS does not contain stale entries', () => {
      const nonResource = routeFacsCapabilities.FACS_NON_RESOURCE_PARAMS;
      const stale = nonResource.filter((p) => !allRouteParams.has(p));
      expect(
        stale,
        `FACS_NON_RESOURCE_PARAMS contains params not used in any route: ${stale.join(', ')}`,
      ).to.deep.equal([]);
    });
  });
});
