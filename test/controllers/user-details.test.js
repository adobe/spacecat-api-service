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

import UserDetailsController from '../../src/controllers/user-details.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('User Details Controller', () => {
  const sandbox = sinon.createSandbox();
  const organizationId = '123e4567-e89b-12d3-a456-426614174000';
  const externalUserId = 'ext-user-123@AdobeOrg';

  describe('Controller Initialization', () => {
    it('should throw error when context is missing', () => {
      expect(() => UserDetailsController()).to.throw('Context required');
    });

    it('should throw error when dataAccess is missing', () => {
      expect(() => UserDetailsController({
        imsClient: {},
        log: {},
      })).to.throw('Data access required');
    });
  });

  const mockOrganization = {
    getId: () => organizationId,
    getName: () => 'Test Organization',
  };

  const mockTrialUser = {
    getId: () => 'trial-user-1',
    getOrganizationId: () => organizationId,
    getExternalUserId: () => externalUserId,
    getEmailId: () => 'user1@example.com',
    getFirstName: () => 'John',
    getLastName: () => 'Doe',
  };

  const mockTrialUser2 = {
    getId: () => 'trial-user-2',
    getOrganizationId: () => organizationId,
    getExternalUserId: () => 'ext-user-456@AdobeOrg',
    getEmailId: () => 'user2@example.com',
    getFirstName: () => 'Jane',
    getLastName: () => 'Smith',
  };

  let mockDataAccess;
  let mockImsClient;
  let mockLog;
  let mockAccessControlUtil;
  let controller;
  let context;

  beforeEach(() => {
    mockDataAccess = {
      TrialUser: {
        allByOrganizationId: sandbox.stub().resolves([mockTrialUser, mockTrialUser2]),
      },
      Organization: {
        findById: sandbox.stub().resolves(mockOrganization),
      },
    };

    mockImsClient = {
      getImsAdminProfile: sandbox.stub().resolves({
        id: 'ims-user-123',
        email: 'imsuser@example.com',
        firstName: 'IMS',
        lastName: 'User',
      }),
    };

    mockLog = {
      info: sandbox.stub(),
      debug: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };

    mockAccessControlUtil = {
      hasAccess: sandbox.stub().resolves(true),
      hasAdminAccess: sandbox.stub().returns(true),
    };

    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtil);

    const ctx = {
      dataAccess: mockDataAccess,
      imsClient: mockImsClient,
      log: mockLog,
    };

    controller = UserDetailsController(ctx);

    context = {
      params: {},
      data: {},
      log: mockLog,
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getUserDetailsByExternalUserId', () => {
    it('should return bad request for invalid organization ID', async () => {
      context.params = {
        organizationId: 'invalid-uuid',
        externalUserId,
      };

      const result = await controller.getUserDetailsByExternalUserId(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Organization ID required');
    });

    it('should return bad request for missing external user ID', async () => {
      context.params = {
        organizationId,
        externalUserId: '',
      };

      const result = await controller.getUserDetailsByExternalUserId(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('External user ID is required');
    });

    it('should return not found when organization does not exist', async () => {
      context.params = { organizationId, externalUserId };
      mockDataAccess.Organization.findById.resolves(null);

      const result = await controller.getUserDetailsByExternalUserId(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Organization not found');
    });

    it('should return forbidden when user does not have access', async () => {
      context.params = { organizationId, externalUserId };
      mockAccessControlUtil.hasAccess.resolves(false);

      const result = await controller.getUserDetailsByExternalUserId(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Access denied to this organization');
    });

    it('should return user details when found in trial users', async () => {
      context.params = { organizationId, externalUserId };

      const result = await controller.getUserDetailsByExternalUserId(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({
        firstName: 'John',
        lastName: 'Doe',
        email: 'user1@example.com',
        organizationId,
      });
    });

    it('should fetch from IMS when user not found and requestor is admin', async () => {
      context.params = {
        organizationId,
        externalUserId: 'not-found-user@AdobeOrg',
      };
      mockAccessControlUtil.hasAdminAccess.returns(true);

      const result = await controller.getUserDetailsByExternalUserId(context);

      expect(result.status).to.equal(200);
      expect(mockImsClient.getImsAdminProfile).to.have.been.calledWith('not-found-user@AdobeOrg');
      const body = await result.json();
      expect(body).to.deep.equal({
        firstName: 'IMS',
        lastName: 'User',
        email: 'imsuser@example.com',
        organizationId,
      });
    });

    it('should return system defaults when IMS call fails for admin', async () => {
      context.params = {
        organizationId,
        externalUserId: 'not-found-user@AdobeOrg',
      };
      mockAccessControlUtil.hasAdminAccess.returns(true);
      mockImsClient.getImsAdminProfile.rejects(new Error('IMS error'));

      const result = await controller.getUserDetailsByExternalUserId(context);

      expect(result.status).to.equal(200);
      expect(mockLog.warn).to.have.been.called;
      const body = await result.json();
      expect(body).to.deep.equal({
        firstName: 'system',
        lastName: '',
        email: 'system',
        organizationId,
      });
    });

    it('should use fallback values when IMS returns incomplete profile', async () => {
      context.params = {
        organizationId,
        externalUserId: 'incomplete-user@AdobeOrg',
      };
      mockAccessControlUtil.hasAdminAccess.returns(true);
      mockImsClient.getImsAdminProfile.resolves({
        id: 'incomplete-user-123',
        // firstName, lastName, email are missing/null
      });

      const result = await controller.getUserDetailsByExternalUserId(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({
        firstName: 'system',
        lastName: '',
        email: 'system',
        organizationId,
      });
    });

    it('should return system defaults when user not found and requestor is not admin', async () => {
      context.params = {
        organizationId,
        externalUserId: 'not-found-user@AdobeOrg',
      };
      mockAccessControlUtil.hasAdminAccess.returns(false);

      const result = await controller.getUserDetailsByExternalUserId(context);

      expect(result.status).to.equal(200);
      expect(mockImsClient.getImsAdminProfile).to.not.have.been.called;
      const body = await result.json();
      expect(body).to.deep.equal({
        firstName: 'system',
        lastName: '',
        email: 'system',
        organizationId,
      });
    });

    it('should handle internal errors gracefully', async () => {
      context.params = { organizationId, externalUserId };
      mockDataAccess.TrialUser.allByOrganizationId.rejects(new Error('Database error'));

      const result = await controller.getUserDetailsByExternalUserId(context);

      expect(result.status).to.equal(500);
      expect(mockLog.error).to.have.been.called;
    });
  });

  describe('getUserDetailsInBulk', () => {
    it('should return bad request for invalid organization ID', async () => {
      context.params = { organizationId: 'invalid-uuid' };
      context.data = { userIds: [externalUserId] };

      const result = await controller.getUserDetailsInBulk(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Organization ID required');
    });

    it('should return bad request for missing userIds', async () => {
      context.params = { organizationId };
      context.data = {};

      const result = await controller.getUserDetailsInBulk(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('userIds array is required and must not be empty');
    });

    it('should return bad request for empty userIds array', async () => {
      context.params = { organizationId };
      context.data = { userIds: [] };

      const result = await controller.getUserDetailsInBulk(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('userIds array is required and must not be empty');
    });

    it('should return not found when organization does not exist', async () => {
      context.params = { organizationId };
      context.data = { userIds: [externalUserId] };
      mockDataAccess.Organization.findById.resolves(null);

      const result = await controller.getUserDetailsInBulk(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Organization not found');
    });

    it('should return forbidden when user does not have access', async () => {
      context.params = { organizationId };
      context.data = { userIds: [externalUserId] };
      mockAccessControlUtil.hasAccess.resolves(false);

      const result = await controller.getUserDetailsInBulk(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Access denied to this organization');
    });

    it('should return all users when found in trial users', async () => {
      context.params = { organizationId };
      context.data = { userIds: [externalUserId, 'ext-user-456@AdobeOrg'] };

      const result = await controller.getUserDetailsInBulk(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({
        [externalUserId]: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'user1@example.com',
          organizationId,
        },
        'ext-user-456@AdobeOrg': {
          firstName: 'Jane',
          lastName: 'Smith',
          email: 'user2@example.com',
          organizationId,
        },
      });
      expect(mockLog.info).to.not.have.been.called;
    });

    it('should fetch from IMS for missing users when requestor is admin', async () => {
      context.params = { organizationId };
      context.data = {
        userIds: [externalUserId, 'not-found-user@AdobeOrg'],
      };
      mockAccessControlUtil.hasAdminAccess.returns(true);

      const result = await controller.getUserDetailsInBulk(context);

      expect(result.status).to.equal(200);
      expect(mockImsClient.getImsAdminProfile).to.have.been.calledOnce;
      expect(mockLog.info).to.have.been.calledWith(
        'Fetched user details from IMS 1 times for organization 123e4567-e89b-12d3-a456-426614174000',
      );
      const body = await result.json();
      expect(body).to.have.property(externalUserId);
      expect(body).to.have.property('not-found-user@AdobeOrg');
      expect(body['not-found-user@AdobeOrg']).to.deep.equal({
        firstName: 'IMS',
        lastName: 'User',
        email: 'imsuser@example.com',
        organizationId,
      });
    });

    it('should return system defaults for missing users when requestor is not admin', async () => {
      context.params = { organizationId };
      context.data = {
        userIds: [externalUserId, 'not-found-user@AdobeOrg'],
      };
      mockAccessControlUtil.hasAdminAccess.returns(false);

      const result = await controller.getUserDetailsInBulk(context);

      expect(result.status).to.equal(200);
      expect(mockImsClient.getImsAdminProfile).to.not.have.been.called;
      expect(mockLog.info).to.have.been.calledWith(
        'Fetched user details from IMS 1 times for organization 123e4567-e89b-12d3-a456-426614174000',
      );
      const body = await result.json();
      expect(body['not-found-user@AdobeOrg']).to.deep.equal({
        firstName: 'system',
        lastName: '',
        email: 'system',
        organizationId,
      });
    });

    it('should handle IMS failures and return system defaults', async () => {
      context.params = { organizationId };
      context.data = {
        userIds: ['not-found-user-1@AdobeOrg', 'not-found-user-2@AdobeOrg'],
      };
      mockAccessControlUtil.hasAdminAccess.returns(true);
      mockImsClient.getImsAdminProfile.rejects(new Error('IMS error'));

      const result = await controller.getUserDetailsInBulk(context);

      expect(result.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledTwice;
      expect(mockLog.info).to.have.been.calledWith(
        'Fetched user details from IMS 2 times for organization 123e4567-e89b-12d3-a456-426614174000',
      );
      const body = await result.json();
      expect(body['not-found-user-1@AdobeOrg']).to.deep.equal({
        firstName: 'system',
        lastName: '',
        email: 'system',
        organizationId,
      });
    });

    it('should use fallback values when IMS returns incomplete profiles in bulk', async () => {
      context.params = { organizationId };
      context.data = {
        userIds: ['incomplete-user@AdobeOrg'],
      };
      mockAccessControlUtil.hasAdminAccess.returns(true);
      mockImsClient.getImsAdminProfile.resolves({
        id: 'incomplete-user-123',
        firstName: null,
        lastName: undefined,
        email: null,
      });

      const result = await controller.getUserDetailsInBulk(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body['incomplete-user@AdobeOrg']).to.deep.equal({
        firstName: 'system',
        lastName: '',
        email: 'system',
        organizationId,
      });
    });

    it('should handle internal errors gracefully', async () => {
      context.params = { organizationId };
      context.data = { userIds: [externalUserId] };
      mockDataAccess.TrialUser.allByOrganizationId.rejects(new Error('Database error'));

      const result = await controller.getUserDetailsInBulk(context);

      expect(result.status).to.equal(500);
      expect(mockLog.error).to.have.been.called;
    });
  });
});
