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

import { Organization, Site } from '@adobe/spacecat-shared-data-access';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import OrganizationSchema from '@adobe/spacecat-shared-data-access/src/models/organization/organization.schema.js';
import SiteSchema from '@adobe/spacecat-shared-data-access/src/models/site/site.schema.js';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon, { stub } from 'sinon';
import esmock from 'esmock';

import BrandsController from '../../src/controllers/brands.js';

use(chaiAsPromised);
use(sinonChai);

describe('Brands Controller', () => {
  const sandbox = sinon.createSandbox();

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
    debug: sandbox.stub(),
  };

  const ORGANIZATION_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';
  const SITE_ID = '0b4dcf79-fe5f-410b-b11f-641f0bf56da3';
  const IMS_ORG_ID = '1234567890ABCDEF12345678@AdobeOrg';
  const BRAND_ID = 'brand123';
  const USER_ID = 'user123';

  const sampleConfig = Config({
    brandConfig: {
      brandId: BRAND_ID,
      userId: USER_ID,
    },
  });

  const organizations = [
    {
      organizationId: ORGANIZATION_ID,
      name: 'Org 1',
      imsOrgId: IMS_ORG_ID,
    },
  ].map((org) => new Organization(
    {
      entities: {
        organization: {
          model: {
            indexes: {},
            schema: {
              attributes: {
                organizationId: { type: 'string', get: (value) => value },
                imsOrgId: { type: 'string', get: (value) => value },
              },
            },
          },
        },
      },
    },
    {
      log: loggerStub,
      getCollection: stub().returns({
        schema: OrganizationSchema,
      }),
    },
    OrganizationSchema,
    org,
    loggerStub,
  ));

  const getCollectionStub = stub();
  getCollectionStub.returns({
    schema: OrganizationSchema,
    findById: stub().withArgs(ORGANIZATION_ID).returns(Promise.resolve(organizations[0])),
  });

  const sites = [
    {
      siteId: SITE_ID,
      organizationId: ORGANIZATION_ID,
      baseURL: 'https://site1.com',
      deliveryType: 'aem_edge',
      config: sampleConfig,
    },
  ].map((site) => new Site(
    {
      entities: {
        site: {
          model: {
            indexes: {},
            schema: {
              attributes: {
                config: { type: 'any', name: 'config', get: (value) => Config(value) },
                organizationId: { type: 'string', name: 'organizationId', get: (value) => value },
              },
            },
          },
        },
      },
    },
    {
      log: loggerStub,
      getCollection: getCollectionStub,
    },
    SiteSchema,
    site,
    loggerStub,
  ));

  let mockDataAccess;
  let brandsController;
  let mockEnv;
  let context;

  beforeEach(() => {
    mockDataAccess = {
      Organization: {
        findById: sinon.stub().resolves(organizations[0]),
      },
      Site: {
        findById: sinon.stub().resolves(sites[0]),
      },
    };

    mockEnv = {
      BRAND_IMS_HOST: 'https://ims-na1.adobelogin.com',
      BRAND_IMS_CLIENT_ID: 'client123',
      BRAND_IMS_CLIENT_CODE: 'code123',
      BRAND_IMS_CLIENT_SECRET: 'secret123',
    };

    const authContextAdmin = {
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true)
        ,
      },
    };

    context = {
      pathInfo: {
        headers: {
          authorization: 'Bearer token123',
          'x-product': 'abcd',
        },
      },
      dataAccess: mockDataAccess,
      ...authContextAdmin,
    };

    brandsController = BrandsController(context, loggerStub, mockEnv);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws an error if context is not an object', () => {
    expect(() => BrandsController()).to.throw('Context required');
  });

  it('throws an error if data access is not an object', () => {
    expect(() => BrandsController({ dataAccess: {} })).to.throw('Data access required');
  });

  it('throws an error if env is not an object', () => {
    expect(() => BrandsController(context, loggerStub)).to.throw('Environment object required');
  });

  describe('getBrandsForOrganization', () => {
    it('returns brands for a valid organization', async () => {
      const mockBrands = [{ id: 'brand1' }, { id: 'brand2' }];
      const brandClientStub = {
        getBrandsForOrganization: sinon.stub().resolves(mockBrands),
      };
      context.brandClient = brandClientStub;

      const response = await brandsController.getBrandsForOrganization({
        ...context,
        params: { organizationId: ORGANIZATION_ID },
        env: {
          BRAND_API_BASE_URL: 'https://brand-api.com',
          BRAND_API_KEY: 'brand-api-key',
        },
      });

      expect(response.status).to.equal(200);
      const brands = await response.json();
      expect(brands).to.deep.equal(mockBrands);
      expect(brandClientStub.getBrandsForOrganization).to.have.been.calledWith(IMS_ORG_ID, 'Bearer token123');
    });

    it('returns bad request if organization ID is not provided', async () => {
      const response = await brandsController.getBrandsForOrganization({
        ...context,
        params: {},
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Organization ID required');
    });

    it('returns not found if organization does not exist', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const response = await brandsController.getBrandsForOrganization({
        ...context,
        params: { organizationId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', `Organization not found: ${ORGANIZATION_ID}`);
    });

    it('returns bad request if authorization header is missing', async () => {
      const response = await brandsController.getBrandsForOrganization({
        ...context,
        pathInfo: { headers: {} },
        params: { organizationId: ORGANIZATION_ID },
      });
      expect(response.status).to.equal(400);
      expect(response.headers.has('x-error')).to.be.true;
      expect(response.headers.get('x-error')).to.equal('Missing Authorization header');
    });

    it('returns forbidden if user does not have access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedBrandsController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);
      const response = await unauthorizedBrandsController.getBrandsForOrganization({
        params: { organizationId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(403);
    });
  });

  describe('getBrandGuidelinesForSite', () => {
    it('returns brand guidelines for a valid site', async () => {
      const mockGuidelines = { theme: 'dark', colors: ['#000', '#fff'] };
      const brandClientStub = {
        getBrandGuidelines: sinon.stub().resolves(mockGuidelines),
      };
      context.brandClient = brandClientStub;

      const response = await brandsController.getBrandGuidelinesForSite({
        ...context,
        params: { siteId: SITE_ID },
        env: {
          BRAND_API_BASE_URL: 'https://brand-api.com',
          BRAND_API_KEY: 'brand-api-key',
        },
      });
      expect(response.status).to.equal(200);
      const guidelines = await response.json();
      expect(guidelines).to.deep.equal(mockGuidelines);
      expect(brandClientStub.getBrandGuidelines).to.have.been.calledWith(
        {
          brandId: BRAND_ID,
          userId: USER_ID,
        },
        IMS_ORG_ID,
        {
          host: mockEnv.BRAND_IMS_HOST,
          clientId: mockEnv.BRAND_IMS_CLIENT_ID,
          clientCode: mockEnv.BRAND_IMS_CLIENT_CODE,
          clientSecret: mockEnv.BRAND_IMS_CLIENT_SECRET,
        },
      );
    });

    it('returns bad request if site ID is not provided', async () => {
      const response = await brandsController.getBrandGuidelinesForSite({
        ...context,
        params: {},
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site ID required');
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const response = await brandsController.getBrandGuidelinesForSite({
        ...context,
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', `Site not found: ${SITE_ID}`);
    });

    it('returns not found if brand mapping does not exist', async () => {
      const siteWithoutBrand = new Site(
        {
          entities: {
            site: {
              model: {
                indexes: {},
                schema: {
                  attributes: {
                    config: { type: 'any', name: 'config', get: (value) => Config(value) },
                    organizationId: { type: 'string', name: 'organizationId', get: (value) => value },
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
          log: loggerStub,
          getCollection: stub().returns({
            schema: SiteSchema,
            findById: stub(),
          }),
        },
        SiteSchema,
        {
          siteId: SITE_ID,
          config: Config({}),
        },
        loggerStub,
      );
      mockDataAccess.Site.findById.resolves(siteWithoutBrand);

      const response = await brandsController.getBrandGuidelinesForSite({
        ...context,
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', `Brand config is missing, brandId or userId for site ID: ${SITE_ID}`);
    });

    it('returns unauthorized if IMS config is missing', async () => {
      mockEnv = {
        OTHER_SECRETS: 'other-secrets',
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.getBrandGuidelinesForSite({
        ...context,
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(400);
      expect(response.headers.has('x-error')).to.be.true;
      expect(response.headers.get('x-error')).to.equal('IMS Config not found in the environment');
    });

    it('returns forbidden if user does not have access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedBrandsController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);
      const response = await unauthorizedBrandsController.getBrandGuidelinesForSite({
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(403);
    });
  });

  describe('getCustomerConfig', () => {
    it('returns customer config for a valid organization with IMS Org ID', async () => {
      const mockCustomerConfig = {
        customer: {
          customerName: 'Adobe',
          imsOrgID: IMS_ORG_ID,
          brands: [
            {
              id: 'brand-1',
              name: 'Brand 1',
              status: 'active',
              region: ['US'],
            },
          ],
          availableVerticals: ['Software & Technology'],
        },
      };

      // Mock the customer config data module
      const customerConfigStub = sinon.stub().returns(mockCustomerConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(200);
      const config = await response.json();
      expect(config).to.deep.equal(mockCustomerConfig);
      expect(customerConfigStub).to.have.been.calledWith(ORGANIZATION_ID);
    });

    it('loads config from S3 successfully', async () => {
      const mockS3Config = {
        customer: {
          customerName: 'From S3',
          brands: [],
        },
      };

      const mockGetFromS3 = sinon.stub().resolves(mockS3Config);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockGetFromS3,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(200);
      const config = await response.json();
      expect(config.customer.customerName).to.equal('From S3');
    });

    it('falls back to mock data when S3 fails', async () => {
      const mockMockConfig = {
        customer: {
          customerName: 'From Mock',
          brands: [],
        },
      };

      const mockGetFromS3 = sinon.stub().rejects(new Error('S3 error'));
      const mockGetFromMock = sinon.stub().returns(mockMockConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockGetFromS3,
        },
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: mockGetFromMock,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(200);
      const config = await response.json();
      expect(config.customer.customerName).to.equal('From Mock');
    });

    it('filters by status query parameter', async () => {
      const mockCustomerConfig = {
        customer: {
          customerName: 'Adobe',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand 1',
              prompts: [
                { id: 'p1', status: 'active' },
                { id: 'p2', status: 'deleted' },
              ],
            },
          ],
          categories: [
            { id: 'c1', name: 'Cat 1', status: 'active' },
            { id: 'c2', name: 'Cat 2', status: 'deleted' },
          ],
          topics: [
            { id: 't1', name: 'Topic 1', status: 'active' },
            { id: 't2', name: 'Topic 2', status: 'deleted' },
          ],
        },
      };

      const customerConfigStub = sinon.stub().returns(mockCustomerConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {
          event: {
            rawQueryString: 'status=deleted',
          },
        },
      });

      expect(response.status).to.equal(200);
      const config = await response.json();
      expect(config.customer.brands[0].prompts).to.have.lengthOf(1);
      expect(config.customer.categories).to.have.lengthOf(1);
      expect(config.customer.topics).to.have.lengthOf(1);
    });

    it('returns bad request if organization ID is not provided', async () => {
      const response = await brandsController.getCustomerConfig({
        ...context,
        params: {},
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Organization ID required');
    });

    it('returns not found if organization does not exist', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const response = await brandsController.getCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', `Organization not found: ${ORGANIZATION_ID}`);
    });

    it('returns not found if customer config does not exist for organization', async () => {
      const customerConfigStub = sinon.stub().returns(null);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Customer configuration not found for organization');
    });

    it('returns forbidden if user does not have access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedBrandsController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedBrandsController.getCustomerConfig({
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(403);
    });

    it('handles error and returns error response', async () => {
      const errorMockDataAccess = {
        Organization: {
          findById: sinon.stub().rejects(new Error('DB error')),
        },
      };

      const errorContext = {
        ...context,
        dataAccess: errorMockDataAccess,
      };

      const errorBrandsController = BrandsController(errorContext, loggerStub, mockEnv);

      const response = await errorBrandsController.getCustomerConfig({
        ...errorContext,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(500);
    });
  });

  describe('getCustomerConfigLean', () => {
    it('returns lean customer config without prompts', async () => {
      const mockCustomerConfig = {
        customer: {
          customerName: 'Adobe',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand 1',
              prompts: [{
                id: 'p1',
                status: 'active',
                categoryId: 'c1',
                topicId: 't1',
              }],
            },
          ],
          categories: [{ id: 'c1', name: 'Category 1' }],
          topics: [{ id: 't1', name: 'Topic 1' }],
        },
      };

      const customerConfigStub = sinon.stub().returns(mockCustomerConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getCustomerConfigLean({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(200);
      const config = await response.json();
      expect(config.customer.brands[0]).to.not.have.property('prompts');
      expect(config.customer.brands[0]).to.have.property('totalPrompts', 1);
      expect(config.customer.brands[0]).to.have.property('totalCategories', 1);
      expect(config.customer.brands[0]).to.have.property('totalTopics', 1);
    });

    it('returns bad request if organization ID is missing', async () => {
      const response = await brandsController.getCustomerConfigLean({
        ...context,
        params: {},
      });

      expect(response.status).to.equal(400);
    });

    it('returns not found if organization does not exist', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const response = await brandsController.getCustomerConfigLean({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(404);
    });

    it('returns not found if customer config does not exist', async () => {
      const customerConfigStub = sinon.stub().returns(null);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getCustomerConfigLean({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(404);
    });

    it('filters prompts by status when provided', async () => {
      const mockCustomerConfig = {
        customer: {
          customerName: 'Adobe',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand 1',
              prompts: [
                {
                  id: 'p1', status: 'active', categoryId: 'c1', topicId: 't1',
                },
                {
                  id: 'p2', status: 'deleted', categoryId: 'c2', topicId: 't2',
                },
              ],
            },
          ],
          categories: [
            { id: 'c1', name: 'Category 1' },
            { id: 'c2', name: 'Category 2' },
          ],
          topics: [
            { id: 't1', name: 'Topic 1' },
            { id: 't2', name: 'Topic 2' },
          ],
        },
      };

      const customerConfigStub = sinon.stub().returns(mockCustomerConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getCustomerConfigLean({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {
          event: {
            rawQueryString: 'status=deleted',
          },
        },
      });

      expect(response.status).to.equal(200);
      const config = await response.json();
      expect(config.customer.brands[0].totalPrompts).to.equal(1);
    });

    it('loads config from S3 successfully', async () => {
      const mockS3Config = {
        customer: {
          customerName: 'From S3',
          brands: [{
            id: 'b1',
            name: 'Brand',
            prompts: [{
              id: 'p1', status: 'active', categoryId: 'c1', topicId: 't1',
            }],
          }],
          categories: [{ id: 'c1', name: 'Cat' }],
          topics: [{ id: 't1', name: 'Topic' }],
        },
      };

      const mockGetFromS3 = sinon.stub().resolves(mockS3Config);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockGetFromS3,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getCustomerConfigLean({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        s3: { s3Client: {}, s3Bucket: 'test' },
      });

      expect(response.status).to.equal(200);
      const config = await response.json();
      expect(config.customer.customerName).to.equal('From S3');
    });

    it('falls back to mock data when S3 fails', async () => {
      const mockMockConfig = {
        customer: {
          customerName: 'From Mock',
          brands: [{
            id: 'b1',
            name: 'Brand',
            prompts: [{
              id: 'p1', status: 'active', categoryId: 'c1', topicId: 't1',
            }],
          }],
          categories: [{ id: 'c1', name: 'Cat' }],
          topics: [{ id: 't1', name: 'Topic' }],
        },
      };

      const mockGetFromS3 = sinon.stub().rejects(new Error('S3 error'));
      const mockGetFromMock = sinon.stub().returns(mockMockConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockGetFromS3,
        },
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: mockGetFromMock,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getCustomerConfigLean({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        s3: { s3Client: {}, s3Bucket: 'test' },
      });

      expect(response.status).to.equal(200);
      const config = await response.json();
      expect(config.customer.customerName).to.equal('From Mock');
    });

    it('handles error and returns error response', async () => {
      const errorMockDataAccess = {
        Organization: {
          findById: sinon.stub().rejects(new Error('DB error')),
        },
      };

      const errorContext = {
        ...context,
        dataAccess: errorMockDataAccess,
      };

      const errorBrandsController = BrandsController(errorContext, loggerStub, mockEnv);

      const response = await errorBrandsController.getCustomerConfigLean({
        ...errorContext,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(500);
    });
  });

  describe('getTopics', () => {
    it('returns topics for organization', async () => {
      const mockCustomerConfig = {
        customer: {
          customerName: 'Adobe',
          topics: [
            { id: 't1', name: 'Topic 1', status: 'active' },
            { id: 't2', name: 'Topic 2', status: 'deleted' },
          ],
          brands: [],
        },
      };

      const customerConfigStub = sinon.stub().returns(mockCustomerConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getTopics({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.topics).to.have.lengthOf(1);
      expect(result.topics[0].id).to.equal('t1');
    });

    it('returns bad request if organization ID is missing', async () => {
      const response = await brandsController.getTopics({
        ...context,
        params: {},
      });

      expect(response.status).to.equal(400);
    });

    it('returns not found if organization does not exist', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const response = await brandsController.getTopics({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(404);
    });

    it('returns not found if customer config does not exist', async () => {
      const customerConfigStub = sinon.stub().returns(null);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getTopics({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(404);
    });

    it('filters topics by brandId', async () => {
      const mockCustomerConfig = {
        customer: {
          customerName: 'Adobe',
          topics: [
            { id: 't1', name: 'Topic 1', status: 'active' },
            { id: 't2', name: 'Topic 2', status: 'active' },
          ],
          brands: [
            {
              id: 'brand-1',
              prompts: [{ topicId: 't1' }],
            },
          ],
        },
      };

      const customerConfigStub = sinon.stub().returns(mockCustomerConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getTopics({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {
          event: {
            rawQueryString: 'brandId=brand-1',
          },
        },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.topics).to.have.lengthOf(1);
      expect(result.topics[0].id).to.equal('t1');
    });

    it('filters topics by status', async () => {
      const mockCustomerConfig = {
        customer: {
          customerName: 'Adobe',
          topics: [
            { id: 't1', name: 'Topic 1', status: 'active' },
            { id: 't2', name: 'Topic 2', status: 'deleted' },
          ],
          brands: [],
        },
      };

      const customerConfigStub = sinon.stub().returns(mockCustomerConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getTopics({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {
          event: {
            rawQueryString: 'status=deleted',
          },
        },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.topics).to.have.lengthOf(1);
      expect(result.topics[0].id).to.equal('t2');
    });

    it('returns not found if brand not found', async () => {
      const mockCustomerConfig = {
        customer: {
          customerName: 'Adobe',
          topics: [],
          brands: [],
        },
      };

      const customerConfigStub = sinon.stub().returns(mockCustomerConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getTopics({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {
          event: {
            rawQueryString: 'brandId=nonexistent',
          },
        },
      });

      expect(response.status).to.equal(404);
    });

    it('loads config from S3 successfully', async () => {
      const mockS3Config = {
        customer: {
          customerName: 'From S3',
          topics: [{ id: 't1', name: 'Topic 1', status: 'active' }],
          brands: [],
        },
      };

      const mockGetFromS3 = sinon.stub().resolves(mockS3Config);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockGetFromS3,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getTopics({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        s3: { s3Client: {}, s3Bucket: 'test' },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.topics).to.have.lengthOf(1);
    });

    it('falls back to mock data when S3 fails', async () => {
      const mockMockConfig = {
        customer: {
          customerName: 'From Mock',
          topics: [{ id: 't1', name: 'Topic 1', status: 'active' }],
          brands: [],
        },
      };

      const mockGetFromS3 = sinon.stub().rejects(new Error('S3 error'));
      const mockGetFromMock = sinon.stub().returns(mockMockConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockGetFromS3,
        },
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: mockGetFromMock,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getTopics({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        s3: { s3Client: {}, s3Bucket: 'test' },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.topics).to.have.lengthOf(1);
    });

    it('handles error and returns error response', async () => {
      const errorMockDataAccess = {
        Organization: {
          findById: sinon.stub().rejects(new Error('DB error')),
        },
      };

      const errorContext = {
        ...context,
        dataAccess: errorMockDataAccess,
      };

      const errorBrandsController = BrandsController(errorContext, loggerStub, mockEnv);

      const response = await errorBrandsController.getTopics({
        ...errorContext,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(500);
    });
  });

  describe('getPrompts', () => {
    it('returns prompts for organization', async () => {
      const mockCustomerConfig = {
        customer: {
          customerName: 'Adobe',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand 1',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Test prompt',
                  status: 'active',
                  categoryId: 'c1',
                  topicId: 't1',
                },
              ],
            },
          ],
          categories: [{ id: 'c1', name: 'Category 1' }],
          topics: [{ id: 't1', name: 'Topic 1', categoryId: 'c1' }],
        },
      };

      const customerConfigStub = sinon.stub().returns(mockCustomerConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getPrompts({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.prompts).to.have.lengthOf(1);
      expect(result.prompts[0].prompt).to.equal('Test prompt');
    });

    it('returns bad request if organization ID is missing', async () => {
      const response = await brandsController.getPrompts({
        ...context,
        params: {},
      });

      expect(response.status).to.equal(400);
    });

    it('returns not found if organization does not exist', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const response = await brandsController.getPrompts({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(404);
    });

    it('returns not found if customer config does not exist', async () => {
      const customerConfigStub = sinon.stub().returns(null);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getPrompts({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(404);
    });

    it('filters prompts by brandId, categoryId, topicId, and status', async () => {
      const mockCustomerConfig = {
        customer: {
          customerName: 'Adobe',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand 1',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Active prompt',
                  status: 'active',
                  categoryId: 'c1',
                  topicId: 't1',
                },
                {
                  id: 'p2',
                  prompt: 'Deleted prompt',
                  status: 'deleted',
                  categoryId: 'c1',
                  topicId: 't1',
                },
                {
                  id: 'p3',
                  prompt: 'Other category',
                  status: 'active',
                  categoryId: 'c2',
                  topicId: 't2',
                },
              ],
            },
            {
              id: 'brand-2',
              name: 'Brand 2',
              prompts: [
                {
                  id: 'p4',
                  prompt: 'Brand 2 prompt',
                  status: 'active',
                  categoryId: 'c1',
                  topicId: 't1',
                },
              ],
            },
          ],
          categories: [
            { id: 'c1', name: 'Category 1' },
            { id: 'c2', name: 'Category 2' },
          ],
          topics: [
            { id: 't1', name: 'Topic 1', categoryId: 'c1' },
            { id: 't2', name: 'Topic 2', categoryId: 'c2' },
          ],
        },
      };

      const customerConfigStub = sinon.stub().returns(mockCustomerConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getPrompts({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {
          event: {
            rawQueryString: 'brandId=brand-1&categoryId=c1&topicId=t1&status=active',
          },
        },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.prompts).to.have.lengthOf(1);
      expect(result.prompts[0].id).to.equal('p1');
    });

    it('enriches prompts with category and topic info', async () => {
      const mockCustomerConfig = {
        customer: {
          customerName: 'Adobe',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand 1',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Test',
                  status: 'active',
                  categoryId: 'c1',
                  topicId: 't1',
                },
              ],
            },
          ],
          categories: [{ id: 'c1', name: 'Cat 1', origin: 'human' }],
          topics: [{ id: 't1', name: 'Topic 1', categoryId: 'c1' }],
        },
      };

      const customerConfigStub = sinon.stub().returns(mockCustomerConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: customerConfigStub,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getPrompts({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.prompts[0].category).to.deep.equal({
        id: 'c1',
        name: 'Cat 1',
        origin: 'human',
      });
      expect(result.prompts[0].topic).to.deep.equal({
        id: 't1',
        name: 'Topic 1',
        categoryId: 'c1',
      });
    });

    it('loads config from S3 successfully', async () => {
      const mockS3Config = {
        customer: {
          customerName: 'From S3',
          brands: [{
            id: 'b1',
            name: 'Brand',
            prompts: [{
              id: 'p1', prompt: 'Test', status: 'active', categoryId: 'c1', topicId: 't1',
            }],
          }],
          categories: [{ id: 'c1', name: 'Cat' }],
          topics: [{ id: 't1', name: 'Topic' }],
        },
      };

      const mockGetFromS3 = sinon.stub().resolves(mockS3Config);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockGetFromS3,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getPrompts({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        s3: { s3Client: {}, s3Bucket: 'test' },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.prompts).to.have.lengthOf(1);
    });

    it('falls back to mock data when S3 fails', async () => {
      const mockMockConfig = {
        customer: {
          customerName: 'From Mock',
          brands: [{
            id: 'b1',
            name: 'Brand',
            prompts: [{
              id: 'p1', prompt: 'Test', status: 'active', categoryId: 'c1', topicId: 't1',
            }],
          }],
          categories: [{ id: 'c1', name: 'Cat' }],
          topics: [{ id: 't1', name: 'Topic' }],
        },
      };

      const mockGetFromS3 = sinon.stub().rejects(new Error('S3 error'));
      const mockGetFromMock = sinon.stub().returns(mockMockConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockGetFromS3,
        },
        '../../src/support/customer-config-data.js': {
          getCustomerConfigByOrganizationId: mockGetFromMock,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.getPrompts({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        s3: { s3Client: {}, s3Bucket: 'test' },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.prompts).to.have.lengthOf(1);
    });

    it('handles error and returns error response', async () => {
      const errorMockDataAccess = {
        Organization: {
          findById: sinon.stub().rejects(new Error('DB error')),
        },
      };

      const errorContext = {
        ...context,
        dataAccess: errorMockDataAccess,
      };

      const errorBrandsController = BrandsController(errorContext, loggerStub, mockEnv);

      const response = await errorBrandsController.getPrompts({
        ...errorContext,
        params: { spaceCatId: ORGANIZATION_ID },
      });

      expect(response.status).to.equal(500);
    });
  });

  describe('saveCustomerConfig', () => {
    it('saves customer config to S3', async () => {
      const mockS3Client = { send: sinon.stub().resolves({}) };
      const mockConfig = {
        customer: {
          customerName: 'Adobe',
          brands: [],
        },
      };

      const response = await brandsController.saveCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: mockConfig,
        s3: {
          s3Client: mockS3Client,
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.message).to.include('saved successfully');
    });

    it('returns bad request if organization ID is missing', async () => {
      const response = await brandsController.saveCustomerConfig({
        ...context,
        params: {},
        data: { customer: { customerName: 'Test' } },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(400);
    });

    it('returns not found if organization does not exist', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const response = await brandsController.saveCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { customer: { customerName: 'Test' } },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(404);
    });

    it('returns bad request if no data provided', async () => {
      const response = await brandsController.saveCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: null,
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(400);
    });

    it('returns bad request if invalid structure', async () => {
      const response = await brandsController.saveCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: {
          customer: {},
        },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(400);
    });

    it('returns bad request if S3 not configured', async () => {
      const response = await brandsController.saveCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: {
          customer: {
            customerName: 'Adobe',
            brands: [],
          },
        },
        s3: null,
      });

      expect(response.status).to.equal(400);
    });

    it('handles S3 save error', async () => {
      const mockS3Save = sinon.stub().rejects(new Error('S3 error'));
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          saveCustomerConfigV2ToS3: mockS3Save,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.saveCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: {
          customer: {
            customerName: 'Adobe',
            brands: [],
          },
        },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(500);
    });
  });

  describe('patchCustomerConfig', () => {
    it('successfully patches customer config', async () => {
      const existingConfig = {
        customer: {
          customerName: 'Adobe',
          imsOrgID: IMS_ORG_ID,
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const mockS3Get = sinon.stub().resolves(existingConfig);
      const mockS3Save = sinon.stub().resolves();
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockS3Get,
          saveCustomerConfigV2ToS3: mockS3Save,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.patchCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: {
          customer: {
            brands: [
              {
                id: 'brand-2',
                name: 'Brand Two',
                status: 'active',
              },
            ],
          },
        },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.message).to.equal('Customer configuration updated successfully');
      expect(result.stats).to.exist;
      expect(result.stats.brands).to.exist;
      expect(mockS3Get).to.have.been.calledOnce;
      expect(mockS3Save).to.have.been.calledOnce;
    });

    it('creates new config when no existing config exists', async () => {
      const mockS3Get = sinon.stub().resolves(null);
      const mockS3Save = sinon.stub().resolves();
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockS3Get,
          saveCustomerConfigV2ToS3: mockS3Save,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.patchCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: {
          customer: {
            customerName: 'New Customer',
            imsOrgID: IMS_ORG_ID,
            brands: [
              {
                id: 'brand-1',
                name: 'Brand One',
                status: 'active',
              },
            ],
          },
        },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.stats.brands.total).to.equal(1);
      expect(result.stats.brands.modified).to.equal(1);
    });

    it('returns bad request if organization ID is not provided', async () => {
      const response = await brandsController.patchCustomerConfig({
        ...context,
        params: {},
        data: { customer: { brands: [] } },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(400);
    });

    it('returns not found if organization does not exist', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const response = await brandsController.patchCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { customer: { brands: [] } },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(404);
    });

    it('returns forbidden if user does not have access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedBrandsController = BrandsController({
        ...context,
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedBrandsController.patchCustomerConfig({
        ...context,
        ...authContextUser,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { customer: { brands: [] } },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(403);
    });

    it('returns bad request if no data provided', async () => {
      const response = await brandsController.patchCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: null,
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(400);
    });

    it('returns bad request if empty data provided', async () => {
      const response = await brandsController.patchCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: {},
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(400);
    });

    it('returns bad request if S3 not configured', async () => {
      const response = await brandsController.patchCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: {
          customer: {
            brands: [],
          },
        },
        s3: null,
      });

      expect(response.status).to.equal(400);
    });

    it('returns bad request if merged config is invalid', async () => {
      const existingConfig = {
        customer: {
          customerName: 'Adobe',
          imsOrgID: IMS_ORG_ID,
          brands: [],
        },
      };

      const mockS3Get = sinon.stub().resolves(existingConfig);
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockS3Get,
        },
        '../../src/support/customer-config-v2-metadata.js': {
          mergeCustomerConfigV2: sinon.stub().returns({
            mergedConfig: { customer: {} }, // Missing required fields
            stats: {},
          }),
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.patchCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: {
          customer: {
            brands: [{ id: 'brand-1', name: 'Brand One' }],
          },
        },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(400);
    });

    it('continues if S3 get fails and treats as no existing config', async () => {
      const mockS3Get = sinon.stub().rejects(new Error('S3 get error'));
      const mockS3Save = sinon.stub().resolves();
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockS3Get,
          saveCustomerConfigV2ToS3: mockS3Save,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.patchCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: {
          customer: {
            customerName: 'New Customer',
            imsOrgID: IMS_ORG_ID,
            brands: [
              {
                id: 'brand-1',
                name: 'Brand One',
                status: 'active',
              },
            ],
          },
        },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(200);
      expect(loggerStub.warn).to.have.been.called;
    });

    it('handles S3 save error', async () => {
      const existingConfig = {
        customer: {
          customerName: 'Adobe',
          imsOrgID: IMS_ORG_ID,
          brands: [],
        },
      };

      const mockS3Get = sinon.stub().resolves(existingConfig);
      const mockS3Save = sinon.stub().rejects(new Error('S3 save error'));
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockS3Get,
          saveCustomerConfigV2ToS3: mockS3Save,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.patchCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: {
          customer: {
            brands: [
              {
                id: 'brand-1',
                name: 'Brand One',
                status: 'active',
              },
            ],
          },
        },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(500);
    });

    it('preserves metadata for unchanged items', async () => {
      const existingConfig = {
        customer: {
          customerName: 'Adobe',
          imsOrgID: IMS_ORG_ID,
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              updatedBy: 'old-user@example.com',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      };

      const mockS3Get = sinon.stub().resolves(existingConfig);
      const mockS3Save = sinon.stub().resolves();
      const brandsControllerWithMock = await esmock('../../src/controllers/brands.js', {
        '../../src/support/customer-config-v2-s3.js': {
          getCustomerConfigV2FromS3: mockS3Get,
          saveCustomerConfigV2ToS3: mockS3Save,
        },
      });

      const controller = brandsControllerWithMock(context, loggerStub, mockEnv);
      const response = await controller.patchCustomerConfig({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: {
          customer: {
            brands: [
              {
                id: 'brand-1',
                name: 'Brand One',
                status: 'active',
              },
            ],
          },
        },
        s3: {
          s3Client: {},
          s3Bucket: 'test-bucket',
        },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.stats.brands.modified).to.equal(0);
    });
  });
});
