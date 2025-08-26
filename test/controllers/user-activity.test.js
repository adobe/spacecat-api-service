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
import esmock from 'esmock';

// import * as utils from '../../src/support/utils.js';
// import UserActivityController from '../../src/controllers/user-activity.js';

use(chaiAsPromised);
use(sinonChai);

describe('User Activity Controller', () => {
  const sandbox = sinon.createSandbox();
  const siteId = '123e4567-e89b-12d3-a456-426614174000';
  const organizationId = '456e7890-e89b-12d3-a456-426614174000';

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

  const mockUserActivity = {
    getId: () => 'activity-123',
    getType: () => 'RUN_AUDIT',
    getProductCode: () => 'LLMO',
  };

  const mockDataAccess = {
    Site: {
      findById: sandbox.stub().resolves(mockSite),
    },
    TrialUserActivity: {
      findBySiteId: sandbox.stub().resolves([mockUserActivity]),
    },
    TrialUserCollection: {
      findByEmailId: sandbox.stub().resolves(mockTrialUser),
    },
    EntitlementCollection: {
      allByOrganizationIdAndProductCode: sandbox.stub().resolves([mockEntitlement]),
    },
    TrialUserActivityCollection: {
      create: sandbox.stub().resolves(mockUserActivity),
    },
  };

  const mockAccessControlUtil = {
    hasAccess: sandbox.stub().resolves(true),
  };

  let userActivityController;

  beforeEach(() => {
    sandbox.restore();
    // Reset stubs
    mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);
    mockDataAccess.TrialUserActivity.findBySiteId = sandbox.stub().resolves([mockUserActivity]);
    mockDataAccess.TrialUserCollection.findByEmailId = sandbox.stub().resolves(mockTrialUser);
    mockDataAccess.EntitlementCollection.allByOrganizationIdAndProductCode = sandbox.stub()
      .resolves([mockEntitlement]);
    mockDataAccess.TrialUserActivityCollection.create = sandbox.stub().resolves(mockUserActivity);
    mockAccessControlUtil.hasAccess = sandbox.stub().resolves(true);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getBySiteID', () => {
    it('should return user activities for valid site ID', async () => {
      const context = {
        params: { siteId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      // Mock AccessControlUtil.fromContext
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedUserActivityController } = await esmock('../../src/controllers/user-activity.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedUserActivityController({ dataAccess: mockDataAccess });
      const result = await controller.getBySiteID(context);

      expect(result.statusCode).to.equal(200);
      expect(result.body).to.be.an('array');
      expect(result.body).to.have.length(1);
    });

    it('should return bad request for invalid UUID', async () => {
      const context = {
        params: { siteId: 'invalid-uuid' },
      };

      const result = await userActivityController.getBySiteID(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Site ID required');
    });

    it('should return not found for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: { siteId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await userActivityController.getBySiteID(context);

      expect(result.statusCode).to.equal(404);
      expect(result.body).to.equal('Site not found');
    });

    it('should return forbidden when user lacks access', async () => {
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns({
          hasAccess: sandbox.stub().resolves(false),
        }),
      };

      const { default: MockedUserActivityController } = await esmock('../../src/controllers/user-activity.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedUserActivityController({ dataAccess: mockDataAccess });
      const context = {
        params: { siteId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await controller.getBySiteID(context);

      expect(result.statusCode).to.equal(403);
      expect(result.body).to.equal('Access denied to this site');
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.TrialUserActivity.findBySiteId.rejects(dbError);

      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedUserActivityController } = await esmock('../../src/controllers/user-activity.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedUserActivityController({ dataAccess: mockDataAccess });
      const context = {
        params: { siteId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await controller.getBySiteID(context);

      expect(result.statusCode).to.equal(500);
      expect(result.body).to.equal('Database connection failed');
    });
  });

  describe('createTrialUserActivity', () => {
    const validActivityData = {
      type: 'RUN_AUDIT',
      productCode: 'LLMO',
      details: { test: 'data' },
    };

    it('should create trial user activity successfully', async () => {
      const context = {
        params: { siteId },
        data: validActivityData,
        authInfo: { getProfile: () => ({ trial_email: 'test@example.com' }) },
      };

      // Mock AccessControlUtil.fromContext
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedUserActivityController } = await esmock('../../src/controllers/user-activity.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedUserActivityController({ dataAccess: mockDataAccess });
      const result = await controller.createTrialUserActivity(context);

      expect(result.statusCode).to.equal(201);
      expect(result.body).to.be.an('object');
    });

    it('should return bad request for invalid UUID', async () => {
      const context = {
        params: { siteId: 'invalid-uuid' },
        data: validActivityData,
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Site ID required');
    });

    it('should return bad request for missing activity data', async () => {
      const context = {
        params: { siteId },
        data: null,
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Activity data is required');
    });

    it('should return bad request for invalid activity type', async () => {
      const invalidActivityData = {
        type: 'INVALID_TYPE',
        productCode: 'LLMO',
      };

      const context = {
        params: { siteId },
        data: invalidActivityData,
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.include('Valid activity type is required');
    });

    it('should return bad request for invalid product code', async () => {
      const invalidActivityData = {
        type: 'RUN_AUDIT',
        productCode: 'INVALID_PRODUCT',
      };

      const context = {
        params: { siteId },
        data: invalidActivityData,
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.include('Valid product code is required');
    });

    it('should return bad request for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: { siteId },
        data: validActivityData,
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Site not found');
    });

    it('should return bad request when user lacks access', async () => {
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns({
          hasAccess: sandbox.stub().resolves(false),
        }),
      };

      const { default: MockedUserActivityController } = await esmock('../../src/controllers/user-activity.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedUserActivityController({ dataAccess: mockDataAccess });
      const context = {
        params: { siteId },
        data: validActivityData,
      };

      const result = await controller.createTrialUserActivity(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Access denied to this site');
    });

    it('should return bad request when user not authenticated', async () => {
      const context = {
        params: { siteId },
        data: validActivityData,
        authInfo: { getProfile: () => ({}) },
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('User not authenticated');
    });

    it('should return bad request when trial user not found', async () => {
      mockDataAccess.TrialUserCollection.findByEmailId.resolves(null);

      const context = {
        params: { siteId },
        data: validActivityData,
        authInfo: { getProfile: () => ({ trial_email: 'test@example.com' }) },
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Trial user not found for the authenticated user');
    });

    it('should return bad request when entitlement not found', async () => {
      mockDataAccess.EntitlementCollection.allByOrganizationIdAndProductCode.resolves([]);

      const context = {
        params: { siteId },
        data: validActivityData,
        authInfo: { getProfile: () => ({ trial_email: 'test@example.com' }) },
      };

      const result = await userActivityController.createTrialUserActivity(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Entitlement not found for this organization and product code');
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.TrialUserActivityCollection.create.rejects(dbError);

      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedUserActivityController } = await esmock('../../src/controllers/user-activity.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedUserActivityController({ dataAccess: mockDataAccess });
      const context = {
        params: { siteId },
        data: validActivityData,
        authInfo: { getProfile: () => ({ trial_email: 'test@example.com' }) },
      };

      const result = await controller.createTrialUserActivity(context);

      expect(result.statusCode).to.equal(500);
      expect(result.body).to.equal('Database connection failed');
    });
  });
});
