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

import UserActivityController from '../../src/controllers/user-activity.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe.skip('User Activity Controller', () => {
  const sandbox = sinon.createSandbox();
  const siteId = '123e4567-e89b-12d3-a456-426614174000';
  const organizationId = '456e7890-e89b-12d3-a456-426614174000';

  describe('Constructor Validation', () => {
    it('should throw error when context is not provided', () => {
      expect(() => UserActivityController()).to.throw('Context required');
    });

    it('should throw error when context is null', () => {
      expect(() => UserActivityController(null)).to.throw('Context required');
    });

    it('should throw error when context is undefined', () => {
      expect(() => UserActivityController(undefined)).to.throw('Context required');
    });

    it('should throw error when context is not an object', () => {
      expect(() => UserActivityController('not-an-object')).to.throw('Context required');
    });

    it('should throw error when context is an empty object', () => {
      expect(() => UserActivityController({})).to.throw('Context required');
    });

    it('should throw error when dataAccess is missing from context', () => {
      expect(() => UserActivityController({ someOtherProperty: 'value' })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is null', () => {
      expect(() => UserActivityController({ dataAccess: null })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is undefined', () => {
      expect(() => UserActivityController({ dataAccess: undefined })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is not an object', () => {
      expect(() => UserActivityController({ dataAccess: 'not-an-object' })).to.throw('Data access required');
    });
  });

  const mockSite = {
    getId: () => siteId,
    getOrganizationId: () => organizationId,
    getName: () => 'Test Site',
  };

  const mockTrialUser = {
    getId: () => 'trial-user-123',
    getEmailId: () => 'test@example.com',
  };

  const mockEntitlement = {
    getId: () => 'entitlement-123',
    getProductCode: () => 'LLMO',
    getTier: () => 'FREE_TRIAL',
  };

  const mockUserActivities = [
    {
      getId: () => 'activity-1',
      getOrganizationId: () => organizationId,
      getTrialUserId: () => 'trial-user-123',
      getSiteId: () => siteId,
      getEntitlementId: () => 'entitlement-123',
      getType: () => 'SIGN_IN',
      getDetails: () => ({ action: 'SIGN_IN' }),
      getProductCode: () => 'LLMO',
      getTimestamp: () => new Date('2023-01-01T00:00:00Z'),
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
    },
    {
      getId: () => 'activity-2',
      getOrganizationId: () => organizationId,
      getTrialUserId: () => 'trial-user-123',
      getSiteId: () => siteId,
      getEntitlementId: () => 'entitlement-123',
      getType: () => 'LOGOUT',
      getDetails: () => ({ action: 'LOGOUT' }),
      getProductCode: () => 'LLMO',
      getTimestamp: () => new Date('2023-01-01T01:00:00Z'),
      getCreatedAt: () => '2023-01-01T01:00:00Z',
      getUpdatedAt: () => '2023-01-01T01:00:00Z',
    },
  ];

  const mockDataAccess = {
    TrialUserActivity: {
      findBySiteId: sandbox.stub().resolves(mockUserActivities),
      allBySiteId: sandbox.stub().resolves(mockUserActivities),
      create: sandbox.stub().resolves(mockUserActivities[0]),
      TYPES: {
        SIGN_UP: 'SIGN_UP',
        SIGN_IN: 'SIGN_IN',
        CREATE_SITE: 'CREATE_SITE',
        RUN_AUDIT: 'RUN_AUDIT',
        PROMPT_RUN: 'PROMPT_RUN',
        DOWNLOAD: 'DOWNLOAD',
      },
    },
    Site: {
      findById: sandbox.stub().resolves(mockSite),
    },
    TrialUser: {
      findById: sandbox.stub().resolves(mockTrialUser),
      findByEmailId: sandbox.stub().resolves(mockTrialUser),
    },
    Entitlement: {
      findById: sandbox.stub().resolves(mockEntitlement),
      allByOrganizationIdAndProductCode: sandbox.stub().resolves([mockEntitlement]),
      PRODUCT_CODES: {
        LLMO: 'LLMO',
        ASO: 'ASO',
      },
    },
  };

  const mockAccessControlUtil = {
    hasAccess: sandbox.stub().resolves(true),
  };

  let userActivityController;

  beforeEach(() => {
    sandbox.restore();
    userActivityController = UserActivityController({
      dataAccess: mockDataAccess,
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    });

    // Reset stubs
    mockDataAccess.TrialUserActivity.findBySiteId = sandbox.stub().resolves(mockUserActivities);
    mockDataAccess.TrialUserActivity.allBySiteId = sandbox.stub().resolves(mockUserActivities);
    mockDataAccess.TrialUserActivity.create = sandbox.stub().resolves(mockUserActivities[0]);
    mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);
    mockDataAccess.TrialUser.findById = sandbox.stub().resolves(mockTrialUser);
    mockDataAccess.TrialUser.findByEmailId = sandbox.stub().resolves(mockTrialUser);
    mockDataAccess.Entitlement.findById = sandbox.stub().resolves(mockEntitlement);
    mockDataAccess.Entitlement.allByOrganizationIdAndProductCode = sandbox
      .stub()
      .resolves([mockEntitlement]);
    mockAccessControlUtil.hasAccess = sandbox.stub().resolves(true);

    // Stub AccessControlUtil.fromContext
    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtil);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('UserActivityController constructor', () => {
    it('should throw error when context is not provided', () => {
      expect(() => UserActivityController()).to.throw('Context required');
    });

    it('should throw error when context is null', () => {
      expect(() => UserActivityController(null)).to.throw('Context required');
    });

    it('should throw error when context is empty object', () => {
      expect(() => UserActivityController({})).to.throw('Context required');
    });

    it('should throw error when dataAccess is not provided', () => {
      expect(() => UserActivityController({ someOtherProp: 'value' })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is null', () => {
      expect(() => UserActivityController({ dataAccess: null })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is empty object', () => {
      expect(() => UserActivityController({ dataAccess: {} })).to.throw('Data access required');
    });
  });

  describe('getBySiteID', () => {
    it('should return user activities for valid site ID', async () => {
      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await userActivityController.getBySiteID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.be.an('array');
      expect(body).to.have.length(2);
    });

    it('should return bad request for invalid UUID', async () => {
      const context = {
        params: { siteId: 'invalid-uuid' },
      };

      const result = await userActivityController.getBySiteID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Site ID required');
    });

    it('should return not found for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await userActivityController.getBySiteID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Site not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await userActivityController.getBySiteID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Access denied to this site');
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.TrialUserActivity.allBySiteId.rejects(dbError);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await userActivityController.getBySiteID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Database connection failed');
    });

    it('should return internal server error when access control check fails', async () => {
      const accessError = new Error('Access control error');
      mockAccessControlUtil.hasAccess.rejects(accessError);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await userActivityController.getBySiteID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Access control error');
    });

    it('should return internal server error when Site.findById fails', async () => {
      const siteError = new Error('Site lookup failed');
      mockDataAccess.Site.findById.rejects(siteError);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await userActivityController.getBySiteID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Site lookup failed');
    });
  });

  describe('createTrialUserActivity', () => {
    it('should create trial user activity for valid data', async () => {
      const context = {
        params: { siteId },
        data: { type: 'SIGN_IN', productCode: 'LLMO' },
        dataAccess: mockDataAccess,
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ trial_email: 'test@example.com' })
          .withAuthenticated(true),
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body).to.have.property('id');
      expect(body).to.have.property('type', 'SIGN_IN');
    });

    it('should return bad request for invalid site ID', async () => {
      const context = {
        params: { siteId: 'invalid-uuid' },
        data: { type: 'SIGN_IN', productCode: 'LLMO' },
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Site ID required');
    });

    it('should return bad request for missing activity data', async () => {
      const context = {
        params: { siteId },
        data: null,
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Activity data is required');
    });

    it('should return bad request for missing type', async () => {
      const context = {
        params: { siteId },
        data: { productCode: 'LLMO' },
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Valid activity type is required (SIGN_UP, SIGN_IN, CREATE_SITE, RUN_AUDIT, PROMPT_RUN, DOWNLOAD)');
    });

    it('should return bad request for invalid type', async () => {
      const context = {
        params: { siteId },
        data: { type: 'INVALID', productCode: 'LLMO' },
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Valid activity type is required (SIGN_UP, SIGN_IN, CREATE_SITE, RUN_AUDIT, PROMPT_RUN, DOWNLOAD)');
    });

    it('should return bad request for missing product code', async () => {
      const context = {
        params: { siteId },
        data: { type: 'SIGN_IN' },
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Valid product code is required (LLMO, ASO)');
    });

    it('should return bad request for invalid product code', async () => {
      const context = {
        params: { siteId },
        data: { type: 'SIGN_IN', productCode: 'INVALID' },
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Valid product code is required (LLMO, ASO)');
    });

    it('should return not found for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: { siteId },
        data: { type: 'SIGN_IN', productCode: 'LLMO' },
        dataAccess: mockDataAccess,
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ trial_email: 'test@example.com' })
          .withAuthenticated(true),
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Site not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: { siteId },
        data: { type: 'SIGN_IN', productCode: 'LLMO' },
        dataAccess: mockDataAccess,
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ trial_email: 'test@example.com' })
          .withAuthenticated(true),
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Access denied to this site');
    });

    it('should return bad request when user trial email not found', async () => {
      const context = {
        params: { siteId },
        data: { type: 'SIGN_IN', productCode: 'LLMO' },
        dataAccess: mockDataAccess,
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({})
          .withAuthenticated(true),
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('User\'s trial email not found');
    });

    it('should return bad request when trial user not found', async () => {
      mockDataAccess.TrialUser.findByEmailId.resolves(null);

      const context = {
        params: { siteId },
        data: { type: 'SIGN_IN', productCode: 'LLMO' },
        dataAccess: mockDataAccess,
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ trial_email: 'test@example.com' })
          .withAuthenticated(true),
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Trial user not found for the authenticated user');
    });

    it('should return bad request when entitlement not found', async () => {
      mockDataAccess.Entitlement.allByOrganizationIdAndProductCode.resolves([]);

      const context = {
        params: { siteId },
        data: { type: 'SIGN_IN', productCode: 'LLMO' },
        dataAccess: mockDataAccess,
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ trial_email: 'test@example.com' })
          .withAuthenticated(true),
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Entitlement not found for this organization and product code');
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.TrialUserActivity.create.rejects(dbError);

      const context = {
        params: { siteId },
        data: { type: 'SIGN_IN', productCode: 'LLMO' },
        dataAccess: mockDataAccess,
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ trial_email: 'test@example.com' })
          .withAuthenticated(true),
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Database connection failed');
    });

    it('should return internal server error when access control check fails', async () => {
      const accessError = new Error('Access control error');
      mockAccessControlUtil.hasAccess.rejects(accessError);

      const context = {
        params: { siteId },
        data: { type: 'SIGN_IN', productCode: 'LLMO' },
        dataAccess: mockDataAccess,
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ trial_email: 'test@example.com' })
          .withAuthenticated(true),
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Access control error');
    });

    it('should return internal server error when Site.findById fails', async () => {
      const siteError = new Error('Site lookup failed');
      mockDataAccess.Site.findById.rejects(siteError);

      const context = {
        params: { siteId },
        data: { type: 'SIGN_IN', productCode: 'LLMO' },
        dataAccess: mockDataAccess,
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ trial_email: 'test@example.com' })
          .withAuthenticated(true),
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Site lookup failed');
    });
  });
});
