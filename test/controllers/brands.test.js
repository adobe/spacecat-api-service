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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon, { stub } from 'sinon';

import BrandsController from '../../src/controllers/brands.js';

use(chaiAsPromised);
use(sinonChai);

describe('Brands Controller', () => {
  const sandbox = sinon.createSandbox();

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
  };

  const ORGANIZATION_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';
  const SITE_ID = '0b4dcf79-fe5f-410b-b11f-641f0bf56da3';
  const IMS_ORG_ID = '1234567890ABCDEF12345678@AdobeOrg';
  const BRAND_ID = 'brand123';

  const sampleConfig = Config({
    brandConfig: {
      brandId: BRAND_ID,
    },
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
      getCollection: stub().returns({
        schema: SiteSchema,
        findById: stub(),
      }),
    },
    SiteSchema,
    site,
    loggerStub,
  ));

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

    context = {
      pathInfo: {
        headers: {
          authorization: 'Bearer token123',
        },
      },
    };

    brandsController = BrandsController(mockDataAccess, loggerStub, mockEnv);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws an error if data access is not an object', () => {
    expect(() => BrandsController()).to.throw('Data access required');
  });

  it('throws an error if env is not an object', () => {
    expect(() => BrandsController(mockDataAccess, loggerStub)).to.throw('Environment object required');
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
        BRAND_ID,
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
      expect(error).to.have.property('message', `Brand mapping not found for site ID: ${SITE_ID}`);
    });

    it('returns unauthorized if IMS config is missing', async () => {
      brandsController = BrandsController(mockDataAccess, loggerStub, {});

      const response = await brandsController.getBrandGuidelinesForSite({
        ...context,
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(400);
      expect(response.headers.has('x-error')).to.be.true;
      expect(response.headers.get('x-error')).to.equal('IMS Config not found in the environment');
    });
  });
});
