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
    it('exposes the Phase 1 + Phase 2 keys', () => {
      expect(routeFacsCapabilities).to.have.all.keys(
        'INTERNAL_ROUTES',
        'PRODUCTS_ROUTES',
        'PRODUCTS_FACS_ADMIN_PERMISSIONS',
        'PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS',
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

    it('each route value is a non-empty array of "<product>/<action>" strings scoped to its product', () => {
      Object.entries(routeFacsCapabilities.PRODUCTS_ROUTES).forEach(([product, subMap]) => {
        Object.entries(subMap).forEach(([route, value]) => {
          expect(value, `${product} ${route}`).to.be.an('array').and.not.empty;
          value.forEach((permission) => {
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

  /**
   * Phase 2 — Resource Identification.
   *
   * Pins the structural contract for `PRODUCTS_FACS_RESOURCE_PARAM_ALIASES`
   * and the exhaustive classification invariant against every `:param` in
   * `src/routes/index.js` (see mac-state-layer.md §"Resource Identification").
   */
  describe('PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS', () => {
    it('keys are uppercase product codes that exist in PRODUCTS_ROUTES', () => {
      const productKeys = Object.keys(routeFacsCapabilities.PRODUCTS_ROUTES);
      Object.keys(routeFacsCapabilities.PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS)
        .forEach((p) => {
          expect(p, `product '${p}' must be uppercase`).to.equal(p.toUpperCase());
          expect(productKeys, `product '${p}' must also exist in PRODUCTS_ROUTES`).to.include(p);
        });
    });

    it('each product value is an array of "<product>/<action>" strings scoped to that product', () => {
      Object.entries(routeFacsCapabilities.PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS)
        .forEach(([product, perms]) => {
          expect(perms, `${product} exempt permissions`).to.be.an('array');
          perms.forEach((permission) => {
            expect(permission, `${product} exempt entry`).to.match(/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/);
            const [prefix] = permission.split('/');
            expect(
              prefix,
              `exempt permission '${permission}' for ${product} must be prefixed with the product code`,
            ).to.equal(product.toLowerCase());
          });
        });
    });

    it('every exempt permission appears as a required permission on at least one route', () => {
      // Sanity check: an exempt permission that no route lists can never
      // fire — flag it so the config stays honest. Per the design doc:
      // "every permission listed in PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS[P]
      //  either appears as a required permission on some route in
      //  PRODUCTS_ROUTES[P]".
      Object.entries(routeFacsCapabilities.PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS)
        .forEach(([product, perms]) => {
          if (perms.length === 0) {
            return;
          }
          const productMap = routeFacsCapabilities.PRODUCTS_ROUTES[product] || {};
          const requiredAcrossRoutes = new Set(Object.values(productMap).flat());
          const orphans = perms.filter((p) => !requiredAcrossRoutes.has(p));
          expect(
            orphans,
            `${product} declares exempt permissions that no route requires: ${orphans.join(', ')}`,
          ).to.deep.equal([]);
        });
    });

    it('admin permissions are NOT also in the state-layer-exempt list (disjoint by design)', () => {
      // The two lists are conceptually distinct:
      //   - PRODUCTS_FACS_ADMIN_PERMISSIONS is the early-bypass list
      //     (wrapper step 9): holders skip the route gate entirely.
      //   - PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS is the late-bypass
      //     list (wrapper step 11): a held permission in this set skips
      //     the per-resource binding lookup but still passes through the
      //     route gate and held-permission resolution.
      // Listing an admin permission in both lists is redundant config —
      // step 9 already short-circuits before step 11 fires.
      const adminByProduct = routeFacsCapabilities.PRODUCTS_FACS_ADMIN_PERMISSIONS || {};
      Object.entries(routeFacsCapabilities.PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS)
        .forEach(([product, exemptPerms]) => {
          const adminPerms = new Set(adminByProduct[product] || []);
          const overlap = exemptPerms.filter((p) => adminPerms.has(p));
          expect(
            overlap,
            `${product} lists admin permissions in both ADMIN and STATE_LAYER_EXEMPT: ${overlap.join(', ')}`,
          ).to.deep.equal([]);
        });
    });
  });

  /**
   * Phase 2 — Product-admin early bypass.
   *
   * Pins the structural contract for `PRODUCTS_FACS_ADMIN_PERMISSIONS`,
   * which the wrapper consults BEFORE route lookup or held-permission
   * resolution. Holders of a product-admin permission bypass FACS entirely
   * for that product (see mac-state-layer.md §"Product-admin permissions").
   */
  describe('PRODUCTS_FACS_ADMIN_PERMISSIONS', () => {
    it('keys are uppercase product codes that exist in PRODUCTS_ROUTES', () => {
      const productKeys = Object.keys(routeFacsCapabilities.PRODUCTS_ROUTES);
      Object.keys(routeFacsCapabilities.PRODUCTS_FACS_ADMIN_PERMISSIONS)
        .forEach((p) => {
          expect(p, `product '${p}' must be uppercase`).to.equal(p.toUpperCase());
          expect(productKeys, `product '${p}' must also exist in PRODUCTS_ROUTES`).to.include(p);
        });
    });

    it('each product value is an array of "<product>/<action>" strings scoped to that product', () => {
      Object.entries(routeFacsCapabilities.PRODUCTS_FACS_ADMIN_PERMISSIONS)
        .forEach(([product, perms]) => {
          expect(perms, `${product} admin permissions`).to.be.an('array');
          perms.forEach((permission) => {
            expect(permission, `${product} admin entry`)
              .to.match(/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/);
            const [prefix] = permission.split('/');
            expect(
              prefix,
              `admin permission '${permission}' for ${product} must be prefixed with the product code`,
            ).to.equal(product.toLowerCase());
          });
        });
    });

    it('LLMO declares llmo/can_manage_user as the admin permission', () => {
      // Regression guard: this is the migration anchor from the previous
      // revision where can_manage_user lived in the state-layer-exempt list.
      // Moving it here is what enables the early bypass.
      expect(routeFacsCapabilities.PRODUCTS_FACS_ADMIN_PERMISSIONS.LLMO)
        .to.include('llmo/can_manage_user');
    });
  });

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
