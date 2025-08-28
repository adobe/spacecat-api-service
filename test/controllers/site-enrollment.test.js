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

import SiteEnrollmentController from '../../src/controllers/site-enrollment.js';
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
      getStatus: () => 'ACTIVE',
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
    },
    {
      getId: () => 'enrollment-2',
      getSiteId: () => siteId,
      getEntitlementId: () => 'ent2',
      getStatus: () => 'PENDING',
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
    },
  ];

  const mockDataAccess = {
    Site: {
      findById: sandbox.stub().resolves(mockSite),
    },
    SiteEnrollment: {
      allBySiteId: sandbox.stub().resolves(mockSiteEnrollments),
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

      const result = await siteEnrollmentController.getBySiteID(context);

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

      const result = await siteEnrollmentController.getBySiteID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Site lookup failed');
    });
  });
});
