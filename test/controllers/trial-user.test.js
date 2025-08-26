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
// import TrialUserController from '../../src/controllers/trial-user.js';

use(chaiAsPromised);
use(sinonChai);

describe('Trial User Controller', () => {
  const sandbox = sinon.createSandbox();
  const organizationId = '123e4567-e89b-12d3-a456-426614174000';

  const mockOrganization = {
    getId: () => organizationId,
    getName: () => 'Test Organization',
  };

  const mockTrialUsers = [
    {
      getId: () => 'trial-user-1',
      getEmailId: () => 'user1@example.com',
      getStatus: () => 'ACTIVE',
    },
    {
      getId: () => 'trial-user-2',
      getEmailId: () => 'user2@example.com',
      getStatus: () => 'INVITED',
    },
  ];

  const mockTrialUser = {
    getId: () => 'trial-user-new',
    getEmailId: () => 'newuser@example.com',
    getStatus: () => 'INVITED',
  };

  const mockDataAccess = {
    Organization: {
      findById: sandbox.stub().resolves(mockOrganization),
    },
    TrialUser: {
      allByOrganizationId: sandbox.stub().resolves(mockTrialUsers),
    },
    TrialUserCollection: {
      findByEmailId: sandbox.stub().resolves(null),
      create: sandbox.stub().resolves(mockTrialUser),
    },
  };

  const mockAccessControlUtil = {
    hasAccess: sandbox.stub().resolves(true),
  };

  let trialUserController;

  beforeEach(() => {
    sandbox.restore();
    // Reset stubs
    mockDataAccess.Organization.findById = sandbox.stub().resolves(mockOrganization);
    mockDataAccess.TrialUser.allByOrganizationId = sandbox.stub().resolves(mockTrialUsers);
    mockDataAccess.TrialUserCollection.findByEmailId = sandbox.stub().resolves(null);
    mockDataAccess.TrialUserCollection.create = sandbox.stub().resolves(mockTrialUser);
    mockAccessControlUtil.hasAccess = sandbox.stub().resolves(true);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getByOrganizationID', () => {
    it('should return trial users for valid organization ID', async () => {
      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      // Mock AccessControlUtil.fromContext
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedTrialUserController } = await esmock('../../src/controllers/trial-user.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedTrialUserController({ dataAccess: mockDataAccess });
      const result = await controller.getByOrganizationID(context);

      expect(result.statusCode).to.equal(200);
      expect(result.body).to.be.an('array');
      expect(result.body).to.have.length(2);
    });

    it('should return bad request for invalid UUID', async () => {
      const context = {
        params: { organizationId: 'invalid-uuid' },
      };

      const result = await trialUserController.getByOrganizationID(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Organization ID required');
    });

    it('should return not found for non-existent organization', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await trialUserController.getByOrganizationID(context);

      expect(result.statusCode).to.equal(404);
      expect(result.body).to.equal('Organization not found');
    });

    it('should return forbidden when user lacks access', async () => {
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns({
          hasAccess: sandbox.stub().resolves(false),
        }),
      };

      const { default: MockedTrialUserController } = await esmock('../../src/controllers/trial-user.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedTrialUserController({ dataAccess: mockDataAccess });
      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await controller.getByOrganizationID(context);

      expect(result.statusCode).to.equal(403);
      expect(result.body).to.equal('Access denied to this organization');
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.TrialUser.allByOrganizationId.rejects(dbError);

      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedTrialUserController } = await esmock('../../src/controllers/trial-user.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedTrialUserController({ dataAccess: mockDataAccess });
      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await controller.getByOrganizationID(context);

      expect(result.statusCode).to.equal(500);
      expect(result.body).to.equal('Database connection failed');
    });

    it('should return internal server error when access control check fails', async () => {
      const accessError = new Error('Access control error');
      mockAccessControlUtil.hasAccess.rejects(accessError);

      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedTrialUserController } = await esmock('../../src/controllers/trial-user.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedTrialUserController({ dataAccess: mockDataAccess });
      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await controller.getByOrganizationID(context);

      expect(result.statusCode).to.equal(500);
      expect(result.body).to.equal('Access control error');
    });
  });

  describe('createTrialUserInvite', () => {
    const validEmailId = 'newuser@example.com';

    it('should create trial user invite successfully', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: validEmailId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      // Mock AccessControlUtil.fromContext
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedTrialUserController } = await esmock('../../src/controllers/trial-user.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedTrialUserController({ dataAccess: mockDataAccess });
      const result = await controller.createTrialUserInvite(context);

      expect(result.statusCode).to.equal(201);
      expect(result.body).to.be.an('object');
    });

    it('should return bad request for invalid UUID', async () => {
      const context = {
        params: { organizationId: 'invalid-uuid' },
        data: { emailId: validEmailId },
      };

      const result = await trialUserController.createTrialUserInvite(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Organization ID required');
    });

    it('should return bad request for missing email ID', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: '' },
      };

      const result = await trialUserController.createTrialUserInvite(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Email ID is required');
    });

    it('should return bad request for null email ID', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: null },
      };

      const result = await trialUserController.createTrialUserInvite(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Email ID is required');
    });

    it('should return not found for non-existent organization', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        params: { organizationId },
        data: { emailId: validEmailId },
      };

      const result = await trialUserController.createTrialUserInvite(context);

      expect(result.statusCode).to.equal(404);
      expect(result.body).to.equal('Organization not found');
    });

    it('should return forbidden when user lacks access', async () => {
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns({
          hasAccess: sandbox.stub().resolves(false),
        }),
      };

      const { default: MockedTrialUserController } = await esmock('../../src/controllers/trial-user.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedTrialUserController({ dataAccess: mockDataAccess });
      const context = {
        params: { organizationId },
        data: { emailId: validEmailId },
      };

      const result = await controller.createTrialUserInvite(context);

      expect(result.statusCode).to.equal(403);
      expect(result.body).to.equal('Access denied to this organization');
    });

    it('should return bad request when trial user already exists', async () => {
      mockDataAccess.TrialUserCollection.findByEmailId.resolves(mockTrialUser);

      const context = {
        params: { organizationId },
        data: { emailId: validEmailId },
      };

      const result = await trialUserController.createTrialUserInvite(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Trial user with this email already exists');
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.TrialUserCollection.create.rejects(dbError);

      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedTrialUserController } = await esmock('../../src/controllers/trial-user.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedTrialUserController({ dataAccess: mockDataAccess });
      const context = {
        params: { organizationId },
        data: { emailId: validEmailId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await controller.createTrialUserInvite(context);

      expect(result.statusCode).to.equal(500);
      expect(result.body).to.equal('Database connection failed');
    });
  });
});
