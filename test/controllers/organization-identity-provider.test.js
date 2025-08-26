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
// import OrganizationIdentityProviderController from
// '../../src/controllers/organization-identity-provider.js';

use(chaiAsPromised);
use(sinonChai);

describe('Organization Identity Provider Controller', () => {
  const sandbox = sinon.createSandbox();
  const organizationId = '123e4567-e89b-12d3-a456-426614174000';

  const mockOrganization = {
    getId: () => organizationId,
    getName: () => 'Test Organization',
  };

  const mockIdentityProviders = [
    {
      getId: () => 'provider-1',
      getOrganizationId: () => organizationId,
      getType: () => 'GOOGLE',
      getStatus: () => 'ACTIVE',
    },
    {
      getId: () => 'provider-2',
      getOrganizationId: () => organizationId,
      getType: () => 'MICROSOFT',
      getStatus: () => 'PENDING',
    },
  ];

  const mockDataAccess = {
    Organization: {
      findById: sandbox.stub().resolves(mockOrganization),
    },
    OrganizationIdentityProvider: {
      allByOrganizationId: sandbox.stub().resolves(mockIdentityProviders),
    },
  };

  const mockAccessControlUtil = {
    hasAccess: sandbox.stub().resolves(true),
  };

  let organizationIdentityProviderController;

  beforeEach(() => {
    sandbox.restore();
    // Reset stubs
    mockDataAccess.Organization.findById = sandbox.stub().resolves(mockOrganization);
    mockDataAccess.OrganizationIdentityProvider.allByOrganizationId = sandbox.stub()
      .resolves(mockIdentityProviders);
    mockAccessControlUtil.hasAccess = sandbox.stub().resolves(true);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getByOrganizationID', () => {
    it('should return identity providers for valid organization ID', async () => {
      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      // Mock AccessControlUtil.fromContext
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedOrganizationIdentityProviderController } = await esmock(
        '../../src/controllers/organization-identity-provider.js',
        {
          '../support/access-control-util.js': AccessControlUtilStub,
        },
      );

      const controller = MockedOrganizationIdentityProviderController({
        dataAccess: mockDataAccess,
      });
      const result = await controller.getByOrganizationID(context);

      expect(result.statusCode).to.equal(200);
      expect(result.body).to.be.an('array');
      expect(result.body).to.have.length(2);
    });

    it('should return bad request for invalid UUID', async () => {
      const context = {
        params: { organizationId: 'invalid-uuid' },
      };

      const result = await organizationIdentityProviderController.getByOrganizationID(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Organization ID required');
    });

    it('should return not found for non-existent organization', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await organizationIdentityProviderController.getByOrganizationID(context);

      expect(result.statusCode).to.equal(404);
      expect(result.body).to.equal('Organization not found');
    });

    it('should return forbidden when user lacks access', async () => {
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns({
          hasAccess: sandbox.stub().resolves(false),
        }),
      };

      const { default: MockedOrganizationIdentityProviderController } = await esmock(
        '../../src/controllers/organization-identity-provider.js',
        {
          '../support/access-control-util.js': AccessControlUtilStub,
        },
      );

      const controller = MockedOrganizationIdentityProviderController({
        dataAccess: mockDataAccess,
      });
      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await controller.getByOrganizationID(context);

      expect(result.statusCode).to.equal(403);
      expect(result.body).to.equal('Only users belonging to the organization can view its identity providers');
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.OrganizationIdentityProvider.allByOrganizationId.rejects(dbError);

      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedOrganizationIdentityProviderController } = await esmock(
        '../../src/controllers/organization-identity-provider.js',
        {
          '../support/access-control-util.js': AccessControlUtilStub,
        },
      );

      const controller = MockedOrganizationIdentityProviderController({
        dataAccess: mockDataAccess,
      });
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

      const { default: MockedOrganizationIdentityProviderController } = await esmock(
        '../../src/controllers/organization-identity-provider.js',
        {
          '../support/access-control-util.js': AccessControlUtilStub,
        },
      );

      const controller = MockedOrganizationIdentityProviderController({
        dataAccess: mockDataAccess,
      });
      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await controller.getByOrganizationID(context);

      expect(result.statusCode).to.equal(500);
      expect(result.body).to.equal('Access control error');
    });
  });
});
