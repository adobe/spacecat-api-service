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
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

import TierClient from '@adobe/spacecat-shared-tier-client';

import EntitlementsController from '../../src/controllers/entitlements.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Entitlements Controller', () => {
  const sandbox = sinon.createSandbox();
  const organizationId = '123e4567-e89b-12d3-a456-426614174000';

  const mockOrganization = {
    getId: () => organizationId,
    getName: () => 'Test Organization',
  };

  const mockEntitlements = [
    {
      getId: () => 'ent1',
      getOrganizationId: () => organizationId,
      getProductCode: () => 'LLMO',
      getTier: () => 'FREE_TRIAL',
      getStatus: () => 'ACTIVE',
      getQuotas: () => ({}),
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedBy: () => 'user1@example.com',
    },
    {
      getId: () => 'ent2',
      getOrganizationId: () => organizationId,
      getProductCode: () => 'ASO',
      getTier: () => 'PAID',
      getStatus: () => 'ACTIVE',
      getQuotas: () => ({}),
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedBy: () => 'user2@example.com',
    },
  ];

  const mockDataAccess = {
    Organization: {
      findById: sandbox.stub().resolves(mockOrganization),
    },
    Entitlement: {
      allByOrganizationId: sandbox.stub().resolves(mockEntitlements),
    },
  };

  const mockAccessControlUtil = {
    hasAccess: sandbox.stub().resolves(true),
    hasAdminAccess: sandbox.stub().returns(true),
  };

  let entitlementController;

  beforeEach(() => {
    sandbox.restore();

    // Create a mock AccessControlUtil instance that will be used by the controller
    const mockAccessControlUtilInstance = {
      hasAccess: sandbox.stub().resolves(true),
      hasAdminAccess: sandbox.stub().returns(true),
    };

    // Stub AccessControlUtil.fromContext to return our mock instance
    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtilInstance);

    entitlementController = EntitlementsController({
      dataAccess: mockDataAccess,
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    });

    // Reset stubs
    mockDataAccess.Organization.findById = sandbox.stub().resolves(mockOrganization);
    mockDataAccess.Entitlement.allByOrganizationId = sandbox.stub().resolves(mockEntitlements);

    // Store reference to the mock instance for test manipulation
    mockAccessControlUtil.hasAccess = mockAccessControlUtilInstance.hasAccess;
    mockAccessControlUtil.hasAdminAccess = mockAccessControlUtilInstance.hasAdminAccess;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('EntitlementsController constructor', () => {
    it('should throw error when context is not provided', () => {
      expect(() => EntitlementsController()).to.throw('Context required');
    });

    it('should throw error when context is null', () => {
      expect(() => EntitlementsController(null)).to.throw('Context required');
    });

    it('should throw error when context is empty object', () => {
      expect(() => EntitlementsController({})).to.throw('Context required');
    });

    it('should throw error when dataAccess is not provided', () => {
      expect(() => EntitlementsController({ someOtherProp: 'value' })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is null', () => {
      expect(() => EntitlementsController({ dataAccess: null })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is empty object', () => {
      expect(() => EntitlementsController({ dataAccess: {} })).to.throw('Data access required');
    });
  });

  describe('getByOrganizationID', () => {
    it('should return entitlements for valid organization ID', async () => {
      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await entitlementController.getByOrganizationID(context);

      expect(result.status).to.equal(200);

      // Parse the response body
      const body = await result.json();
      expect(body).to.be.an('array');
      expect(body).to.have.length(2);

      // Verify the structure of the first entitlement includes updatedBy
      expect(body[0]).to.have.property('updatedBy');
      expect(body[0].updatedBy).to.equal('user1@example.com');

      // Verify the structure of the second entitlement includes updatedBy
      expect(body[1]).to.have.property('updatedBy');
      expect(body[1].updatedBy).to.equal('user2@example.com');
    });

    it('should return bad request for invalid UUID', async () => {
      const context = {
        params: { organizationId: 'invalid-uuid' },
      };

      const result = await entitlementController.getByOrganizationID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Organization ID required');
    });

    it('should return not found for non-existent organization', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await entitlementController.getByOrganizationID(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Organization not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await entitlementController.getByOrganizationID(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Only users belonging to the organization can view its entitlements');
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.Entitlement.allByOrganizationId.rejects(dbError);

      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await entitlementController.getByOrganizationID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Database connection failed');

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error getting entitlements for organization ${organizationId}: ${dbError.message}`);
    });

    it('should return internal server error when access control check fails', async () => {
      const accessError = new Error('Access control error');
      mockAccessControlUtil.hasAccess.rejects(accessError);

      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await entitlementController.getByOrganizationID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Access control error');

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error getting entitlements for organization ${organizationId}: ${accessError.message}`);
    });

    it('should return internal server error when Organization.findById fails', async () => {
      const orgError = new Error('Organization lookup failed');
      mockDataAccess.Organization.findById.rejects(orgError);

      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await entitlementController.getByOrganizationID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Organization lookup failed');

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error getting entitlements for organization ${organizationId}: ${orgError.message}`);
    });
  });

  describe('createEntitlement', () => {
    const mockCreatedEntitlement = {
      getId: () => 'entitlement-123',
      getOrganizationId: () => organizationId,
      getProductCode: () => 'LLMO',
      getTier: () => 'FREE_TRIAL',
      getStatus: () => 'ACTIVE',
      getQuotas: () => ({}),
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedBy: () => 'admin@example.com',
    };

    const mockTierClient = {
      createEntitlement: sandbox.stub().resolves({
        entitlement: mockCreatedEntitlement,
      }),
    };

    beforeEach(() => {
      // Reset TierClient mock
      sandbox.stub(TierClient, 'createForOrg').resolves(mockTierClient);
    });

    it('should create entitlement successfully for admin user', async () => {
      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'admin@example.com' }) },
      };

      const result = await entitlementController.createEntitlement(context);

      expect(result.status).to.equal(201);

      // Parse the response body
      const body = await result.json();
      expect(body).to.have.property('id', 'entitlement-123');
      expect(body).to.have.property('organizationId', organizationId);
      expect(body).to.have.property('productCode', 'LLMO');
      expect(body).to.have.property('tier', 'FREE_TRIAL');

      // Verify TierClient was called correctly
      expect(TierClient.createForOrg).to.have.been.calledWith(
        context,
        mockOrganization,
        'LLMO',
      );
      expect(mockTierClient.createEntitlement).to.have.been.calledWith('FREE_TRIAL');
    });

    it('should return forbidden when user is not admin', async () => {
      // Create a new controller instance with non-admin user
      const nonAdminController = EntitlementsController({
        dataAccess: mockDataAccess,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      });

      // Override the hasAdminAccess method to return false for this test
      mockAccessControlUtil.hasAdminAccess.returns(false);

      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'user@example.com' }) },
      };

      const result = await nonAdminController.createEntitlement(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Only admins can create entitlements');

      // Restore the original behavior
      mockAccessControlUtil.hasAdminAccess.returns(true);
    });

    it('should return bad request for invalid organization ID', async () => {
      const context = {
        params: { organizationId: 'invalid-uuid' },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'admin@example.com' }) },
      };

      const result = await entitlementController.createEntitlement(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Organization ID required');
    });

    it('should return not found for non-existent organization', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'admin@example.com' }) },
      };

      const result = await entitlementController.createEntitlement(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Organization not found');
    });

    it('should return internal server error when TierClient creation fails', async () => {
      const tierClientError = new Error('TierClient creation failed');
      TierClient.createForOrg.rejects(tierClientError);

      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'admin@example.com' }) },
      };

      const result = await entitlementController.createEntitlement(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('TierClient creation failed');

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error creating entitlement for organization ${organizationId}: ${tierClientError.message}`);
    });

    it('should return internal server error when entitlement creation fails', async () => {
      const entitlementError = new Error('Entitlement creation failed');
      mockTierClient.createEntitlement.rejects(entitlementError);

      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'admin@example.com' }) },
      };

      const result = await entitlementController.createEntitlement(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Entitlement creation failed');

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error creating entitlement for organization ${organizationId}: ${entitlementError.message}`);
    });

    it('should return internal server error when Organization.findById fails', async () => {
      const orgError = new Error('Organization lookup failed');
      mockDataAccess.Organization.findById.rejects(orgError);

      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'admin@example.com' }) },
      };

      const result = await entitlementController.createEntitlement(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Organization lookup failed');

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error creating entitlement for organization ${organizationId}: ${orgError.message}`);
    });

    it('should use correct product code and tier constants', async () => {
      const context = {
        params: { organizationId },
        log: { error: sinon.stub() },
        authInfo: { getProfile: () => ({ email: 'admin@example.com' }) },
      };

      await entitlementController.createEntitlement(context);

      // Verify TierClient.createForOrg was called with correct product code
      expect(TierClient.createForOrg).to.have.been.calledWith(
        context,
        mockOrganization,
        'LLMO',
      );

      // Verify createEntitlement was called with correct tier
      expect(mockTierClient.createEntitlement).to.have.been.calledWith('FREE_TRIAL');
    });
  });

  describe('addEnrollments', () => {
    const entitlementId = '456e7890-e89b-12d3-a456-426614174000';
    const siteId1 = '111e1111-e89b-12d3-a456-426614174001';
    const siteId2 = '222e2222-e89b-12d3-a456-426614174002';

    const mockEntitlement = {
      getId: () => entitlementId,
      getOrganizationId: () => organizationId,
    };

    const mockSite1 = {
      getId: () => siteId1,
    };

    const mockSite2 = {
      getId: () => siteId2,
    };

    const mockEnrollment1 = {
      getId: () => 'enrollment-1',
      getSiteId: () => siteId1,
      getEntitlementId: () => entitlementId,
      getCreatedAt: () => '2023-01-01T00:00:00Z',
    };

    const mockEnrollment2 = {
      getId: () => 'enrollment-2',
      getSiteId: () => siteId2,
      getEntitlementId: () => entitlementId,
      getCreatedAt: () => '2023-01-01T00:00:00Z',
    };

    beforeEach(() => {
      mockDataAccess.Entitlement.findById = sandbox.stub().resolves(mockEntitlement);
      mockDataAccess.Site = {
        findById: sandbox.stub(),
      };
      mockDataAccess.SiteEnrollment = {
        create: sandbox.stub(),
        allBySiteId: sandbox.stub().resolves([]),
      };
    });

    it('should add enrollments successfully for valid data', async () => {
      mockDataAccess.Site.findById.withArgs(siteId1).resolves(mockSite1);
      mockDataAccess.Site.findById.withArgs(siteId2).resolves(mockSite2);
      mockDataAccess.SiteEnrollment.create.onFirstCall().resolves(mockEnrollment1);
      mockDataAccess.SiteEnrollment.create.onSecondCall().resolves(mockEnrollment2);

      const context = {
        params: { entitlementId },
        data: { siteIds: [siteId1, siteId2] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.success).to.have.length(2);
      expect(body.errors).to.have.length(0);
      expect(body.summary.total).to.equal(2);
      expect(body.summary.successful).to.equal(2);
      expect(body.summary.failed).to.equal(0);
    });

    it('should return forbidden when user is not admin', async () => {
      mockAccessControlUtil.hasAdminAccess.returns(false);

      const context = {
        params: { entitlementId },
        data: { siteIds: [siteId1] },
        log: { error: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Only admins can add enrollments');

      mockAccessControlUtil.hasAdminAccess.returns(true);
    });

    it('should return bad request for invalid entitlement ID', async () => {
      const context = {
        params: { entitlementId: 'invalid-uuid' },
        data: { siteIds: [siteId1] },
        log: { error: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Entitlement ID required');
    });

    it('should return bad request when siteIds array is missing', async () => {
      const context = {
        params: { entitlementId },
        data: {},
        log: { error: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('siteIds array is required and must not be empty');
    });

    it('should return bad request when siteIds array is empty', async () => {
      const context = {
        params: { entitlementId },
        data: { siteIds: [] },
        log: { error: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('siteIds array is required and must not be empty');
    });

    it('should return bad request for invalid site IDs', async () => {
      const context = {
        params: { entitlementId },
        data: { siteIds: ['invalid-uuid-1', 'invalid-uuid-2'] },
        log: { error: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('Invalid site IDs');
    });

    it('should return not found when entitlement does not exist', async () => {
      mockDataAccess.Entitlement.findById.resolves(null);

      const context = {
        params: { entitlementId },
        data: { siteIds: [siteId1] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Entitlement not found');
    });

    it('should handle errors when site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: { entitlementId },
        data: { siteIds: [siteId1] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      // The body is the full response object, not just the message
      expect(body.success).to.be.an('array');
      expect(body.errors).to.be.an('array');
      expect(body.errors).to.have.length(1);
      expect(body.errors[0].error).to.equal('Site not found');
    });

    it('should handle errors when enrollment already exists', async () => {
      mockDataAccess.Site.findById.resolves(mockSite1);
      mockDataAccess.SiteEnrollment.allBySiteId.resolves([mockEnrollment1]);

      const context = {
        params: { entitlementId },
        data: { siteIds: [siteId1] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      // The body is the full response object, not just the message
      expect(body.success).to.be.an('array');
      expect(body.errors).to.be.an('array');
      expect(body.errors).to.have.length(1);
      expect(body.errors[0].error).to.equal('Enrollment already exists');
    });

    it('should handle partial success when some sites fail', async () => {
      mockDataAccess.Site.findById.withArgs(siteId1).resolves(mockSite1);
      mockDataAccess.Site.findById.withArgs(siteId2).resolves(null);
      mockDataAccess.SiteEnrollment.create.resolves(mockEnrollment1);

      const context = {
        params: { entitlementId },
        data: { siteIds: [siteId1, siteId2] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.success).to.have.length(1);
      expect(body.errors).to.have.length(1);
      expect(body.summary.successful).to.equal(1);
      expect(body.summary.failed).to.equal(1);
    });

    it('should handle errors when SiteEnrollment.create fails', async () => {
      mockDataAccess.Site.findById.resolves(mockSite1);
      mockDataAccess.SiteEnrollment.allBySiteId.resolves([]);
      const createError = new Error('Failed to create enrollment');
      mockDataAccess.SiteEnrollment.create.rejects(createError);

      const context = {
        params: { entitlementId },
        data: { siteIds: [siteId1] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.success).to.be.an('array');
      expect(body.errors).to.be.an('array');
      expect(body.errors).to.have.length(1);
      expect(body.errors[0].error).to.equal('Failed to create enrollment');
      expect(context.log.error.calledWith(`Error creating enrollment for site ${siteId1}: Failed to create enrollment`)).to.be.true;
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database error');
      mockDataAccess.Entitlement.findById.rejects(dbError);

      const context = {
        params: { entitlementId },
        data: { siteIds: [siteId1] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Database error');
    });

    it('should handle Promise.allSettled rejection gracefully', async () => {
      // Create a Proxy around siteIds array that causes map to create rejecting promises
      const proxiedSiteIds = new Proxy([siteId1], {
        get(target, prop) {
          if (prop === 'map') {
            return function map() {
              // Return an array with a promise that rejects
              return [Promise.reject(new Error('Unexpected promise rejection'))];
            };
          }
          return target[prop];
        },
      });

      const context = {
        params: { entitlementId },
        data: { siteIds: proxiedSiteIds },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.errors).to.have.length(1);
      expect(body.errors[0].siteId).to.equal('unknown');
      expect(body.errors[0].error).to.equal('Unexpected promise rejection');
    });

    it('should handle Promise.allSettled rejection without message gracefully', async () => {
      // Create a Proxy that causes map to create rejecting promises without message
      const proxiedSiteIds = new Proxy([siteId1], {
        get(target, prop) {
          if (prop === 'map') {
            return function map() {
              // Return a promise that rejects with an object without message
              return [Promise.reject(new Error())];
            };
          }
          return target[prop];
        },
      });

      const context = {
        params: { entitlementId },
        data: { siteIds: proxiedSiteIds },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.addEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.errors).to.have.length(1);
      expect(body.errors[0].siteId).to.equal('unknown');
      expect(body.errors[0].error).to.equal('Unknown error');
    });
  });

  describe('deleteEnrollments', () => {
    const enrollmentId1 = '111e1111-e89b-12d3-a456-426614174001';
    const enrollmentId2 = '222e2222-e89b-12d3-a456-426614174002';
    const siteId1 = '333e3333-e89b-12d3-a456-426614174003';
    const siteId2 = '444e4444-e89b-12d3-a456-426614174004';
    const entitlementId = '555e5555-e89b-12d3-a456-426614174005';

    const mockEnrollment1 = {
      getId: () => enrollmentId1,
      getSiteId: () => siteId1,
      getEntitlementId: () => entitlementId,
      remove: sandbox.stub().resolves(),
    };

    const mockEnrollment2 = {
      getId: () => enrollmentId2,
      getSiteId: () => siteId2,
      getEntitlementId: () => entitlementId,
      remove: sandbox.stub().resolves(),
    };

    beforeEach(() => {
      mockDataAccess.SiteEnrollment = {
        findById: sandbox.stub(),
      };
    });

    it('should delete enrollments successfully for valid data', async () => {
      mockDataAccess.SiteEnrollment.findById.withArgs(enrollmentId1).resolves(mockEnrollment1);
      mockDataAccess.SiteEnrollment.findById.withArgs(enrollmentId2).resolves(mockEnrollment2);

      const context = {
        params: {},
        data: { enrollmentIds: [enrollmentId1, enrollmentId2] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.deleteEnrollments(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.success).to.have.length(2);
      expect(body.errors).to.have.length(0);
      expect(body.summary.total).to.equal(2);
      expect(body.summary.successful).to.equal(2);
      expect(body.summary.failed).to.equal(0);

      expect(mockEnrollment1.remove).to.have.been.calledOnce;
      expect(mockEnrollment2.remove).to.have.been.calledOnce;
    });

    it('should return forbidden when user is not admin', async () => {
      mockAccessControlUtil.hasAdminAccess.returns(false);

      const context = {
        params: {},
        data: { enrollmentIds: [enrollmentId1] },
        log: { error: sinon.stub() },
      };

      const result = await entitlementController.deleteEnrollments(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Only admins can delete enrollments');

      mockAccessControlUtil.hasAdminAccess.returns(true);
    });

    it('should return bad request when enrollmentIds array is missing', async () => {
      const context = {
        params: {},
        data: {},
        log: { error: sinon.stub() },
      };

      const result = await entitlementController.deleteEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('enrollmentIds array is required and must not be empty');
    });

    it('should return bad request when enrollmentIds array is empty', async () => {
      const context = {
        params: {},
        data: { enrollmentIds: [] },
        log: { error: sinon.stub() },
      };

      const result = await entitlementController.deleteEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('enrollmentIds array is required and must not be empty');
    });

    it('should return bad request for invalid enrollment IDs', async () => {
      const context = {
        params: {},
        data: { enrollmentIds: ['invalid-uuid-1', 'invalid-uuid-2'] },
        log: { error: sinon.stub() },
      };

      const result = await entitlementController.deleteEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('Invalid enrollment IDs');
    });

    it('should handle errors when enrollment does not exist', async () => {
      mockDataAccess.SiteEnrollment.findById.resolves(null);

      const context = {
        params: {},
        data: { enrollmentIds: [enrollmentId1] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.deleteEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      // The body is the full response object, not just the message
      expect(body.success).to.be.an('array');
      expect(body.errors).to.be.an('array');
      expect(body.errors).to.have.length(1);
      expect(body.errors[0].error).to.equal('Enrollment not found');
    });

    it('should handle partial success when some enrollments fail', async () => {
      mockDataAccess.SiteEnrollment.findById.withArgs(enrollmentId1).resolves(mockEnrollment1);
      mockDataAccess.SiteEnrollment.findById.withArgs(enrollmentId2).resolves(null);

      const context = {
        params: {},
        data: { enrollmentIds: [enrollmentId1, enrollmentId2] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.deleteEnrollments(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.success).to.have.length(1);
      expect(body.errors).to.have.length(1);
      expect(body.summary.successful).to.equal(1);
      expect(body.summary.failed).to.equal(1);
    });

    it('should handle errors during enrollment removal', async () => {
      const removeError = new Error('Remove failed');
      const failingEnrollment = {
        getId: () => enrollmentId1,
        getSiteId: () => siteId1,
        getEntitlementId: () => entitlementId,
        remove: sandbox.stub().rejects(removeError),
      };

      mockDataAccess.SiteEnrollment.findById.withArgs(enrollmentId1).resolves(failingEnrollment);
      mockDataAccess.SiteEnrollment.findById.withArgs(enrollmentId2).resolves(mockEnrollment2);

      const context = {
        params: {},
        data: { enrollmentIds: [enrollmentId1, enrollmentId2] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.deleteEnrollments(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.success).to.have.length(1);
      expect(body.errors).to.have.length(1);
      expect(body.errors[0].error).to.equal('Remove failed');
    });

    it('should handle errors during enrollment removal in the loop', async () => {
      // This tests the inner catch block when findById throws an error
      const dbError = new Error('Database error during findById');
      mockDataAccess.SiteEnrollment.findById.rejects(dbError);

      const context = {
        params: {},
        data: { enrollmentIds: [enrollmentId1] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.deleteEnrollments(context);

      // The error is caught in the inner try-catch and added to errors
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.errors).to.have.length(1);
      expect(body.errors[0].error).to.equal('Database error during findById');
    });

    it('should return internal server error when unexpected error occurs', async () => {
      // This test verifies the outer catch block by creating a controller
      // with a Proxy dataAccess that throws when SiteEnrollment is accessed
      const proxyDataAccess = new Proxy(mockDataAccess, {
        get(target, prop) {
          if (prop === 'SiteEnrollment') {
            throw new Error('DataAccess error');
          }
          return target[prop];
        },
      });

      const brokenContext = {
        dataAccess: proxyDataAccess,
        env: {},
        log: { error: sandbox.stub(), info: sandbox.stub() },
        attributes: {},
      };

      const brokenController = EntitlementsController(brokenContext);

      const context = {
        params: {},
        data: { enrollmentIds: [enrollmentId1] },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await brokenController.deleteEnrollments(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('DataAccess error');
      expect(context.log.error.calledWith('Error deleting enrollments: DataAccess error')).to.be.true;
    });

    it('should handle Promise.allSettled rejection gracefully', async () => {
      // Create a Proxy around enrollmentIds array that causes map to create rejecting promises
      const proxiedEnrollmentIds = new Proxy([enrollmentId1], {
        get(target, prop) {
          if (prop === 'map') {
            return function map() {
              // Return an array with a promise that rejects
              return [Promise.reject(new Error('Unexpected deletion error'))];
            };
          }
          return target[prop];
        },
      });

      const context = {
        params: {},
        data: { enrollmentIds: proxiedEnrollmentIds },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.deleteEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.errors).to.have.length(1);
      expect(body.errors[0].enrollmentId).to.equal('unknown');
      expect(body.errors[0].error).to.equal('Unexpected deletion error');
    });

    it('should handle Promise.allSettled rejection without message gracefully', async () => {
      // Create a Proxy that causes map to create rejecting promises without message
      const proxiedEnrollmentIds = new Proxy([enrollmentId1], {
        get(target, prop) {
          if (prop === 'map') {
            return function map() {
              // Return a promise that rejects with an object without message
              return [Promise.reject(new Error())];
            };
          }
          return target[prop];
        },
      });

      const context = {
        params: {},
        data: { enrollmentIds: proxiedEnrollmentIds },
        log: { error: sinon.stub(), info: sinon.stub() },
      };

      const result = await entitlementController.deleteEnrollments(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.errors).to.have.length(1);
      expect(body.errors[0].enrollmentId).to.equal('unknown');
      expect(body.errors[0].error).to.equal('Unknown error');
    });
  });
});
