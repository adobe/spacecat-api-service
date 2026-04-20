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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import TierClient from '@adobe/spacecat-shared-tier-client';

import SiteEnrollmentController from '../../src/controllers/site-enrollments.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Site Enrollment Controller', () => {
  const sandbox = sinon.createSandbox();
  const siteId = '123e4567-e89b-12d3-a456-426614174000';

  const mockSite = {
    getId: () => siteId,
    getName: () => 'Test Site',
  };

  const mockSiteEnrollments = [
    {
      getId: () => 'enrollment-1',
      getSiteId: () => siteId,
      getEntitlementId: () => 'ent1',
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedBy: () => 'user1@example.com',
    },
    {
      getId: () => 'enrollment-2',
      getSiteId: () => siteId,
      getEntitlementId: () => 'ent2',
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedBy: () => 'user2@example.com',
    },
  ];

  const orgId = '456e7890-e89b-12d3-a456-426614174001';
  const entitlementId = '789e0123-e89b-12d3-a456-426614174002';

  const mockSiteWithOrg = {
    getId: () => siteId,
    getOrganizationId: () => orgId,
  };

  const mockAsoEntitlement = { getId: () => entitlementId, getTier: () => 'FREE_TRIAL' };

  const mockNewEnrollment = {
    getId: () => 'new-enrollment-1',
    getSiteId: () => siteId,
    getEntitlementId: () => entitlementId,
    getStatus: () => 'ACTIVE',
    getCreatedAt: () => '2023-01-01T00:00:00Z',
    getUpdatedAt: () => '2023-01-01T00:00:00Z',
    getUpdatedBy: () => 'system',
  };

  const mockDataAccess = {
    Site: {
      findById: sandbox.stub().resolves(mockSite),
    },
    SiteEnrollment: {
      allBySiteId: sandbox.stub().resolves(mockSiteEnrollments),
    },
    Configuration: {
      findLatest: sandbox.stub(),
    },
    Entitlement: {
      findByOrganizationIdAndProductCode: sandbox.stub(),
    },
  };

  const mockAccessControlUtil = {
    hasAccess: sandbox.stub().resolves(true),
  };

  let siteEnrollmentController;

  beforeEach(() => {
    sandbox.restore();

    // Create a mock AccessControlUtil instance that will be used by the controller
    const mockAccessControlUtilInstance = {
      hasAccess: sandbox.stub().resolves(true),
      hasAdminAccess: sandbox.stub().returns(true),
    };

    // Stub AccessControlUtil.fromContext to return our mock instance
    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtilInstance);

    siteEnrollmentController = SiteEnrollmentController({
      dataAccess: mockDataAccess,
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    });

    // Reset stubs
    mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);
    mockDataAccess.SiteEnrollment.allBySiteId = sandbox.stub().resolves(mockSiteEnrollments);
    mockDataAccess.Configuration.findLatest = sandbox.stub();
    mockDataAccess.Entitlement.findByOrganizationIdAndProductCode = sandbox.stub();

    // Store reference to the mock instance for test manipulation
    mockAccessControlUtil.hasAccess = mockAccessControlUtilInstance.hasAccess;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('SiteEnrollmentController constructor', () => {
    it('should throw error when context is not provided', () => {
      expect(() => SiteEnrollmentController()).to.throw('Context required');
    });

    it('should throw error when context is null', () => {
      expect(() => SiteEnrollmentController(null)).to.throw('Context required');
    });

    it('should throw error when context is empty object', () => {
      expect(() => SiteEnrollmentController({})).to.throw('Context required');
    });

    it('should throw error when dataAccess is not provided', () => {
      expect(() => SiteEnrollmentController({ someOtherProp: 'value' })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is null', () => {
      expect(() => SiteEnrollmentController({ dataAccess: null })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is empty object', () => {
      expect(() => SiteEnrollmentController({ dataAccess: {} })).to.throw('Data access required');
    });
  });

  describe('getBySiteID', () => {
    it('should return site enrollments for valid site ID', async () => {
      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        log: { error: sinon.stub() },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await siteEnrollmentController.getBySiteID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.be.an('array');
      expect(body).to.have.length(2);
    });

    it('should return bad request for invalid UUID', async () => {
      const context = {
        params: { siteId: 'invalid-uuid' },
      };

      const result = await siteEnrollmentController.getBySiteID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Site ID required');
    });

    it('should return not found for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        log: { error: sinon.stub() },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await siteEnrollmentController.getBySiteID(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Site not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        log: { error: sinon.stub() },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await siteEnrollmentController.getBySiteID(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Access denied to this site');
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.SiteEnrollment.allBySiteId.rejects(dbError);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        log: { error: sinon.stub() },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await siteEnrollmentController.getBySiteID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Database connection failed');

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error getting site enrollments for site ${siteId}: ${dbError.message}`);
    });

    it('should return internal server error when access control check fails', async () => {
      const accessError = new Error('Access control error');
      mockAccessControlUtil.hasAccess.rejects(accessError);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        log: { error: sinon.stub() },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await siteEnrollmentController.getBySiteID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Access control error');

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error getting site enrollments for site ${siteId}: ${accessError.message}`);
    });

    it('should return internal server error when Site.findById fails', async () => {
      const siteError = new Error('Site lookup failed');
      mockDataAccess.Site.findById.rejects(siteError);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        log: { error: sinon.stub() },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await siteEnrollmentController.getBySiteID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Site lookup failed');

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error getting site enrollments for site ${siteId}: ${siteError.message}`);
    });
  });

  describe('createPlgEnrollment', () => {
    let mockConfiguration;
    let mockTierClientInstance;

    const makeContext = () => ({
      params: { siteId },
      log: { error: sandbox.stub() },
    });

    beforeEach(() => {
      mockTierClientInstance = {
        createEntitlement: sandbox.stub().resolves({ siteEnrollment: mockNewEnrollment }),
      };
      sandbox.stub(TierClient, 'createForSite').resolves(mockTierClientInstance);

      mockConfiguration = { isHandlerEnabledForSite: sandbox.stub().returns(true) };
      mockDataAccess.Site.findById = sandbox.stub().resolves(mockSiteWithOrg);
      mockDataAccess.SiteEnrollment.allBySiteId = sandbox.stub().resolves([]);
      mockDataAccess.Configuration.findLatest = sandbox.stub().resolves(mockConfiguration);
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode = sandbox.stub()
        .resolves(mockAsoEntitlement);
    });

    it('returns 403 when caller is not admin', async () => {
      AccessControlUtil.fromContext.returns({
        hasAccess: sandbox.stub().resolves(true),
        hasAdminAccess: sandbox.stub().returns(false),
      });
      const ctrl = SiteEnrollmentController({ dataAccess: mockDataAccess, attributes: {} });
      const result = await ctrl.createPlgEnrollment(makeContext());
      expect(result.status).to.equal(403);
    });

    it('returns 400 for invalid site ID', async () => {
      const result = await siteEnrollmentController.createPlgEnrollment({
        params: { siteId: 'not-a-uuid' },
        log: { error: sandbox.stub() },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Site ID required');
    });

    it('returns 404 when site not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await siteEnrollmentController.createPlgEnrollment(makeContext());
      expect(result.status).to.equal(404);
    });

    it('returns 400 when summit-plg handler is not enabled for site', async () => {
      mockConfiguration.isHandlerEnabledForSite.returns(false);
      const result = await siteEnrollmentController.createPlgEnrollment(makeContext());
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('summit-plg');
    });

    it('returns 200 skipped when org has no ASO entitlement', async () => {
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(null);
      const result = await siteEnrollmentController.createPlgEnrollment(makeContext());
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.skipped).to.be.true;
      expect(body.reason).to.equal('no_aso_entitlement');
      expect(body.organizationId).to.equal(orgId);
    });

    it('returns 200 skipped when site is already enrolled', async () => {
      const existingEnrollment = {
        getId: () => 'existing-1',
        getSiteId: () => siteId,
        getEntitlementId: () => entitlementId,
        getCreatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedBy: () => 'system',
      };
      mockDataAccess.SiteEnrollment.allBySiteId.resolves([existingEnrollment]);
      const result = await siteEnrollmentController.createPlgEnrollment(makeContext());
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.skipped).to.be.true;
      expect(body.reason).to.equal('already_enrolled');
      expect(body.enrollment.id).to.equal('existing-1');
    });

    it('creates enrollment and returns 201', async () => {
      const result = await siteEnrollmentController.createPlgEnrollment(makeContext());
      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.siteId).to.equal(siteId);
      expect(body.entitlementId).to.equal(entitlementId);
    });

    it('returns 500 on unexpected error', async () => {
      mockDataAccess.Configuration.findLatest.rejects(new Error('DB failure'));
      const context = makeContext();
      const result = await siteEnrollmentController.createPlgEnrollment(context);
      expect(result.status).to.equal(500);
      expect(context.log.error).to.have.been.calledWithMatch(`Error creating enrollment for site ${siteId}`);
    });
  });
});
