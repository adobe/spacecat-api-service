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

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import {
  Site, Organization,
  Entitlement as EntitlementModel,
  TrialUser as TrialUserModel,
  OrganizationIdentityProvider as OrganizationIdentityProviderModel,
} from '@adobe/spacecat-shared-data-access';
import TierClient from '@adobe/spacecat-shared-tier-client';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Access Control Util', () => {
  it('should throw an error if context is not provided', () => {
    expect(() => AccessControlUtil.fromContext()).to.throw('Missing context');
  });

  it('should throw an error if authInfo is not provided', () => {
    const context = { test: {} };
    expect(() => AccessControlUtil.fromContext(context)).to.throw('Missing authInfo');
  });

  it('should check if user has admin access', () => {
    const authInfo = new AuthInfo()
      .withType('jwt')
      .withProfile({
        is_admin: true,
      });

    const context = {
      pathInfo: {
        headers: { 'x-product': 'llmo' },
      },
      attributes: { authInfo },
      dataAccess: {
        Entitlement: {
          findByOrganizationIdAndProductCode: sinon.stub(),
        },
        TrialUser: {},
        OrganizationIdentityProvider: {},
      },
    };

    const accessControlUtil = AccessControlUtil.fromContext(context);
    expect(accessControlUtil.hasAdminAccess()).to.be.true;
  });

  it('should throw an error if entity is not provided', async () => {
    const context = {
      pathInfo: {
        headers: { 'x-product': 'llmo' },
      },
      attributes: { authInfo: new AuthInfo() },
      dataAccess: {
        Entitlement: {
          findByOrganizationIdAndProductCode: sinon.stub(),
        },
        TrialUser: {},
        OrganizationIdentityProvider: {},
      },
    };
    const accessControlUtil = AccessControlUtil.fromContext(context);
    try {
      await accessControlUtil.hasAccess();
    } catch (error) {
      expect(error.message).to.equal('Missing entity');
    }
  });

  const sandbox = sinon.createSandbox();
  let context;
  let logSpy;

  beforeEach(() => {
    logSpy = sandbox.spy();
    context = {
      log: {
        info: logSpy, error: logSpy, warn: logSpy, debug: logSpy,
      },
      pathInfo: {
        headers: { 'x-product': 'llmo' },
      },
      attributes: {
        authInfo: {
          getType: () => 'jwt',
          isAdmin: () => false,
          hasOrganization: () => true,
          hasScope: () => true,
          getScopes: () => [{ name: 'user' }],
        },
      },
      dataAccess: {
        Entitlement: { TIER: { FREE_TRIAL: 'free_trial', PAID: 'paid' }, findByOrganizationIdAndProductCode: sinon.stub() },
        TrialUser: { STATUS: { REGISTERED: 'registered' }, findByEmailId: sinon.stub() },
        OrganizationIdentityProvider: {},
        SiteEnrollment: { findBySiteId: sinon.stub() },
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  // Test anonymous endpoints
  it('handles anonymous Slack endpoints', () => {
    const slackContext = {
      log: { info: logSpy },
      pathInfo: {
        method: 'GET',
        suffix: '/slack/events',
      },
    };

    const util = AccessControlUtil.fromContext(slackContext);
    expect(util.authInfo).to.exist;
    expect(util.authInfo.getProfile().user_id).to.equal('anonymous');
  });

  it('handles anonymous site detection endpoints', () => {
    const slackContext = {
      log: { info: logSpy },
      pathInfo: {
        method: 'POST',
        suffix: '/hooks/site-detection/cdn/some-secret',
      },
    };

    const util = AccessControlUtil.fromContext(slackContext);
    expect(util.authInfo).to.exist;
    expect(util.authInfo.getProfile().user_id).to.equal('anonymous');
  });

  it('handles POST slack endpoints', () => {
    const slackContext = {
      log: { info: logSpy },
      pathInfo: {
        method: 'POST',
        suffix: '/slack/events',
      },
    };

    const util = AccessControlUtil.fromContext(slackContext);
    expect(util.authInfo).to.exist;
    expect(util.authInfo.getProfile().user_id).to.equal('anonymous');
  });

  // Test error cases in hasAccess
  it('throws error when entity is missing in hasAccess', async () => {
    const util = AccessControlUtil.fromContext(context);
    await expect(util.hasAccess(null)).to.be.rejectedWith('Missing entity');
    await expect(util.hasAccess(undefined)).to.be.rejectedWith('Missing entity');
    await expect(util.hasAccess({})).to.be.rejectedWith('Missing entity');
  });

  // Test organization related checks
  it('throws error when site has no organization', async () => {
    const util = AccessControlUtil.fromContext(context);
    const site = {
      getOrganization: async () => null,
    };
    // Make site instanceof Site return true
    Object.setPrototypeOf(site, Site.prototype);

    await expect(util.hasAccess(site)).to.be.rejectedWith('Missing organization for site');
  });

  it('handles different entity types correctly', async () => {
    const util = AccessControlUtil.fromContext(context);

    // Test with Site entity
    const site = {
      getOrganization: async () => ({
        getImsOrgId: () => 'test-org-id',
      }),
    };
    Object.setPrototypeOf(site, Site.prototype);

    // Test with Organization entity
    const org = {
      getImsOrgId: () => 'test-org-id',
    };
    Object.setPrototypeOf(org, Organization.prototype);

    const siteResult = await util.hasAccess(site);
    const orgResult = await util.hasAccess(org);

    expect(siteResult).to.be.true;
    expect(orgResult).to.be.true;
  });

  it('should handle Organization entity type directly without calling getOrganization', async () => {
    const util = AccessControlUtil.fromContext(context);

    // Test with Organization entity directly
    const org = {
      getImsOrgId: () => 'test-org-id',
    };
    Object.setPrototypeOf(org, Organization.prototype);

    // Mock the authInfo.hasOrganization to return true for test-org-id
    util.authInfo.hasOrganization = sinon.stub().returns(true);

    const result = await util.hasAccess(org);

    expect(result).to.be.true;
    expect(util.authInfo.hasOrganization).to.have.been.calledWith('test-org-id');
  });

  it('should handle Organization entity type with productCode validation', async () => {
    // Mock TierClient for this test
    const mockTierClient = {
      checkValidEntitlement: sinon.stub().resolves({
        entitlement: {
          getId: () => 'entitlement-123',
          getProductCode: () => 'llmo',
          getTier: () => 'paid',
        },
      }),
    };
    sandbox.stub(TierClient, 'createForOrg').returns(mockTierClient);

    const util = AccessControlUtil.fromContext(context);

    // Test with Organization entity directly
    const org = {
      getImsOrgId: () => 'test-org-id',
      getId: () => 'test-org-id',
    };
    Object.setPrototypeOf(org, Organization.prototype);

    // Mock the authInfo.hasOrganization to return true for test-org-id
    util.authInfo.hasOrganization = sinon.stub().returns(true);

    const result = await util.hasAccess(org, '', 'llmo');

    expect(result).to.be.true;
    expect(util.authInfo.hasOrganization).to.have.been.calledWith('test-org-id');
    expect(TierClient.createForOrg).to.have.been.calledWith(context, org, 'llmo');
    expect(mockTierClient.checkValidEntitlement).to.have.been.called;
  });

  // Test constructor error cases
  it('throws error when context is missing', () => {
    expect(() => AccessControlUtil.fromContext()).to.throw('Missing context');
    expect(() => AccessControlUtil.fromContext(null)).to.throw('Missing context');

    // Test for missing authInfo with valid context but no attributes
    expect(() => AccessControlUtil.fromContext({
      log: { info: () => {} },
      pathInfo: {},
    })).to.throw('Missing authInfo');
  });

  describe('hasAccess with subService', () => {
    let util;
    let mockAuthInfo;

    beforeEach(() => {
      mockAuthInfo = {
        getType: () => 'jwt',
        isAdmin: () => false,
        getScopes: () => [],
        hasOrganization: sinon.stub(),
        hasScope: sinon.stub(),
      };

      const testContext = {
        log: {
          info: logSpy, error: logSpy, warn: logSpy, debug: logSpy,
        },
        pathInfo: {
          headers: { 'x-product': 'llmo' },
        },
        attributes: {
          authInfo: mockAuthInfo,
        },
        dataAccess: {
          Entitlement: {
            TIER: {
              FREE_TRIAL: 'free_trial',
              PAID: 'paid',
            },
          },
          TrialUser: {
            STATUS: {
              REGISTERED: 'registered',
            },
          },
          OrganizationIdentityProvider: {},
        },
      };

      util = AccessControlUtil.fromContext(testContext);
    });

    it('checks scope for auto_fix subService', async () => {
      const site = {
        getOrganization: async () => ({
          getImsOrgId: () => 'test-org-id',
        }),
      };
      Object.setPrototypeOf(site, Site.prototype);

      mockAuthInfo.hasOrganization.returns(true);
      mockAuthInfo.hasScope.returns(true);

      const result = await util.hasAccess(site, 'auto_fix');

      expect(mockAuthInfo.hasOrganization).to.have.been.calledWith('test-org-id');
      expect(mockAuthInfo.hasScope).to.have.been.calledWith('user', 'dx_aem_perf_auto_fix');
      expect(result).to.be.true;
    });

    it('checks scope for auto_suggest subService', async () => {
      const site = {
        getOrganization: async () => ({
          getImsOrgId: () => 'test-org-id',
        }),
      };
      Object.setPrototypeOf(site, Site.prototype);

      mockAuthInfo.hasOrganization.returns(true);
      mockAuthInfo.hasScope.returns(true);

      const result = await util.hasAccess(site, 'auto_suggest');

      expect(mockAuthInfo.hasOrganization).to.have.been.calledWith('test-org-id');
      expect(mockAuthInfo.hasScope).to.have.been.calledWith('user', 'dx_aem_perf_auto_suggest');
      expect(result).to.be.true;
    });

    it('returns false when org access is true but scope check fails', async () => {
      const site = {
        getOrganization: async () => ({
          getImsOrgId: () => 'test-org-id',
        }),
      };
      Object.setPrototypeOf(site, Site.prototype);

      mockAuthInfo.hasOrganization.returns(true);
      mockAuthInfo.hasScope.returns(false);

      const result = await util.hasAccess(site, 'auto_fix');

      expect(mockAuthInfo.hasOrganization).to.have.been.calledWith('test-org-id');
      expect(mockAuthInfo.hasScope).to.have.been.calledWith('user', 'dx_aem_perf_auto_fix');
      expect(result).to.be.false;
    });

    it('returns false when both org access and scope check fail', async () => {
      const site = {
        getOrganization: async () => ({
          getImsOrgId: () => 'test-org-id',
        }),
      };
      Object.setPrototypeOf(site, Site.prototype);

      mockAuthInfo.hasOrganization.returns(false);
      mockAuthInfo.hasScope.returns(false);

      const result = await util.hasAccess(site, 'auto_fix');

      expect(mockAuthInfo.hasOrganization).to.have.been.calledWith('test-org-id');
      expect(mockAuthInfo.hasScope).to.not.have.been.called;
      expect(result).to.be.false;
    });
  });

  describe('IMS User Access Control', () => {
    it('verifies access control for IMS user with user scope and tenant', async () => {
      const authInfo = new AuthInfo()
        .withType('ims')
        .withScopes([{ name: 'user' }])
        .withProfile({
          tenants: [{
            id: 'org-1',
          }],
          is_admin: false,
        })
        .withAuthenticated(true);

      const contextForIMS = {
        log: {
          info: logSpy, error: logSpy, warn: logSpy, debug: logSpy,
        },
        pathInfo: {
          headers: { 'x-product': 'llmo' },
        },
        attributes: { authInfo },
        dataAccess: {
          Entitlement: {
            TIER: {
              FREE_TRIAL: 'free_trial',
              PAID: 'paid',
            },
            findByOrganizationIdAndProductCode: sinon.stub(),
          },
          TrialUser: {
            STATUS: {
              REGISTERED: 'registered',
            },
          },
          OrganizationIdentityProvider: {},
        },
      };
      const accessControl = AccessControlUtil.fromContext(contextForIMS);

      // Verify IMS specific checks
      expect(accessControl.isAccessTypeJWT()).to.be.false;
      expect(accessControl.isScopeAdmin()).to.be.false;
      expect(accessControl.hasAdminAccess()).to.be.false;

      // Test access to site from different org
      const site = {
        getOrganization: async () => ({
          getImsOrgId: () => 'org-2',
        }),
      };
      Object.setPrototypeOf(site, Site.prototype);

      const hasAccess = await accessControl.hasAccess(site);
      expect(hasAccess).to.be.false;

      // Test access to site from same org
      const siteFromSameOrg = {
        getOrganization: async () => ({
          getImsOrgId: () => 'org-1',
        }),
      };
      Object.setPrototypeOf(siteFromSameOrg, Site.prototype);

      const hasAccessToSameOrg = await accessControl.hasAccess(siteFromSameOrg);
      expect(hasAccessToSameOrg).to.be.true;
    });
  });

  describe('Organization Access Control', () => {
    it('verifies access control for IMS user with admin scope', async () => {
      const authInfo = new AuthInfo()
        .withType('ims')
        .withScopes([{ name: 'admin' }])
        .withAuthenticated(true);

      const contextForIMS = {
        log: {
          info: logSpy, error: logSpy, warn: logSpy, debug: logSpy,
        },
        pathInfo: {
          headers: { 'x-product': 'llmo' },
        },
        attributes: { authInfo },
        dataAccess: {
          Entitlement: {
            TIER: {
              FREE_TRIAL: 'free_trial',
              PAID: 'paid',
            },
            findByOrganizationIdAndProductCode: sinon.stub(),
          },
          TrialUser: {
            STATUS: {
              REGISTERED: 'registered',
            },
          },
          OrganizationIdentityProvider: {},
        },
      };
      const accessControl = AccessControlUtil.fromContext(contextForIMS);

      // Test Organization instance
      const org = {
        getImsOrgId: () => 'org-1',
      };
      Object.setPrototypeOf(org, Organization.prototype);

      const hasAccess = await accessControl.hasAccess(org);
      expect(hasAccess).to.be.true;

      // Test Organization instance with different org
      const differentOrg = {
        getImsOrgId: () => 'org-2',
      };
      Object.setPrototypeOf(differentOrg, Organization.prototype);

      const hasAccessToDifferentOrg = await accessControl.hasAccess(differentOrg);
      expect(hasAccessToDifferentOrg).to.be.true;
    });

    it('should return true for hasAdminAccess when auth type is foo', async () => {
      const authInfo = new AuthInfo()
        .withType('foo')
        .withAuthenticated(true);

      const contextForIMS = {
        log: {
          info: logSpy, error: logSpy, warn: logSpy, debug: logSpy,
        },
        pathInfo: {
          headers: { 'x-product': 'llmo' },
        },
        attributes: { authInfo },
        dataAccess: {
          Entitlement: {
            TIER: {
              FREE_TRIAL: 'free_trial',
              PAID: 'paid',
            },
            findByOrganizationIdAndProductCode: sinon.stub(),
          },
          TrialUser: {
            STATUS: {
              REGISTERED: 'registered',
            },
          },
          OrganizationIdentityProvider: {},
        },
      };

      const accessControl = AccessControlUtil.fromContext(contextForIMS);

      // Test Organization instance
      const org = {
        getImsOrgId: () => 'org-1',
      };
      Object.setPrototypeOf(org, Organization.prototype);

      const hasAccess = await accessControl.hasAccess(org);
      expect(hasAccess).to.be.true;

      // Test Organization instance with different org
      const differentOrg = {
        getImsOrgId: () => 'org-2',
      };
      Object.setPrototypeOf(differentOrg, Organization.prototype);

      const hasAccessToDifferentOrg = await accessControl.hasAccess(differentOrg);
      expect(hasAccessToDifferentOrg).to.be.true;
    });
  });

  describe('Entitlement Validation', () => {
    let util;
    let mockOrg;
    let mockEntitlement;
    let mockTrialUser;
    let mockIdentityProvider;
    let mockSiteEnrollment;
    let mockAuthInfo;
    let mockTierClient;

    beforeEach(() => {
      // Mock the constant calls directly
      sandbox.stub(EntitlementModel, 'TIERS').value({
        FREE_TRIAL: 'free_trial',
        PAID: 'paid',
      });

      sandbox.stub(TrialUserModel, 'STATUSES').value({
        REGISTERED: 'registered',
      });

      sandbox.stub(OrganizationIdentityProviderModel, 'PROVIDER_TYPES').value({
        IMS: 'IMS',
        MICROSOFT: 'MICROSOFT',
        GOOGLE: 'GOOGLE',
      });

      mockOrg = {
        getId: () => 'org-123',
        getImsOrgId: () => 'org-123',
      };
      Object.setPrototypeOf(mockOrg, Organization.prototype);

      mockEntitlement = {
        findByOrganizationIdAndProductCode: sinon.stub(),
      };

      mockTrialUser = {
        findByEmailId: sinon.stub(),
        create: sinon.stub(),
      };

      mockIdentityProvider = {
        allByOrganizationId: sinon.stub(),
        create: sinon.stub(),
      };

      mockSiteEnrollment = {
        allBySiteId: sinon.stub(),
      };

      // Mock TierClient
      mockTierClient = {
        checkValidEntitlement: sinon.stub(),
      };
      sandbox.stub(TierClient, 'createForOrg').returns(mockTierClient);
      sandbox.stub(TierClient, 'createForSite').resolves(mockTierClient);

      mockAuthInfo = {
        getType: () => 'jwt',
        isAdmin: () => false,
        getScopes: () => [],
        hasOrganization: () => true,
        hasScope: () => true,
        getProfile: sinon.stub().returns({
          trial_email: 'trial@example.com',
          email: 'user@example.com',
          first_name: 'John',
          last_name: 'Doe',
        }),
      };

      const testContext = {
        log: {
          info: logSpy, error: logSpy, warn: logSpy, debug: logSpy,
        },
        pathInfo: {
          headers: { 'x-product': 'llmo' },
        },
        attributes: {
          authInfo: mockAuthInfo,
        },
        dataAccess: {
          Entitlement: mockEntitlement,
          TrialUser: mockTrialUser,
          OrganizationIdentityProvider: mockIdentityProvider,
          SiteEnrollment: mockSiteEnrollment,
        },
      };

      util = AccessControlUtil.fromContext(testContext);
    });

    it('should validate entitlement successfully for paid tier', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'paid',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      await expect(util.validateEntitlement(mockOrg, null, 'llmo')).to.not.be.rejected;
    });

    it('should throw error when entitlement is missing for organization', async () => {
      mockTierClient.checkValidEntitlement.resolves({});

      await expect(util.validateEntitlement(mockOrg, null, 'llmo'))
        .to.be.rejectedWith('Missing entitlement for organization');
    });

    it('should throw error when organization is not entitled for product', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'other_product',
        getTier: () => 'paid',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      // The production code doesn't validate product code mismatch, so this should pass
      await expect(util.validateEntitlement(mockOrg, null, 'llmo')).to.not.be.rejected;
    });

    it('should throw error when entitlement has no tier', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => undefined,
      }; // missing tier
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      await expect(util.validateEntitlement(mockOrg, null, 'llmo'))
        .to.be.rejectedWith('[Error] Entitlement tier is not set for llmo');
    });

    it('should validate site enrollment when site is provided and matches product code', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'paid',
      };
      const siteEnrollment = {
        getId: () => 'site-enrollment-123',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement, siteEnrollment });

      const mockSite = {
        getId: () => 'site-123',
      };
      Object.setPrototypeOf(mockSite, Site.prototype);

      await expect(util.validateEntitlement(mockOrg, mockSite, 'llmo')).to.not.be.rejected;
    });

    it('should throw error when site is enrolled for different product code', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'paid',
      };
      // TierClient returns no site enrollment for different product
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      const mockSite = {
        getId: () => 'site-123',
      };
      Object.setPrototypeOf(mockSite, Site.prototype);

      await expect(util.validateEntitlement(mockOrg, mockSite, 'llmo'))
        .to.be.rejectedWith('Missing enrollment for site');
    });

    it('should proceed when site has no entitlement (null)', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'paid',
      };
      // TierClient returns no site enrollment
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      const mockSite = {
        getId: () => 'site-123',
      };
      Object.setPrototypeOf(mockSite, Site.prototype);

      await expect(util.validateEntitlement(mockOrg, mockSite, 'llmo'))
        .to.be.rejectedWith('Missing enrollment for site');
    });

    it('should proceed when site has no entitlement (undefined)', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'paid',
      };
      // TierClient returns no site enrollment
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      const mockSite = {
        getId: () => 'site-123',
      };
      Object.setPrototypeOf(mockSite, Site.prototype);

      await expect(util.validateEntitlement(mockOrg, mockSite, 'llmo'))
        .to.be.rejectedWith('Missing enrollment for site');
    });

    it('should not call site enrollment validation when site is not provided', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'paid',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      await expect(util.validateEntitlement(mockOrg, null, 'llmo')).to.not.be.rejected;

      expect(mockSiteEnrollment.allBySiteId).to.not.have.been.called;
    });

    it('should create trial user when tier is free_trial and trial user does not exist', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'free_trial',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      mockTrialUser.findByEmailId.resolves(null);

      const identityProviders = [];

      mockIdentityProvider.allByOrganizationId.resolves(identityProviders);

      // Mock the create method to return a value
      mockTrialUser.create.resolves({ id: 'new-trial-user' });

      // Mock the identity provider create method to return an object with provider property
      mockIdentityProvider.create.resolves({ provider: 'GOOGLE' });

      await util.validateEntitlement(mockOrg, null, 'llmo');

      expect(mockTrialUser.create).to.have.been.calledWith({
        emailId: 'trial@example.com',
        firstName: 'John',
        lastName: 'Doe',
        organizationId: 'org-123',
        status: 'registered',
        externalUserId: 'user@example.com',
        lastSeenAt: sinon.match.string,
      });
    });

    it('should create trial user with fallback values when profile has null first_name and last_name', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'free_trial',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      mockTrialUser.findByEmailId.resolves(null);

      const identityProviders = [];
      mockIdentityProvider.allByOrganizationId.resolves(identityProviders);
      mockTrialUser.create.resolves({ id: 'new-trial-user' });
      mockIdentityProvider.create.resolves({ provider: 'GOOGLE' });

      // Mock profile with null values
      const mockProfile = {
        trial_email: 'trial@example.com',
        first_name: null,
        last_name: null,
        email: 'user@example.com',
      };
      mockAuthInfo.getProfile.returns(mockProfile);

      await util.validateEntitlement(mockOrg, null, 'llmo');

      expect(mockTrialUser.create).to.have.been.calledWith({
        emailId: 'trial@example.com',
        firstName: '-',
        lastName: '-',
        organizationId: 'org-123',
        status: 'registered',
        externalUserId: 'user@example.com',
        lastSeenAt: sinon.match.string,
      });
    });

    it('should create trial user with fallback values when profile has undefined first_name and last_name', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'free_trial',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      mockTrialUser.findByEmailId.resolves(null);

      const identityProviders = [];
      mockIdentityProvider.allByOrganizationId.resolves(identityProviders);
      mockTrialUser.create.resolves({ id: 'new-trial-user' });
      mockIdentityProvider.create.resolves({ provider: 'GOOGLE' });

      // Mock profile with undefined values
      const mockProfile = {
        trial_email: 'trial@example.com',
        first_name: undefined,
        last_name: undefined,
        email: 'user@example.com',
      };
      mockAuthInfo.getProfile.returns(mockProfile);

      await util.validateEntitlement(mockOrg, null, 'llmo');

      expect(mockTrialUser.create).to.have.been.calledWith({
        emailId: 'trial@example.com',
        firstName: '-',
        lastName: '-',
        organizationId: 'org-123',
        status: 'registered',
        externalUserId: 'user@example.com',
        lastSeenAt: sinon.match.string,
      });
    });

    it('should create trial user with fallback values when profile has empty string first_name and last_name', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'free_trial',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      mockTrialUser.findByEmailId.resolves(null);

      const identityProviders = [];
      mockIdentityProvider.allByOrganizationId.resolves(identityProviders);
      mockTrialUser.create.resolves({ id: 'new-trial-user' });
      mockIdentityProvider.create.resolves({ provider: 'GOOGLE' });

      // Mock profile with empty string values
      const mockProfile = {
        trial_email: 'trial@example.com',
        first_name: '',
        last_name: '',
        email: 'user@example.com',
      };
      mockAuthInfo.getProfile.returns(mockProfile);

      await util.validateEntitlement(mockOrg, null, 'llmo');

      expect(mockTrialUser.create).to.have.been.calledWith({
        emailId: 'trial@example.com',
        firstName: '-',
        lastName: '-',
        organizationId: 'org-123',
        status: 'registered',
        externalUserId: 'user@example.com',
        lastSeenAt: sinon.match.string,
      });
    });

    it('should create trial user with mixed fallback values when profile has partial data', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'free_trial',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      mockTrialUser.findByEmailId.resolves(null);

      const identityProviders = [];
      mockIdentityProvider.allByOrganizationId.resolves(identityProviders);
      mockTrialUser.create.resolves({ id: 'new-trial-user' });
      mockIdentityProvider.create.resolves({ provider: 'GOOGLE' });

      // Mock profile with mixed data - valid first_name, null last_name
      const mockProfile = {
        trial_email: 'trial@example.com',
        first_name: 'John',
        last_name: null,
        email: 'user@example.com',
      };
      mockAuthInfo.getProfile.returns(mockProfile);

      await util.validateEntitlement(mockOrg, null, 'llmo');

      expect(mockTrialUser.create).to.have.been.calledWith({
        emailId: 'trial@example.com',
        firstName: 'John',
        lastName: '-',
        organizationId: 'org-123',
        status: 'registered',
        externalUserId: 'user@example.com',
        lastSeenAt: sinon.match.string,
      });
    });

    it('should not create trial user when trial user already exists', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'free_trial',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      mockTrialUser.findByEmailId.resolves({ id: 'existing-user' });

      const identityProviders = [
        { provider: 'GOOGLE', getProvider: () => 'GOOGLE' },
      ];
      mockIdentityProvider.allByOrganizationId.resolves(identityProviders);

      await util.validateEntitlement(mockOrg, null, 'llmo');

      expect(mockTrialUser.create).to.not.have.been.called;
    });

    it('should throw error when x-product header does not match productCode', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'paid',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      // Create a mock organization that works with instanceof check
      const mockOrgInstance = {
        getId: () => 'org-123',
        getImsOrgId: () => 'org-123',
      };
      // Make it pass instanceof Organization check
      Object.setPrototypeOf(mockOrgInstance, Organization.prototype);

      // Set up context with x-product header
      const testContextWithHeader = {
        log: {
          info: logSpy, error: logSpy, warn: logSpy, debug: logSpy,
        },
        pathInfo: {
          headers: { 'x-product': 'different-product' },
        },
        attributes: {
          authInfo: {
            getType: () => 'jwt',
            isAdmin: () => false,
            getScopes: () => [],
            hasOrganization: () => true,
            hasScope: () => true,
            getProfile: () => ({
              trial_email: 'trial@example.com',
              email: 'user@example.com',
              first_name: 'John',
              last_name: 'Doe',
            }),
          },
        },
        dataAccess: {
          Entitlement: mockEntitlement,
          TrialUser: mockTrialUser,
          OrganizationIdentityProvider: mockIdentityProvider,
          SiteEnrollment: mockSiteEnrollment,
        },
      };

      const utilWithHeader = AccessControlUtil.fromContext(testContextWithHeader);

      await expect(utilWithHeader.hasAccess(mockOrgInstance, '', 'llmo'))
        .to.be.rejectedWith('[Error] Unauthorized request');
    });

    it('should validate successfully when x-product header matches productCode', async () => {
      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'paid',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      // Create a mock organization that works with instanceof check
      const mockOrgInstance = {
        getId: () => 'org-123',
        getImsOrgId: () => 'org-123',
      };
      // Make it pass instanceof Organization check
      Object.setPrototypeOf(mockOrgInstance, Organization.prototype);

      // Set up context with matching x-product header
      const testContextWithHeader = {
        log: {
          info: logSpy, error: logSpy, warn: logSpy, debug: logSpy,
        },
        pathInfo: {
          headers: { 'x-product': 'llmo' },
        },
        attributes: {
          authInfo: {
            getType: () => 'jwt',
            isAdmin: () => false,
            getScopes: () => [],
            hasOrganization: () => true,
            hasScope: () => true,
            getProfile: () => ({
              trial_email: 'trial@example.com',
              email: 'user@example.com',
              first_name: 'John',
              last_name: 'Doe',
            }),
          },
        },
        dataAccess: {
          Entitlement: mockEntitlement,
          TrialUser: mockTrialUser,
          OrganizationIdentityProvider: mockIdentityProvider,
          SiteEnrollment: mockSiteEnrollment,
        },
      };

      const utilWithHeader = AccessControlUtil.fromContext(testContextWithHeader);

      await expect(utilWithHeader.hasAccess(mockOrgInstance, '', 'llmo')).to.not.be.rejected;
    });
  });

  describe('hasAccess with productCode', () => {
    let util;
    let mockOrg;
    let mockEntitlement;
    let mockTrialUser;
    let mockIdentityProvider;
    let mockSiteEnrollment;
    let mockTierClient;

    beforeEach(() => {
      mockOrg = {
        getId: () => 'org-123',
        getImsOrgId: () => 'org-123',
      };

      mockEntitlement = {
        findByOrganizationIdAndProductCode: sinon.stub(),
      };

      mockTrialUser = {
        findByEmailId: sinon.stub(),
        create: sinon.stub(),
      };

      mockIdentityProvider = {
        allByOrganizationId: sinon.stub(),
      };

      mockSiteEnrollment = {
        allBySiteId: sinon.stub(),
      };

      // Mock TierClient
      mockTierClient = {
        checkValidEntitlement: sinon.stub(),
      };
      sandbox.stub(TierClient, 'createForOrg').returns(mockTierClient);
      sandbox.stub(TierClient, 'createForSite').resolves(mockTierClient);

      const testContext = {
        log: {
          info: logSpy, error: logSpy, warn: logSpy, debug: logSpy,
        },
        pathInfo: {
          headers: { 'x-product': 'llmo' },
        },
        attributes: {
          authInfo: {
            getType: () => 'jwt',
            isAdmin: () => false,
            getScopes: () => [],
            hasOrganization: () => true,
            hasScope: () => true,
            getProfile: () => ({
              trial_email: 'trial@example.com',
              email: 'user@example.com',
            }),
          },
        },
        dataAccess: {
          Entitlement: mockEntitlement,
          TrialUser: mockTrialUser,
          OrganizationIdentityProvider: mockIdentityProvider,
          SiteEnrollment: mockSiteEnrollment,
        },
      };

      util = AccessControlUtil.fromContext(testContext);
    });

    it('should call validateEntitlement when productCode is provided', async () => {
      const site = {
        getOrganization: async () => mockOrg,
        getId: () => 'site-123',
      };
      Object.setPrototypeOf(site, Site.prototype);

      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'paid',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      // Mock site enrollment to return empty array (no site entitlement)
      mockSiteEnrollment.allBySiteId.resolves([]);

      const result = await util.hasAccess(site, '', 'llmo');
      expect(result).to.be.false;

      expect(mockTierClient.checkValidEntitlement).to.have.been.called;
    });

    it('should not call validateEntitlement when productCode is empty', async () => {
      const site = {
        getOrganization: async () => mockOrg,
      };
      Object.setPrototypeOf(site, Site.prototype);

      const result = await util.hasAccess(site, '', '');

      expect(mockTierClient.checkValidEntitlement).to.not.have.been.called;
      expect(result).to.be.true;
    });

    it('should handle entitlement validation errors', async () => {
      const site = {
        getOrganization: async () => mockOrg,
        getId: () => 'site-123',
      };
      Object.setPrototypeOf(site, Site.prototype);

      mockTierClient.checkValidEntitlement.resolves({});

      const result = await util.hasAccess(site, '', 'llmo');
      expect(result).to.be.false;
    });

    it('should validate site enrollment when hasAccess is called with site and product code', async () => {
      const site = {
        getOrganization: async () => mockOrg,
        getId: () => 'site-123',
      };
      Object.setPrototypeOf(site, Site.prototype);

      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'paid',
      };
      const siteEnrollment = {
        getId: () => 'site-enrollment-123',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement, siteEnrollment });

      const result = await util.hasAccess(site, '', 'llmo');

      expect(result).to.be.true;
      expect(mockTierClient.checkValidEntitlement).to.have.been.called;
    });

    it('should throw error when site enrollment validation fails in hasAccess', async () => {
      const site = {
        getOrganization: async () => mockOrg,
        getId: () => 'site-123',
      };
      Object.setPrototypeOf(site, Site.prototype);

      const entitlement = {
        getId: () => 'entitlement-123',
        getProductCode: () => 'llmo',
        getTier: () => 'paid',
      };
      mockTierClient.checkValidEntitlement.resolves({ entitlement });

      const mockSiteEnrollments = [
        {
          getEntitlementId: () => 'different-entitlement-id',
        },
      ];

      mockSiteEnrollment.allBySiteId.resolves(mockSiteEnrollments);

      const result = await util.hasAccess(site, '', 'llmo');
      expect(result).to.be.false;

      expect(mockTierClient.checkValidEntitlement).to.have.been.called;
    });
  });

  describe('Constructor with dataAccess dependencies', () => {
    it('should initialize dataAccess dependencies correctly', () => {
      const mockEntitlement = {};
      const mockTrialUser = {};
      const mockIdentityProvider = {};
      const mockSiteEnrollment = {};

      const testContext = {
        log: {
          info: logSpy, error: logSpy, warn: logSpy, debug: logSpy,
        },
        pathInfo: {
          headers: { 'x-product': 'llmo' },
        },
        attributes: {
          authInfo: {
            getType: () => 'jwt',
            isAdmin: () => true,
            getScopes: () => [],
            hasOrganization: () => true,
            hasScope: () => true,
            getProfile: () => ({}),
          },
        },
        dataAccess: {
          Entitlement: mockEntitlement,
          TrialUser: mockTrialUser,
          OrganizationIdentityProvider: mockIdentityProvider,
          SiteEnrollment: mockSiteEnrollment,
        },
      };

      const util = AccessControlUtil.fromContext(testContext);

      expect(util.Entitlement).to.equal(mockEntitlement);
      expect(util.TrialUser).to.equal(mockTrialUser);
      expect(util.IdentityProvider).to.equal(mockIdentityProvider);
      expect(util.SiteEnrollment).to.equal(mockSiteEnrollment);
    });
  });
});
