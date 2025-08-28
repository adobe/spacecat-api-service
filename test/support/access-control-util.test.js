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
import { Site, Organization } from '@adobe/spacecat-shared-data-access';

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
      attributes: { authInfo },
      dataAccess: {
        Entitlment: {
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

    const accessControlUtil = AccessControlUtil.fromContext(context);
    expect(accessControlUtil.hasAdminAccess()).to.be.true;
  });

  it('should throw an error if entity is not provided', async () => {
    const context = {
      attributes: { authInfo: new AuthInfo() },
      dataAccess: {
        Entitlment: {
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
      log: { info: logSpy },
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
        Entitlment: { TIER: { FREE_TRIAL: 'free_trial', PAID: 'paid' }, findByOrganizationIdAndProductCode: sinon.stub() },
        TrialUser: { STATUS: { REGISTERED: 'registered' }, findByEmailId: sinon.stub() },
        OrganizationIdentityProvider: {},
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
    expect(logSpy).to.have.been.calledWith('Anonymous endpoint, skipping authorization: GET /slack/events');
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
    expect(logSpy).to.have.been.calledWith('Anonymous endpoint, skipping authorization: POST /hooks/site-detection/cdn/***********');
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
    expect(logSpy).to.have.been.calledWith('Anonymous endpoint, skipping authorization: POST /slack/events');
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
    const util = AccessControlUtil.fromContext(context);

    // Test with Organization entity directly
    const org = {
      getImsOrgId: () => 'test-org-id',
      getId: () => 'test-org-id',
    };
    Object.setPrototypeOf(org, Organization.prototype);

    // Mock the authInfo.hasOrganization to return true for test-org-id
    util.authInfo.hasOrganization = sinon.stub().returns(true);

    // Mock the entitlement validation to succeed
    util.Entitlment.findByOrganizationIdAndProductCode = sinon.stub().resolves([
      { productCode: 'llmo', tier: 'paid' },
    ]);

    const result = await util.hasAccess(org, '', 'llmo');

    expect(result).to.be.true;
    expect(util.authInfo.hasOrganization).to.have.been.calledWith('test-org-id');
    expect(util.Entitlment.findByOrganizationIdAndProductCode).to.have.been.calledWith('test-org-id', 'llmo');
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
        log: { info: () => {} },
        attributes: {
          authInfo: mockAuthInfo,
        },
        dataAccess: {
          Entitlment: {
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
        attributes: { authInfo },
        dataAccess: {
          Entitlment: {
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
        attributes: { authInfo },
        dataAccess: {
          Entitlment: {
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
        attributes: { authInfo },
        dataAccess: {
          Entitlment: {
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
    let mockEntitlment;
    let mockTrialUser;
    let mockIdentityProvider;
    let mockSiteEnrollment;

    beforeEach(() => {
      mockOrg = {
        getId: () => 'org-123',
        getImsOrgId: () => 'org-123',
      };

      mockEntitlment = {
        TIER: {
          FREE_TRIAL: 'free_trial',
          PAID: 'paid',
        },
        findByOrganizationIdAndProductCode: sinon.stub(),
      };

      mockTrialUser = {
        findByEmailId: sinon.stub(),
        create: sinon.stub(),
        STATUS: {
          REGISTERED: 'registered',
        },
      };

      mockIdentityProvider = {
        findByOrganizationId: sinon.stub(),
        create: sinon.stub(),
        PROVIDER_TYPES: {
          IMS: 'IMS',
          MICROSOFT: 'MICROSOFT',
          GOOGLE: 'GOOGLE',
        },
      };

      mockSiteEnrollment = {
        findBySiteId: sinon.stub(),
      };

      const testContext = {
        log: { info: () => {} },
        attributes: {
          authInfo: {
            getType: () => 'jwt',
            isAdmin: () => false,
            getScopes: () => [],
            hasOrganization: () => true,
            hasScope: () => true,
            getProfile: () => ({
              trial_email: 'trial@example.com',
              provider: 'GOOGLE',
              email: 'user@example.com',
            }),
          },
        },
        dataAccess: {
          Entitlment: mockEntitlment,
          TrialUser: mockTrialUser,
          OrganizationIdentityProvider: mockIdentityProvider,
          SiteEnrollment: mockSiteEnrollment,
        },
      };

      util = AccessControlUtil.fromContext(testContext);
    });

    it('should validate entitlement successfully for paid tier', async () => {
      const entitlements = [
        { productCode: 'llmo', tier: 'paid' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      await expect(util.validateEntitlement(mockOrg, null, 'llmo')).to.not.be.rejected;
    });

    it('should throw error when entitlement is missing for organization', async () => {
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(null);

      await expect(util.validateEntitlement(mockOrg, null, 'llmo'))
        .to.be.rejectedWith('Missing entitlement for organization');
    });

    it('should throw error when organization is not entitled for product', async () => {
      const entitlements = [
        { productCode: 'other_product', tier: 'paid' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      await expect(util.validateEntitlement(mockOrg, null, 'llmo'))
        .to.be.rejectedWith('[Error] Organization is not entitled for llmo');
    });

    it('should throw error when entitlement has no tier', async () => {
      const entitlements = [
        { productCode: 'llmo' }, // missing tier
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      await expect(util.validateEntitlement(mockOrg, null, 'llmo'))
        .to.be.rejectedWith('[Error] Organization is not entitled for llmo');
    });

    it('should validate site enrollment when site is provided and matches product code', async () => {
      const entitlements = [
        { productCode: 'llmo', tier: 'paid' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      const mockSite = {
        getId: () => 'site-123',
      };

      const mockSiteEnrollmentInstance = {
        getEntitlement: sinon.stub().resolves({
          productCode: 'llmo',
        }),
      };

      mockSiteEnrollment.findBySiteId.resolves(mockSiteEnrollmentInstance);

      await expect(util.validateEntitlement(mockOrg, mockSite, 'llmo')).to.not.be.rejected;

      expect(mockSiteEnrollment.findBySiteId).to.have.been.calledWith('site-123');
      expect(mockSiteEnrollmentInstance.getEntitlement).to.have.been.calledOnce;
    });

    it('should throw error when site is enrolled for different product code', async () => {
      const entitlements = [
        { productCode: 'llmo', tier: 'paid' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      const mockSite = {
        getId: () => 'site-123',
      };

      const mockSiteEnrollmentInstance = {
        getEntitlement: sinon.stub().resolves({
          productCode: 'different_product',
        }),
      };

      mockSiteEnrollment.findBySiteId.resolves(mockSiteEnrollmentInstance);

      await expect(util.validateEntitlement(mockOrg, mockSite, 'llmo'))
        .to.be.rejectedWith('[Error] Site is not enrolled for llmo');

      expect(mockSiteEnrollment.findBySiteId).to.have.been.calledWith('site-123');
      expect(mockSiteEnrollmentInstance.getEntitlement).to.have.been.calledOnce;
    });

    it('should proceed when site has no entitlement (null)', async () => {
      const entitlements = [
        { productCode: 'llmo', tier: 'paid' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      const mockSite = {
        getId: () => 'site-123',
      };

      const mockSiteEnrollmentInstance = {
        getEntitlement: sinon.stub().resolves(null),
      };

      mockSiteEnrollment.findBySiteId.resolves(mockSiteEnrollmentInstance);

      await expect(util.validateEntitlement(mockOrg, mockSite, 'llmo')).to.not.be.rejected;

      expect(mockSiteEnrollment.findBySiteId).to.have.been.calledWith('site-123');
      expect(mockSiteEnrollmentInstance.getEntitlement).to.have.been.calledOnce;
    });

    it('should proceed when site has no entitlement (undefined)', async () => {
      const entitlements = [
        { productCode: 'llmo', tier: 'paid' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      const mockSite = {
        getId: () => 'site-123',
      };

      const mockSiteEnrollmentInstance = {
        getEntitlement: sinon.stub().resolves(undefined),
      };

      mockSiteEnrollment.findBySiteId.resolves(mockSiteEnrollmentInstance);

      await expect(util.validateEntitlement(mockOrg, mockSite, 'llmo')).to.not.be.rejected;

      expect(mockSiteEnrollment.findBySiteId).to.have.been.calledWith('site-123');
      expect(mockSiteEnrollmentInstance.getEntitlement).to.have.been.calledOnce;
    });

    it('should not call site enrollment validation when site is not provided', async () => {
      const entitlements = [
        { productCode: 'llmo', tier: 'paid' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      await expect(util.validateEntitlement(mockOrg, null, 'llmo')).to.not.be.rejected;

      expect(mockSiteEnrollment.findBySiteId).to.not.have.been.called;
    });

    it('should create trial user when tier is free_trial and trial user does not exist', async () => {
      const entitlements = [
        { productCode: 'llmo', tier: 'free_trial' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      mockTrialUser.findByEmailId.resolves(null);

      const identityProviders = [
        { provider: 'GOOGLE', getProvider: () => 'GOOGLE' },
      ];
      mockIdentityProvider.findByOrganizationId.resolves(identityProviders);

      await util.validateEntitlement(mockOrg, null, 'llmo');

      expect(mockTrialUser.create).to.have.been.calledWith({
        emailId: 'trial@example.com',
        provider: 'GOOGLE',
        organizationId: 'org-123',
        status: 'registered',
        externalUserId: 'user@example.com',
        lastSeenAt: sinon.match.string,
      });
    });

    it('should not create trial user when trial user already exists', async () => {
      const entitlements = [
        { productCode: 'llmo', tier: 'free_trial' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      mockTrialUser.findByEmailId.resolves({ id: 'existing-user' });

      const identityProviders = [
        { provider: 'GOOGLE', getProvider: () => 'GOOGLE' },
      ];
      mockIdentityProvider.findByOrganizationId.resolves(identityProviders);

      await util.validateEntitlement(mockOrg, null, 'llmo');

      expect(mockTrialUser.create).to.not.have.been.called;
    });

    it('should throw error when IDP provider is not supported for free trial', async () => {
      const entitlements = [
        { productCode: 'llmo', tier: 'free_trial' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      mockTrialUser.findByEmailId.resolves(null);

      // Test with unsupported provider
      const testContext = {
        log: { info: () => {} },
        attributes: {
          authInfo: {
            getType: () => 'jwt',
            isAdmin: () => false,
            getScopes: () => [],
            hasOrganization: () => true,
            hasScope: () => true,
            getProfile: () => ({
              trial_email: 'trial@example.com',
              provider: 'unsupported_provider',
              email: 'user@example.com',
            }),
          },
        },
        dataAccess: {
          Entitlment: mockEntitlment,
          TrialUser: mockTrialUser,
          OrganizationIdentityProvider: mockIdentityProvider,
          SiteEnrollment: mockSiteEnrollment,
        },
      };

      const testUtil = AccessControlUtil.fromContext(testContext);

      await expect(testUtil.validateEntitlement(mockOrg, null, 'llmo'))
        .to.be.rejectedWith('[Error] IDP not supported');
    });

    it('should create identity provider when it does not exist for supported provider', async () => {
      const entitlements = [
        { productCode: 'llmo', tier: 'free_trial' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      mockTrialUser.findByEmailId.resolves(null);

      // No existing identity provider for this organization
      mockIdentityProvider.findByOrganizationId.resolves([]);

      // Mock the create method to return a new identity provider
      const newIdentityProvider = { provider: 'GOOGLE' };
      mockIdentityProvider.create.resolves(newIdentityProvider);

      await util.validateEntitlement(mockOrg, null, 'llmo');

      // Verify that create was called with the correct parameters
      expect(mockIdentityProvider.create).to.have.been.calledWith({
        organizationId: 'org-123',
        provider: 'GOOGLE',
        externalId: 'GOOGLE',
      });

      // Verify that trial user was created with the new identity provider
      expect(mockTrialUser.create).to.have.been.calledWith({
        emailId: 'trial@example.com',
        provider: 'GOOGLE',
        organizationId: 'org-123',
        status: 'registered',
        externalUserId: 'user@example.com',
        lastSeenAt: sinon.match.string,
      });
    });
  });

  describe('hasAccess with productCode', () => {
    let util;
    let mockOrg;
    let mockEntitlment;
    let mockTrialUser;
    let mockIdentityProvider;
    let mockSiteEnrollment;

    beforeEach(() => {
      mockOrg = {
        getId: () => 'org-123',
        getImsOrgId: () => 'org-123',
      };

      mockEntitlment = {
        TIER: {
          FREE_TRIAL: 'free_trial',
          PAID: 'paid',
        },
        findByOrganizationIdAndProductCode: sinon.stub(),
      };

      mockTrialUser = {
        findByEmailId: sinon.stub(),
        create: sinon.stub(),
        STATUS: {
          REGISTERED: 'registered',
        },
      };

      mockIdentityProvider = {
        findByOrganizationId: sinon.stub(),
      };

      mockSiteEnrollment = {
        findBySiteId: sinon.stub(),
      };

      const testContext = {
        log: { info: () => {} },
        attributes: {
          authInfo: {
            getType: () => 'jwt',
            isAdmin: () => false,
            getScopes: () => [],
            hasOrganization: () => true,
            hasScope: () => true,
            getProfile: () => ({
              trial_email: 'trial@example.com',
              provider: 'google',
              email: 'user@example.com',
            }),
          },
        },
        dataAccess: {
          Entitlment: mockEntitlment,
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

      const entitlements = [
        { productCode: 'llmo', tier: 'paid' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      // Mock site enrollment to return null (no site entitlement)
      const mockSiteEnrollmentInstance = {
        getEntitlement: sinon.stub().resolves(null),
      };
      mockSiteEnrollment.findBySiteId.resolves(mockSiteEnrollmentInstance);

      const result = await util.hasAccess(site, '', 'llmo');

      expect(mockEntitlment.findByOrganizationIdAndProductCode).to.have.been.calledWith('org-123', 'llmo');
      expect(mockSiteEnrollment.findBySiteId).to.have.been.calledWith('site-123');
      expect(result).to.be.true;
    });

    it('should not call validateEntitlement when productCode is empty', async () => {
      const site = {
        getOrganization: async () => mockOrg,
      };
      Object.setPrototypeOf(site, Site.prototype);

      const result = await util.hasAccess(site, '', '');

      expect(mockEntitlment.findByOrganizationIdAndProductCode).to.not.have.been.called;
      expect(result).to.be.true;
    });

    it('should handle entitlement validation errors', async () => {
      const site = {
        getOrganization: async () => mockOrg,
      };
      Object.setPrototypeOf(site, Site.prototype);

      mockEntitlment.findByOrganizationIdAndProductCode.resolves(null);

      await expect(util.hasAccess(site, '', 'llmo'))
        .to.be.rejectedWith('Missing entitlement for organization');
    });

    it('should validate site enrollment when hasAccess is called with site and product code', async () => {
      const site = {
        getOrganization: async () => mockOrg,
        getId: () => 'site-123',
      };
      Object.setPrototypeOf(site, Site.prototype);

      const entitlements = [
        { productCode: 'llmo', tier: 'paid' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      const mockSiteEnrollmentInstance = {
        getEntitlement: sinon.stub().resolves({
          productCode: 'llmo',
        }),
      };

      mockSiteEnrollment.findBySiteId.resolves(mockSiteEnrollmentInstance);

      const result = await util.hasAccess(site, '', 'llmo');

      expect(result).to.be.true;
      expect(mockEntitlment.findByOrganizationIdAndProductCode).to.have.been.calledWith('org-123', 'llmo');
      expect(mockSiteEnrollment.findBySiteId).to.have.been.calledWith('site-123');
      expect(mockSiteEnrollmentInstance.getEntitlement).to.have.been.calledOnce;
    });

    it('should throw error when site enrollment validation fails in hasAccess', async () => {
      const site = {
        getOrganization: async () => mockOrg,
        getId: () => 'site-123',
      };
      Object.setPrototypeOf(site, Site.prototype);

      const entitlements = [
        { productCode: 'llmo', tier: 'paid' },
      ];
      mockEntitlment.findByOrganizationIdAndProductCode.resolves(entitlements);

      const mockSiteEnrollmentInstance = {
        getEntitlement: sinon.stub().resolves({
          productCode: 'different_product',
        }),
      };

      mockSiteEnrollment.findBySiteId.resolves(mockSiteEnrollmentInstance);

      await expect(util.hasAccess(site, '', 'llmo'))
        .to.be.rejectedWith('[Error] Site is not enrolled for llmo');

      expect(mockEntitlment.findByOrganizationIdAndProductCode).to.have.been.calledWith('org-123', 'llmo');
      expect(mockSiteEnrollment.findBySiteId).to.have.been.calledWith('site-123');
      expect(mockSiteEnrollmentInstance.getEntitlement).to.have.been.calledOnce;
    });
  });

  describe('Constructor with dataAccess dependencies', () => {
    it('should initialize dataAccess dependencies correctly', () => {
      const mockEntitlment = { TIER: { FREE_TRIAL: 'free_trial' } };
      const mockTrialUser = { STATUS: { REGISTERED: 'registered' } };
      const mockIdentityProvider = {};
      const mockSiteEnrollment = {};

      const testContext = {
        log: { info: () => {} },
        attributes: {
          authInfo: {
            getType: () => 'jwt',
            isAdmin: () => false,
            getScopes: () => [],
            hasOrganization: () => true,
            hasScope: () => true,
            getProfile: () => ({}),
          },
        },
        dataAccess: {
          Entitlment: mockEntitlment,
          TrialUser: mockTrialUser,
          OrganizationIdentityProvider: mockIdentityProvider,
          SiteEnrollment: mockSiteEnrollment,
        },
      };

      const util = AccessControlUtil.fromContext(testContext);

      expect(util.Entitlment).to.equal(mockEntitlment);
      expect(util.TrialUser).to.equal(mockTrialUser);
      expect(util.IdentityProvider).to.equal(mockIdentityProvider);
      expect(util.SiteEnrollment).to.equal(mockSiteEnrollment);
    });
  });
});
