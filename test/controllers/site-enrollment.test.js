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
import SiteEnrollmentController from '../../src/controllers/site-enrollment.js';

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
      getStatus: () => 'ACTIVE',
    },
    {
      getId: () => 'enrollment-2',
      getSiteId: () => siteId,
      getStatus: () => 'PENDING',
    },
  ];

  const mockDataAccess = {
    Site: {
      findById: sandbox.stub().resolves(mockSite),
    },
    SiteEnrollment: {
      findBySiteId: sandbox.stub().resolves(mockSiteEnrollments),
    },
  };

  const mockAccessControlUtil = {
    hasAccess: sandbox.stub().resolves(true),
  };

  let siteEnrollmentController;

  beforeEach(() => {
    sandbox.restore();
    siteEnrollmentController = SiteEnrollmentController({
      dataAccess: mockDataAccess,
    });

    // Reset stubs
    mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);
    mockDataAccess.SiteEnrollment.findBySiteId = sandbox.stub().resolves(mockSiteEnrollments);
    mockAccessControlUtil.hasAccess = sandbox.stub().resolves(true);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getBySiteID', () => {
    it('should return site enrollments for valid site ID', async () => {
      const context = {
        params: { siteId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      // Mock AccessControlUtil.fromContext
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedSiteEnrollmentController } = await esmock('../../src/controllers/site-enrollment.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedSiteEnrollmentController({ dataAccess: mockDataAccess });
      const result = await controller.getBySiteID(context);

      expect(result.statusCode).to.equal(200);
      expect(result.body).to.be.an('array');
      expect(result.body).to.have.length(2);
    });

    it('should return bad request for invalid UUID', async () => {
      const context = {
        params: { siteId: 'invalid-uuid' },
      };

      const result = await siteEnrollmentController.getBySiteID(context);

      expect(result.statusCode).to.equal(400);
      expect(result.body).to.equal('Site ID required');
    });

    it('should return not found for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: { siteId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await siteEnrollmentController.getBySiteID(context);

      expect(result.statusCode).to.equal(404);
      expect(result.body).to.equal('Site not found');
    });

    it('should return forbidden when user lacks access', async () => {
      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns({
          hasAccess: sandbox.stub().resolves(false),
        }),
      };

      const { default: MockedSiteEnrollmentController } = await esmock('../../src/controllers/site-enrollment.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedSiteEnrollmentController({ dataAccess: mockDataAccess });
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
      mockDataAccess.SiteEnrollment.findBySiteId.rejects(dbError);

      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedSiteEnrollmentController } = await esmock('../../src/controllers/site-enrollment.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedSiteEnrollmentController({ dataAccess: mockDataAccess });
      const context = {
        params: { siteId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await controller.getBySiteID(context);

      expect(result.statusCode).to.equal(500);
      expect(result.body).to.equal('Database connection failed');
    });

    it('should return internal server error when access control check fails', async () => {
      const accessError = new Error('Access control error');
      mockAccessControlUtil.hasAccess.rejects(accessError);

      const AccessControlUtilStub = {
        fromContext: sandbox.stub().returns(mockAccessControlUtil),
      };

      const { default: MockedSiteEnrollmentController } = await esmock('../../src/controllers/site-enrollment.js', {
        '../support/access-control-util.js': AccessControlUtilStub,
      });

      const controller = MockedSiteEnrollmentController({ dataAccess: mockDataAccess });
      const context = {
        params: { siteId },
        authInfo: { getProfile: () => ({ email: 'test@example.com' }) },
      };

      const result = await controller.getBySiteID(context);

      expect(result.statusCode).to.equal(500);
      expect(result.body).to.equal('Access control error');
    });
  });
});
