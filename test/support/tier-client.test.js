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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import TierClient from '../../src/support/tier-client.js';

use(chaiAsPromised);
use(sinonChai);

describe('TierClient', () => {
  const sandbox = sinon.createSandbox();
  const orgId = '123e4567-e89b-12d3-a456-426614174000';
  const siteId = '456e7890-e89b-12d3-a456-426614174000';
  const productCode = 'LLMO';

  const mockEntitlement = {
    getId: () => 'entitlement-123',
    getOrganizationId: () => orgId,
    getProductCode: () => productCode,
    getTier: () => 'FREE_TRIAL',
  };

  const mockSiteEnrollment = {
    getId: () => 'enrollment-123',
    getSiteId: () => siteId,
    getEntitlementId: () => 'entitlement-123',
    getStatus: () => 'ACTIVE',
  };

  const mockOrganization = {
    getId: () => orgId,
    getImsOrgId: () => 'ims-org-123',
  };

  const mockSite = {
    getId: () => siteId,
    getName: () => 'Test Site',
  };

  const mockIdentityProvider = {
    getId: () => 'idp-123',
    getProvider: () => 'IMS',
    getOrganizationId: () => orgId,
  };

  const mockDataAccess = {
    Entitlement: {
      findByOrganizationIdAndProductCode: sandbox.stub(),
      findById: sandbox.stub(),
      create: sandbox.stub(),
    },
    SiteEnrollment: {
      allBySiteId: sandbox.stub(),
      create: sandbox.stub(),
    },
    Organization: {
      findById: sandbox.stub(),
    },
    Site: {
      findById: sandbox.stub(),
    },
    OrganizationIdentityProvider: {
      allByOrganizationId: sandbox.stub(),
      create: sandbox.stub(),
    },
  };

  const mockContext = {
    dataAccess: mockDataAccess,
    log: {
      info: sandbox.stub(),
      error: sandbox.stub(),
    },
    attributes: {
      authInfo: {
        getProfile: () => ({ provider: 'IMS' }),
      },
    },
  };

  let tierClient;

  beforeEach(() => {
    sandbox.restore();

    // Reset all stubs
    Object.values(mockDataAccess).forEach((service) => {
      Object.values(service).forEach((method) => {
        if (typeof method === 'function' && method.reset) {
          method.reset();
        }
      });
    });

    tierClient = TierClient(mockContext, orgId, siteId, productCode);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Constructor Validation', () => {
    it('should throw error when context is not provided', () => {
      expect(() => TierClient()).to.throw('Context required');
    });

    it('should throw error when context is null', () => {
      expect(() => TierClient(null, orgId, siteId, productCode)).to.throw('Context required');
    });

    it('should throw error when orgId is not provided', () => {
      expect(() => TierClient(mockContext, '', siteId, productCode)).to.throw('Organization ID required');
    });

    it('should allow siteId to be empty or null', () => {
      // siteId is now optional, so this should not throw an error
      expect(() => TierClient(mockContext, orgId, '', productCode)).to.not.throw();
      expect(() => TierClient(mockContext, orgId, null, productCode)).to.not.throw();
    });

    it('should throw error when productCode is not provided', () => {
      expect(() => TierClient(mockContext, orgId, siteId, '')).to.throw('Product code required');
    });

    it('should throw error when dataAccess is missing', () => {
      const invalidContext = { log: {} };
      expect(() => TierClient(invalidContext, orgId, siteId, productCode)).to.throw('Data access required');
    });
  });

  describe('checkValidEntitlement', () => {
    it('should return empty object when no entitlement exists', async () => {
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(null);

      const result = await tierClient.checkValidEntitlement();

      expect(result).to.deep.equal({});
      expect(mockDataAccess.Entitlement.findByOrganizationIdAndProductCode)
        .to.have.been.calledWith(orgId, productCode);
    });

    it('should return only entitlement when site enrollment is missing', async () => {
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(mockEntitlement);
      mockDataAccess.SiteEnrollment.allBySiteId.resolves([]);

      const result = await tierClient.checkValidEntitlement();

      expect(result).to.deep.equal({ entitlement: mockEntitlement });
      expect(mockDataAccess.SiteEnrollment.allBySiteId).to.have.been.calledWith(siteId);
    });

    it('should return both entitlement and site enrollment when both exist', async () => {
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(mockEntitlement);
      mockDataAccess.SiteEnrollment.allBySiteId.resolves([mockSiteEnrollment]);

      const result = await tierClient.checkValidEntitlement();

      expect(result).to.deep.equal({
        entitlement: mockEntitlement,
        siteEnrollment: mockSiteEnrollment,
      });
    });

    it('should handle database errors', async () => {
      const error = new Error('Database error');
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.rejects(error);

      await expect(tierClient.checkValidEntitlement()).to.be.rejectedWith('Database error');
    });
  });

  describe('createEntitlement', () => {
    beforeEach(() => {
      mockDataAccess.Organization.findById.resolves(mockOrganization);
      mockDataAccess.Site.findById.resolves(mockSite);
    });

    it('should return existing entitlement and site enrollment when both exist', async () => {
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(mockEntitlement);
      mockDataAccess.SiteEnrollment.allBySiteId.resolves([mockSiteEnrollment]);

      const result = await tierClient.createEntitlement('FREE_TRIAL');

      expect(result).to.deep.equal({
        entitlement: mockEntitlement,
        siteEnrollment: mockSiteEnrollment,
      });
      expect(mockDataAccess.Entitlement.create).to.not.have.been.called;
      expect(mockDataAccess.SiteEnrollment.create).to.not.have.been.called;
    });

    it('should create site enrollment when only entitlement exists', async () => {
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(mockEntitlement);
      mockDataAccess.SiteEnrollment.allBySiteId.resolves([]);
      mockDataAccess.SiteEnrollment.create.resolves(mockSiteEnrollment);

      const result = await tierClient.createEntitlement('FREE_TRIAL');

      expect(result).to.deep.equal({
        entitlement: mockEntitlement,
        siteEnrollment: mockSiteEnrollment,
      });
      expect(mockDataAccess.Entitlement.create).to.not.have.been.called;
      expect(mockDataAccess.SiteEnrollment.create).to.have.been.calledWith({
        siteId,
        entitlementId: mockEntitlement.getId(),
      });
    });

    it('should create everything when nothing exists', async () => {
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(null);
      mockDataAccess.OrganizationIdentityProvider.allByOrganizationId.resolves([]);
      mockDataAccess.OrganizationIdentityProvider.create.resolves(mockIdentityProvider);
      mockDataAccess.Entitlement.create.resolves(mockEntitlement);
      mockDataAccess.SiteEnrollment.create.resolves(mockSiteEnrollment);

      const result = await tierClient.createEntitlement('FREE_TRIAL');

      expect(result).to.deep.equal({
        entitlement: mockEntitlement,
        siteEnrollment: mockSiteEnrollment,
      });
      expect(mockDataAccess.OrganizationIdentityProvider.create).to.have.been.calledWith({
        organizationId: orgId,
        provider: 'IMS',
        externalId: mockOrganization.getImsOrgId(),
      });
      expect(mockDataAccess.Entitlement.create).to.have.been.calledWith({
        organizationId: orgId,
        productCode,
        tier: 'FREE_TRIAL',
        quotas: { llmo_trial_prompts: 200 },
      });
      expect(mockDataAccess.SiteEnrollment.create).to.have.been.calledWith({
        siteId,
        entitlementId: mockEntitlement.getId(),
      });
    });

    it('should reuse existing identity provider when it exists', async () => {
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(null);
      mockDataAccess.OrganizationIdentityProvider.allByOrganizationId
        .resolves([mockIdentityProvider]);
      mockDataAccess.Entitlement.create.resolves(mockEntitlement);
      mockDataAccess.SiteEnrollment.create.resolves(mockSiteEnrollment);

      const result = await tierClient.createEntitlement('FREE_TRIAL');

      expect(result).to.deep.equal({
        entitlement: mockEntitlement,
        siteEnrollment: mockSiteEnrollment,
      });
      // The create method should not be called because identity provider already exists
      expect(mockDataAccess.OrganizationIdentityProvider.create).to.not.have.been.called;
    });

    it('should throw error for invalid tier', async () => {
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(null);

      await expect(tierClient.createEntitlement('INVALID_TIER')).to.be.rejectedWith('Invalid tier: INVALID_TIER');
    });

    it('should throw error when siteId is not provided for createEntitlement', async () => {
      // Create a TierClient without siteId
      const tierClientWithoutSite = TierClient(mockContext, orgId, null, productCode);

      await expect(tierClientWithoutSite.createEntitlement('FREE_TRIAL')).to.be.rejectedWith('Site ID required for creating entitlements');
    });

    it('should throw error when organization not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      await expect(tierClient.createEntitlement('FREE_TRIAL')).to.be.rejectedWith(`Organization not found: ${orgId}`);
    });

    it('should throw error when site not found', async () => {
      mockDataAccess.Site.findById.resolves(null);

      await expect(tierClient.createEntitlement('FREE_TRIAL')).to.be.rejectedWith(`Site not found: ${siteId}`);
    });

    it('should handle database errors during creation', async () => {
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(null);
      mockDataAccess.OrganizationIdentityProvider.allByOrganizationId.resolves([]);
      mockDataAccess.OrganizationIdentityProvider.create.resolves(mockIdentityProvider);
      mockDataAccess.Entitlement.create.rejects(new Error('Database error'));

      await expect(tierClient.createEntitlement('FREE_TRIAL')).to.be.rejectedWith('Database error');
    });
  });

  describe('Edge Cases', () => {
    it('should handle context without authInfo', async () => {
      const contextWithoutAuth = {
        ...mockContext,
        attributes: {},
      };
      const clientWithoutAuth = TierClient(contextWithoutAuth, orgId, siteId, productCode);

      mockDataAccess.Organization.findById.resolves(mockOrganization);
      mockDataAccess.Site.findById.resolves(mockSite);
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(null);
      mockDataAccess.OrganizationIdentityProvider.allByOrganizationId.resolves([]);
      mockDataAccess.OrganizationIdentityProvider.create.resolves(mockIdentityProvider);
      mockDataAccess.Entitlement.create.resolves(mockEntitlement);
      mockDataAccess.SiteEnrollment.create.resolves(mockSiteEnrollment);

      const result = await clientWithoutAuth.createEntitlement('FREE_TRIAL');

      expect(result).to.deep.equal({
        entitlement: mockEntitlement,
        siteEnrollment: mockSiteEnrollment,
      });
    });

    it('should handle multiple site enrollments with different entitlements', async () => {
      const otherSiteEnrollment = {
        getId: () => 'other-enrollment-123',
        getSiteId: () => siteId,
        getEntitlementId: () => 'other-entitlement-123',
      };

      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(mockEntitlement);
      mockDataAccess.SiteEnrollment.allBySiteId.resolves([otherSiteEnrollment]);

      const result = await tierClient.checkValidEntitlement();

      expect(result).to.deep.equal({ entitlement: mockEntitlement });
    });
  });
});
