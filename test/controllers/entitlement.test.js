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

import EntitlementController from '../../src/controllers/entitlement.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Entitlement Controller', () => {
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
  };

  let entitlementController;

  beforeEach(() => {
    sandbox.restore();

    // Create a mock AccessControlUtil instance that will be used by the controller
    const mockAccessControlUtilInstance = {
      hasAccess: sandbox.stub().resolves(true),
    };

    // Stub AccessControlUtil.fromContext to return our mock instance
    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtilInstance);

    entitlementController = EntitlementController({
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
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('EntitlementController constructor', () => {
    it('should throw error when context is not provided', () => {
      expect(() => EntitlementController()).to.throw('Context required');
    });

    it('should throw error when context is null', () => {
      expect(() => EntitlementController(null)).to.throw('Context required');
    });

    it('should throw error when context is empty object', () => {
      expect(() => EntitlementController({})).to.throw('Context required');
    });

    it('should throw error when dataAccess is not provided', () => {
      expect(() => EntitlementController({ someOtherProp: 'value' })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is null', () => {
      expect(() => EntitlementController({ dataAccess: null })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is empty object', () => {
      expect(() => EntitlementController({ dataAccess: {} })).to.throw('Data access required');
    });
  });

  describe('getByOrganizationID', () => {
    it('should return entitlements for valid organization ID', async () => {
      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await entitlementController.getByOrganizationID(context);

      expect(result.status).to.equal(200);

      // Parse the response body
      const body = await result.json();
      expect(body).to.be.an('array');
      expect(body).to.have.length(2);
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
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await entitlementController.getByOrganizationID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Database connection failed');
    });

    it('should return internal server error when access control check fails', async () => {
      const accessError = new Error('Access control error');
      mockAccessControlUtil.hasAccess.rejects(accessError);

      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await entitlementController.getByOrganizationID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Access control error');
    });

    it('should return internal server error when Organization.findById fails', async () => {
      const orgError = new Error('Organization lookup failed');
      mockDataAccess.Organization.findById.rejects(orgError);

      const context = {
        params: { organizationId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await entitlementController.getByOrganizationID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Organization lookup failed');
    });
  });
});
