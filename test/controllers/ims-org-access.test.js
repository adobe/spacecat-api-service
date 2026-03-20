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

import ImsOrgAccessController from '../../src/controllers/ims-org-access.js';

use(chaiAsPromised);
use(sinonChai);

const SITE_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';
const ORG_ID = '5f3b3626-029c-476e-924b-0c1bba2e871f';
const TARGET_ORG_ID = '7033554c-de8a-44ac-a356-09b51af8cc28';
const ACCESS_ID = 'a0000000-0000-4000-8000-000000000001';

function makeGrant(overrides = {}) {
  return {
    getId: () => ACCESS_ID,
    getSiteId: () => SITE_ID,
    getOrganizationId: () => ORG_ID,
    getTargetOrganizationId: () => TARGET_ORG_ID,
    getProductCode: () => 'LLMO',
    getRole: () => 'agency',
    getGrantedBy: () => 'system',
    getExpiresAt: () => undefined,
    getCreatedAt: () => '2025-01-01T00:00:00Z',
    getUpdatedAt: () => '2025-01-01T00:00:00Z',
    remove: sinon.stub().resolves(),
    ...overrides,
  };
}

describe('ImsOrgAccess Controller', () => {
  const sandbox = sinon.createSandbox();
  let mockDataAccess;
  let context;
  let controller;
  let mockSite;
  let mockGrant;

  beforeEach(() => {
    mockGrant = makeGrant();
    mockSite = { getId: () => SITE_ID };

    mockDataAccess = {
      SiteImsOrgAccess: {
        create: sinon.stub().resolves(mockGrant),
        findById: sinon.stub().resolves(mockGrant),
        allBySiteId: sinon.stub().resolves([mockGrant]),
      },
      AccessGrantLog: {
        create: sinon.stub().resolves({}),
      },
      Site: {
        findById: sinon.stub().resolves(mockSite),
      },
    };

    const adminAuthInfo = new AuthInfo()
      .withType('ims')
      .withProfile({ is_admin: true, sub: 'test-admin@adobe.com' })
      .withAuthenticated(true);

    context = {
      dataAccess: mockDataAccess,
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
        warn: sinon.stub(),
      },
      pathInfo: { headers: {} },
      attributes: { authInfo: adminAuthInfo },
    };

    controller = ImsOrgAccessController(context);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws when context is missing', () => {
    expect(() => ImsOrgAccessController()).to.throw('Context required');
  });

  it('throws when dataAccess is missing', () => {
    expect(() => ImsOrgAccessController({ log: context.log })).to.throw('Data access required');
  });

  describe('createGrant', () => {
    it('creates a grant and returns 201 — grantedBy derived from JWT sub', async () => {
      const response = await controller.createGrant({
        params: { siteId: SITE_ID },
        data: {
          organizationId: ORG_ID,
          targetOrganizationId: TARGET_ORG_ID,
          productCode: 'LLMO',
          role: 'agency',
        },
        ...context,
      });

      expect(response.status).to.equal(201);
      const body = await response.json();
      expect(body).to.have.property('id', ACCESS_ID);
      expect(body).to.have.property('productCode', 'LLMO');
      expect(mockDataAccess.AccessGrantLog.create).to.have.been.calledOnce;
      // grantedBy is derived from profile.sub, not the request body
      const createArgs = mockDataAccess.SiteImsOrgAccess.create.firstCall.args[0];
      expect(createArgs.grantedBy).to.equal('ims:test-admin@adobe.com');
      expect(createArgs.updatedBy).to.equal('ims:test-admin@adobe.com');
    });

    it('returns 403 when not admin', async () => {
      const nonAdminContext = {
        ...context,
        attributes: {
          authInfo: new AuthInfo().withType('ims').withProfile({ is_admin: false }).withAuthenticated(true),
        },
      };
      const ctrl = ImsOrgAccessController(nonAdminContext);

      const response = await ctrl.createGrant({
        params: { siteId: SITE_ID },
        data: { organizationId: ORG_ID, targetOrganizationId: TARGET_ORG_ID, productCode: 'LLMO' },
        ...nonAdminContext,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 400 when siteId is invalid', async () => {
      const response = await controller.createGrant({
        params: { siteId: 'not-a-uuid' },
        data: {},
        ...context,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when site not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const response = await controller.createGrant({
        params: { siteId: SITE_ID },
        data: { organizationId: ORG_ID, targetOrganizationId: TARGET_ORG_ID, productCode: 'LLMO' },
        ...context,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 400 when organizationId missing', async () => {
      const response = await controller.createGrant({
        params: { siteId: SITE_ID },
        data: { targetOrganizationId: TARGET_ORG_ID, productCode: 'LLMO' },
        ...context,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when targetOrganizationId missing', async () => {
      const response = await controller.createGrant({
        params: { siteId: SITE_ID },
        data: { organizationId: ORG_ID, productCode: 'LLMO' },
        ...context,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when productCode missing', async () => {
      const response = await controller.createGrant({
        params: { siteId: SITE_ID },
        data: { organizationId: ORG_ID, targetOrganizationId: TARGET_ORG_ID },
        ...context,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when data is null — covers context.data || {} branch', async () => {
      // Omitting data entirely triggers the || {} fallback
      const response = await controller.createGrant({
        params: { siteId: SITE_ID },
        ...context,
      });
      expect(response.status).to.equal(400);
    });

    it('uses system as grantedBy when getProfile returns null', async () => {
      const authInfo = new AuthInfo().withType('ims').withProfile({ is_admin: true }).withAuthenticated(true);
      sinon.stub(authInfo, 'getProfile').returns(null);
      const noSubContext = { ...context, attributes: { authInfo } };
      const ctrl = ImsOrgAccessController(noSubContext);
      await ctrl.createGrant({
        params: { siteId: SITE_ID },
        data: { organizationId: ORG_ID, targetOrganizationId: TARGET_ORG_ID, productCode: 'LLMO' },
        ...noSubContext,
      });
      const createArgs = mockDataAccess.SiteImsOrgAccess.create.firstCall.args[0];
      expect(createArgs.grantedBy).to.equal('system');
    });

    it('defaults role to agency when not provided', async () => {
      await controller.createGrant({
        params: { siteId: SITE_ID },
        data: { organizationId: ORG_ID, targetOrganizationId: TARGET_ORG_ID, productCode: 'LLMO' },
        ...context,
      });
      const createArgs = mockDataAccess.SiteImsOrgAccess.create.firstCall.args[0];
      expect(createArgs.role).to.equal('agency');
    });

    it('skips AccessGrantLog when not available', async () => {
      const noLogContext = {
        ...context,
        dataAccess: { ...mockDataAccess, AccessGrantLog: null },
      };
      const ctrl = ImsOrgAccessController(noLogContext);
      const response = await ctrl.createGrant({
        params: { siteId: SITE_ID },
        data: { organizationId: ORG_ID, targetOrganizationId: TARGET_ORG_ID, productCode: 'LLMO' },
        ...noLogContext,
      });
      expect(response.status).to.equal(201);
      expect(mockDataAccess.AccessGrantLog.create).not.to.have.been.called;
    });

    it('returns 409 when 50-delegate limit exceeded', async () => {
      const limitError = new Error('Cannot add delegate: limit reached');
      limitError.status = 409;
      mockDataAccess.SiteImsOrgAccess.create.rejects(limitError);

      const response = await controller.createGrant({
        params: { siteId: SITE_ID },
        data: {
          organizationId: ORG_ID,
          targetOrganizationId: TARGET_ORG_ID,
          productCode: 'LLMO',
        },
        ...context,
      });
      expect(response.status).to.equal(409);
    });

    it('returns 500 on unexpected error', async () => {
      mockDataAccess.SiteImsOrgAccess.create.rejects(new Error('DB down'));
      const response = await controller.createGrant({
        params: { siteId: SITE_ID },
        data: {
          organizationId: ORG_ID,
          targetOrganizationId: TARGET_ORG_ID,
          productCode: 'LLMO',
        },
        ...context,
      });
      expect(response.status).to.equal(500);
    });
  });

  describe('listGrants', () => {
    it('returns list of grants for site', async () => {
      const response = await controller.listGrants({ params: { siteId: SITE_ID }, ...context });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.be.an('array').with.lengthOf(1);
      expect(body[0]).to.have.property('id', ACCESS_ID);
    });

    it('returns 403 for non-admin', async () => {
      const nonAdminContext = {
        ...context,
        attributes: {
          authInfo: new AuthInfo().withType('ims').withProfile({ is_admin: false }).withAuthenticated(true),
        },
      };
      const ctrl = ImsOrgAccessController(nonAdminContext);
      const response = await ctrl.listGrants({ params: { siteId: SITE_ID }, ...nonAdminContext });
      expect(response.status).to.equal(403);
    });

    it('returns 400 when siteId is invalid', async () => {
      const response = await controller.listGrants({ params: { siteId: 'not-a-uuid' }, ...context });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when site not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const response = await controller.listGrants({ params: { siteId: SITE_ID }, ...context });
      expect(response.status).to.equal(404);
    });

    it('returns 500 on unexpected error', async () => {
      mockDataAccess.SiteImsOrgAccess.allBySiteId.rejects(new Error('DB down'));
      const response = await controller.listGrants({ params: { siteId: SITE_ID }, ...context });
      expect(response.status).to.equal(500);
    });
  });

  describe('getGrant', () => {
    it('returns a single grant', async () => {
      const response = await controller.getGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        ...context,
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('id', ACCESS_ID);
    });

    it('returns 403 for non-admin', async () => {
      const nonAdminContext = {
        ...context,
        attributes: {
          authInfo: new AuthInfo().withType('ims').withProfile({ is_admin: false }).withAuthenticated(true),
        },
      };
      const ctrl = ImsOrgAccessController(nonAdminContext);
      const response = await ctrl.getGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        ...nonAdminContext,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 400 when siteId is invalid', async () => {
      const response = await controller.getGrant({
        params: { siteId: 'not-a-uuid', accessId: ACCESS_ID },
        ...context,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when accessId is invalid', async () => {
      const response = await controller.getGrant({
        params: { siteId: SITE_ID, accessId: 'not-a-uuid' },
        ...context,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when grant siteId does not match', async () => {
      mockDataAccess.SiteImsOrgAccess.findById.resolves(makeGrant({ getSiteId: () => 'other-site' }));
      const response = await controller.getGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        ...context,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 404 when grant not found', async () => {
      mockDataAccess.SiteImsOrgAccess.findById.resolves(null);
      const response = await controller.getGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        ...context,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 500 on unexpected error', async () => {
      mockDataAccess.SiteImsOrgAccess.findById.rejects(new Error('DB down'));
      const response = await controller.getGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        ...context,
      });
      expect(response.status).to.equal(500);
    });
  });

  describe('revokeGrant', () => {
    it('revokes grant and returns 204 — performedBy derived from JWT sub', async () => {
      const response = await controller.revokeGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        data: {},
        ...context,
      });
      expect(response.status).to.equal(204);
      expect(mockGrant.remove).to.have.been.calledOnce;
      expect(mockDataAccess.AccessGrantLog.create).to.have.been.calledOnce;
      // performedBy is derived from profile.sub, not the request body
      const logArgs = mockDataAccess.AccessGrantLog.create.firstCall.args[0];
      expect(logArgs.performedBy).to.equal('ims:test-admin@adobe.com');
    });

    it('returns 403 for non-admin', async () => {
      const nonAdminContext = {
        ...context,
        attributes: {
          authInfo: new AuthInfo().withType('ims').withProfile({ is_admin: false }).withAuthenticated(true),
        },
      };
      const ctrl = ImsOrgAccessController(nonAdminContext);
      const response = await ctrl.revokeGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        data: {},
        ...nonAdminContext,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 400 when siteId is invalid', async () => {
      const response = await controller.revokeGrant({
        params: { siteId: 'not-a-uuid', accessId: ACCESS_ID },
        data: {},
        ...context,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when accessId is invalid', async () => {
      const response = await controller.revokeGrant({
        params: { siteId: SITE_ID, accessId: 'not-a-uuid' },
        data: {},
        ...context,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when grant siteId does not match', async () => {
      mockDataAccess.SiteImsOrgAccess.findById.resolves(makeGrant({ getSiteId: () => 'other-site' }));
      const response = await controller.revokeGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        data: {},
        ...context,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 404 when grant not found', async () => {
      mockDataAccess.SiteImsOrgAccess.findById.resolves(null);
      const response = await controller.revokeGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        data: {},
        ...context,
      });
      expect(response.status).to.equal(404);
    });

    it('uses system as performedBy when getProfile returns null', async () => {
      const authInfo = new AuthInfo().withType('ims').withProfile({ is_admin: true }).withAuthenticated(true);
      sinon.stub(authInfo, 'getProfile').returns(null);
      const noSubContext = { ...context, attributes: { authInfo } };
      const ctrl = ImsOrgAccessController(noSubContext);
      await ctrl.revokeGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        data: {},
        ...noSubContext,
      });
      const logArgs = mockDataAccess.AccessGrantLog.create.firstCall.args[0];
      expect(logArgs.performedBy).to.equal('system');
    });

    it('skips AccessGrantLog when not available', async () => {
      const noLogContext = {
        ...context,
        dataAccess: { ...mockDataAccess, AccessGrantLog: null },
      };
      const ctrl = ImsOrgAccessController(noLogContext);
      const response = await ctrl.revokeGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        data: {},
        ...noLogContext,
      });
      expect(response.status).to.equal(204);
      expect(mockGrant.remove).to.have.been.calledOnce;
      expect(mockDataAccess.AccessGrantLog.create).not.to.have.been.called;
    });

    it('continues even if AccessGrantLog.create fails', async () => {
      mockDataAccess.AccessGrantLog.create.rejects(new Error('log error'));
      const response = await controller.revokeGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        data: {},
        ...context,
      });
      expect(response.status).to.equal(204);
      expect(mockGrant.remove).to.have.been.calledOnce;
    });

    it('returns 500 on unexpected error', async () => {
      mockDataAccess.SiteImsOrgAccess.findById.rejects(new Error('DB down'));
      const response = await controller.revokeGrant({
        params: { siteId: SITE_ID, accessId: ACCESS_ID },
        data: {},
        ...context,
      });
      expect(response.status).to.equal(500);
    });
  });
});
