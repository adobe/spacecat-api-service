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
import sinon from 'sinon';
import esmock from 'esmock';

describe('facs-secondary-resolvers', () => {
  let sandbox;
  let listBrandIdsForSiteStub;
  let listResourceIdsWithCapabilityStub;
  let mod;
  let context;

  const site = { getId: () => 's1', getOrganizationId: () => 'org-1' };
  const org = { getImsOrgId: () => 'IMS@AdobeOrg' };
  const args = {
    siteId: 's1', product: 'LLMO', subjectId: 'u@AdobeID', capability: 'llmo/can_view',
  };

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    listBrandIdsForSiteStub = sandbox.stub();
    listResourceIdsWithCapabilityStub = sandbox.stub();
    mod = await esmock('../../src/support/facs-secondary-resolvers.js', {
      '../../src/support/brands-storage.js': {
        listBrandIdsForSite: listBrandIdsForSiteStub,
      },
      '../../src/support/state-access-mapping-utils.js': {
        listResourceIdsWithCapability: listResourceIdsWithCapabilityStub,
      },
    });
    context = {
      dataAccess: {
        services: { postgrestClient: { from: () => {} } },
        Site: { findById: sandbox.stub().resolves(site) },
        Organization: { findById: sandbox.stub().resolves(org) },
      },
    };
  });

  afterEach(() => sandbox.restore());

  describe('hasCapabilityOnSiteBrands', () => {
    it('grants when the caller holds the capability on any related brand', async () => {
      listBrandIdsForSiteStub.resolves(new Set(['b1', 'b2']));
      listResourceIdsWithCapabilityStub.resolves(new Set(['b2']));

      const granted = await mod.hasCapabilityOnSiteBrands(context, args);

      expect(granted).to.equal(true);
      // Org-scoped resolution: brands looked up by the site's org id + site id.
      expect(listBrandIdsForSiteStub.calledOnceWith('org-1', 's1')).to.be.true;
      // Single state-layer query, scoped by imsOrgId/product/resourceType/subject/capability.
      const [pg, query] = listResourceIdsWithCapabilityStub.firstCall.args;
      expect(pg).to.equal(context.dataAccess.services.postgrestClient);
      expect(query).to.deep.equal({
        imsOrgId: 'IMS@AdobeOrg',
        product: 'LLMO',
        resourceType: 'brand',
        subjectId: 'u@AdobeID',
        capability: 'llmo/can_view',
      });
    });

    it('denies when the caller holds the capability on no related brand', async () => {
      listBrandIdsForSiteStub.resolves(new Set(['b1']));
      listResourceIdsWithCapabilityStub.resolves(new Set(['b9']));
      expect(await mod.hasCapabilityOnSiteBrands(context, args)).to.equal(false);
    });

    it('fails closed when postgrestClient is absent', async () => {
      context.dataAccess.services.postgrestClient = undefined;
      expect(await mod.hasCapabilityOnSiteBrands(context, args)).to.equal(false);
      expect(listBrandIdsForSiteStub.called).to.be.false;
    });

    it('fails closed when the site is not found', async () => {
      context.dataAccess.Site.findById.resolves(null);
      expect(await mod.hasCapabilityOnSiteBrands(context, args)).to.equal(false);
    });

    it('fails closed when the org has no imsOrgId', async () => {
      context.dataAccess.Organization.findById.resolves({ getImsOrgId: () => undefined });
      expect(await mod.hasCapabilityOnSiteBrands(context, args)).to.equal(false);
      expect(listBrandIdsForSiteStub.called).to.be.false;
    });

    it('fails closed when the site maps to no brands', async () => {
      listBrandIdsForSiteStub.resolves(new Set());
      expect(await mod.hasCapabilityOnSiteBrands(context, args)).to.equal(false);
      expect(listResourceIdsWithCapabilityStub.called).to.be.false;
    });
  });

  describe('secondaryResolvers.llmoSiteToBrands', () => {
    it('maps resourceId → siteId and delegates to hasCapabilityOnSiteBrands', async () => {
      listBrandIdsForSiteStub.resolves(new Set(['b1']));
      listResourceIdsWithCapabilityStub.resolves(new Set(['b1']));

      const granted = await mod.secondaryResolvers.llmoSiteToBrands(context, {
        resourceId: 's1', capability: 'llmo/can_view', product: 'LLMO', subjectId: 'u@AdobeID',
      });

      expect(granted).to.equal(true);
      expect(context.dataAccess.Site.findById.calledOnceWith('s1')).to.be.true;
    });
  });
});
