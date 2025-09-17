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

import SiteEnrollmentController from '../../src/controllers/site-enrollments.js';
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

  const enrollmentId = '456e4567-e89b-12d3-a456-426614174001';
  const anotherEnrollmentId = '456e4567-e89b-12d3-a456-426614174002';

  const mockSiteEnrollments = [
    {
      getId: () => enrollmentId,
      getSiteId: () => siteId,
      getEntitlementId: () => 'ent1',
      getStatus: () => 'ACTIVE',
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedBy: () => 'user1@example.com',
      getConfig: () => ({ dataFolder: 'test-data', brand: 'Test Brand' }),
    },
    {
      getId: () => anotherEnrollmentId,
      getSiteId: () => siteId,
      getEntitlementId: () => 'ent2',
      getStatus: () => 'PENDING',
      getCreatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedAt: () => '2023-01-01T00:00:00Z',
      getUpdatedBy: () => 'user2@example.com',
      getConfig: () => ({}),
    },
  ];

  const mockSiteEnrollment = {
    getId: () => enrollmentId,
    getSiteId: () => siteId,
    getEntitlementId: () => 'ent1',
    getStatus: () => 'ACTIVE',
    getCreatedAt: () => '2023-01-01T00:00:00Z',
    getUpdatedAt: () => '2023-01-01T00:00:00Z',
    getUpdatedBy: () => 'user1@example.com',
    getConfig: sandbox.stub().returns({ dataFolder: 'test-data', brand: 'Test Brand' }),
    setConfig: sandbox.stub(),
    save: sandbox.stub().resolves(),
  };

  const mockDataAccess = {
    Site: {
      findById: sandbox.stub().resolves(mockSite),
    },
    SiteEnrollment: {
      allBySiteId: sandbox.stub().resolves(mockSiteEnrollments),
      findById: sandbox.stub().resolves(mockSiteEnrollment),
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
    mockDataAccess.SiteEnrollment.findById = sandbox.stub().resolves(mockSiteEnrollment);

    // Reset mock site enrollment stubs
    mockSiteEnrollment.getConfig = sandbox.stub().returns({ dataFolder: 'test-data', brand: 'Test Brand' });
    mockSiteEnrollment.setConfig = sandbox.stub();
    mockSiteEnrollment.save = sandbox.stub().resolves();

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
        log: { error: sinon.stub() },
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
        log: { error: sinon.stub() },
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
        log: { error: sinon.stub() },
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
        log: { error: sinon.stub() },
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

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error getting site enrollments for site ${siteId}: ${dbError.message}`);
    });

    it('should return internal server error when access control check fails', async () => {
      const accessError = new Error('Access control error');
      mockAccessControlUtil.hasAccess.rejects(accessError);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        log: { error: sinon.stub() },
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

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error getting site enrollments for site ${siteId}: ${accessError.message}`);
    });

    it('should return internal server error when Site.findById fails', async () => {
      const siteError = new Error('Site lookup failed');
      mockDataAccess.Site.findById.rejects(siteError);

      const context = {
        params: { siteId },
        dataAccess: mockDataAccess,
        log: { error: sinon.stub() },
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

      // Verify that log.error was called
      expect(context.log.error).to.have.been.calledWith(`Error getting site enrollments for site ${siteId}: ${siteError.message}`);
    });
  });

  describe('getConfigByEnrollmentID', () => {
    const createContext = (overrides = {}) => ({
      params: { siteId, enrollmentId },
      dataAccess: mockDataAccess,
      log: { error: sinon.stub() },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
      ...overrides,
    });

    it('should return site enrollment config for valid IDs', async () => {
      const context = createContext();
      const result = await siteEnrollmentController.getConfigByEnrollmentID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({ dataFolder: 'test-data', brand: 'Test Brand' });
    });

    it('should return empty config when site enrollment has no config', async () => {
      mockSiteEnrollment.getConfig.returns({});

      const context = createContext();
      const result = await siteEnrollmentController.getConfigByEnrollmentID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({});
    });

    it('should return empty config when site enrollment getConfig returns null', async () => {
      mockSiteEnrollment.getConfig.returns(null);

      const context = createContext();
      const result = await siteEnrollmentController.getConfigByEnrollmentID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({});
    });

    it('should return empty config when site enrollment getConfig returns undefined', async () => {
      mockSiteEnrollment.getConfig.returns(undefined);

      const context = createContext();
      const result = await siteEnrollmentController.getConfigByEnrollmentID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({});
    });

    it('should return bad request for invalid site UUID', async () => {
      const context = createContext({ params: { siteId: 'invalid-uuid', enrollmentId } });
      const result = await siteEnrollmentController.getConfigByEnrollmentID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Site ID required');
    });

    it('should return bad request for invalid enrollment UUID', async () => {
      const context = createContext({ params: { siteId, enrollmentId: 'invalid-uuid' } });
      const result = await siteEnrollmentController.getConfigByEnrollmentID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Enrollment ID required');
    });

    it('should return not found for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = createContext();
      const result = await siteEnrollmentController.getConfigByEnrollmentID(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Site not found');
    });

    it('should return not found for non-existent site enrollment', async () => {
      mockDataAccess.SiteEnrollment.findById.resolves(null);

      const context = createContext();
      const result = await siteEnrollmentController.getConfigByEnrollmentID(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Site enrollment not found');
    });

    it('should return not found when site enrollment belongs to different site', async () => {
      const differentSiteEnrollment = {
        ...mockSiteEnrollment,
        getSiteId: () => 'different-site-id',
      };
      mockDataAccess.SiteEnrollment.findById.resolves(differentSiteEnrollment);

      const context = createContext();
      const result = await siteEnrollmentController.getConfigByEnrollmentID(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Site enrollment not found for this site');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = createContext();
      const result = await siteEnrollmentController.getConfigByEnrollmentID(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Access denied to this site');
    });

    it('should return internal server error when database operation fails', async () => {
      const dbError = new Error('Database connection failed');
      mockDataAccess.SiteEnrollment.findById.rejects(dbError);

      const context = createContext();
      const result = await siteEnrollmentController.getConfigByEnrollmentID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Database connection failed');

      expect(context.log.error).to.have.been.calledWith(`Error getting site enrollment config for siteEnrollment ${enrollmentId}: ${dbError.message}`);
    });
  });

  describe('updateConfigByEnrollmentID', () => {
    const createContext = (config = { dataFolder: 'updated-data', brand: 'Updated Brand' }, overrides = {}) => ({
      params: { siteId, enrollmentId },
      data: config,
      dataAccess: mockDataAccess,
      log: { error: sinon.stub() },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
      ...overrides,
    });

    beforeEach(() => {
      mockSiteEnrollment.getConfig.returns({ dataFolder: 'updated-data', brand: 'Updated Brand' });
    });

    it('should update site enrollment config successfully', async () => {
      const newConfig = { dataFolder: 'updated-data', brand: 'Updated Brand' };
      const context = createContext(newConfig);

      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal(newConfig);

      expect(mockSiteEnrollment.setConfig).to.have.been.calledWith(newConfig);
      expect(mockSiteEnrollment.save).to.have.been.called;
    });

    it('should handle empty config object', async () => {
      const emptyConfig = {};
      const context = createContext(emptyConfig);
      mockSiteEnrollment.getConfig.returns({});

      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({});

      expect(mockSiteEnrollment.setConfig).to.have.been.calledWith({});
      expect(mockSiteEnrollment.save).to.have.been.called;
    });

    it('should handle null config', async () => {
      const context = createContext(null);
      mockSiteEnrollment.getConfig.returns({});

      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({});

      expect(mockSiteEnrollment.setConfig).to.have.been.calledWith({});
      expect(mockSiteEnrollment.save).to.have.been.called;
    });

    it('should handle when getConfig returns null after update', async () => {
      const newConfig = { dataFolder: 'updated-data', brand: 'Updated Brand' };
      const context = createContext(newConfig);
      mockSiteEnrollment.getConfig.returns(null);

      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({});

      expect(mockSiteEnrollment.setConfig).to.have.been.calledWith(newConfig);
      expect(mockSiteEnrollment.save).to.have.been.called;
    });

    it('should handle when getConfig returns undefined after update', async () => {
      const newConfig = { dataFolder: 'updated-data', brand: 'Updated Brand' };
      const context = createContext(newConfig);
      mockSiteEnrollment.getConfig.returns(undefined);

      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({});

      expect(mockSiteEnrollment.setConfig).to.have.been.calledWith(newConfig);
      expect(mockSiteEnrollment.save).to.have.been.called;
    });

    it('should return bad request for invalid site UUID', async () => {
      const context = createContext({}, { params: { siteId: 'invalid-uuid', enrollmentId } });
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Site ID required');
    });

    it('should return bad request for invalid enrollment UUID', async () => {
      const context = createContext({}, { params: { siteId, enrollmentId: 'invalid-uuid' } });
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Enrollment ID required');
    });

    it('should return bad request for invalid config format - not an object', async () => {
      const context = createContext('not-an-object');
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Config must be an object with string key-value pairs');
    });

    it('should return bad request for config with non-string keys', async () => {
      const invalidConfig = { 123: 'value' }; // numeric key
      const context = createContext(invalidConfig);
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Config must be an object with string key-value pairs');
    });

    it('should return bad request for config with non-string values', async () => {
      const invalidConfig = { key: 123 }; // numeric value
      const context = createContext(invalidConfig);
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Config must be an object with string key-value pairs');
    });

    it('should return bad request for config with nested objects', async () => {
      const invalidConfig = { key: { nested: 'value' } };
      const context = createContext(invalidConfig);
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Config must be an object with string key-value pairs');
    });

    it('should return not found for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = createContext();
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Site not found');
    });

    it('should return not found for non-existent site enrollment', async () => {
      mockDataAccess.SiteEnrollment.findById.resolves(null);

      const context = createContext();
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Site enrollment not found');
    });

    it('should return not found when site enrollment belongs to different site', async () => {
      const differentSiteEnrollment = {
        ...mockSiteEnrollment,
        getSiteId: () => 'different-site-id',
      };
      mockDataAccess.SiteEnrollment.findById.resolves(differentSiteEnrollment);

      const context = createContext();
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Site enrollment not found for this site');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = createContext();
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Access denied to this site');
    });

    it('should return internal server error when save operation fails', async () => {
      const saveError = new Error('Save operation failed');
      mockSiteEnrollment.save.rejects(saveError);

      const context = createContext();
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Save operation failed');

      expect(context.log.error).to.have.been.calledWith(`Error updating site enrollment config for siteEnrollment ${enrollmentId}: ${saveError.message}`);
    });

    it('should return internal server error when database lookup fails', async () => {
      const dbError = new Error('Database lookup failed');
      mockDataAccess.SiteEnrollment.findById.rejects(dbError);

      const context = createContext();
      const result = await siteEnrollmentController.updateConfigByEnrollmentID(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Database lookup failed');

      expect(context.log.error).to.have.been.calledWith(`Error updating site enrollment config for siteEnrollment ${enrollmentId}: ${dbError.message}`);
    });
  });
});
