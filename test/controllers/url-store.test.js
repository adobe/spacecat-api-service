/*
 * Copyright 2024 Adobe. All rights reserved.
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

import { Site } from '@adobe/spacecat-shared-data-access';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import UrlStoreController from '../../src/controllers/url-store.js';

use(chaiAsPromised);

const siteId = '3f1c3ab1-9ad0-4231-ac87-8159acf52cb6';

describe('UrlStore Controller', () => {
  const sandbox = sinon.createSandbox();

  const controllerFunctions = [
    'listUrls',
    'listUrlsByAuditType',
    'getUrl',
    'addUrls',
    'updateUrls',
    'deleteUrls',
  ];

  // Mock AuditUrl entity
  const createMockAuditUrl = (data) => ({
    getSiteId: () => data.siteId,
    getUrl: () => data.url,
    getByCustomer: () => data.byCustomer,
    getAudits: () => data.audits || [],
    getCreatedAt: () => data.createdAt || '2025-01-01T00:00:00Z',
    getUpdatedAt: () => data.updatedAt || '2025-01-01T00:00:00Z',
    getCreatedBy: () => data.createdBy || 'system',
    getUpdatedBy: () => data.updatedBy || 'system',
    setByCustomer: sandbox.stub(),
    setAudits: sandbox.stub(),
    setUpdatedBy: sandbox.stub(),
    save: sandbox.stub().resolves(data),
    remove: sandbox.stub().resolves(),
    ...data,
  });

  const mockAuditUrls = [
    createMockAuditUrl({
      siteId,
      url: 'https://example.com/page1',
      byCustomer: true,
      audits: ['accessibility'],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    }),
    createMockAuditUrl({
      siteId,
      url: 'https://example.com/page2',
      byCustomer: false,
      audits: ['broken-backlinks'],
      createdAt: '2025-01-02T00:00:00Z',
      updatedAt: '2025-01-02T00:00:00Z',
    }),
  ];

  let mockDataAccess;
  let urlStoreController;
  let context;
  let log;

  beforeEach(() => {
    log = {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
    };

    mockDataAccess = {
      AuditUrl: {
        allBySiteIdByCustomerSorted: sandbox.stub()
          .resolves({ items: mockAuditUrls, cursor: null }),
        allBySiteIdAndAuditType: sandbox.stub()
          .resolves({ items: mockAuditUrls, cursor: null }),
        findBySiteIdAndUrl: sandbox.stub().resolves(null),
        create: sandbox.stub().resolves(mockAuditUrls[0]),
      },
      Site: {
        findById: sandbox.stub().resolves({ siteId }),
      },
    };

    context = {
      params: { siteId },
      data: {},
      dataAccess: mockDataAccess,
      pathInfo: {
        headers: { 'x-product': 'abcd' },
      },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    };

    urlStoreController = UrlStoreController(context, log);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    controllerFunctions.forEach((funcName) => {
      expect(urlStoreController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(urlStoreController).forEach((funcName) => {
      expect(controllerFunctions).to.include(funcName);
    });
  });

  it('throws an error if context is not an object', () => {
    expect(() => UrlStoreController()).to.throw('Context required');
  });

  it('throws an error if context is empty', () => {
    expect(() => UrlStoreController({})).to.throw('Context required');
  });

  it('throws an error if data access is not an object', () => {
    expect(() => UrlStoreController({ dataAccess: {} })).to.throw('Data access required');
  });

  describe('listUrls', () => {
    it('returns bad request if site ID is invalid', async () => {
      context.params.siteId = 'invalid-uuid';
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(404);
    });

    it('returns forbidden when user does not have access', async () => {
      const mockOrg = { getImsOrgId: () => 'test-org-id' };
      const mockSite = {
        siteId,
        getOrganization: async () => mockOrg,
      };
      Object.setPrototypeOf(mockSite, Site.prototype);
      mockDataAccess.Site.findById.resolves(mockSite);

      const restrictedAuthInfo = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'user' }])
        .withProfile({ is_admin: false })
        .withAuthenticated(true);
      restrictedAuthInfo.claims = { organizations: [] };

      context.attributes.authInfo = restrictedAuthInfo;
      urlStoreController = UrlStoreController(context, log);

      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(403);
    });

    it('returns URLs with default byCustomer=true', async () => {
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(200);

      const body = await result.json();
      expect(body).to.have.property('items');
      expect(body).to.have.property('pagination');
      expect(body.pagination).to.have.property('limit', 100);
      expect(body.pagination).to.have.property('hasMore', false);
    });

    it('returns bad request for invalid byCustomer parameter', async () => {
      context.data = { byCustomer: 'invalid' };
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for invalid sortBy field', async () => {
      context.data = { sortBy: 'invalidField' };
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for invalid sortOrder', async () => {
      context.data = { sortOrder: 'invalid' };
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for invalid limit', async () => {
      context.data = { limit: 0 };
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for non-integer limit', async () => {
      context.data = { limit: 'abc' };
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(400);
    });

    it('handles internal server error', async () => {
      mockDataAccess.AuditUrl.allBySiteIdByCustomerSorted.rejects(new Error('DB error'));
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(500);
    });

    it('accepts byCustomer as string true', async () => {
      context.data = { byCustomer: 'true' };
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(200);
    });

    it('accepts byCustomer as string false', async () => {
      context.data = { byCustomer: 'false' };
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(200);
    });

    it('accepts byCustomer as boolean true', async () => {
      context.data = { byCustomer: true };
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(200);
    });

    it('accepts byCustomer as boolean false', async () => {
      context.data = { byCustomer: false };
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(200);
    });

    it('respects max limit', async () => {
      context.data = { limit: 1000 };
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.pagination.limit).to.equal(500);
    });

    it('uses valid sortBy and sortOrder', async () => {
      context.data = { sortBy: 'createdAt', sortOrder: 'desc' };
      const result = await urlStoreController.listUrls(context);
      expect(result.status).to.equal(200);
    });
  });

  describe('listUrlsByAuditType', () => {
    it('returns bad request if site ID is invalid', async () => {
      context.params = { siteId: 'invalid', auditType: 'accessibility' };
      const result = await urlStoreController.listUrlsByAuditType(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if audit type is missing', async () => {
      context.params = { siteId, auditType: '' };
      const result = await urlStoreController.listUrlsByAuditType(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      context.params = { siteId, auditType: 'accessibility' };
      mockDataAccess.Site.findById.resolves(null);
      const result = await urlStoreController.listUrlsByAuditType(context);
      expect(result.status).to.equal(404);
    });

    it('returns URLs filtered by audit type', async () => {
      context.params = { siteId, auditType: 'accessibility' };
      const result = await urlStoreController.listUrlsByAuditType(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.have.property('items');
    });

    it('handles array response format', async () => {
      context.params = { siteId, auditType: 'accessibility' };
      mockDataAccess.AuditUrl.allBySiteIdAndAuditType.resolves(mockAuditUrls);
      const result = await urlStoreController.listUrlsByAuditType(context);
      expect(result.status).to.equal(200);
    });

    it('returns bad request for invalid sortBy', async () => {
      context.params = { siteId, auditType: 'accessibility' };
      context.data = { sortBy: 'invalid' };
      const result = await urlStoreController.listUrlsByAuditType(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for invalid sortOrder', async () => {
      context.params = { siteId, auditType: 'accessibility' };
      context.data = { sortOrder: 'invalid' };
      const result = await urlStoreController.listUrlsByAuditType(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for invalid limit', async () => {
      context.params = { siteId, auditType: 'accessibility' };
      context.data = { limit: -1 };
      const result = await urlStoreController.listUrlsByAuditType(context);
      expect(result.status).to.equal(400);
    });

    it('handles internal server error', async () => {
      context.params = { siteId, auditType: 'accessibility' };
      mockDataAccess.AuditUrl.allBySiteIdAndAuditType.rejects(new Error('DB error'));
      const result = await urlStoreController.listUrlsByAuditType(context);
      expect(result.status).to.equal(500);
    });

    it('returns forbidden when user does not have access', async () => {
      context.params = { siteId, auditType: 'accessibility' };
      const mockOrg = { getImsOrgId: () => 'test-org-id' };
      const mockSite = { siteId, getOrganization: async () => mockOrg };
      Object.setPrototypeOf(mockSite, Site.prototype);
      mockDataAccess.Site.findById.resolves(mockSite);

      const restrictedAuthInfo = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'user' }])
        .withProfile({ is_admin: false })
        .withAuthenticated(true);
      restrictedAuthInfo.claims = { organizations: [] };
      context.attributes.authInfo = restrictedAuthInfo;
      urlStoreController = UrlStoreController(context, log);

      const result = await urlStoreController.listUrlsByAuditType(context);
      expect(result.status).to.equal(403);
    });
  });

  describe('getUrl', () => {
    it('returns bad request if site ID is invalid', async () => {
      context.params = { siteId: 'invalid', base64Url: 'aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdlMQ' };
      const result = await urlStoreController.getUrl(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if base64Url is missing', async () => {
      context.params = { siteId, base64Url: '' };
      const result = await urlStoreController.getUrl(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      context.params = { siteId, base64Url: 'aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdlMQ' };
      mockDataAccess.Site.findById.resolves(null);
      const result = await urlStoreController.getUrl(context);
      expect(result.status).to.equal(404);
    });

    it('returns not found if URL does not exist', async () => {
      context.params = { siteId, base64Url: 'aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdlMQ' };
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(null);
      const result = await urlStoreController.getUrl(context);
      expect(result.status).to.equal(404);
    });

    it('returns the URL if found', async () => {
      context.params = { siteId, base64Url: 'aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdlMQ' };
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(mockAuditUrls[0]);
      const result = await urlStoreController.getUrl(context);
      expect(result.status).to.equal(200);
    });

    it('handles internal server error', async () => {
      context.params = { siteId, base64Url: 'aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdlMQ' };
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.rejects(new Error('DB error'));
      const result = await urlStoreController.getUrl(context);
      expect(result.status).to.equal(500);
    });

    it('returns forbidden when user does not have access', async () => {
      context.params = { siteId, base64Url: 'aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdlMQ' };
      const mockOrg = { getImsOrgId: () => 'test-org-id' };
      const mockSite = { siteId, getOrganization: async () => mockOrg };
      Object.setPrototypeOf(mockSite, Site.prototype);
      mockDataAccess.Site.findById.resolves(mockSite);

      const restrictedAuthInfo = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'user' }])
        .withProfile({ is_admin: false })
        .withAuthenticated(true);
      restrictedAuthInfo.claims = { organizations: [] };
      context.attributes.authInfo = restrictedAuthInfo;
      urlStoreController = UrlStoreController(context, log);

      const result = await urlStoreController.getUrl(context);
      expect(result.status).to.equal(403);
    });
  });

  describe('addUrls', () => {
    it('returns bad request if site ID is invalid', async () => {
      context.params.siteId = 'invalid';
      context.data = [{ url: 'https://example.com/page1', audits: [] }];
      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if URLs array is missing', async () => {
      context.data = null;
      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if URLs array is empty', async () => {
      context.data = [];
      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if too many URLs', async () => {
      context.data = Array(101).fill({ url: 'https://example.com/page', audits: [] });
      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      context.data = [{ url: 'https://example.com/page1', audits: [] }];
      mockDataAccess.Site.findById.resolves(null);
      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(404);
    });

    it('creates new URLs successfully', async () => {
      context.data = [{ url: 'https://example.com/page1', audits: ['accessibility'] }];
      mockDataAccess.AuditUrl.create.resolves(mockAuditUrls[0]);
      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.metadata.success).to.equal(1);
    });

    it('updates existing URL on upsert', async () => {
      context.data = [{ url: 'https://example.com/page1', audits: ['accessibility'], byCustomer: true }];
      const existingUrl = createMockAuditUrl({
        siteId,
        url: 'https://example.com/page1',
        byCustomer: false,
        audits: [],
      });
      existingUrl.save.resolves(existingUrl);
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(existingUrl);
      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(201);
    });

    it('reports invalid URL format', async () => {
      context.data = [{ url: 'not-a-valid-url', audits: [] }];
      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.metadata.failure).to.equal(1);
      expect(body.failures[0].reason).to.equal('Invalid URL format');
    });

    it('reports missing URL', async () => {
      context.data = [{ audits: [] }];
      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.failures[0].reason).to.equal('Invalid URL format');
    });

    it('handles create error for individual URL', async () => {
      context.data = [{ url: 'https://example.com/page1', audits: [] }];
      mockDataAccess.AuditUrl.create.rejects(new Error('Create failed'));
      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.metadata.failure).to.equal(1);
    });

    it('returns forbidden when user does not have access', async () => {
      context.data = [{ url: 'https://example.com/page1', audits: [] }];
      const mockOrg = { getImsOrgId: () => 'test-org-id' };
      const mockSite = { siteId, getOrganization: async () => mockOrg };
      Object.setPrototypeOf(mockSite, Site.prototype);
      mockDataAccess.Site.findById.resolves(mockSite);

      const restrictedAuthInfo = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'user' }])
        .withProfile({ is_admin: false })
        .withAuthenticated(true);
      restrictedAuthInfo.claims = { organizations: [] };
      context.attributes.authInfo = restrictedAuthInfo;
      urlStoreController = UrlStoreController(context, log);

      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(403);
    });

    it('defaults byCustomer to true when not provided', async () => {
      context.data = [{ url: 'https://example.com/page1', audits: [] }];
      mockDataAccess.AuditUrl.create.resolves(mockAuditUrls[0]);
      await urlStoreController.addUrls(context);
      expect(mockDataAccess.AuditUrl.create.firstCall.args[0].byCustomer).to.equal(true);
    });

    it('handles audits not being an array', async () => {
      context.data = [{ url: 'https://example.com/page1' }];
      mockDataAccess.AuditUrl.create.resolves(mockAuditUrls[0]);
      const result = await urlStoreController.addUrls(context);
      expect(result.status).to.equal(201);
    });
  });

  describe('updateUrls', () => {
    it('returns bad request if site ID is invalid', async () => {
      context.params.siteId = 'invalid';
      context.data = [{ url: 'https://example.com/page1', audits: [] }];
      const result = await urlStoreController.updateUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if updates array is missing', async () => {
      context.data = null;
      const result = await urlStoreController.updateUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if updates array is empty', async () => {
      context.data = [];
      const result = await urlStoreController.updateUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if too many updates', async () => {
      context.data = Array(101).fill({ url: 'https://example.com/page', audits: [] });
      const result = await urlStoreController.updateUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      context.data = [{ url: 'https://example.com/page1', audits: [] }];
      mockDataAccess.Site.findById.resolves(null);
      const result = await urlStoreController.updateUrls(context);
      expect(result.status).to.equal(404);
    });

    it('updates URLs successfully', async () => {
      context.data = [{ url: 'https://example.com/page1', audits: ['accessibility'] }];
      const existingUrl = createMockAuditUrl({
        siteId,
        url: 'https://example.com/page1',
        byCustomer: true,
        audits: [],
      });
      existingUrl.save.resolves(existingUrl);
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(existingUrl);
      const result = await urlStoreController.updateUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.metadata.success).to.equal(1);
    });

    it('reports URL not found', async () => {
      context.data = [{ url: 'https://example.com/page1', audits: [] }];
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(null);
      const result = await urlStoreController.updateUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.failures[0].reason).to.equal('URL not found');
    });

    it('reports missing URL in update', async () => {
      context.data = [{ audits: [] }];
      const result = await urlStoreController.updateUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.failures[0].reason).to.equal('URL required');
    });

    it('reports missing audits array', async () => {
      context.data = [{ url: 'https://example.com/page1' }];
      const result = await urlStoreController.updateUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.failures[0].reason).to.equal('Audits array required');
    });

    it('handles update error for individual URL', async () => {
      context.data = [{ url: 'https://example.com/page1', audits: [] }];
      const existingUrl = createMockAuditUrl({
        siteId,
        url: 'https://example.com/page1',
        byCustomer: true,
        audits: [],
      });
      existingUrl.save.rejects(new Error('Save failed'));
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(existingUrl);
      const result = await urlStoreController.updateUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.metadata.failure).to.equal(1);
    });

    it('returns forbidden when user does not have access', async () => {
      context.data = [{ url: 'https://example.com/page1', audits: [] }];
      const mockOrg = { getImsOrgId: () => 'test-org-id' };
      const mockSite = { siteId, getOrganization: async () => mockOrg };
      Object.setPrototypeOf(mockSite, Site.prototype);
      mockDataAccess.Site.findById.resolves(mockSite);

      const restrictedAuthInfo = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'user' }])
        .withProfile({ is_admin: false })
        .withAuthenticated(true);
      restrictedAuthInfo.claims = { organizations: [] };
      context.attributes.authInfo = restrictedAuthInfo;
      urlStoreController = UrlStoreController(context, log);

      const result = await urlStoreController.updateUrls(context);
      expect(result.status).to.equal(403);
    });
  });

  describe('deleteUrls', () => {
    it('returns bad request if site ID is invalid', async () => {
      context.params.siteId = 'invalid';
      context.data = { urls: ['https://example.com/page1'] };
      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if urls array is missing', async () => {
      context.data = {};
      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if urls array is empty', async () => {
      context.data = { urls: [] };
      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if too many URLs', async () => {
      context.data = { urls: Array(101).fill('https://example.com/page') };
      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      context.data = { urls: ['https://example.com/page1'] };
      mockDataAccess.Site.findById.resolves(null);
      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(404);
    });

    it('deletes customer URLs successfully', async () => {
      context.data = { urls: ['https://example.com/page1'] };
      const existingUrl = createMockAuditUrl({
        siteId,
        url: 'https://example.com/page1',
        byCustomer: true,
        audits: [],
      });
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(existingUrl);
      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.metadata.success).to.equal(1);
    });

    it('refuses to delete non-customer URLs', async () => {
      context.data = { urls: ['https://example.com/page1'] };
      const existingUrl = createMockAuditUrl({
        siteId,
        url: 'https://example.com/page1',
        byCustomer: false,
        audits: [],
      });
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(existingUrl);
      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.metadata.failure).to.equal(1);
      expect(body.failures[0].reason).to.include('byCustomer: true');
    });

    it('reports URL not found', async () => {
      context.data = { urls: ['https://example.com/page1'] };
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(null);
      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.failures[0].reason).to.equal('URL not found');
    });

    it('reports missing URL in array', async () => {
      context.data = { urls: [''] };
      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.failures[0].reason).to.equal('URL required');
    });

    it('handles delete error for individual URL', async () => {
      context.data = { urls: ['https://example.com/page1'] };
      const existingUrl = createMockAuditUrl({
        siteId,
        url: 'https://example.com/page1',
        byCustomer: true,
        audits: [],
      });
      existingUrl.remove.rejects(new Error('Delete failed'));
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(existingUrl);
      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.metadata.failure).to.equal(1);
    });

    it('returns forbidden when user does not have access', async () => {
      context.data = { urls: ['https://example.com/page1'] };
      const mockOrg = { getImsOrgId: () => 'test-org-id' };
      const mockSite = { siteId, getOrganization: async () => mockOrg };
      Object.setPrototypeOf(mockSite, Site.prototype);
      mockDataAccess.Site.findById.resolves(mockSite);

      const restrictedAuthInfo = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'user' }])
        .withProfile({ is_admin: false })
        .withAuthenticated(true);
      restrictedAuthInfo.claims = { organizations: [] };
      context.attributes.authInfo = restrictedAuthInfo;
      urlStoreController = UrlStoreController(context, log);

      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(403);
    });

    it('handles byCustomer check via direct property', async () => {
      context.data = { urls: ['https://example.com/page1'] };
      const existingUrl = {
        getSiteId: () => siteId,
        getUrl: () => 'https://example.com/page1',
        byCustomer: true,
        getAudits: () => [],
        remove: sandbox.stub().resolves(),
      };
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(existingUrl);
      const result = await urlStoreController.deleteUrls(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.metadata.success).to.equal(1);
    });
  });
});
