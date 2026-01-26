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

import esmock from 'esmock';
import TrialUserController from '../../src/controllers/trial-users.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Trial User Controller', () => {
  const sandbox = sinon.createSandbox();
  const organizationId = '123e4567-e89b-12d3-a456-426614174000';

  const mockOrganization = {
    getId: () => organizationId,
    getName: () => 'Test Organization',
  };

  // Define constants for test data
  const TRIAL_USER_STATUS_INVITED = 'INVITED';

  const mockTrialUsers = [
    {
      getId: () => 'trial-user-1',
      getOrganizationId: () => organizationId,
      getExternalUserId: () => 'ext-user-1',
      getStatus: () => 'ACTIVE',
      getProvider: () => 'GOOGLE',
      getLastSeenAt: () => '2023-01-01T00:00:00Z',
      getEmailId: () => 'user1@example.com',
      getFirstName: () => 'John',
      getLastName: () => 'Doe',
      getMetadata: () => ({ origin: TRIAL_USER_STATUS_INVITED }),
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedBy: () => 'user1@example.com',
    },
    {
      getId: () => 'trial-user-2',
      getOrganizationId: () => organizationId,
      getExternalUserId: () => 'ext-user-2',
      getStatus: () => 'INVITED',
      getProvider: () => 'GOOGLE',
      getLastSeenAt: () => '2023-01-01T00:00:00Z',
      getEmailId: () => 'user2@example.com',
      getFirstName: () => 'Jane',
      getLastName: () => 'Smith',
      getMetadata: () => ({ origin: TRIAL_USER_STATUS_INVITED }),
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedBy: () => 'user2@example.com',
    },
  ];

  const mockTrialUser = {
    getId: () => 'trial-user-123',
    getOrganizationId: () => organizationId,
    getExternalUserId: () => 'ext-user-123',
    getStatus: () => 'ACTIVE',
    getProvider: () => 'GOOGLE',
    getLastSeenAt: () => '2023-01-01T00:00:00Z',
    getEmailId: () => 'test@example.com',
    getFirstName: () => 'Test',
    getLastName: () => 'User',
    getMetadata: () => ({ origin: TRIAL_USER_STATUS_INVITED }),
    getCreatedAt: () => '2023-01-01T00:00:00Z',
    getUpdatedAt: () => '2023-01-01T00:00:00Z',
    getUpdatedBy: () => 'test@example.com',
  };

  const mockDataAccess = {
    TrialUser: {
      findById: sandbox.stub().resolves(mockTrialUser),
      allByOrganizationId: sandbox.stub().resolves(mockTrialUsers),
      findByEmailId: sandbox.stub().resolves(null),
      create: sandbox.stub().resolves(mockTrialUser),
      STATUSES: {
        INVITED: 'INVITED',
      },
    },
    Organization: {
      findById: sandbox.stub().resolves(mockOrganization),
    },
  };

  const mockAccessControlUtil = {
    hasAccess: sandbox.stub().resolves(true),
  };

  const mockLogger = {
    error: sandbox.stub(),
    info: sandbox.stub(),
    debug: sandbox.stub(),
    warn: sandbox.stub(),
  };

  let trialUserController;
  let mockSendTrialUserInviteEmail;

  beforeEach(async () => {
    sandbox.restore();

    // Create a mock AccessControlUtil instance that will be used by the controller
    const mockAccessControlUtilInstance = {
      hasAccess: sandbox.stub().resolves(true),
    };

    // Stub AccessControlUtil.fromContext to return our mock instance
    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtilInstance);

    // Mock IMS client
    const mockImsClient = {
      createFrom: sandbox.stub().returns({
        getServiceAccessToken: sandbox.stub().resolves({ access_token: 'mock-access-token' }),
      }),
    };

    // Mock fetch globally
    global.fetch = sandbox.stub().resolves({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: sandbox.stub().resolves({ success: true }),
    });

    // Create mock for email service
    mockSendTrialUserInviteEmail = sandbox.stub().resolves({ success: true });

    // Create mocked controller with all necessary mocks
    const MockedTrialUserController = await esmock('../../src/controllers/trial-users.js', {
      '@adobe/spacecat-shared-ims-client': { ImsClient: mockImsClient },
      '../../src/support/access-control-util.js': {
        default: {
          fromContext: () => mockAccessControlUtilInstance,
        },
      },
      '../../src/support/email-service.js': {
        sendTrialUserInviteEmail: mockSendTrialUserInviteEmail,
      },
    });

    trialUserController = MockedTrialUserController({
      dataAccess: mockDataAccess,
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    });

    // Reset stubs
    mockDataAccess.TrialUser.findById = sandbox.stub().resolves(mockTrialUser);
    mockDataAccess.TrialUser.allByOrganizationId = sandbox.stub().resolves(mockTrialUsers);
    mockDataAccess.TrialUser.findByOrganizationId = sandbox
      .stub()
      .resolves(mockTrialUsers);
    mockDataAccess.Organization.findById = sandbox.stub().resolves(mockOrganization);

    // Store reference to the mock instance for test manipulation
    mockAccessControlUtil.hasAccess = mockAccessControlUtilInstance.hasAccess;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Constructor Validation', () => {
    it('should throw error when context is not provided', () => {
      expect(() => TrialUserController()).to.throw('Context required');
    });

    it('should throw error when context is null', () => {
      expect(() => TrialUserController(null)).to.throw('Context required');
    });

    it('should throw error when context is undefined', () => {
      expect(() => TrialUserController(undefined)).to.throw('Context required');
    });

    it('should throw error when context is not an object', () => {
      expect(() => TrialUserController('not-an-object')).to.throw('Context required');
    });

    it('should throw error when context is an empty object', () => {
      expect(() => TrialUserController({})).to.throw('Context required');
    });

    it('should throw error when dataAccess is missing from context', () => {
      expect(() => TrialUserController({ someOtherProperty: 'value' })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is null', () => {
      expect(() => TrialUserController({ dataAccess: null })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is undefined', () => {
      expect(() => TrialUserController({ dataAccess: undefined })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is not an object', () => {
      expect(() => TrialUserController({ dataAccess: 'not-an-object' })).to.throw('Data access required');
    });
  });

  describe('getByOrganizationID', () => {
    it('should return trial users for valid organization ID', async () => {
      const context = {
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getByOrganizationID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.be.an('array');
      expect(body).to.have.length(2);
    });

    it('should return bad request for invalid UUID', async () => {
      const context = {
        params: { organizationId: 'invalid-uuid' },
      };

      const result = await trialUserController.getByOrganizationID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Organization ID required');
    });

    it('should return not found for non-existent organization', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getByOrganizationID(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Organization not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getByOrganizationID(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Access denied to this organization');
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.TrialUser.allByOrganizationId.rejects(dbError);

      const context = {
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getByOrganizationID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Database connection failed');
      expect(mockLogger.error).to.have.been.calledWith(`Error getting trial users for organization ${organizationId}: ${dbError.message}`);
    });

    it('should return internal server error when access control check fails', async () => {
      const accessError = new Error('Access control error');
      mockAccessControlUtil.hasAccess.rejects(accessError);

      const context = {
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getByOrganizationID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Access control error');
      expect(mockLogger.error).to.have.been.calledWith(`Error getting trial users for organization ${organizationId}: ${accessError.message}`);
    });

    it('should return internal server error when Organization.findById fails', async () => {
      const orgError = new Error('Organization lookup failed');
      mockDataAccess.Organization.findById.rejects(orgError);

      const context = {
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getByOrganizationID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Organization lookup failed');
      expect(mockLogger.error).to.have.been.calledWith(`Error getting trial users for organization ${organizationId}: ${orgError.message}`);
    });
  });

  describe('createTrialUserForEmailInvite', () => {
    it('should create trial user invite for valid data', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: 'newuser@example.com' },
        dataAccess: mockDataAccess,
        log: mockLogger,
        env: {
          EMAIL_IMS_CLIENT_ID: 'test-client-id',
          EMAIL_IMS_CLIENT_SECRET: 'test-client-secret',
          EMAIL_IMS_CLIENT_CODE: 'test-client-code',
          EMAIL_IMS_SCOPE: 'test-scope',
          ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message',
          EMAIL_LLMO_TEMPLATE: 'expdev_xwalk_trial_confirm',
        },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      // Mock the create method to return a trial user with the passed data
      const createdTrialUser = {
        ...mockTrialUser,
        getEmailId: () => 'newuser@example.com',
      };
      mockDataAccess.TrialUser.create.resolves(createdTrialUser);

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body).to.have.property('id');
      expect(body).to.have.property('emailId', 'newuser@example.com');
    });

    it('should return bad request for invalid organization ID', async () => {
      const context = {
        params: { organizationId: 'invalid-uuid' },
        data: { emailId: 'newuser@example.com' },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Organization ID required');
    });

    it('should return bad request for missing email ID', async () => {
      const context = {
        params: { organizationId },
        data: {},
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Email ID is required');
    });

    it('should return bad request for empty email ID', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: '' },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Email ID is required');
    });

    it('should return bad request for invalid email format', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: 'invalid-email' },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Valid email address is required');
    });

    it('should return bad request for email missing @ symbol', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: 'user.example.com' },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Valid email address is required');
    });

    it('should return bad request for email missing domain', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: 'user@' },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Valid email address is required');
    });

    it('should return bad request for email missing TLD', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: 'user@example' },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Valid email address is required');
    });

    it('should return bad request for email with spaces', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: 'user name@example.com' },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Valid email address is required');
    });

    it('should accept valid email with subdomain', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: 'user@sub.example.com' },
        dataAccess: mockDataAccess,
        log: mockLogger,
        env: {
          EMAIL_IMS_CLIENT_ID: 'test-client-id',
          EMAIL_IMS_CLIENT_SECRET: 'test-client-secret',
          EMAIL_IMS_CLIENT_CODE: 'test-client-code',
          EMAIL_IMS_SCOPE: 'test-scope',
          ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message',
          EMAIL_LLMO_TEMPLATE: 'expdev_xwalk_trial_confirm',
        },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      // Mock the create method to return a trial user with the passed email
      const createdTrialUser = {
        ...mockTrialUser,
        getEmailId: () => 'user@sub.example.com',
      };
      mockDataAccess.TrialUser.create.resolves(createdTrialUser);

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body).to.have.property('id');
      expect(body).to.have.property('emailId', 'user@sub.example.com');
    });

    it('should accept valid email with plus addressing', async () => {
      const context = {
        params: { organizationId },
        data: { emailId: 'user+tag@example.com' },
        dataAccess: mockDataAccess,
        log: mockLogger,
        env: {
          EMAIL_IMS_CLIENT_ID: 'test-client-id',
          EMAIL_IMS_CLIENT_SECRET: 'test-client-secret',
          EMAIL_IMS_CLIENT_CODE: 'test-client-code',
          EMAIL_IMS_SCOPE: 'test-scope',
          ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message',
          EMAIL_LLMO_TEMPLATE: 'expdev_xwalk_trial_confirm',
        },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      // Mock the create method to return a trial user with the passed email
      const createdTrialUser = {
        ...mockTrialUser,
        getEmailId: () => 'user+tag@example.com',
      };
      mockDataAccess.TrialUser.create.resolves(createdTrialUser);

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body).to.have.property('id');
      expect(body).to.have.property('emailId', 'user+tag@example.com');
    });

    it('should return not found for non-existent organization', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        params: { organizationId },
        data: { emailId: 'newuser@example.com' },
        dataAccess: mockDataAccess,
        log: mockLogger,
        env: {},
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Organization not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: { organizationId },
        data: { emailId: 'newuser@example.com' },
        dataAccess: mockDataAccess,
        log: mockLogger,
        env: {},
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Access denied to this organization');
    });

    it('should return conflict when trial user already exists', async () => {
      mockDataAccess.TrialUser.findByEmailId.resolves(mockTrialUser);

      const context = {
        params: { organizationId },
        data: { emailId: 'existing@example.com' },
        dataAccess: mockDataAccess,
        log: mockLogger,
        env: {},
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(409);
      const body = await result.json();
      expect(body.message).to.equal(`Trial user with this email already exists ${mockTrialUser.getId()}`);
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.TrialUser.create.rejects(dbError);
      // Ensure findByEmailId returns null for this test
      mockDataAccess.TrialUser.findByEmailId.resolves(null);

      const context = {
        params: { organizationId },
        data: { emailId: 'newuser@example.com' },
        dataAccess: mockDataAccess,
        log: mockLogger,
        env: {},
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Database connection failed');
      expect(mockLogger.error).to.have.been.calledWith(`Error creating trial user invite for organization ${organizationId}: ${dbError.message}`);
    });

    it('should return internal server error when access control check fails', async () => {
      const accessError = new Error('Access control error');
      mockAccessControlUtil.hasAccess.rejects(accessError);

      const context = {
        params: { organizationId },
        data: { emailId: 'newuser@example.com' },
        dataAccess: mockDataAccess,
        log: mockLogger,
        env: {},
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Access control error');
      expect(mockLogger.error).to.have.been.calledWith(`Error creating trial user invite for organization ${organizationId}: ${accessError.message}`);
    });

    it('should return internal server error when Organization.findById fails', async () => {
      const orgError = new Error('Organization lookup failed');
      mockDataAccess.Organization.findById.rejects(orgError);

      const context = {
        params: { organizationId },
        data: { emailId: 'newuser@example.com' },
        dataAccess: mockDataAccess,
        log: mockLogger,
        env: {},
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Organization lookup failed');
      expect(mockLogger.error).to.have.been.calledWith(`Error creating trial user invite for organization ${organizationId}: ${orgError.message}`);
    });

    it('should return bad request when email sending fails', async () => {
      // Mock email service to return failure
      mockSendTrialUserInviteEmail.resolves({ success: false, error: 'Email service error' });

      const context = {
        params: { organizationId },
        data: { emailId: 'newuser@example.com' },
        dataAccess: mockDataAccess,
        log: mockLogger,
        env: {
          EMAIL_IMS_CLIENT_ID: 'test-client-id',
          EMAIL_IMS_CLIENT_SECRET: 'test-client-secret',
          EMAIL_IMS_CLIENT_CODE: 'test-client-code',
          EMAIL_IMS_SCOPE: 'test-scope',
          ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message',
          EMAIL_LLMO_TEMPLATE: 'expdev_xwalk_trial_confirm',
        },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.createTrialUserForEmailInvite(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('An error occurred while sending email to the user');
    });
  });

  describe('getEmailPreferences', () => {
    it('should return email preferences for authenticated user', async () => {
      const mockTrialUserWithPrefs = {
        ...mockTrialUser,
        getMetadata: () => ({ emailPreferences: { weeklyDigest: false } }),
      };
      mockDataAccess.TrialUser.findByEmailId.resolves(mockTrialUserWithPrefs);

      const context = {
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ trial_email: 'test@example.com' })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getEmailPreferences(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.emailPreferences).to.deep.equal({ weeklyDigest: false });
    });

    it('should return default preferences when metadata is empty', async () => {
      const mockTrialUserNoPrefs = {
        ...mockTrialUser,
        getMetadata: () => ({}),
      };
      mockDataAccess.TrialUser.findByEmailId.resolves(mockTrialUserNoPrefs);

      const context = {
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ trial_email: 'test@example.com' })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getEmailPreferences(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.emailPreferences).to.deep.equal({ weeklyDigest: true });
    });

    it('should return unauthorized when user email cannot be determined', async () => {
      const context = {
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({})
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getEmailPreferences(context);

      expect(result.status).to.equal(401);
      const body = await result.json();
      expect(body.message).to.equal('Unable to identify current user');
    });

    it('should return unauthorized when authInfo is missing', async () => {
      const context = {
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {},
      };

      const result = await trialUserController.getEmailPreferences(context);

      expect(result.status).to.equal(401);
    });

    it('should return unauthorized when profile is null', async () => {
      const context = {
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: {
            getProfile: () => null,
          },
        },
      };

      const result = await trialUserController.getEmailPreferences(context);

      expect(result.status).to.equal(401);
    });

    it('should handle missing/empty metadata gracefully', async () => {
      // Test null metadata
      const mockTrialUserNullMeta = {
        ...mockTrialUser,
        getMetadata: () => null,
      };
      mockDataAccess.TrialUser.findByEmailId.resolves(mockTrialUserNullMeta);

      const context = {
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ trial_email: 'test@example.com' })
            .withAuthenticated(true),
        },
      };

      let result = await trialUserController.getEmailPreferences(context);
      expect(result.status).to.equal(200);
      let body = await result.json();
      expect(body.emailPreferences.weeklyDigest).to.equal(true);

      // Test metadata without emailPreferences
      const mockTrialUserNoEmailPrefs = {
        ...mockTrialUser,
        getMetadata: () => ({ someOther: 'data' }),
      };
      mockDataAccess.TrialUser.findByEmailId.resolves(mockTrialUserNoEmailPrefs);

      result = await trialUserController.getEmailPreferences(context);
      expect(result.status).to.equal(200);
      body = await result.json();
      expect(body.emailPreferences.weeklyDigest).to.equal(true);
    });

    it('should return not found when user does not exist', async () => {
      mockDataAccess.TrialUser.findByEmailId.resolves(null);

      const context = {
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ trial_email: 'nonexistent@example.com' })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getEmailPreferences(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('User not found');
    });

    it('should return internal server error on database failure', async () => {
      const dbError = new Error('Database error');
      mockDataAccess.TrialUser.findByEmailId.rejects(dbError);

      const context = {
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ trial_email: 'test@example.com' })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getEmailPreferences(context);

      expect(result.status).to.equal(500);
    });

    it('should use email profile field when trial_email is not available', async () => {
      mockDataAccess.TrialUser.findByEmailId.resolves(mockTrialUser);

      const context = {
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ email: 'fallback@example.com' })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.getEmailPreferences(context);

      expect(result.status).to.equal(200);
      expect(mockDataAccess.TrialUser.findByEmailId).to.have.been.calledWith('fallback@example.com');
    });
  });

  describe('updateEmailPreferences', () => {
    it('should update email preferences successfully', async () => {
      const savedMetadata = {};
      const mockTrialUserForUpdate = {
        ...mockTrialUser,
        getMetadata: () => savedMetadata,
        setMetadata: (meta) => { Object.assign(savedMetadata, meta); },
        save: sandbox.stub().resolves(),
      };
      mockDataAccess.TrialUser.findByEmailId.resolves(mockTrialUserForUpdate);

      const context = {
        data: { weeklyDigest: false },
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ trial_email: 'test@example.com' })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.updateEmailPreferences(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.emailPreferences.weeklyDigest).to.equal(false);
      expect(mockTrialUserForUpdate.save).to.have.been.called;
    });

    it('should return bad request for non-boolean weeklyDigest', async () => {
      const context = {
        data: { weeklyDigest: 'not-a-boolean' },
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ trial_email: 'test@example.com' })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.updateEmailPreferences(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('weeklyDigest must be a boolean value');
    });

    it('should return bad request when weeklyDigest is missing', async () => {
      const context = {
        data: {},
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ trial_email: 'test@example.com' })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.updateEmailPreferences(context);

      expect(result.status).to.equal(400);
    });

    it('should return unauthorized when user email cannot be determined', async () => {
      const context = {
        data: { weeklyDigest: true },
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({})
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.updateEmailPreferences(context);

      expect(result.status).to.equal(401);
    });

    it('should return not found when user does not exist', async () => {
      mockDataAccess.TrialUser.findByEmailId.resolves(null);

      const context = {
        data: { weeklyDigest: true },
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ trial_email: 'nonexistent@example.com' })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.updateEmailPreferences(context);

      expect(result.status).to.equal(404);
    });

    it('should return internal server error on save failure', async () => {
      const saveError = new Error('Save failed');
      const mockTrialUserForUpdate = {
        ...mockTrialUser,
        getMetadata: () => ({}),
        setMetadata: sandbox.stub(),
        save: sandbox.stub().rejects(saveError),
      };
      mockDataAccess.TrialUser.findByEmailId.resolves(mockTrialUserForUpdate);

      const context = {
        data: { weeklyDigest: true },
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ trial_email: 'test@example.com' })
            .withAuthenticated(true),
        },
      };

      const result = await trialUserController.updateEmailPreferences(context);

      expect(result.status).to.equal(500);
    });

    it('should handle various metadata states when updating', async () => {
      const baseContext = {
        dataAccess: mockDataAccess,
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withType('ims')
            .withProfile({ trial_email: 'test@example.com' })
            .withAuthenticated(true),
        },
      };

      // Test preserving existing preferences
      const existingMetadata = {
        emailPreferences: { otherPref: true },
        otherData: 'value',
      };
      const mockTrialUserWithPrefs = {
        ...mockTrialUser,
        getMetadata: () => existingMetadata,
        setMetadata: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };
      mockDataAccess.TrialUser.findByEmailId.resolves(mockTrialUserWithPrefs);

      await trialUserController.updateEmailPreferences({
        ...baseContext,
        data: { weeklyDigest: false },
      });
      expect(mockTrialUserWithPrefs.setMetadata).to.have.been.calledWith({
        emailPreferences: { otherPref: true, weeklyDigest: false },
        otherData: 'value',
      });

      // Test null metadata
      const mockTrialUserNullMeta = {
        ...mockTrialUser,
        getMetadata: () => null,
        setMetadata: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };
      mockDataAccess.TrialUser.findByEmailId.resolves(mockTrialUserNullMeta);

      let result = await trialUserController.updateEmailPreferences({
        ...baseContext,
        data: { weeklyDigest: false },
      });
      expect(result.status).to.equal(200);
      expect(mockTrialUserNullMeta.setMetadata).to.have.been.calledWith({
        emailPreferences: { weeklyDigest: false },
      });

      // Test metadata without emailPreferences
      const mockTrialUserNoEmailPrefs = {
        ...mockTrialUser,
        getMetadata: () => ({ someOther: 'data' }),
        setMetadata: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };
      mockDataAccess.TrialUser.findByEmailId.resolves(mockTrialUserNoEmailPrefs);

      result = await trialUserController.updateEmailPreferences({
        ...baseContext,
        data: { weeklyDigest: true },
      });
      expect(result.status).to.equal(200);
    });
  });
});
