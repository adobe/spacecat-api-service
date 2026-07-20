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

  function orgWith(imsOrgId) {
    return { getImsOrgId: () => imsOrgId };
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

  it('returns null for a product that does not ReBAC-scope site (LLMO)', async () => {
    const context = {
      attributes: {
        facs: { enabled: true, product: 'LLMO', subjectId: 'user@AdobeID' },
        authInfo: { hasFacsPermission: () => false },
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
});
