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

import { expect } from 'chai';

import { resolveViewableSiteIds } from '../../src/support/facs-site-visibility.js';

describe('resolveViewableSiteIds', () => {
  function fakeFacsPostgrest(rows) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      range: () => builder,
      then: (onF, onR) => Promise.resolve({ data: rows, error: null }).then(onF, onR),
    };
    return { from: () => builder };
  }

  // Per-table fake: resolves different rows for facs_access_mappings (grants),
  // brands, and brand_sites — needed for the LLMO brand→site path which chains
  // all three. Supports the `.in()` filter the brand→site lookup uses.
  function fakeMultiTablePostgrest(rowsByTable) {
    return {
      from: (table) => {
        const rows = rowsByTable[table] ?? [];
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          is: () => builder,
          order: () => builder,
          range: () => builder,
          limit: () => builder,
          then: (onF, onR) => Promise.resolve({ data: rows, error: null }).then(onF, onR),
        };
        return builder;
      },
    };
  }

  function orgWith(imsOrgId, id = 'org-uuid') {
    return { getImsOrgId: () => imsOrgId, getId: () => id };
  }

  it('returns null when facs is not enabled', async () => {
    const context = { attributes: {} };
    const result = await resolveViewableSiteIds(context, orgWith('org1'));
    expect(result).to.equal(null);
  });

  it('returns null when the caller holds an org-wide can_view grant', async () => {
    const context = {
      attributes: {
        facs: { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' },
        authInfo: { hasFacsPermission: () => true },
      },
    };
    const result = await resolveViewableSiteIds(context, orgWith('org1'));
    expect(result).to.equal(null);
  });

  it('returns null when the caller holds an org-wide can_view grant (LLMO)', async () => {
    const context = {
      attributes: {
        facs: { enabled: true, product: 'LLMO', subjectId: 'user@AdobeID' },
        authInfo: { hasFacsPermission: () => true },
      },
    };
    const result = await resolveViewableSiteIds(context, orgWith('org1'));
    expect(result).to.equal(null);
  });

  it('returns a 503 Response when PostgREST is unavailable', async () => {
    const context = {
      attributes: {
        facs: { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' },
        authInfo: { hasFacsPermission: () => false },
      },
      dataAccess: { services: {} },
    };
    const result = await resolveViewableSiteIds(context, orgWith('org1'));
    expect(result).to.have.property('status', 503);
  });

  it('returns the viewable site id Set when filtering applies', async () => {
    const context = {
      attributes: {
        facs: { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' },
        authInfo: { hasFacsPermission: () => false },
      },
      dataAccess: {
        services: {
          postgrestClient: fakeFacsPostgrest([
            { resource_id: 'site1', granted_capabilities: ['aso/can_view'] },
          ]),
        },
      },
    };
    const result = await resolveViewableSiteIds(context, orgWith('org1'));
    expect(result.has('site1')).to.equal(true);
    expect(result.has('site2')).to.equal(false);
  });

  it('returns an empty Set (fail closed) when the caller can view no sites', async () => {
    const context = {
      attributes: {
        facs: { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' },
        authInfo: { hasFacsPermission: () => false },
      },
      dataAccess: {
        services: { postgrestClient: fakeFacsPostgrest([]) },
      },
    };
    const result = await resolveViewableSiteIds(context, orgWith('org1'));
    expect(result.size).to.equal(0);
  });

  describe('LLMO brand-scoped narrowing', () => {
    function llmoContext(rowsByTable) {
      return {
        attributes: {
          facs: { enabled: true, product: 'LLMO', subjectId: 'user@AdobeID' },
          authInfo: { hasFacsPermission: () => false },
        },
        dataAccess: { services: { postgrestClient: fakeMultiTablePostgrest(rowsByTable) } },
      };
    }

    it('derives viewable sites from the caller viewable brands (brands ∪ brand_sites)', async () => {
      const context = llmoContext({
        facs_access_mappings: [{ resource_id: 'brand-A', granted_capabilities: ['llmo/can_view'] }],
        brands: [{ site_id: 'site1' }],
        brand_sites: [{ site_id: 'site2' }],
      });
      const result = await resolveViewableSiteIds(context, orgWith('org1'));
      expect(result.has('site1')).to.equal(true);
      expect(result.has('site2')).to.equal(true);
      expect(result.has('site3')).to.equal(false);
    });

    it('returns an empty Set when the caller holds no viewable brands (excludes brand-less sites)', async () => {
      const context = llmoContext({
        facs_access_mappings: [], // no brand grants
        brands: [{ site_id: 'site1' }],
        brand_sites: [{ site_id: 'site2' }],
      });
      const result = await resolveViewableSiteIds(context, orgWith('org1'));
      expect(result.size).to.equal(0);
    });

    it('ignores brand grants that lack llmo/can_view', async () => {
      const context = llmoContext({
        facs_access_mappings: [{ resource_id: 'brand-A', granted_capabilities: ['llmo/can_configure'] }],
        brands: [{ site_id: 'site1' }],
        brand_sites: [],
      });
      const result = await resolveViewableSiteIds(context, orgWith('org1'));
      expect(result.size).to.equal(0);
    });

    it('returns a 503 Response when PostgREST is unavailable', async () => {
      const context = {
        attributes: {
          facs: { enabled: true, product: 'LLMO', subjectId: 'user@AdobeID' },
          authInfo: { hasFacsPermission: () => false },
        },
        dataAccess: { services: {} },
      };
      const result = await resolveViewableSiteIds(context, orgWith('org1'));
      expect(result).to.have.property('status', 503);
    });
  });
});
