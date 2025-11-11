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

import { Organization, Site } from '@adobe/spacecat-shared-data-access';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon, { stub } from 'sinon';

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import OrganizationSchema from '@adobe/spacecat-shared-data-access/src/models/organization/organization.schema.js';
import SiteSchema from '@adobe/spacecat-shared-data-access/src/models/site/site.schema.js';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import TierClient from '@adobe/spacecat-shared-tier-client';

import HomepageController from '../../src/controllers/homepage.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Homepage Controller', () => {
  const sandbox = sinon.createSandbox();
  const orgId = '9033554c-de8a-44ac-a356-09b51af8cc28';
  const siteId = '550e8400-e29b-41d4-a716-446655440000';
  const imsOrgId = '1234567890ABCDEF12345678@AdobeOrg';

  const site = new Site(
    { entities: { site: { model: {} } } },
    {
      log: console,
      getCollection: stub().returns({
        schema: SiteSchema,
        findById: stub(),
      }),
    },
    SiteSchema,
    {
      siteId,
      organizationId: orgId,
      baseURL: 'https://example.com',
      deliveryType: 'aem_edge',
      isLive: true,
      config: Config({}),
    },
    console,
  );

  const organization = new Organization(
    {
      entities: {
        organization: {
          model: {
            indexes: {},
            schema: {
              attributes: {
                organizationId: { type: 'string', get: (value) => value },
                config: { type: 'any', get: (value) => Config(value) },
                name: { type: 'string', get: (value) => value },
                imsOrgId: { type: 'string', get: (value) => value },
              },
            },
          },
          patch: sinon.stub().returns({
            composite: () => ({ go: () => {} }),
            set: () => {},
          }),
        },
      },
    },
    {
      log: console,
      getCollection: stub().returns({
        schema: OrganizationSchema,
        findById: stub(),
      }),
    },
    OrganizationSchema,
    {
      organizationId: orgId,
      name: 'Test Organization',
      imsOrgId,
      config: Config({}),
    },
    console,
  );

  let context;
  let mockOrganization;
  let mockSite;
  let mockSiteEnrollment;
  let mockTierClient;

  beforeEach(() => {
    mockOrganization = {
      all: sandbox.stub(),
      create: sandbox.stub(),
      findById: sandbox.stub(),
      findByImsOrgId: sandbox.stub(),
    };

    mockSite = {
      all: sandbox.stub(),
      allByOrganizationId: sandbox.stub(),
      create: sandbox.stub(),
      findById: sandbox.stub(),
      findByBaseURL: sandbox.stub(),
    };

    mockSiteEnrollment = {
      allBySiteId: sandbox.stub().resolves([{ getEntitlementId: () => 'entitlement-1' }]),
      allByEntitlementId: sandbox.stub().resolves([{ getId: () => 'enrollment-1', getSiteId: () => siteId }]),
    };

    // Mock TierClient
    mockTierClient = {
      checkValidEntitlement: sandbox.stub().resolves({ entitlement: { getId: () => 'entitlement-1' } }),
    };

    sandbox.stub(TierClient, 'createForOrg').returns(mockTierClient);

    context = {
      log: console,
      dataAccess: {
        Organization: mockOrganization,
        Site: mockSite,
        SiteEnrollment: mockSiteEnrollment,
      },
      attributes: {
        authInfo: new AuthInfo({
          profile: {
            email: 'test@example.com',
            imsOrgs: [],
            imsUserId: 'testUserId',
          },
        }),
      },
      pathInfo: {
        headers: {
          'x-product': 'ASO',
        },
        suffix: '/homepage',
      },
      data: {},
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getHomepageData', () => {
    let hasAccessStub;

    beforeEach(() => {
      hasAccessStub = sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);
    });

    it('should return bad request if no product code header provided', async () => {
      delete context.pathInfo.headers['x-product'];
      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('Product code required');
    });

    it('should return forbidden if no query parameters provided', async () => {
      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(403);
      const body = await response.json();
      expect(body.message).to.include('Access denied or resources not found');
    });

    it('should skip invalid siteId and return forbidden when no other params', async () => {
      context.data = { ...context.data, siteId: 'invalid-uuid' };

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(403);
      const body = await response.json();
      expect(body.message).to.include('Access denied or resources not found');
    });

    it('should return forbidden if site does not exist and no fallback provided', async () => {
      context.data = { ...context.data, siteId };
      mockSite.findById.resolves(null);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(403);
      expect(mockSite.findById).to.have.been.calledWith(siteId);
    });

    it('should return forbidden if user has no access to site and no fallback provided', async () => {
      context.data = { ...context.data, siteId };
      mockSite.findById.resolves(site);
      mockOrganization.findById.resolves(organization);
      hasAccessStub.resolves(false);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(403);
      expect(hasAccessStub).to.have.been.called;
    });

    it('should return homepage data for valid siteId', async () => {
      context.data = { ...context.data, siteId };
      mockSite.findById.resolves(site);
      mockOrganization.findById.resolves(organization);
      mockSiteEnrollment.allBySiteId.resolves([{
        getEntitlementId: () => 'entitlement-1',
        getId: () => 'enrollment-1',
      }]);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('data');
      expect(body.data).to.have.property('organization');
      expect(body.data).to.have.property('site');
      expect(body.data.site).to.be.an('object');
    });

    it('should skip invalid organizationId and return forbidden when no other params', async () => {
      context.data = { ...context.data, organizationId: 'invalid-uuid' };

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(403);
      const body = await response.json();
      expect(body.message).to.include('Access denied or resources not found');
    });

    it('should return forbidden if organization does not exist and no fallback provided', async () => {
      context.data = { ...context.data, organizationId: orgId };
      mockOrganization.findById.resolves(null);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(403);
      expect(mockOrganization.findById).to.have.been.calledWith(orgId);
    });

    it('should return forbidden if user has no access to organization and no fallback provided', async () => {
      context.data = { ...context.data, organizationId: orgId };
      mockOrganization.findById.resolves(organization);
      hasAccessStub.resolves(false);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(403);
      expect(hasAccessStub).to.have.been.called;
    });

    it('should return homepage data for valid organizationId with enrolled sites', async () => {
      context.data = { ...context.data, organizationId: orgId };
      mockOrganization.findById.resolves(organization);
      mockSite.findById.resolves(site);
      mockSiteEnrollment.allByEntitlementId.resolves([{ getId: () => 'enrollment-1', getSiteId: () => siteId }]);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('data');
      expect(body.data).to.have.property('organization');
      expect(body.data).to.have.property('site');
    });

    it('should return forbidden for non-existent imsOrg', async () => {
      context.data = { ...context.data, imsOrg: 'nonexistent@AdobeOrg' };
      mockOrganization.findByImsOrgId.resolves(null);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(403);
      expect(mockOrganization.findByImsOrgId).to.have.been.calledWith('nonexistent@AdobeOrg');
    });

    it('should return forbidden if user has no access via imsOrg and no fallback', async () => {
      context.data = { ...context.data, imsOrg: imsOrgId };
      mockOrganization.findByImsOrgId.resolves(organization);
      hasAccessStub.resolves(false);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(403);
      expect(hasAccessStub).to.have.been.called;
    });

    it('should return homepage data for valid imsOrg with enrolled sites', async () => {
      context.data = { ...context.data, imsOrg: imsOrgId };
      mockOrganization.findByImsOrgId.resolves(organization);
      mockSite.findById.resolves(site);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('data');
      expect(body.data).to.have.property('organization');
      expect(body.data).to.have.property('site');
      expect(mockOrganization.findByImsOrgId).to.have.been.calledWith(imsOrgId);
    });

    it('should return only first enrolled site when multiple sites exist for organization', async () => {
      new Site( // eslint-disable-line no-new
        { entities: { site: { model: {} } } },
        {
          log: console,
          getCollection: stub().returns({
            schema: SiteSchema,
            findById: stub(),
          }),
        },
        SiteSchema,
        {
          siteId: '650e8400-e29b-41d4-a716-446655440001',
          organizationId: orgId,
          baseURL: 'https://example2.com',
          deliveryType: 'aem_edge',
          isLive: false,
          config: Config({}),
        },
        console,
      );

      context.data = { ...context.data, organizationId: orgId };
      mockOrganization.findById.resolves(organization);
      mockSite.findById.resolves(site);
      mockSiteEnrollment.allByEntitlementId.resolves([{ getId: () => 'enrollment-1', getSiteId: () => siteId }]);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.data).to.have.property('site');
      expect(body.data.site).to.be.an('object');
    });

    it('should handle errors gracefully', async () => {
      context.data = { ...context.data, siteId };
      mockSite.findById.rejects(new Error('Database error'));

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('Failed to fetch homepage data');
    });

    it('should fallback to organizationId when siteId has no access', async () => {
      context.data = { ...context.data, siteId, organizationId: orgId };
      mockSite.findById.resolves(site);
      mockOrganization.findById.resolves(organization);
      mockSite.allByOrganizationId.resolves([site]);

      // First call for site access returns false, second call for org access returns true
      hasAccessStub.onFirstCall().resolves(false);
      hasAccessStub.onSecondCall().resolves(true);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.data).to.have.property('organization');
      expect(body.data).to.have.property('site');
      expect(mockOrganization.findById).to.have.been.calledWith(orgId);
    });

    it('should fallback to imsOrg when siteId and organizationId have no access', async () => {
      context.data = {
        ...context.data, siteId, organizationId: orgId, imsOrg: imsOrgId,
      };
      mockSite.findById.resolves(site);
      mockOrganization.findById.resolves(organization);
      mockOrganization.findByImsOrgId.resolves(organization);
      mockSite.allByOrganizationId.resolves([site]);

      // First two calls return false, third call for imsOrg returns true
      hasAccessStub.onFirstCall().resolves(false);
      hasAccessStub.onSecondCall().resolves(false);
      hasAccessStub.onThirdCall().resolves(true);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.data).to.have.property('organization');
      expect(body.data).to.have.property('site');
      expect(mockOrganization.findByImsOrgId).to.have.been.calledWith(imsOrgId);
    });

    it('should fallback to imsOrg when siteId is not found but imsOrg works', async () => {
      context.data = { ...context.data, siteId, imsOrg: imsOrgId };
      mockSite.findById.onFirstCall().resolves(null);
      mockSite.findById.onSecondCall().resolves(site);
      mockOrganization.findByImsOrgId.resolves(organization);

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.data).to.have.property('organization');
      expect(body.data).to.have.property('site');
      expect(mockOrganization.findByImsOrgId).to.have.been.calledWith(imsOrgId);
    });

    it('should return forbidden when organization has no enrolled sites', async () => {
      context.data = { ...context.data, organizationId: orgId };
      mockOrganization.findById.resolves(organization);
      mockSiteEnrollment.allByEntitlementId.resolves([]); // No enrollments

      const controller = HomepageController(context);
      const response = await controller.getHomepageData(context);

      expect(response.status).to.equal(403);
      const body = await response.json();
      expect(body.message).to.include('Access denied or resources not found');
    });
  });

  describe('Constructor', () => {
    it('should throw error if context is not provided', () => {
      expect(() => HomepageController()).to.throw('Context required');
    });

    it('should throw error if dataAccess is not provided', () => {
      const invalidContext = {
        pathInfo: { headers: {} },
        attributes: {
          authInfo: new AuthInfo({
            profile: {
              email: 'test@example.com',
              imsOrgs: [],
              imsUserId: 'testUserId',
            },
          }),
        },
      };
      expect(() => HomepageController(invalidContext)).to.throw('Data access required');
    });
  });
});
