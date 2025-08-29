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

  beforeEach(() => {
    sandbox.restore();

    // Create a mock AccessControlUtil instance that will be used by the controller
    const mockAccessControlUtilInstance = {
      hasAccess: sandbox.stub().resolves(true),
    };

    // Stub AccessControlUtil.fromContext to return our mock instance
    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtilInstance);

    trialUserController = TrialUserController({
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
      expect(body.message).to.equal('Trial user with this email already exists');
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
  });

  describe('sendEmailsToTrialUsers', () => {
    let TrialUserControllerWithMocks;
    let trialUserControllerWithMocks;
    let mockImsClient;
    let mockFetch;
    let mockFs;

    const validEmailAddresses = ['user1@example.com', 'user2@example.com'];
    const templateData = { first_name: 'John', aem_host: 'https://example.com' };
    const mockEmailTemplate = '<sendTemplateEmailReq><toList>{{emailAddresses}}</toList><templateData>{{templateData}}</templateData></sendTemplateEmailReq>';

    beforeEach(async () => {
      // Mock ImsClient
      mockImsClient = {
        createFrom: sandbox.stub(),
        getServiceAccessTokenV3: sandbox.stub().resolves('mock-access-token'),
      };

      // Mock fetch
      mockFetch = sandbox.stub().resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: sandbox.stub().resolves({ success: true }),
      });

      // Mock fs
      mockFs = {
        readFile: sandbox.stub().resolves(mockEmailTemplate),
      };

      // Create mocked controller
      TrialUserControllerWithMocks = await esmock('../../src/controllers/trial-users.js', {
        '@adobe/spacecat-shared-ims-client': { ImsClient: mockImsClient },
        fs: mockFs,
      }, {
        globals: { fetch: mockFetch },
      });

      // Mock ImsClient.createFrom to return an object with getServiceAccessTokenV3
      mockImsClient.createFrom.returns({
        getServiceAccessTokenV3: mockImsClient.getServiceAccessTokenV3,
      });

      // Create controller instance with mocks
      trialUserControllerWithMocks = TrialUserControllerWithMocks({
        dataAccess: mockDataAccess,
        env: {
          ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message',
        },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      });
    });

    it('should successfully send emails to trial users', async () => {
      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.equal('Successfully sent emails to all 2 trial users');
      expect(body.successCount).to.equal(2);
      expect(body.failureCount).to.equal(0);
      expect(body.totalCount).to.equal(2);
      expect(body.results).to.be.an('array').with.length(2);
      expect(body.results[0]).to.deep.include({ email: 'user1@example.com', status: 'success' });
      expect(body.results[1]).to.deep.include({ email: 'user2@example.com', status: 'success' });

      // Should call fetch twice (once per email address)
      expect(mockFetch).to.have.been.calledTwice;
      expect(mockLogger.info).to.have.been.calledWith('Successfully sent email to user1@example.com');
      expect(mockLogger.info).to.have.been.calledWith('Successfully sent email to user2@example.com');
      expect(mockLogger.info).to.have.been.calledWith(`Email sending completed for organization ${organizationId}: Successfully sent emails to all 2 trial users`);
    });

    it('should use default postoffice endpoint when env var not set', async () => {
      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: {}, // No ADOBE_POSTOFFICE_ENDPOINT set
      };

      await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      // Should be called twice (once per email address) with default endpoint
      expect(mockFetch).to.have.been.calledTwice;
      expect(mockFetch).to.have.been.calledWith(
        'https://postoffice.adobe.com/po-server/message?templateName=expdev_xwalk_trial_confirm&locale=en-us',
      );
    });

    it('should use custom postoffice endpoint when env var is set', async () => {
      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://custom-postoffice.adobe.com/po-server/message' },
      };

      await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      // Should be called twice (once per email address) with custom endpoint
      expect(mockFetch).to.have.been.calledTwice;
      expect(mockFetch).to.have.been.calledWith(
        'https://custom-postoffice.adobe.com/po-server/message?templateName=expdev_xwalk_trial_confirm&locale=en-us',
      );
    });

    it('should return bad request for invalid organization ID', async () => {
      const context = {
        params: { organizationId: 'invalid-uuid' },
        data: { emailAddresses: validEmailAddresses, templateData },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Organization ID required');
    });

    it('should return bad request when emailAddresses is not an array', async () => {
      const context = {
        params: { organizationId },
        data: { emailAddresses: 'not-an-array', templateData },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Email addresses array is required and cannot be empty');
    });

    it('should return bad request when emailAddresses is empty array', async () => {
      const context = {
        params: { organizationId },
        data: { emailAddresses: [], templateData },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Email addresses array is required and cannot be empty');
    });

    it('should return bad request when emailAddresses is missing', async () => {
      const context = {
        params: { organizationId },
        data: { templateData },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Email addresses array is required and cannot be empty');
    });

    it('should return bad request for invalid email address', async () => {
      const context = {
        params: { organizationId },
        data: { emailAddresses: ['valid@example.com', 'invalid-email'], templateData },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Invalid email address: invalid-email');
    });

    it('should work without templateData', async () => {
      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.equal('Successfully sent emails to all 2 trial users');
      expect(body.successCount).to.equal(2);
      expect(body.failureCount).to.equal(0);
      expect(body.totalCount).to.equal(2);
    });

    it('should return not found for non-existent organization', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Organization not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Access denied to this organization');
    });

    it('should return internal server error when IMS token generation fails', async () => {
      const imsError = new Error('IMS token generation failed');
      mockImsClient.getServiceAccessTokenV3.rejects(imsError);

      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('IMS token generation failed');
      expect(mockLogger.error).to.have.been.calledWith(`Error sending emails to trial users for organization ${organizationId}: ${imsError.message}`);
    });

    it('should handle partial email sending failures', async () => {
      // Mock fetch to succeed for first call, fail for second
      mockFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
      });
      mockFetch.onCall(1).resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.equal('Sent emails to 1 out of 2 trial users (1 failed)');
      expect(body.successCount).to.equal(1);
      expect(body.failureCount).to.equal(1);
      expect(body.totalCount).to.equal(2);
      expect(body.results).to.have.length(2);
      expect(body.results[0]).to.deep.include({ email: 'user1@example.com', status: 'success' });
      expect(body.results[1]).to.deep.include({ email: 'user2@example.com', status: 'failed' });

      expect(mockLogger.info).to.have.been.calledWith('Successfully sent email to user1@example.com');
      expect(mockLogger.error).to.have.been.calledWith('Failed to send email to user2@example.com: 500 Internal Server Error');
    });

    it('should return internal server error when all email sending fails', async () => {
      mockFetch.resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Failed to send any emails. All 2 attempts failed.');
      expect(mockLogger.error).to.have.been.calledWith('Failed to send email to user1@example.com: 500 Internal Server Error');
      expect(mockLogger.error).to.have.been.calledWith('Failed to send email to user2@example.com: 500 Internal Server Error');
      expect(mockLogger.error).to.have.been.calledWith(`Failed to send any emails for organization ${organizationId}`);
    });

    it('should return internal server error when fetch throws an error', async () => {
      const fetchError = new Error('Network error');
      mockFetch.rejects(fetchError);

      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Network error');
      expect(mockLogger.error).to.have.been.calledWith(`Error sending emails to trial users for organization ${organizationId}: ${fetchError.message}`);
    });

    it('should return internal server error when template file reading fails', async () => {
      const fsError = new Error('File not found');
      mockFs.readFile.rejects(fsError);

      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('File not found');
      expect(mockLogger.error).to.have.been.calledWith(`Error sending emails to trial users for organization ${organizationId}: ${fsError.message}`);
    });

    it('should return internal server error when Organization.findById fails', async () => {
      const orgError = new Error('Organization lookup failed');
      mockDataAccess.Organization.findById.rejects(orgError);

      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Organization lookup failed');
      expect(mockLogger.error).to.have.been.calledWith(`Error sending emails to trial users for organization ${organizationId}: ${orgError.message}`);
    });

    it('should return internal server error when access control check fails', async () => {
      const accessError = new Error('Access control error');
      mockAccessControlUtil.hasAccess.rejects(accessError);

      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Access control error');
      expect(mockLogger.error).to.have.been.calledWith(`Error sending emails to trial users for organization ${organizationId}: ${accessError.message}`);
    });

    it('should correctly build email payload with template data', async () => {
      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      // Verify that fetch was called twice (once per email address)
      expect(mockFetch).to.have.been.calledTwice;

      // Check first email
      const firstCall = mockFetch.getCall(0);
      const [firstUrl, firstOptions] = firstCall.args;

      expect(firstUrl).to.equal('https://test-postoffice.adobe.com/po-server/message?templateName=expdev_xwalk_trial_confirm&locale=en-us');
      expect(firstOptions.method).to.equal('POST');
      expect(firstOptions.headers).to.deep.include({
        Accept: 'application/xml',
        Authorization: 'IMS mock-access-token',
        'Content-Type': 'application/xml',
      });

      // Verify the first payload contains the first email address and template data
      const firstPayload = firstOptions.body;
      expect(firstPayload).to.include('user1@example.com');
      expect(firstPayload).to.not.include('user2@example.com');
      expect(firstPayload).to.include('<key>first_name</key>');
      expect(firstPayload).to.include('<value>John</value>');
      expect(firstPayload).to.include('<key>aem_host</key>');
      expect(firstPayload).to.include('<value>https://example.com</value>');

      // Check second email
      const secondCall = mockFetch.getCall(1);
      const secondPayload = secondCall.args[1].body;
      expect(secondPayload).to.include('user2@example.com');
      expect(secondPayload).to.not.include('user1@example.com');
    });

    it('should handle single email address correctly', async () => {
      const context = {
        params: { organizationId },
        data: { emailAddresses: ['single@example.com'], templateData: {} },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.equal('Successfully sent emails to all 1 trial users');
      expect(body.successCount).to.equal(1);
      expect(body.failureCount).to.equal(0);
      expect(body.totalCount).to.equal(1);
      expect(body.results).to.have.length(1);
      expect(body.results[0]).to.deep.include({ email: 'single@example.com', status: 'success' });

      // Should call fetch once for single email
      expect(mockFetch).to.have.been.calledOnce;
    });

    it('should handle empty template data correctly', async () => {
      const context = {
        params: { organizationId },
        data: { emailAddresses: validEmailAddresses, templateData: {} },
        log: mockLogger,
        env: { ADOBE_POSTOFFICE_ENDPOINT: 'https://test-postoffice.adobe.com/po-server/message' },
      };

      const result = await trialUserControllerWithMocks.sendEmailsToTrialUsers(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.equal('Successfully sent emails to all 2 trial users');
      expect(body.successCount).to.equal(2);
      expect(body.failureCount).to.equal(0);
      expect(body.totalCount).to.equal(2);

      // Verify that the payloads don't contain any template data
      expect(mockFetch).to.have.been.calledTwice;
      const firstPayload = mockFetch.getCall(0).args[1].body;
      const secondPayload = mockFetch.getCall(1).args[1].body;
      expect(firstPayload).to.not.include('<key>');
      expect(secondPayload).to.not.include('<key>');
    });
  });
});
