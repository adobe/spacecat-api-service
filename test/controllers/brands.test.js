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
import { SerenityTransportError } from '../../src/support/serenity/rest-transport.js';

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
  // Category CRUD now addresses rows by the categories.id UUID, not the
  // retired category_id business key (LLMO-5515).
  const CATEGORY_UUID = 'c1111111-1111-4111-b111-111111111111';
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
      services: {
        postgrestClient: {
          from: sinon.stub().returns({
            select: sinon.stub().returnsThis(),
            eq: sinon.stub().returnsThis(),
            maybeSingle: sinon.stub().resolves({ data: null, error: null }),
            upsert: sinon.stub().resolves({ error: null }),
          }),
        },
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

    it('returns not found if organization does not exist for site', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const response = await brandsController.getBrandGuidelinesForSite({
        ...context,
        params: { siteId: SITE_ID },
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', `Organization not found for site: ${SITE_ID}`);
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

    describe('Brand Governance Agent priority chain', () => {
      const BRAND_GOV_ENV = {
        IMS_HOST: 'https://ims-na1.adobelogin.com',
        BRAND_GOV_IMS_CLIENT_ID: 'gov-client-id',
        BRAND_GOV_IMS_CLIENT_CODE: 'gov-client-code',
        BRAND_GOV_IMS_CLIENT_SECRET: 'gov-client-secret',
      };

      const makeSiteWithoutBrand = () => new Site(
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
          getCollection: stub().returns({ schema: SiteSchema, findById: stub() }),
        },
        SiteSchema,
        { siteId: SITE_ID, config: Config({}) },
        loggerStub,
      );

      it('returns Brand Governance guidelines and skips Brand Publish when site is registered in governance', async () => {
        const mockGovGuidelines = {
          id: 'frescopa-2A53',
          name: 'Frescopa Coffee',
          imsOrgId: IMS_ORG_ID,
          guidelines: [{ name: 'Sophisticated Voice', text: 'Use sensory language' }],
        };
        const brandGovClientStub = {
          getBrandGuidelinesForUrl: sinon.stub().resolves(mockGovGuidelines),
        };
        const brandClientStub = { getBrandGuidelines: sinon.stub() };
        const govContext = {
          ...context,
          brandGovernanceClient: brandGovClientStub,
          brandClient: brandClientStub,
        };
        const govEnv = { ...mockEnv, ...BRAND_GOV_ENV };
        const govController = BrandsController(govContext, loggerStub, govEnv);

        const response = await govController.getBrandGuidelinesForSite({
          ...govContext,
          params: { siteId: SITE_ID },
        });

        expect(response.status).to.equal(200);
        const guidelines = await response.json();
        expect(guidelines).to.deep.equal(mockGovGuidelines);
        expect(brandGovClientStub.getBrandGuidelinesForUrl).to.have.been.calledOnceWith(
          'https://site1.com',
          IMS_ORG_ID,
          {
            host: BRAND_GOV_ENV.IMS_HOST,
            clientId: BRAND_GOV_ENV.BRAND_GOV_IMS_CLIENT_ID,
            clientCode: BRAND_GOV_ENV.BRAND_GOV_IMS_CLIENT_CODE,
            clientSecret: BRAND_GOV_ENV.BRAND_GOV_IMS_CLIENT_SECRET,
          },
        );
        expect(brandClientStub.getBrandGuidelines).to.not.have.been.called;
      });

      it('falls back to Brand Publish when Brand Governance returns null (site not in governance)', async () => {
        const mockGuidelines = { theme: 'dark', colors: ['#000', '#fff'] };
        const brandGovClientStub = {
          getBrandGuidelinesForUrl: sinon.stub().resolves(null),
        };
        const brandClientStub = { getBrandGuidelines: sinon.stub().resolves(mockGuidelines) };
        const govContext = {
          ...context,
          brandGovernanceClient: brandGovClientStub,
          brandClient: brandClientStub,
        };
        const govEnv = { ...mockEnv, ...BRAND_GOV_ENV };
        const govController = BrandsController(govContext, loggerStub, govEnv);

        const response = await govController.getBrandGuidelinesForSite({
          ...govContext,
          params: { siteId: SITE_ID },
          env: { BRAND_API_BASE_URL: 'https://brand-api.com', BRAND_API_KEY: 'brand-api-key' },
        });

        expect(response.status).to.equal(200);
        const guidelines = await response.json();
        expect(guidelines).to.deep.equal(mockGuidelines);
        expect(brandGovClientStub.getBrandGuidelinesForUrl).to.have.been.calledOnce;
        expect(brandClientStub.getBrandGuidelines).to.have.been.calledOnce;
      });

      it('returns 404 when Brand Governance returns null and brand config is also missing', async () => {
        mockDataAccess.Site.findById.resolves(makeSiteWithoutBrand());
        const brandGovClientStub = { getBrandGuidelinesForUrl: sinon.stub().resolves(null) };
        const govContext = { ...context, brandGovernanceClient: brandGovClientStub };
        const govEnv = { ...mockEnv, ...BRAND_GOV_ENV };
        const govController = BrandsController(govContext, loggerStub, govEnv);

        const response = await govController.getBrandGuidelinesForSite({
          ...govContext,
          params: { siteId: SITE_ID },
          env: { BRAND_API_BASE_URL: 'https://brand-api.com', BRAND_API_KEY: 'brand-api-key' },
        });

        expect(response.status).to.equal(404);
        const error = await response.json();
        expect(error).to.have.property('message', `Brand config is missing, brandId or userId for site ID: ${SITE_ID}`);
      });

      it('skips Brand Governance and uses Brand Publish when gov env vars are not configured', async () => {
        const mockGuidelines = { theme: 'light' };
        const brandClientStub = { getBrandGuidelines: sinon.stub().resolves(mockGuidelines) };
        const govClientStub = { getBrandGuidelinesForUrl: sinon.stub() };
        // mockEnv has no BRAND_GOV_IMS_* vars — govConfig will be null, gov path skipped
        const noGovContext = {
          ...context, brandClient: brandClientStub, brandGovernanceClient: govClientStub,
        };

        const response = await brandsController.getBrandGuidelinesForSite({
          ...noGovContext,
          params: { siteId: SITE_ID },
          env: { BRAND_API_BASE_URL: 'https://brand-api.com', BRAND_API_KEY: 'brand-api-key' },
        });

        expect(response.status).to.equal(200);
        expect(govClientStub.getBrandGuidelinesForUrl).to.not.have.been.called;
        expect(brandClientStub.getBrandGuidelines).to.have.been.calledOnce;
      });

      it('falls back to Brand Publish when Brand Governance client throws', async () => {
        const mockGuidelines = { theme: 'dark' };
        const brandGovClientStub = {
          getBrandGuidelinesForUrl: sinon.stub().rejects(new Error('Brand Governance API unavailable')),
        };
        const brandClientStub = { getBrandGuidelines: sinon.stub().resolves(mockGuidelines) };
        const govContext = {
          ...context, brandGovernanceClient: brandGovClientStub, brandClient: brandClientStub,
        };
        const govEnv = { ...mockEnv, ...BRAND_GOV_ENV };
        const govController = BrandsController(govContext, loggerStub, govEnv);

        const response = await govController.getBrandGuidelinesForSite({
          ...govContext,
          params: { siteId: SITE_ID },
          env: { BRAND_API_BASE_URL: 'https://brand-api.com', BRAND_API_KEY: 'brand-api-key' },
        });

        expect(response.status).to.equal(200);
        expect(brandGovClientStub.getBrandGuidelinesForUrl).to.have.been.calledOnce;
        expect(brandClientStub.getBrandGuidelines).to.have.been.calledOnce;
      });

      it('returns 500 when Brand Governance throws and Brand Publish also fails', async () => {
        const brandGovClientStub = {
          getBrandGuidelinesForUrl: sinon.stub().rejects(new Error('Brand Governance API unavailable')),
        };
        const brandClientStub = { getBrandGuidelines: sinon.stub().rejects(new Error('Brand Publish also down')) };
        const govContext = {
          ...context, brandGovernanceClient: brandGovClientStub, brandClient: brandClientStub,
        };
        const govEnv = { ...mockEnv, ...BRAND_GOV_ENV };
        const govController = BrandsController(govContext, loggerStub, govEnv);

        const response = await govController.getBrandGuidelinesForSite({
          ...govContext,
          params: { siteId: SITE_ID },
          env: { BRAND_API_BASE_URL: 'https://brand-api.com', BRAND_API_KEY: 'brand-api-key' },
        });

        expect(response.status).to.equal(500);
      });
    });
  });

  describe('listPromptsByBrand (brand-scoped prompts CRUD)', () => {
    const BRAND_UUID = 'd1111111-1111-4111-b111-111111111111';
    const PROMPT_ID = 'prompt-1';

    beforeEach(() => {
      const promptRow = {
        id: BRAND_UUID,
        prompt_id: PROMPT_ID,
        name: 'Test Prompt',
        text: 'What is the best product?',
        regions: ['us'],
        status: 'active',
        origin: 'human',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Test Brand' },
        categories: {
          id: 'cat-uuid', category_id: 'cat-1', name: 'Category', origin: 'human',
        },
        topics: {
          id: 'topic-uuid', topic_id: 'topic-1', name: 'Topic', category_id: 'cat-1',
        },
      };
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake((table) => {
          const chain = {
            select: sandbox.stub().returnsThis(),
            eq: sandbox.stub().returnsThis(),
            neq: sandbox.stub().returnsThis(),
            order: sandbox.stub().returnsThis(),
            update: sandbox.stub().returnsThis(),
            or: sandbox.stub().returnsThis(),
            contains: sandbox.stub().returnsThis(),
            overlaps: sandbox.stub().returnsThis(),
            range: sandbox.stub().resolves({
              data: table === 'prompts' ? [promptRow] : [],
              error: null,
              count: 1,
            }),
            maybeSingle: sandbox.stub().callsFake(() => {
              if (table === 'brands') {
                return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
              }
              if (table === 'llmo_customer_config') {
                return Promise.resolve({
                  data: {
                    config: {
                      customer: {
                        brands: [{ id: 'chevrolet', name: 'Chevrolet' }],
                      },
                    },
                  },
                  error: null,
                });
              }
              if (table === 'prompts') {
                return Promise.resolve({
                  data: {
                    prompt_id: PROMPT_ID,
                    name: 'Test',
                    text: 'Prompt text',
                    regions: [],
                    status: 'active',
                    origin: 'human',
                    updated_at: '2026-01-01T00:00:00Z',
                    updated_by: 'system',
                    brands: { id: BRAND_UUID, name: 'Test Brand' },
                    categories: null,
                    topics: null,
                  },
                  error: null,
                });
              }
              return Promise.resolve({ data: null, error: null });
            }),
          };
          return chain;
        }),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 503 when postgrestClient is not available', async () => {
      mockDataAccess.services.postgrestClient = null;

      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(503);
    });

    it('returns bad request when spaceCatId is missing', async () => {
      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('Organization ID');
    });

    it('returns bad request when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(400);
    });

    it('returns bad request when brandId is missing', async () => {
      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('Brand ID');
    });

    it('returns bad request when limit is invalid', async () => {
      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        invocation: { event: { rawQueryString: 'limit=99999' } },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('Limit');
    });

    it('listPromptsByBrand returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.listPromptsByBrand({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(403);
    });

    it('returns 200 with paginated prompts when brand exists', async () => {
      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('items').that.is.an('array');
      expect(body).to.have.property('total');
      expect(body).to.have.property('limit');
      expect(body).to.have.property('page');
    });

    it('listPromptsByBrand returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        const chain = {
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          or: sandbox.stub().returnsThis(),
          contains: sandbox.stub().returnsThis(),
          overlaps: sandbox.stub().returnsThis(),
          range: sandbox.stub().rejects(new Error('DB connection lost')),
          maybeSingle: sandbox.stub().callsFake(() => {
            if (table === 'brands') {
              return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
            }
            if (table === 'llmo_customer_config') {
              return Promise.resolve({
                data: { config: { customer: { brands: [] } } }, error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        };
        return chain;
      });

      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(500);
    });

    it('getPromptByBrandAndId returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.getPromptByBrandAndId({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(403);
    });

    it('getPromptByBrandAndId returns 200 when prompt exists', async () => {
      const response = await brandsController.getPromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.id).to.equal(PROMPT_ID);
      expect(body.prompt).to.equal('Prompt text');
    });

    it('getPromptByBrandAndId returns 404 when prompt not found', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => ({
        select: sandbox.stub().returnsThis(),
        eq: sandbox.stub().returnsThis(),
        neq: sandbox.stub().returnsThis(),
        order: sandbox.stub().returnsThis(),
        range: sandbox.stub().resolves({ data: [], error: null, count: 0 }),
        maybeSingle: sandbox.stub().callsFake(() => {
          if (table === 'brands') {
            return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
          }
          if (table === 'llmo_customer_config') {
            return Promise.resolve({
              data: { config: { customer: { brands: [] } } }, error: null,
            });
          }
          if (table === 'prompts') {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      }));

      const response = await brandsController.getPromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: 'nonexistent' },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(404);
    });

    it('getPromptByBrandAndId returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        const chain = {
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          range: sandbox.stub().resolves({ data: [], error: null, count: 0 }),
          maybeSingle: sandbox.stub().callsFake(() => {
            if (table === 'brands') {
              return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
            }
            if (table === 'llmo_customer_config') {
              return Promise.resolve({
                data: { config: { customer: { brands: [] } } }, error: null,
              });
            }
            if (table === 'prompts') {
              return Promise.reject(new Error('DB connection lost'));
            }
            return Promise.resolve({ data: null, error: null });
          }),
        };
        return chain;
      });

      const response = await brandsController.getPromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(500);
    });

    it('createPromptsByBrand returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.createPromptsByBrand({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: [{ prompt: 'New', regions: [] }],
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(403);
    });

    it('createPromptsByBrand returns 201 with created/updated counts', async () => {
      const thenable = (v) => ({ then: (resolve) => resolve(v), catch: () => thenable(v) });
      const contextWithEmail = {
        ...context,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      };
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        if (table === 'prompts') {
          const insertChain = { select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) };
          return {
            select: () => ({
              eq: () => ({
                eq: () => thenable({ data: [], error: null }),
              }),
            }),
            insert: () => insertChain,
            update: () => ({ eq: () => thenable({ error: null }) }),
          };
        }
        const chain = {
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        };
        if (table === 'brands') {
          chain.maybeSingle = sandbox.stub().resolves({ data: { id: BRAND_UUID }, error: null });
        }
        if (table === 'llmo_customer_config') {
          chain.maybeSingle = sandbox.stub()
            .resolves({ data: { config: { customer: { brands: [] } } }, error: null });
        }
        return chain;
      });

      const response = await brandsController.createPromptsByBrand({
        ...contextWithEmail,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: [{ prompt: 'New prompt text', regions: ['us'] }],
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(201);
      const body = await response.json();
      expect(body).to.have.property('created');
      expect(body).to.have.property('updated');
      expect(body).to.have.property('prompts');
    });

    it('createPromptsByBrand persists normalized intent from the request body', async () => {
      const thenable = (v) => ({ then: (resolve) => resolve(v), catch: () => thenable(v) });
      const insertStub = sandbox.stub()
        .returns({ select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) });
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        if (table === 'prompts') {
          return {
            select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
            insert: insertStub,
            update: () => ({ eq: () => thenable({ error: null }) }),
          };
        }
        const chain = {
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: { id: BRAND_UUID }, error: null }),
        };
        if (table === 'llmo_customer_config') {
          chain.maybeSingle = sandbox.stub()
            .resolves({ data: { config: { customer: { brands: [] } } }, error: null });
        }
        return chain;
      });

      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        // legacy 'commercial' -> 'transactional'; uppercase lowercased; bogus -> null
        data: [{ prompt: 'P', regions: ['us'], intent: 'COMMERCIAL' }],
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(201);
      const inserted = insertStub.firstCall.args[0];
      expect(inserted[0].intent).to.equal('transactional');
    });

    it('createPromptsByBrand returns 400 when prompts not an array', async () => {
      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: {},
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(400);
    });

    it('createPromptsByBrand returns 400 when prompts is empty array', async () => {
      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: [],
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(400);
    });

    it('createPromptsByBrand returns 400 when prompts exceed 3000', async () => {
      const manyPrompts = Array.from({ length: 3001 }, (_, i) => ({ prompt: `Prompt ${i}`, regions: [] }));
      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: manyPrompts,
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(400);
    });

    it('createPromptsByBrand returns 500 when storage throws', async () => {
      const rejectingThenable = { then: (resolve, reject) => reject(new Error('Insert failed')) };
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        if (table === 'prompts') {
          return {
            select: () => ({ eq: () => ({ eq: () => rejectingThenable }) }),
            insert: () => ({ select: () => rejectingThenable }),
            update: () => ({ eq: () => rejectingThenable }),
          };
        }
        const chain = {
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: { id: BRAND_UUID }, error: null }),
        };
        if (table === 'llmo_customer_config') {
          chain.maybeSingle = sandbox.stub()
            .resolves({ data: { config: { customer: { brands: [] } } }, error: null });
        }
        return chain;
      });

      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: [{ prompt: 'New', regions: [] }],
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(500);
    });

    it('createPromptsByBrand returns 409 and logs at warn (not error) when INSERT fails with 23505', async () => {
      const th = (v) => ({ then: (resolve) => resolve(v), catch: () => th(v) });
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        if (table === 'prompts') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  ...th({ data: [], error: null }),
                  in: () => th({ data: [], error: null }),
                }),
              }),
            }),
            insert: () => ({
              select: () => th({
                data: null,
                error: {
                  code: '23505',
                  message: 'duplicate key value violates unique constraint "uq_prompt_text_region_per_brand"',
                },
              }),
            }),
            update: () => ({ eq: () => th({ error: null }) }),
          };
        }
        const chain = {
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: { id: BRAND_UUID }, error: null }),
        };
        if (table === 'llmo_customer_config') {
          chain.maybeSingle = sandbox.stub()
            .resolves({ data: { config: { customer: { brands: [] } } }, error: null });
        }
        return chain;
      });
      loggerStub.warn.resetHistory();
      loggerStub.error.resetHistory();

      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: [{ id: 'p-1', prompt: 'Synthetic test prompt', regions: ['us'] }],
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(409);
      expect(loggerStub.warn).to.have.been.called;
      expect(loggerStub.error).to.not.have.been.called;
    });

    it('updatePromptByBrandAndId returns 200 when prompt updated', async () => {
      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        data: { prompt: 'Updated text' },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.id).to.equal(PROMPT_ID);
    });

    it('updatePromptByBrandAndId persists normalized intent from the request body', async () => {
      const thenable = (v) => ({ then: (resolve) => resolve(v), catch: () => thenable(v) });
      const updatedRow = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt text',
        regions: [],
        status: 'active',
        origin: 'human',
        intent: 'informational',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Test Brand' },
        categories: null,
        topics: null,
      };
      const single = (data) => ({ maybeSingle: () => thenable({ data, error: null }) });
      const updateStub = sandbox.stub().returns({
        eq: () => ({ eq: () => ({ eq: () => ({ select: () => single(updatedRow) }) }) }),
      });
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        if (table === 'brands') {
          return { select: () => ({ eq: () => ({ eq: () => single({ id: BRAND_UUID }) }) }) };
        }
        // prompts: update path + the getPromptById re-read
        return {
          update: updateStub,
          select: () => ({ eq: () => ({ eq: () => ({ eq: () => single(updatedRow) }) }) }),
        };
      });

      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        // legacy 'statistical' -> 'informational'
        data: { intent: 'Statistical' },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(200);
      expect(updateStub.firstCall.args[0].intent).to.equal('informational');
      const body = await response.json();
      expect(body.intent).to.equal('informational');
    });

    it('updatePromptByBrandAndId uses empty object when data is undefined', async () => {
      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        data: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
    });

    it('updatePromptByBrandAndId uses system when no auth email', async () => {
      const contextNoEmail = { ...context, attributes: undefined };
      const response = await brandsController.updatePromptByBrandAndId({
        ...contextNoEmail,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
    });

    it('updatePromptByBrandAndId returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.updatePromptByBrandAndId({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(403);
    });

    it('updatePromptByBrandAndId returns 404 when prompt not found', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => ({
        select: sandbox.stub().returnsThis(),
        eq: sandbox.stub().returnsThis(),
        neq: sandbox.stub().returnsThis(),
        order: sandbox.stub().returnsThis(),
        update: sandbox.stub().returnsThis(),
        range: sandbox.stub().resolves({ data: [], error: null, count: 0 }),
        maybeSingle: sandbox.stub().callsFake(() => {
          if (table === 'brands') {
            return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
          }
          if (table === 'llmo_customer_config') {
            return Promise.resolve({
              data: { config: { customer: { brands: [] } } }, error: null,
            });
          }
          if (table === 'prompts') {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      }));

      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: 'nonexistent' },
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(404);
    });

    it('deletePromptByBrandAndId returns 204 when prompt deleted', async () => {
      const response = await brandsController.deletePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(204);
    });

    it('deletePromptByBrandAndId returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.deletePromptByBrandAndId({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(403);
    });

    it('deletePromptByBrandAndId returns 404 when prompt not found', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => ({
        select: sandbox.stub().returnsThis(),
        eq: sandbox.stub().returnsThis(),
        neq: sandbox.stub().returnsThis(),
        order: sandbox.stub().returnsThis(),
        update: sandbox.stub().returnsThis(),
        range: sandbox.stub().resolves({ data: [], error: null, count: 0 }),
        maybeSingle: sandbox.stub().callsFake(() => {
          if (table === 'brands') {
            return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
          }
          if (table === 'llmo_customer_config') {
            return Promise.resolve({
              data: { config: { customer: { brands: [] } } }, error: null,
            });
          }
          if (table === 'prompts') {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      }));

      const response = await brandsController.deletePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: 'nonexistent' },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(404);
    });

    it('updatePromptByBrandAndId returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        const chain = {
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          range: sandbox.stub().resolves({ data: [], error: null, count: 0 }),
          maybeSingle: sandbox.stub().callsFake(() => {
            if (table === 'brands') {
              return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
            }
            if (table === 'llmo_customer_config') {
              return Promise.resolve({
                data: { config: { customer: { brands: [] } } }, error: null,
              });
            }
            if (table === 'prompts') {
              return Promise.reject(new Error('DB connection lost'));
            }
            return Promise.resolve({ data: null, error: null });
          }),
        };
        return chain;
      });

      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(500);
    });

    it('deletePromptByBrandAndId returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        const chain = {
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          range: sandbox.stub().resolves({ data: [], error: null, count: 0 }),
          maybeSingle: sandbox.stub().callsFake(() => {
            if (table === 'brands') {
              return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
            }
            if (table === 'llmo_customer_config') {
              return Promise.resolve({
                data: { config: { customer: { brands: [] } } }, error: null,
              });
            }
            if (table === 'prompts') {
              return Promise.reject(new Error('DB connection lost'));
            }
            return Promise.resolve({ data: null, error: null });
          }),
        };
        return chain;
      });

      const response = await brandsController.deletePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(500);
    });

    // --- listPromptsByBrand: params undefined & org not found ---

    it('listPromptsByBrand returns 400 when params is undefined', async () => {
      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('listPromptsByBrand returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('listPromptsByBrand returns 404 when brand not found', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: 'nonexistent' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    // --- getPromptByBrandAndId: validation, org not found, postgrest ---

    it('getPromptByBrandAndId returns 400 when params is undefined', async () => {
      const response = await brandsController.getPromptByBrandAndId({
        ...context,
        params: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('getPromptByBrandAndId returns 400 when spaceCatId is missing', async () => {
      const response = await brandsController.getPromptByBrandAndId({
        ...context,
        params: { brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('getPromptByBrandAndId returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.getPromptByBrandAndId({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('getPromptByBrandAndId returns 400 when brandId is missing', async () => {
      const response = await brandsController.getPromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('getPromptByBrandAndId returns 400 when promptId is missing', async () => {
      const response = await brandsController.getPromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('getPromptByBrandAndId returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.getPromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('getPromptByBrandAndId returns 503 when postgrestClient is not available', async () => {
      mockDataAccess.services.postgrestClient = null;

      const response = await brandsController.getPromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('getPromptByBrandAndId returns 404 when brand not found', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.getPromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: 'nonexistent', promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    // --- createPromptsByBrand: validation, org not found, postgrest ---

    it('createPromptsByBrand returns 400 when params is undefined', async () => {
      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: undefined,
        data: [{ prompt: 'New', regions: [] }],
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('createPromptsByBrand returns 400 when spaceCatId is missing', async () => {
      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { brandId: BRAND_UUID },
        data: [{ prompt: 'New', regions: [] }],
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('createPromptsByBrand returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID },
        data: [{ prompt: 'New', regions: [] }],
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('createPromptsByBrand returns 400 when brandId is missing', async () => {
      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: [{ prompt: 'New', regions: [] }],
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('createPromptsByBrand returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: [{ prompt: 'New', regions: [] }],
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('createPromptsByBrand returns 503 when postgrestClient is not available', async () => {
      mockDataAccess.services.postgrestClient = null;

      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: [{ prompt: 'New', regions: [] }],
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('createPromptsByBrand returns 404 when brand not found', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: 'nonexistent' },
        data: [{ prompt: 'New', regions: [] }],
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    // --- updatePromptByBrandAndId: validation, org not found, postgrest ---

    it('updatePromptByBrandAndId returns 400 when params is undefined', async () => {
      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: undefined,
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('updatePromptByBrandAndId returns 400 when spaceCatId is missing', async () => {
      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { brandId: BRAND_UUID, promptId: PROMPT_ID },
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('updatePromptByBrandAndId returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID, promptId: PROMPT_ID },
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('updatePromptByBrandAndId returns 400 when brandId is missing', async () => {
      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, promptId: PROMPT_ID },
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('updatePromptByBrandAndId returns 400 when promptId is missing', async () => {
      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('updatePromptByBrandAndId returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('updatePromptByBrandAndId returns 503 when postgrestClient is not available', async () => {
      mockDataAccess.services.postgrestClient = null;

      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('updatePromptByBrandAndId returns 404 when brand not found', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updatePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: 'nonexistent', promptId: PROMPT_ID },
        data: { prompt: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    // --- deletePromptByBrandAndId: validation, org not found, postgrest ---

    it('deletePromptByBrandAndId returns 400 when params is undefined', async () => {
      const response = await brandsController.deletePromptByBrandAndId({
        ...context,
        params: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('deletePromptByBrandAndId returns 400 when spaceCatId is missing', async () => {
      const response = await brandsController.deletePromptByBrandAndId({
        ...context,
        params: { brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('deletePromptByBrandAndId returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.deletePromptByBrandAndId({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('deletePromptByBrandAndId returns 400 when brandId is missing', async () => {
      const response = await brandsController.deletePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('deletePromptByBrandAndId returns 400 when promptId is missing', async () => {
      const response = await brandsController.deletePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('deletePromptByBrandAndId returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deletePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('deletePromptByBrandAndId returns 503 when postgrestClient is not available', async () => {
      mockDataAccess.services.postgrestClient = null;

      const response = await brandsController.deletePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID, promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('deletePromptByBrandAndId returns 404 when brand not found', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deletePromptByBrandAndId({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: 'nonexistent', promptId: PROMPT_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });
  });

  describe('bulkDeletePromptsByBrand', () => {
    const BRAND_UUID = 'd1111111-1111-4111-b111-111111111111';

    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake((table) => {
          const chain = {
            select: sandbox.stub().returnsThis(),
            eq: sandbox.stub().returnsThis(),
            neq: sandbox.stub().returnsThis(),
            order: sandbox.stub().returnsThis(),
            update: sandbox.stub().returnsThis(),
            range: sandbox.stub().resolves({ data: [], error: null, count: 0 }),
            maybeSingle: sandbox.stub().callsFake(() => {
              if (table === 'brands') {
                return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
              }
              if (table === 'llmo_customer_config') {
                return Promise.resolve({
                  data: { config: { customer: { brands: [] } } },
                  error: null,
                });
              }
              if (table === 'prompts') {
                return Promise.resolve({ data: { id: 'row-id' }, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            }),
          };
          return chain;
        }),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 400 when promptIds is missing', async () => {
      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('promptIds');
    });

    it('returns 400 when promptIds is empty', async () => {
      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { promptIds: [] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when promptIds exceeds 100', async () => {
      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { promptIds: Array.from({ length: 101 }, (_, i) => `p${i}`) },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: undefined,
        data: { promptIds: ['p1'] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID },
        data: { promptIds: ['p1'] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { promptIds: ['p1'] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 400 when spaceCatId is missing', async () => {
      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: { brandId: BRAND_UUID },
        data: { promptIds: ['p1'] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when brandId is missing', async () => {
      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { promptIds: ['p1'] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 200 with bulk delete result', async () => {
      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { promptIds: ['p1', 'p2'] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('metadata');
      expect(body.metadata).to.have.property('total', 2);
      expect(body.metadata).to.have.property('success');
      expect(body).to.have.property('failures').that.is.an('array');
    });

    it('returns 404 when brand not found', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        const chain = {
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          range: sandbox.stub().resolves({ data: [], error: null, count: 0 }),
          maybeSingle: sandbox.stub().callsFake(() => {
            if (table === 'brands') {
              return Promise.resolve({ data: null, error: null });
            }
            if (table === 'llmo_customer_config') {
              return Promise.resolve({
                data: { config: { customer: { brands: [] } } },
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        };
        return chain;
      });

      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: 'nonexistent' },
        data: { promptIds: ['p1'] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is not available', async () => {
      mockDataAccess.services.postgrestClient = null;

      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { promptIds: ['p1'] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.bulkDeletePromptsByBrand({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { promptIds: ['p1'] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB error')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { promptIds: ['p1'] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });

    it('returns 400 when both params and data are undefined', async () => {
      const response = await brandsController.bulkDeletePromptsByBrand({
        ...context,
        params: undefined,
        data: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });
  });

  describe('checkPromptsByBrand', () => {
    const BRAND_UUID = 'd1111111-1111-4111-b111-111111111111';
    const VALID_PROMPTS = [
      { text: 'What are generative credits?', region: 'gb' },
      { text: 'How do I cancel?', region: 'us' },
    ];

    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake((table) => {
          const chain = {
            select: sandbox.stub().returnsThis(),
            eq: sandbox.stub().returnsThis(),
            neq: sandbox.stub().returnsThis(),
            order: sandbox.stub().returnsThis(),
            range: sandbox.stub().resolves({ data: [], error: null, count: 0 }),
            maybeSingle: sandbox.stub().callsFake(() => {
              if (table === 'brands') {
                return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
              }
              if (table === 'llmo_customer_config') {
                return Promise.resolve({
                  data: { config: { customer: { brands: [] } } },
                  error: null,
                });
              }
              return Promise.resolve({ data: null, error: null });
            }),
          };
          return chain;
        }),
        rpc: sandbox.stub().resolves({ data: [VALID_PROMPTS[0]], error: null }),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: undefined,
        data: { prompts: VALID_PROMPTS },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is missing', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { brandId: BRAND_UUID },
        data: { prompts: VALID_PROMPTS },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID },
        data: { prompts: VALID_PROMPTS },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when brandId is missing', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { prompts: VALID_PROMPTS },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when prompts is missing', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('prompts');
    });

    it('returns 400 when prompts is empty', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: [] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when prompts exceeds 500', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: Array.from({ length: 501 }, (_, i) => ({ text: `p${i}`, region: 'us' })) },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when a prompt is missing region', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: [{ text: 'some prompt' }] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when a prompt is missing text', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: [{ region: 'us' }] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when a prompt item is null', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: [null] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when prompt text is whitespace only', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: [{ text: '   ', region: 'us' }] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when prompt region is whitespace only', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: [{ text: 'some prompt', region: '   ' }] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when prompt text exceeds 2000 chars', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: [{ text: 'x'.repeat(2001), region: 'us' }] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('accepts exactly 500 prompts', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: Array.from({ length: 500 }, (_, i) => ({ text: `p${i}`, region: 'us' })) },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
    });

    it('accepts prompt text of exactly 2000 chars', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: [{ text: 'x'.repeat(2000), region: 'us' }] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: VALID_PROMPTS },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is not available', async () => {
      mockDataAccess.services.postgrestClient = null;

      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: VALID_PROMPTS },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 404 when brand is not found', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        const chain = {
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          range: sandbox.stub().resolves({ data: [], error: null, count: 0 }),
          maybeSingle: sandbox.stub().callsFake(() => {
            if (table === 'brands') {
              return Promise.resolve({ data: null, error: null });
            }
            if (table === 'llmo_customer_config') {
              return Promise.resolve({
                data: { config: { customer: { brands: [] } } },
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        };
        return chain;
      });

      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: 'nonexistent' },
        data: { prompts: VALID_PROMPTS },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.checkPromptsByBrand({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: VALID_PROMPTS },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 200 with matching results on happy path', async () => {
      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: VALID_PROMPTS },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('results').that.is.an('array');
      expect(body.results).to.deep.equal([VALID_PROMPTS[0]]);
    });

    it('returns 500 when storage throws and logs structured error', async () => {
      const dbError = new Error('DB error');
      mockDataAccess.services.postgrestClient.rpc = sandbox.stub().rejects(dbError);

      const response = await brandsController.checkPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { prompts: VALID_PROMPTS },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
      expect(loggerStub.error).to.have.been.calledWith('Error checking prompts existence', {
        brandId: BRAND_UUID,
        error: dbError,
      });
    });
  });

  describe('getPromptStatsByBrand', () => {
    const BRAND_UUID = 'd1111111-1111-4111-b111-111111111111';
    // RPC returns flat intent_* fields; the storage layer transforms them to nested intents
    const STATS_RPC_ROW = {
      branded: 42,
      unbranded: 1208,
      intent_informational: 410,
      intent_instructional: 180,
      intent_comparative: 95,
      intent_transactional: 250,
      intent_planning: 60,
      intent_delegation: 15,
    };

    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake((table) => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().callsFake(() => {
            if (table === 'brands') {
              return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        })),
        rpc: sandbox.stub().resolves({ data: STATS_RPC_ROW, error: null }),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 400 when spaceCatId is missing', async () => {
      const response = await brandsController.getPromptStatsByBrand({
        ...context,
        params: { brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.getPromptStatsByBrand({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when brandId is missing', async () => {
      const response = await brandsController.getPromptStatsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById = sinon.stub().resolves(null);
      const response = await brandsController.getPromptStatsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access to the organization', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);
      const response = await unauthorizedController.getPromptStatsByBrand({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 503 when postgrestClient is not available', async () => {
      mockDataAccess.services.postgrestClient = null;
      const response = await brandsController.getPromptStatsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 404 when brand is not found', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake(() => ({
        select: sandbox.stub().returnsThis(),
        eq: sandbox.stub().returnsThis(),
        maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
      }));
      const response = await brandsController.getPromptStatsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 200 with the flat stats shape on success', async () => {
      const response = await brandsController.getPromptStatsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('branded', 42);
      expect(body).to.have.property('unbranded', 1208);
      expect(body.intents).to.deep.include({ informational: 410, delegation: 15 });
    });

    it('returns 500 when storage throws and logs the error', async () => {
      const dbError = new Error('RPC failure');
      mockDataAccess.services.postgrestClient.rpc = sandbox.stub().rejects(dbError);
      const response = await brandsController.getPromptStatsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
      expect(loggerStub.error).to.have.been.calledWith('Error fetching prompt stats', {
        brandId: BRAND_UUID,
        error: dbError,
      });
    });
  });

  describe('listBrandsForOrg', () => {
    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: [], error: null }),
          then: (resolve) => resolve({ data: [], error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 200 with brands list', async () => {
      const response = await brandsController.listBrandsForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
    });

    it('returns 404 when organization not found', async () => {
      mockDataAccess.Organization.findById = sinon.stub().resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.listBrandsForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.listBrandsForOrg({
        ...context,
        params: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.listBrandsForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.listBrandsForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 400 when spaceCatId is missing', async () => {
      const response = await brandsController.listBrandsForOrg({
        ...context,
        params: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.listBrandsForOrg({
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB error')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.listBrandsForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });
  });

  describe('getBrandForOrg', () => {
    const BRAND_UUID = 'a1111111-1111-4111-b111-111111111111';

    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({
            data: {
              id: BRAND_UUID,
              name: 'Test Brand',
              status: 'active',
              origin: 'human',
              updated_at: '2026-01-01T00:00:00Z',
              updated_by: 'user@test.com',
              brand_aliases: [],
              competitors: [],
              brand_sites: [],
            },
            error: null,
          }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 200 with the brand', async () => {
      const response = await brandsController.getBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.getBrandForOrg({
        ...context,
        params: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.getBrandForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when brandId is missing', async () => {
      const response = await brandsController.getBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.getBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.getBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 404 when brand not found during resolve', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.getBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 404 when getBrandById returns null', async () => {
      const maybeSingleStub = sandbox.stub();
      // First call: resolveBrandUuid succeeds
      maybeSingleStub.onFirstCall().resolves({ data: { id: BRAND_UUID }, error: null });
      // Second call: getBrandById finds nothing
      maybeSingleStub.onSecondCall().resolves({ data: null, error: null });

      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: maybeSingleStub,
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.getBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.getBrandForOrg({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB connection lost')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.getBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });
  });

  describe('getBrandForOrgSite', () => {
    const SAMPLE_BRAND = {
      id: 'b1111111-1111-4111-b111-111111111111',
      name: 'Acme',
      status: 'active',
    };

    /**
     * Build a BrandsController instance with resolveLlmoOnboardingMode and
     * getBrandBySite mocked to controllable return values. Other helpers
     * (resolveBrandUuid, listBrands, …) come through unchanged.
     */
    async function buildController({
      mode,
      brand,
      brandError,
    } = {}) {
      const resolveLlmoOnboardingModeStub = sinon.stub().resolves(mode);
      const getBrandBySiteStub = brandError
        ? sinon.stub().rejects(brandError)
        : sinon.stub().resolves(brand);

      const Mocked = await esmock('../../src/controllers/brands.js', {
        '../../src/support/llmo-onboarding-mode.js': {
          resolveLlmoOnboardingMode: resolveLlmoOnboardingModeStub,
          LLMO_ONBOARDING_MODE_V2: 'v2',
        },
        '../../src/support/brands-storage.js': {
          listBrands: sinon.stub().resolves([]),
          upsertBrand: sinon.stub(),
          updateBrand: sinon.stub(),
          deleteBrand: sinon.stub(),
          getBrandById: sinon.stub().resolves(null),
          getBrandBySite: getBrandBySiteStub,
        },
      });

      return {
        controller: Mocked(context, loggerStub, mockEnv),
        resolveLlmoOnboardingModeStub,
        getBrandBySiteStub,
      };
    }

    it('returns 200 with the brand when org is v2 and brand resolves', async () => {
      const {
        controller,
        resolveLlmoOnboardingModeStub,
        getBrandBySiteStub,
      } = await buildController({ mode: 'v2', brand: SAMPLE_BRAND });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SITE_ID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.deep.equal(SAMPLE_BRAND);
      expect(resolveLlmoOnboardingModeStub).to.have.been.calledOnce;
      const [orgArg, , optsArg] = resolveLlmoOnboardingModeStub.firstCall.args;
      expect(orgArg).to.equal(ORGANIZATION_ID);
      // readOnly: true is load-bearing — without it the resolver could write
      // to feature_flags from a GET (row-1 brandalf-revert side effect).
      expect(optsArg).to.deep.equal({ readOnly: true });
      expect(getBrandBySiteStub).to.have.been.calledOnce;
      expect(getBrandBySiteStub.firstCall.args[0]).to.equal(ORGANIZATION_ID);
      expect(getBrandBySiteStub.firstCall.args[1]).to.equal(SITE_ID);
    });

    it('returns 404 when resolver reports v1 (no v2 brand configured)', async () => {
      const { controller, getBrandBySiteStub } = await buildController({ mode: 'v1' });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SITE_ID },
        dataAccess: mockDataAccess,
      });

      expect(response.status).to.equal(404);
      // Storage should not be called when resolver gates the request out.
      expect(getBrandBySiteStub).to.not.have.been.called;
    });

    it('returns 404 when org is v2 but site has no active brand', async () => {
      const { controller } = await buildController({ mode: 'v2', brand: null });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SITE_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 400 when params is undefined', async () => {
      const { controller } = await buildController({ mode: 'v2', brand: SAMPLE_BRAND });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const { controller } = await buildController({ mode: 'v2', brand: SAMPLE_BRAND });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: { spaceCatId: 'not-a-uuid', siteId: SITE_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when siteId is missing', async () => {
      const { controller } = await buildController({ mode: 'v2', brand: SAMPLE_BRAND });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when siteId is not a valid UUID', async () => {
      const { controller } = await buildController({ mode: 'v2', brand: SAMPLE_BRAND });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: 'not-a-uuid' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      const { controller } = await buildController({ mode: 'v2', brand: SAMPLE_BRAND });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SITE_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const Mocked = await esmock('../../src/controllers/brands.js', {
        '../../src/support/llmo-onboarding-mode.js': {
          resolveLlmoOnboardingMode: sinon.stub().resolves('v2'),
          LLMO_ONBOARDING_MODE_V2: 'v2',
        },
        '../../src/support/brands-storage.js': {
          listBrands: sinon.stub().resolves([]),
          upsertBrand: sinon.stub(),
          updateBrand: sinon.stub(),
          deleteBrand: sinon.stub(),
          getBrandById: sinon.stub().resolves(null),
          getBrandBySite: sinon.stub().resolves(SAMPLE_BRAND),
        },
      });
      const unauthorizedController = Mocked({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.getBrandForOrgSite({
        params: { spaceCatId: ORGANIZATION_ID, siteId: SITE_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 404 when site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const { controller } = await buildController({ mode: 'v2', brand: SAMPLE_BRAND });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SITE_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when site does not belong to the organization', async () => {
      const otherOrgSite = {
        getOrganizationId: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      };
      mockDataAccess.Site.findById.resolves(otherOrgSite);
      const { controller, getBrandBySiteStub } = await buildController({
        mode: 'v2',
        brand: SAMPLE_BRAND,
      });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SITE_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
      // Resolver and storage should never be reached when site/org mismatch.
      expect(getBrandBySiteStub).to.not.have.been.called;
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      const { controller } = await buildController({ mode: 'v2', brand: SAMPLE_BRAND });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SITE_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 500 when storage throws', async () => {
      const { controller } = await buildController({
        mode: 'v2',
        brandError: new Error('DB connection lost'),
      });

      const response = await controller.getBrandForOrgSite({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SITE_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });
  });

  describe('listCategoriesForOrg', () => {
    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          then: (resolve) => resolve({ data: [], error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 200 with categories list', async () => {
      const response = await brandsController.listCategoriesForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.listCategoriesForOrg({
        ...context,
        params: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is missing', async () => {
      const response = await brandsController.listCategoriesForOrg({
        ...context,
        params: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.listCategoriesForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.listCategoriesForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.listCategoriesForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.listCategoriesForOrg({
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB error')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.listCategoriesForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });
  });

  describe('createCategoryForOrg', () => {
    const CATEGORY_ROW = {
      id: 'cat-uuid',
      category_id: 'my-category',
      name: 'My Category',
      status: 'active',
      origin: 'human',
      updated_at: '2026-01-01T00:00:00Z',
      updated_by: 'user@test.com',
    };

    beforeEach(() => {
      // Lookup returns null (not found) on first .maybeSingle(), and .single()
      // (from insert path) resolves the happy-path row. Tests that want the
      // "existing row" path override maybeSingle to return CATEGORY_ROW.
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          insert: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          upsert: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
          single: sandbox.stub().resolves({
            data: CATEGORY_ROW,
            error: null,
          }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 201 when category is created', async () => {
      const response = await brandsController.createCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'My Category' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(201);
      const body = await response.json();
      expect(body).to.have.property('name', 'My Category');
    });

    it('returns 400 when category data is missing', async () => {
      const response = await brandsController.createCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: null,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when category name is missing', async () => {
      const response = await brandsController.createCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { origin: 'human' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.createCategoryForOrg({
        ...context,
        params: undefined,
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.createCategoryForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid' },
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.createCategoryForOrg({
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 503 when postgrestClient is not available', async () => {
      mockDataAccess.services.postgrestClient = null;

      const response = await brandsController.createCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB error')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });

    it('returns 200 with the existing row when a category with the same name already exists (idempotent update)', async () => {
      const existingRow = {
        id: 'uuid-existing',
        category_id: 'baseurl-discovery-research',
        name: 'Discovery & Research',
        status: 'active',
        origin: 'human',
        updated_at: '2026-03-15T00:00:00Z',
        updated_by: 'tester@adobe.com',
      };
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          insert: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          upsert: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: existingRow, error: null }),
          single: sandbox.stub().resolves({ data: existingRow, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        // Client posts a stray `id`; it is ignored. The stable UUID PK is
        // authoritative and is what `id` reflects (LLMO-5515).
        data: { id: 'discovery-research', name: 'Discovery & Research' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'tester@adobe.com' } } },
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      // `id` is now the UUID primary key (== `uuid`), not the retired
      // category_id business key.
      expect(body.id).to.equal('uuid-existing');
      expect(body.uuid).to.equal('uuid-existing');
    });

    it('returns 500 when the lookup-by-name query fails with a non-23505 PostgREST error', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          insert: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          upsert: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({
            data: null,
            error: {
              code: '23503',
              message: 'insert or update on table "categories" violates foreign key constraint "categories_org_fk"',
            },
          }),
          single: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'DupTest' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'tester@adobe.com' } } },
      });

      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.match(/Failed to lookup category by name/);
    });

    it('returns 409 and logs at warn (not error) when storage raises concurrent-hard-delete 409', async () => {
      // Storage surfaces the race as a typed 409. The controller must
      // mirror the topics pattern and demote these to WARN to avoid
      // re-polluting Coralogix ERROR severity — the explicit goal of
      // LLMO-4370.
      const existingRow = {
        id: 'uuid-vanishing',
        category_id: 'vanishing',
        name: 'Vanishing',
        status: 'active',
        origin: 'human',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
      };
      // Shared across every .from() call, so the first maybeSingle() (the
      // lookup) finds the row and the second (post-update) returns null —
      // simulating the row being hard-deleted between the two round-trips.
      const sharedMaybeSingle = sandbox.stub();
      sharedMaybeSingle.onCall(0).resolves({ data: existingRow, error: null });
      sharedMaybeSingle.onCall(1).resolves({ data: null, error: null });
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          maybeSingle: sharedMaybeSingle,
        })),
      };
      loggerStub.warn.resetHistory();
      loggerStub.error.resetHistory();
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        // Force the update path (differing status) so the race path is hit.
        data: { name: 'Vanishing', status: 'pending' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'tester@adobe.com' } } },
      });

      expect(response.status).to.equal(409);
      expect(loggerStub.warn).to.have.been.called;
      expect(loggerStub.error).to.not.have.been.called;
    });

    it('logs the outcome tag for post-deploy Coralogix quantification', async () => {
      loggerStub.info.resetHistory();
      await brandsController.createCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'My Category' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      // info call includes {organization_id, category_id, outcome} for
      // aggregatable log-storm metrics — see LLMO-4370 #15.
      expect(loggerStub.info).to.have.been.called;
      const infoCall = loggerStub.info.getCalls().find(
        (c) => /Category POST resolved/.test(c.args[0] || ''),
      );
      expect(infoCall).to.exist;
      expect(infoCall.args[1]).to.have.property('outcome', 'insert');
      expect(infoCall.args[1]).to.have.property('organization_id', ORGANIZATION_ID);
    });
  });

  describe('updateCategoryForOrg', () => {
    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({
            data: {
              id: 'cat-uuid',
              category_id: 'my-category',
              name: 'Updated Category',
              status: 'active',
              origin: 'human',
              updated_at: '2026-01-02T00:00:00Z',
              updated_by: 'user@test.com',
            },
            error: null,
          }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 200 when category is updated', async () => {
      const response = await brandsController.updateCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        data: { name: 'Updated Category' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('name', 'Updated Category');
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.updateCategoryForOrg({
        ...context,
        params: undefined,
        data: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.updateCategoryForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid', categoryId: CATEGORY_UUID },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when categoryId is missing', async () => {
      const response = await brandsController.updateCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when categoryId is not a valid UUID (business keys retired, LLMO-5515)', async () => {
      const response = await brandsController.updateCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 404 when category not found', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.updateCategoryForOrg({
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB error')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });

    it('returns 409 and logs at warn when PATCH name collides with a sibling in the same org', async () => {
      // Storage layer maps 23505 on `uq_category_name_per_org` to a typed
      // 409. The controller must surface that at WARN to keep the PATCH
      // path symmetric with POST's no-storm contract. LLMO-4370 #9.
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "uq_category_name_per_org"',
            },
          }),
        })),
      };
      loggerStub.warn.resetHistory();
      loggerStub.error.resetHistory();
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        data: { name: 'Collides With Sibling' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'tester@adobe.com' } } },
      });

      expect(response.status).to.equal(409);
      expect(loggerStub.warn).to.have.been.called;
      expect(loggerStub.error).to.not.have.been.called;
    });
  });

  describe('deleteCategoryForOrg', () => {
    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: { id: 'cat-uuid' }, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 204 when category is deleted', async () => {
      const response = await brandsController.deleteCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(204);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.deleteCategoryForOrg({
        ...context,
        params: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.deleteCategoryForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid', categoryId: CATEGORY_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when categoryId is missing', async () => {
      const response = await brandsController.deleteCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when categoryId is not a valid UUID (business keys retired, LLMO-5515)', async () => {
      const response = await brandsController.deleteCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 404 when category not found', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.deleteCategoryForOrg({
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB connection lost')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: CATEGORY_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });
  });

  describe('listTopicsForOrg', () => {
    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          then: (resolve) => resolve({ data: [], error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 200 with topics list', async () => {
      const response = await brandsController.listTopicsForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.listTopicsForOrg({
        ...context,
        params: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is missing', async () => {
      const response = await brandsController.listTopicsForOrg({
        ...context,
        params: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.listTopicsForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.listTopicsForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.listTopicsForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.listTopicsForOrg({
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB error')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.listTopicsForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        invocation: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });
  });

  describe('createTopicForOrg', () => {
    beforeEach(() => {
      // createTopic in topics-storage.js uses .single() for the upsert and
      // then re-fetches the row with .maybeSingle() so the response carries
      // the topic_categories embed (categoryUuids). Both must be stubbed.
      const topicRow = {
        id: 'topic-uuid',
        topic_id: 'my-topic',
        name: 'My Topic',
        description: null,
        status: 'active',
        brand_id: null,
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'user@test.com',
      };
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          upsert: sandbox.stub().returnsThis(),
          single: sandbox.stub().resolves({ data: topicRow, error: null }),
          maybeSingle: sandbox.stub().resolves({ data: topicRow, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 201 when topic is created', async () => {
      const response = await brandsController.createTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'My Topic' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(201);
      const body = await response.json();
      expect(body).to.have.property('name', 'My Topic');
    });

    it('returns 400 when topic data is missing', async () => {
      const response = await brandsController.createTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: null,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when topic name is missing', async () => {
      const response = await brandsController.createTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { description: 'some description' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.createTopicForOrg({
        ...context,
        params: undefined,
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.createTopicForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid' },
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.createTopicForOrg({
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 503 when postgrestClient is not available', async () => {
      mockDataAccess.services.postgrestClient = null;

      const response = await brandsController.createTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB error')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'Test' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });

    it('returns 409 and logs at warn (not error) when the storage layer raises a 23505 unique violation', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          upsert: sandbox.stub().returnsThis(),
          single: sandbox.stub().resolves({
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "uq_topic_per_org"',
              details: '',
              hint: '',
            },
          }),
        })),
      };
      loggerStub.warn.resetHistory();
      loggerStub.error.resetHistory();
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'DupTopic' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'tester@adobe.com' } } },
      });

      expect(response.status).to.equal(409);
      const body = await response.json();
      expect(body.message).to.include('A topic with these attributes already exists');
      expect(loggerStub.warn).to.have.been.called;
      expect(loggerStub.error).to.not.have.been.called;
    });
  });

  describe('updateTopicForOrg', () => {
    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({
            data: {
              id: 'topic-uuid',
              topic_id: 'my-topic',
              name: 'Updated Topic',
              description: null,
              status: 'active',
              brand_id: null,
              updated_at: '2026-01-02T00:00:00Z',
              updated_by: 'user@test.com',
            },
            error: null,
          }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 200 when topic is updated', async () => {
      const response = await brandsController.updateTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'my-topic' },
        data: { name: 'Updated Topic' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('name', 'Updated Topic');
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.updateTopicForOrg({
        ...context,
        params: undefined,
        data: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.updateTopicForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid', topicId: 'my-topic' },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when topicId is missing', async () => {
      const response = await brandsController.updateTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'my-topic' },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'my-topic' },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 404 when topic not found', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'nonexistent' },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.updateTopicForOrg({
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'my-topic' },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB error')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'my-topic' },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });
  });

  describe('deleteTopicForOrg', () => {
    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: { id: 'topic-uuid' }, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 204 when topic is deleted', async () => {
      const response = await brandsController.deleteTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'my-topic' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(204);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.deleteTopicForOrg({
        ...context,
        params: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.deleteTopicForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid', topicId: 'my-topic' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when topicId is missing', async () => {
      const response = await brandsController.deleteTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'my-topic' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'my-topic' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 404 when topic not found', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'nonexistent' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.deleteTopicForOrg({
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'my-topic' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB connection lost')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteTopicForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, topicId: 'my-topic' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });
  });

  describe('listPromptsByBrand - query params forwarding', () => {
    const BRAND_UUID = 'd1111111-1111-4111-b111-111111111111';

    beforeEach(() => {
      const promptRow = {
        id: BRAND_UUID,
        prompt_id: 'prompt-1',
        name: 'Test Prompt',
        text: 'What is the best product?',
        regions: ['us'],
        status: 'active',
        origin: 'human',
        source: 'config',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Test Brand' },
        categories: null,
        topics: null,
      };
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake((table) => {
          const chain = {
            select: sandbox.stub().returnsThis(),
            eq: sandbox.stub().returnsThis(),
            neq: sandbox.stub().returnsThis(),
            order: sandbox.stub().returnsThis(),
            update: sandbox.stub().returnsThis(),
            or: sandbox.stub().returnsThis(),
            contains: sandbox.stub().returnsThis(),
            overlaps: sandbox.stub().returnsThis(),
            range: sandbox.stub().resolves({
              data: table === 'prompts' ? [promptRow] : [],
              error: null,
              count: 1,
            }),
            maybeSingle: sandbox.stub().callsFake(() => {
              if (table === 'brands') {
                return Promise.resolve({ data: { id: BRAND_UUID }, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            }),
          };
          return chain;
        }),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('forwards search param and returns 200', async () => {
      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        invocation: { event: { rawQueryString: 'search=product' } },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.items).to.be.an('array');
    });

    it('forwards sort and order params and returns 200', async () => {
      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        invocation: { event: { rawQueryString: 'sort=topic&order=asc' } },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
    });

    it('forwards region param and returns 200', async () => {
      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        invocation: { event: { rawQueryString: 'region=us' } },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
    });

    it('forwards origin param and returns 200', async () => {
      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        invocation: { event: { rawQueryString: 'origin=ai' } },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
    });

    it('returns prompt items from normalized tables', async () => {
      const response = await brandsController.listPromptsByBrand({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.items[0]).to.have.property('id');
    });
  });

  describe('createBrandForOrg', () => {
    const BRAND_UUID = 'a1111111-1111-4111-b111-111111111111';

    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          in: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          upsert: sandbox.stub().returnsThis(),
          delete: sandbox.stub().returnsThis(),
          single: sandbox.stub().resolves({
            data: { id: BRAND_UUID, name: 'New Brand' },
            error: null,
          }),
          maybeSingle: sandbox.stub().resolves({
            data: {
              id: BRAND_UUID,
              name: 'New Brand',
              // 'pending' = no active same-name brand exists (a fresh-create
              // precondition); avoids tripping the LLMO-5587 demotion guard, which
              // only fires when an upsert-by-name would demote an *active* brand.
              status: 'pending',
              origin: 'human',
              updated_at: '2026-01-01T00:00:00Z',
              updated_by: 'user@test.com',
              brand_aliases: [],
              brand_social_accounts: [],
              brand_earned_sources: [],
              competitors: [],
              brand_sites: [],
            },
            error: null,
          }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 201 when brand is created', async () => {
      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        // baseSiteId keeps the brand active (an active brand requires a base site);
        // without it the upsert would compute `pending` onto the same-name active
        // brand the mock returns, which the LLMO-5587 demotion guard rejects.
        data: { name: 'New Brand', baseSiteId: 'b2222222-2222-4222-b222-222222222222' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(201);
    });

    it('returns 409 when a by-name create would demote an active brand to pending (LLMO-5587)', async () => {
      // An ACTIVE brand of the same name already exists; a create carrying
      // status:'pending' would silently demote it via the (org, name) upsert.
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          in: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          upsert: sandbox.stub().returnsThis(),
          single: sandbox.stub().resolves({ data: { id: BRAND_UUID, name: 'New Brand' }, error: null }),
          maybeSingle: sandbox.stub().resolves({
            data: {
              id: BRAND_UUID, name: 'New Brand', site_id: 'site-1', status: 'active',
            },
            error: null,
          }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'New Brand', status: 'pending' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(409);
    });

    it('returns 400 when brand data is missing', async () => {
      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: null,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    describe('serenity-first provisioning (semrushMarket present)', () => {
      const semrushData = {
        name: 'New Brand',
        urls: [{ value: 'https://acme.com/path' }],
        semrushMarket: { market: 'us', languageCode: 'en' },
        semrushModelIds: ['model-a', 'model-b'],
      };

      async function buildController({
        provisionBrandSubworkspace, upsertBrand, ensureMarketSite,
      }) {
        const Mocked = await esmock('../../src/controllers/brands.js', {
          '../../src/support/serenity/brand-provisioning.js': { provisionBrandSubworkspace },
          // Stub the site mirror by default so these tests stay isolated from the
          // Site/brand_sites side effect; a test that cares passes its own stub.
          '../../src/support/serenity/site-linkage.js': {
            ensureMarketSite: ensureMarketSite || sinon.stub().resolves('site-x'),
          },
          ...(upsertBrand ? { '../../src/support/brands-storage.js': { upsertBrand } } : {}),
        });
        return Mocked.default(context, loggerStub, mockEnv);
      }

      it('provisions the sub-workspace then creates the brand bound to it (201)', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const upsertStub = sinon.stub().resolves({ id: 'forced-id', name: 'New Brand' });
        const controller = await buildController({
          provisionBrandSubworkspace: provisionStub, upsertBrand: upsertStub,
        });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: { ...semrushData },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(provisionStub.calledOnce).to.equal(true);
        const provisionArgs = provisionStub.firstCall.args[1];
        expect(provisionArgs.market).to.equal('us');
        expect(provisionArgs.languageCode).to.equal('en');
        expect(provisionArgs.brandDomain).to.equal('acme.com');
        expect(provisionArgs.brandName).to.equal('New Brand');
        expect(provisionArgs.modelIds).to.deep.equal(['model-a', 'model-b']);
        // provisioning happens before the row is written, and its outputs are
        // persisted onto the row.
        expect(upsertStub.calledOnce).to.equal(true);
        expect(upsertStub.calledAfter(provisionStub)).to.equal(true);
        const upsertArgs = upsertStub.firstCall.args[0];
        expect(upsertArgs.forceBrandId).to.equal(provisionArgs.brandId);
        expect(upsertArgs.semrushWorkspaceId).to.equal('ws-1');
      });

      it('mirrors the provisioned brand domain as a Site (+ brand_sites link) after the row is written', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const upsertStub = sinon.stub().resolves({ id: 'forced-id', name: 'New Brand' });
        const ensureSiteStub = sinon.stub().resolves('site-x');
        const controller = await buildController({
          provisionBrandSubworkspace: provisionStub,
          upsertBrand: upsertStub,
          ensureMarketSite: ensureSiteStub,
        });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: { ...semrushData },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(ensureSiteStub).to.have.been.calledOnce;
        // runs after the brand row is persisted (compensation safety)
        expect(ensureSiteStub.calledAfter(upsertStub)).to.equal(true);
        const opts = ensureSiteStub.firstCall.args[1];
        expect(opts.organizationId).to.equal(ORGANIZATION_ID);
        expect(opts.domain).to.equal('acme.com');
        expect(opts.brandId).to.equal(provisionStub.firstCall.args[1].brandId);
      });

      it('does NOT mirror a Site for a pending (draft) brand — nothing is provisioned yet', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const upsertStub = sinon.stub().resolves({ id: 'draft-id', name: 'New Brand', status: 'pending' });
        const ensureSiteStub = sinon.stub().resolves('site-x');
        const controller = await buildController({
          provisionBrandSubworkspace: provisionStub,
          upsertBrand: upsertStub,
          ensureMarketSite: ensureSiteStub,
        });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: { ...semrushData, status: 'pending' },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(provisionStub).to.not.have.been.called;
        expect(ensureSiteStub).to.not.have.been.called;
      });

      it('forwards the brand URL sources (urls + social + earned) to provisioning', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const upsertStub = sinon.stub().resolves({ id: 'forced-id', name: 'New Brand' });
        const controller = await buildController({
          provisionBrandSubworkspace: provisionStub, upsertBrand: upsertStub,
        });

        const social = [{ url: 'https://x.com/acme', regions: ['us'] }];
        const earned = [{ name: 'News', url: 'https://news/acme', regions: [] }];
        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: { ...semrushData, socialAccounts: social, earnedContent: earned },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(provisionStub.firstCall.args[1].brandUrlSources).to.deep.equal({
          urls: semrushData.urls,
          socialAccounts: social,
          earnedContent: earned,
        });
      });

      it('forwards the brand competitors to provisioning', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const upsertStub = sinon.stub().resolves({ id: 'forced-id', name: 'New Brand' });
        const controller = await buildController({
          provisionBrandSubworkspace: provisionStub, upsertBrand: upsertStub,
        });

        const competitors = [{ name: 'Rival', url: 'https://rival.com', regions: ['us'] }];
        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: { ...semrushData, competitors },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(provisionStub.firstCall.args[1].competitors).to.deep.equal(competitors);
      });

      it('returns the provisioning error and does NOT create the brand on failure', async () => {
        const err = new Error('Organization has no Semrush workspace configured');
        err.status = 400;
        const provisionStub = sinon.stub().rejects(err);
        const upsertStub = sinon.stub().resolves({ id: 'x' });
        const controller = await buildController({
          provisionBrandSubworkspace: provisionStub, upsertBrand: upsertStub,
        });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: { ...semrushData },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(400);
        expect(upsertStub.called).to.equal(false);
      });

      it('releases the orphaned sub-workspace when the brand row write fails after provisioning', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-orphan' });
        const releaseStub = sinon.stub().resolves();
        // A routine post-provision DB failure (e.g. unique-constraint 409).
        const upsertStub = sinon.stub().rejects(new Error('duplicate key value violates unique constraint'));
        const Mocked = await esmock('../../src/controllers/brands.js', {
          '../../src/support/serenity/brand-provisioning.js': {
            provisionBrandSubworkspace: provisionStub,
            releaseProvisionedWorkspace: releaseStub,
          },
          '../../src/support/brands-storage.js': { upsertBrand: upsertStub },
        });
        const controller = Mocked.default(context, loggerStub, mockEnv);

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: { ...semrushData },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        // The DB write failed, so the create still errors out...
        expect(response.status).to.not.equal(201);
        expect(provisionStub.calledOnce).to.equal(true);
        // ...but the provisioned-yet-unreferenced sub-workspace is released back
        // to the parent pool, not leaked.
        expect(releaseStub.calledOnce).to.equal(true);
        expect(releaseStub.firstCall.args[1]).to.equal('ws-orphan');
      });

      it('returns 400 when semrushMarket lacks a languageCode', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const controller = await buildController({ provisionBrandSubworkspace: provisionStub });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: { name: 'New Brand', urls: [{ value: 'https://acme.com' }], semrushMarket: { market: 'us' } },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(400);
        expect(provisionStub.called).to.equal(false);
      });

      it('returns 400 when semrushModelIds is missing or empty and generatePrompts is true', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const controller = await buildController({ provisionBrandSubworkspace: provisionStub });

        // generatePrompts:true → a prompt-generating project, which needs a model.
        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: {
            name: 'New Brand',
            urls: [{ value: 'https://acme.com' }],
            semrushMarket: { market: 'us', languageCode: 'en' },
            generatePrompts: true,
          },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(400);
        expect(provisionStub.called).to.equal(false);
      });

      it('returns 400 when generatePrompts is true but no market/language was supplied', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const controller = await buildController({ provisionBrandSubworkspace: provisionStub });

        // generatePrompts true signals Semrush mode even with no semrushMarket, but
        // generating prompts needs a project → market+language are required.
        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: {
            name: 'New Brand',
            urls: [{ value: 'https://acme.com' }],
            generatePrompts: true,
          },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(400);
        expect(provisionStub.called).to.equal(false);
      });

      it('provisions WITHOUT models when generatePrompts is false (model-less project allowed)', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const upsertStub = sinon.stub().resolves({ id: 'forced-id', name: 'New Brand' });
        const controller = await buildController({
          provisionBrandSubworkspace: provisionStub, upsertBrand: upsertStub,
        });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: {
            name: 'New Brand',
            urls: [{ value: 'https://acme.com' }],
            semrushMarket: { market: 'us', languageCode: 'en' },
            generatePrompts: false,
          },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(provisionStub.called).to.equal(true);
        // generateTopics is threaded through as false.
        expect(provisionStub.firstCall.args[1].generateTopics).to.equal(false);
        expect(provisionStub.firstCall.args[1].modelIds).to.deep.equal([]);
      });

      it('returns 400 when no primary URL is present to derive a domain', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const controller = await buildController({ provisionBrandSubworkspace: provisionStub });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: { name: 'New Brand', urls: [], semrushMarket: { market: 'us', languageCode: 'en' } },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(400);
        expect(provisionStub.called).to.equal(false);
      });

      it('does NOT provision when no semrushMarket is supplied (flat create)', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const controller = await buildController({ provisionBrandSubworkspace: provisionStub });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: { name: 'New Brand' },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(provisionStub.called).to.equal(false);
      });

      it('saves a pending draft WITHOUT a primary URL: no provisioning, market stashed (201)', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const upsertStub = sinon.stub().resolves({ id: 'draft-id', name: 'New Brand', status: 'pending' });
        const controller = await buildController({
          provisionBrandSubworkspace: provisionStub, upsertBrand: upsertStub,
        });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          // status pending, market chosen, but NO urls — the wizard's "Save as
          // pending" from the Primary URL step.
          data: {
            name: 'New Brand',
            status: 'pending',
            urls: [],
            semrushMarket: { market: 'us', languageCode: 'en' },
          },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        // Provisioning is deferred for a draft.
        expect(provisionStub.called).to.equal(false);
        // The market is stashed for activation; no primary URL yet.
        const upsertArgs = upsertStub.firstCall.args[0];
        expect(upsertArgs.brand.pendingSemrushProvisioning).to.deep.equal({
          primaryUrl: null,
          markets: [{ market: 'us', languageCode: 'en' }],
          generatePrompts: false,
        });
        // A draft is never bound to a workspace at create time.
        expect(upsertArgs.semrushWorkspaceId).to.equal(null);
        expect(upsertArgs.forceBrandId).to.equal(null);
      });

      it('stashes the primary URL on a pending draft when one was entered (still no provisioning)', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const upsertStub = sinon.stub().resolves({ id: 'draft-id', name: 'New Brand', status: 'pending' });
        const controller = await buildController({
          provisionBrandSubworkspace: provisionStub, upsertBrand: upsertStub,
        });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: {
            name: 'New Brand',
            status: 'pending',
            urls: [{ value: 'https://acme.com/path' }],
            semrushMarket: { market: 'us', languageCode: 'en' },
          },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(provisionStub.called).to.equal(false);
        expect(upsertStub.firstCall.args[0].brand.pendingSemrushProvisioning).to.deep.equal({
          primaryUrl: 'https://acme.com/path',
          markets: [{ market: 'us', languageCode: 'en' }],
          generatePrompts: false,
        });
      });

      it('stashes the primary URL from a bare STRING url entry on a pending draft', async () => {
        // The wizard may send `urls` as plain strings rather than { value }
        // objects; the pending primaryUrl resolution must accept either shape.
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const upsertStub = sinon.stub().resolves({ id: 'draft-id', name: 'New Brand', status: 'pending' });
        const controller = await buildController({
          provisionBrandSubworkspace: provisionStub, upsertBrand: upsertStub,
        });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: {
            name: 'New Brand',
            status: 'pending',
            // Plain strings, not { value } objects.
            urls: ['https://acme.com/path'],
            semrushMarket: { market: 'us', languageCode: 'en' },
          },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(provisionStub.called).to.equal(false);
        expect(upsertStub.firstCall.args[0].brand.pendingSemrushProvisioning).to.deep.equal({
          primaryUrl: 'https://acme.com/path',
          markets: [{ market: 'us', languageCode: 'en' }],
          generatePrompts: false,
        });
      });

      it('seeds the initial market modelIds from semrushModelIds on a pending draft (no provisioning)', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const upsertStub = sinon.stub().resolves({ id: 'draft-id', name: 'New Brand', status: 'pending' });
        const controller = await buildController({
          provisionBrandSubworkspace: provisionStub, upsertBrand: upsertStub,
        });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: {
            name: 'New Brand',
            status: 'pending',
            urls: [{ value: 'https://acme.com' }],
            semrushMarket: { market: 'us', languageCode: 'en' },
            // The wizard's model picks: unlike the direct path they are optional
            // for a draft, but when present they seed the initial market.
            semrushModelIds: ['chatgpt', 'perplexity'],
          },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(provisionStub.called).to.equal(false);
        expect(upsertStub.firstCall.args[0].brand.pendingSemrushProvisioning).to.deep.equal({
          primaryUrl: 'https://acme.com',
          markets: [{ market: 'us', languageCode: 'en', modelIds: ['chatgpt', 'perplexity'] }],
          generatePrompts: false,
        });
      });

      it('still requires market and languageCode even for a pending draft', async () => {
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-1' });
        const controller = await buildController({ provisionBrandSubworkspace: provisionStub });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: { name: 'New Brand', status: 'pending', semrushMarket: { market: 'us' } },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(400);
        expect(provisionStub.called).to.equal(false);
      });
    });

    it('returns 400 when brand name is missing', async () => {
      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { description: 'No name' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when brand guidance fields have the wrong type', async () => {
      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'New Brand', brandContext: { text: 'wrong' } },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when brand guidance fields are longer than 4000 characters', async () => {
      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'New Brand', mentionSentimentGuidance: 'x'.repeat(4001) },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('accepts brand guidance that trims to within the limit despite surrounding whitespace', async () => {
      // 4004 raw characters, but 4000 after trim — storage trims before persisting,
      // so the controller validates the trimmed length and must not reject this.
      const padded = `  ${'x'.repeat(4000)}  `;
      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'New Brand', brandContext: padded },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(201);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.createBrandForOrg({
        ...context,
        params: undefined,
        data: { name: 'New Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'New Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid' },
        data: { name: 'New Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.createBrandForOrg({
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'New Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 503 when postgrestClient is not available', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'New Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB error')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'New Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });

    describe('competitor self-reference guard + Semrush-mode gating (create)', () => {
      async function buildCreateController({ upsertBrand, provisionBrandSubworkspace }) {
        const mocks = { '../../src/support/brands-storage.js': { upsertBrand } };
        if (provisionBrandSubworkspace) {
          mocks['../../src/support/serenity/brand-provisioning.js'] = { provisionBrandSubworkspace };
        }
        const Mocked = await esmock('../../src/controllers/brands.js', mocks);
        return Mocked.default(context, loggerStub, mockEnv);
      }

      it('strips a self-referential competitor on create (its own primary URL)', async () => {
        const upsertStub = sinon.stub().resolves({ id: BRAND_UUID, name: 'New Brand' });
        const controller = await buildCreateController({ upsertBrand: upsertStub });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: {
            name: 'New Brand',
            urls: [{ value: 'https://acme.com' }],
            competitors: [
              { name: 'Self', url: 'https://acme.com' },
              { name: 'Real Rival', url: 'https://rival.com' },
            ],
          },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        const { brand } = upsertStub.firstCall.firstArg;
        expect(brand.competitors.map((c) => c.url)).to.deep.equal(['https://rival.com']);
        expect(loggerStub.info).to.have.been.calledWithMatch(
          'brands: dropped self-referential competitor(s) on create',
        );
      });

      it('keeps competitors when the brand payload carries no resolvable own domain', async () => {
        // brandDomainFromPayload returns null (urls is empty), so the reserved
        // list starts EMPTY (primaryDomain falsy → []). No competitor matches a
        // reserved own-property domain, so nothing is dropped.
        const upsertStub = sinon.stub().resolves({ id: BRAND_UUID, name: 'No Domain Brand' });
        const controller = await buildCreateController({ upsertBrand: upsertStub });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: {
            name: 'No Domain Brand',
            // No urls → brandDomainFromPayload() === null → reserved = [].
            competitors: [
              { name: 'Rival A', url: 'https://rival-a.com' },
              { name: 'Rival B', url: 'https://rival-b.com' },
            ],
          },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        const { brand } = upsertStub.firstCall.firstArg;
        // Nothing dropped: both competitors survive.
        expect(brand.competitors.map((c) => c.url)).to.deep.equal([
          'https://rival-a.com',
          'https://rival-b.com',
        ]);
      });

      it('does NOT enter Semrush mode for a flat create carrying generatePrompts:false (no market)', async () => {
        // Regression guard: a flat (non-Semrush) caller that defensively sends
        // generatePrompts:false with no semrushMarket must be created as a plain
        // brand — never pulled into Semrush provisioning.
        const upsertStub = sinon.stub().resolves({ id: BRAND_UUID, name: 'Flat Brand' });
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-x' });
        const controller = await buildCreateController({
          upsertBrand: upsertStub,
          provisionBrandSubworkspace: provisionStub,
        });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: {
            name: 'Flat Brand',
            urls: [{ value: 'https://flat.com' }],
            generatePrompts: false,
          },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(provisionStub.called).to.equal(false);
        // Plain row written, not bound to any Semrush workspace.
        expect(upsertStub.firstCall.firstArg.semrushWorkspaceId).to.equal(null);
        expect(upsertStub.firstCall.firstArg.brand.pendingSemrushProvisioning).to.equal(undefined);
      });

      it('STILL enters Semrush mode for a PENDING draft with generatePrompts:false and no market', async () => {
        // The boolean-presence signal is preserved for drafts: a pending brand
        // with generatePrompts:false and no market is a legitimate
        // sub-workspace-only Semrush draft and must stash deferred provisioning.
        const upsertStub = sinon.stub().resolves({ id: 'draft-id', name: 'Draft', status: 'pending' });
        const provisionStub = sinon.stub().resolves({ semrushWorkspaceId: 'ws-x' });
        const controller = await buildCreateController({
          upsertBrand: upsertStub,
          provisionBrandSubworkspace: provisionStub,
        });

        const response = await controller.createBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID },
          data: {
            name: 'Draft',
            status: 'pending',
            generatePrompts: false,
          },
          dataAccess: mockDataAccess,
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(201);
        expect(provisionStub.called).to.equal(false);
        // Treated as Semrush mode → deferred-provisioning stash written.
        expect(upsertStub.firstCall.firstArg.brand.pendingSemrushProvisioning).to.deep.equal({
          primaryUrl: null,
          markets: [],
          generatePrompts: false,
        });
      });
    });
  });

  describe('updateBrandForOrg', () => {
    const BRAND_UUID = 'a1111111-1111-4111-b111-111111111111';

    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          in: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          upsert: sandbox.stub().returnsThis(),
          delete: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({
            data: {
              id: BRAND_UUID,
              name: 'Updated Brand',
              status: 'active',
              origin: 'human',
              updated_at: '2026-01-02T00:00:00Z',
              updated_by: 'user@test.com',
              brand_aliases: [],
              brand_social_accounts: [],
              brand_earned_sources: [],
              competitors: [],
              brand_sites: [],
            },
            error: null,
          }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 200 when brand is updated', async () => {
      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { name: 'Updated Brand' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(200);
    });

    async function buildUpdateController({
      updateBrand,
      syncBrandUrlsAcrossMarkets = sinon.stub().resolves({}),
      createSerenityTransport,
      syncCompetitorBenchmarksAcrossMarkets = sinon.stub().resolves({ rejected: [] }),
      syncBrandAliasesAcrossMarkets = sinon.stub().resolves({ rejected: [] }),
      getBrandCompetitors = sinon.stub().resolves([]),
      getBrandById,
    }) {
      // Only override getBrandById when a test supplies one; otherwise leave the
      // real export in place (partial esmock keeps the rest of the module real).
      const brandsStorageMock = { updateBrand, getBrandCompetitors };
      if (getBrandById) {
        brandsStorageMock.getBrandById = getBrandById;
      }
      const Mocked = await esmock('../../src/controllers/brands.js', {
        '../../src/support/brands-storage.js': brandsStorageMock,
        '../../src/support/prompts-storage.js': { resolveBrandUuid: sinon.stub().resolves(BRAND_UUID) },
        '../../src/support/serenity/rest-transport.js': { createSerenityTransport },
        '../../src/support/serenity/brand-urls.js': { syncBrandUrlsAcrossMarkets },
        // removedCompetitorDomains is left REAL so the diff logic is exercised.
        '../../src/support/serenity/competitor-benchmarks.js': { syncCompetitorBenchmarksAcrossMarkets },
        '../../src/support/serenity/brand-aliases.js': { syncBrandAliasesAcrossMarkets },
      });
      return Mocked.default(context, loggerStub, mockEnv);
    }

    it('re-syncs brand URLs across markets when a URL field changes on a sub-workspace brand', async () => {
      const updated = {
        id: BRAND_UUID,
        name: 'Updated Brand',
        semrushWorkspaceId: 'ws-9',
        urls: [{ value: 'https://acme.com' }],
        socialAccounts: [],
        earnedContent: [],
      };
      const updateBrandStub = sinon.stub().resolves(updated);
      const syncStub = sinon.stub().resolves({ markets: 1, created: 1, deleted: 0 });
      const transport = { name: 't', listProjects: sinon.stub().resolves({ items: [] }) };
      const createTransportStub = sinon.stub().returns(transport);
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        syncBrandUrlsAcrossMarkets: syncStub,
        createSerenityTransport: createTransportStub,
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { socialAccounts: [{ url: 'https://x.com/acme', regions: ['us'] }] },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(200);
      expect(createTransportStub).to.have.been.calledOnce;
      expect(syncStub).to.have.been.calledOnceWith(
        transport,
        { urls: [{ value: 'https://acme.com' }], socialAccounts: [], earnedContent: [] },
        'ws-9',
      );
    });

    it('forwards baseSiteId: null to storage so a pending brand can unset its primary URL (LLMO-5870)', async () => {
      const updateBrandStub = sinon.stub().resolves({ id: BRAND_UUID, name: 'Updated Brand' });
      const controller = await buildUpdateController({ updateBrand: updateBrandStub });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { baseSiteId: null },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(200);
      // The controller must not strip an explicit null — it is the unset signal the
      // storage layer gates on `existing.status === 'pending'`.
      expect(updateBrandStub.firstCall.args[0].updates).to.have.property('baseSiteId', null);
    });

    it('re-syncs brand aliases across markets when brandAliases changes on a sub-workspace brand', async () => {
      const updated = {
        id: BRAND_UUID,
        name: 'Updated Brand',
        semrushWorkspaceId: 'ws-9',
        brandAliases: [{ name: 'Acme', regions: [] }, { name: 'Acme DE', regions: ['de'] }],
      };
      const updateBrandStub = sinon.stub().resolves(updated);
      const aliasSyncStub = sinon.stub().resolves({ rejected: [] });
      const transport = { name: 't', listProjects: sinon.stub().resolves({ items: [] }) };
      const createTransportStub = sinon.stub().returns(transport);
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        syncBrandAliasesAcrossMarkets: aliasSyncStub,
        createSerenityTransport: createTransportStub,
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { brandAliases: [{ name: 'Acme', regions: [] }] },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(200);
      expect(aliasSyncStub).to.have.been.calledOnceWith(
        transport,
        updated.brandAliases,
        'Updated Brand',
        'ws-9',
      );
    });

    it('surfaces semrushRejectedAliases on the response when Semrush refuses some aliases', async () => {
      const updated = {
        id: BRAND_UUID,
        name: 'Updated Brand',
        semrushWorkspaceId: 'ws-9',
        brandAliases: [{ name: 'bogus', regions: [] }],
      };
      const rejected = [{
        projectId: 'p-us', market: 'us', domain: 'brand.com', aliases: ['bogus'],
      }];
      const controller = await buildUpdateController({
        updateBrand: sinon.stub().resolves(updated),
        syncBrandAliasesAcrossMarkets: sinon.stub().resolves({ rejected }),
        createSerenityTransport: sinon.stub().returns({ name: 't', listProjects: sinon.stub().resolves({ items: [] }) }),
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { brandAliases: [{ name: 'bogus', regions: [] }] },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.semrushRejectedAliases).to.deep.equal(rejected);
    });

    it('does NOT re-sync when the edit touches no URL field', async () => {
      const updateBrandStub = sinon.stub().resolves({ id: BRAND_UUID, semrushWorkspaceId: 'ws-9' });
      const syncStub = sinon.stub().resolves({});
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        syncBrandUrlsAcrossMarkets: syncStub,
        createSerenityTransport: sinon.stub(),
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { description: 'just a description change' },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(200);
      expect(syncStub).to.not.have.been.called;
    });

    it('strips pendingSemrushProvisioning from a PATCH when the brand is NOT pending (no runtime injection)', async () => {
      // The describe-level postgrest mock resolves the brand with status:'active',
      // so the pending-only guard strips the stash an attacker tried to inject.
      const updateBrandStub = sinon.stub().resolves({ id: BRAND_UUID, semrushWorkspaceId: null });
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        syncBrandUrlsAcrossMarkets: sinon.stub().resolves({}),
        createSerenityTransport: sinon.stub(),
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: {
          description: 'legit edit',
          // An attacker-supplied stash that activation would otherwise trust.
          pendingSemrushProvisioning: {
            primaryUrl: 'https://evil.example',
            markets: [{ market: 'us', languageCode: 'en' }],
          },
        },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(200);
      expect(updateBrandStub).to.have.been.calledOnce;
      const { updates } = updateBrandStub.firstCall.args[0];
      expect(updates).to.not.have.property('pendingSemrushProvisioning');
    });

    it('keeps pendingSemrushProvisioning on a PATCH when the brand IS pending (draft Markets-tab edit)', async () => {
      // The draft Markets tab appends a market (with its LLMs) by PATCHing the
      // stash; the pending-only guard must let it through for a pending brand.
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake(() => ({
        select: sandbox.stub().returnsThis(),
        eq: sandbox.stub().returnsThis(),
        maybeSingle: sandbox.stub().resolves({ data: { status: 'pending' }, error: null }),
      }));
      const updateBrandStub = sinon.stub().resolves({ id: BRAND_UUID, semrushWorkspaceId: null });
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        syncBrandUrlsAcrossMarkets: sinon.stub().resolves({}),
        createSerenityTransport: sinon.stub(),
      });

      const stash = {
        primaryUrl: 'https://acme.com',
        markets: [{ market: 'us', languageCode: 'en', modelIds: ['chatgpt'] }],
      };
      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { pendingSemrushProvisioning: stash },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(200);
      expect(updateBrandStub).to.have.been.calledOnce;
      const { updates } = updateBrandStub.firstCall.args[0];
      expect(updates.pendingSemrushProvisioning).to.deep.equal(stash);
    });

    it('strips pendingSemrushProvisioning when a PATCH would flip a pending brand to active', async () => {
      // Going active is the serenity activate endpoint's job, not PATCH's: a
      // PATCH that sets status:'active' must not also carry a staging stash.
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake(() => ({
        select: sandbox.stub().returnsThis(),
        eq: sandbox.stub().returnsThis(),
        maybeSingle: sandbox.stub().resolves({ data: { status: 'pending' }, error: null }),
      }));
      const updateBrandStub = sinon.stub().resolves({ id: BRAND_UUID, semrushWorkspaceId: null });
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        syncBrandUrlsAcrossMarkets: sinon.stub().resolves({}),
        createSerenityTransport: sinon.stub(),
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: {
          status: 'active',
          pendingSemrushProvisioning: {
            primaryUrl: 'https://acme.com',
            markets: [{ market: 'us', languageCode: 'en' }],
          },
        },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(200);
      const { updates } = updateBrandStub.firstCall.args[0];
      expect(updates).to.not.have.property('pendingSemrushProvisioning');
    });

    it('does NOT re-sync a flat-mode brand (no sub-workspace) even when URLs change', async () => {
      const updateBrandStub = sinon.stub().resolves({
        id: BRAND_UUID, semrushWorkspaceId: null, urls: [], socialAccounts: [], earnedContent: [],
      });
      const syncStub = sinon.stub().resolves({});
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        syncBrandUrlsAcrossMarkets: syncStub,
        createSerenityTransport: sinon.stub(),
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { urls: [{ value: 'https://acme.com' }] },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(200);
      expect(syncStub).to.not.have.been.called;
    });

    it('hard-fails the edit when the brand-URL re-sync fails', async () => {
      const updateBrandStub = sinon.stub().resolves({
        id: BRAND_UUID, semrushWorkspaceId: 'ws-9', urls: [], socialAccounts: [], earnedContent: [],
      });
      const err = new Error('upstream boom');
      err.status = 502;
      const syncStub = sinon.stub().rejects(err);
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        syncBrandUrlsAcrossMarkets: syncStub,
        createSerenityTransport: sinon.stub().returns({ name: 't', listProjects: sinon.stub().resolves({ items: [] }) }),
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { urls: [{ value: 'https://acme.com' }] },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(502);
      expect(syncStub).to.have.been.calledOnce;
    });

    it('rejects a non-IMS caller on the brand-edit re-sync (never forwards the bearer upstream)', async () => {
      const updateBrandStub = sinon.stub().resolves({
        id: BRAND_UUID, semrushWorkspaceId: 'ws-9', urls: [], socialAccounts: [], earnedContent: [],
      });
      const syncStub = sinon.stub().resolves({});
      const createTransportStub = sinon.stub().returns({ name: 't', listProjects: sinon.stub().resolves({ items: [] }) });
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        syncBrandUrlsAcrossMarkets: syncStub,
        createSerenityTransport: createTransportStub,
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { urls: [{ value: 'https://acme.com' }] },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer s2s-tok' } },
        attributes: { authInfo: { getType: () => 'jwt', profile: { email: 'svc@test.com' } } },
      });

      expect(response.status).to.equal(401);
      // A non-IMS bearer is never built into a transport nor forwarded to Semrush.
      expect(createTransportStub).to.not.have.been.called;
      expect(syncStub).to.not.have.been.called;
    });

    it('redacts the gateway URL from a Semrush upstream error on brand-edit re-sync', async () => {
      const updateBrandStub = sinon.stub().resolves({
        id: BRAND_UUID, semrushWorkspaceId: 'ws-9', urls: [], socialAccounts: [], earnedContent: [],
      });
      const leakUrl = 'https://gw.internal/enterprise/workspaces/ws-9/projects/proj-abc/aio';
      const syncStub = sinon.stub().rejects(
        new SerenityTransportError(502, `Semrush POST ${leakUrl} failed: 502`, {}),
      );
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        syncBrandUrlsAcrossMarkets: syncStub,
        createSerenityTransport: sinon.stub().returns({ name: 't', listProjects: sinon.stub().resolves({ items: [] }) }),
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { urls: [{ value: 'https://acme.com' }] },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(502);
      const body = await response.json();
      expect(body.message).to.equal('Upstream request failed');
      expect(JSON.stringify(body)).to.not.contain('gw.internal');
      // ...and not via the x-error header either.
      expect(response.headers.get('x-error') || '').to.not.contain('gw.internal');
    });

    // createErrorResponse lines 196-197: a SerenityTransportError whose status IS
    // 401/403 is passed through as that status with the 'Upstream authorization
    // failed' message (the true side of the status ternary and the false side of
    // the message ternary; the 502 sides are covered by the redaction test above).
    it('maps a 401 Semrush upstream error to HTTP 401 + generic auth message', async () => {
      const updateBrandStub = sinon.stub().resolves({
        id: BRAND_UUID, semrushWorkspaceId: 'ws-9', urls: [], socialAccounts: [], earnedContent: [],
      });
      const leakUrl = 'https://gw.internal/enterprise/workspaces/ws-9/projects/proj-abc/aio';
      const syncStub = sinon.stub().rejects(
        new SerenityTransportError(401, `Semrush POST ${leakUrl} failed: 401`, {}),
      );
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        syncBrandUrlsAcrossMarkets: syncStub,
        createSerenityTransport: sinon.stub().returns({ name: 't', listProjects: sinon.stub().resolves({ items: [] }) }),
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { urls: [{ value: 'https://acme.com' }] },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(401);
      const body = await response.json();
      expect(body.message).to.equal('Upstream authorization failed');
      // The internal gateway URL must not leak via body or header.
      expect(JSON.stringify(body)).to.not.contain('gw.internal');
      expect(response.headers.get('x-error') || '').to.not.contain('gw.internal');
    });

    it('re-syncs CI competitors (with removed domains) when competitors change on a sub-workspace brand', async () => {
      const updated = {
        id: BRAND_UUID,
        name: 'Updated Brand',
        semrushWorkspaceId: 'ws-9',
        competitors: [{ name: 'Rival', url: 'https://rival.com', regions: ['us'] }],
      };
      const updateBrandStub = sinon.stub().resolves(updated);
      const ciSyncStub = sinon.stub().resolves({ markets: 1, changed: 1 });
      const transport = { name: 't', listProjects: sinon.stub().resolves({ items: [] }) };
      const createTransportStub = sinon.stub().returns(transport);
      // Old list had an extra competitor that is now gone → it must be reported removed.
      const getBrandCompetitorsStub = sinon.stub().resolves([
        { url: 'https://rival.com', regions: ['us'] },
        { url: 'https://gone.com', regions: ['us'] },
      ]);
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        createSerenityTransport: createTransportStub,
        syncCompetitorBenchmarksAcrossMarkets: ciSyncStub,
        getBrandCompetitors: getBrandCompetitorsStub,
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { competitors: [{ name: 'Rival', url: 'https://rival.com', regions: ['us'] }] },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(200);
      // old competitors read BEFORE the update to compute removals.
      expect(getBrandCompetitorsStub).to.have.been.calledOnceWith(BRAND_UUID);
      expect(getBrandCompetitorsStub).to.have.been.calledBefore(updateBrandStub);
      // sync gets the NEW competitor list, the removed domain, and the workspace.
      expect(ciSyncStub).to.have.been.calledOnceWith(
        transport,
        updated.competitors,
        ['gone.com'],
        'ws-9',
      );
    });

    it('does NOT re-sync competitors when the edit leaves them untouched', async () => {
      const updateBrandStub = sinon.stub().resolves({
        id: BRAND_UUID, semrushWorkspaceId: 'ws-9', urls: [], socialAccounts: [], earnedContent: [],
      });
      const ciSyncStub = sinon.stub().resolves({});
      const getBrandCompetitorsStub = sinon.stub().resolves([]);
      const controller = await buildUpdateController({
        updateBrand: updateBrandStub,
        createSerenityTransport: sinon.stub().returns({ name: 't', listProjects: sinon.stub().resolves({ items: [] }) }),
        syncCompetitorBenchmarksAcrossMarkets: ciSyncStub,
        getBrandCompetitors: getBrandCompetitorsStub,
      });

      const response = await controller.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { urls: [{ value: 'https://acme.com' }] },
        dataAccess: mockDataAccess,
        pathInfo: { headers: { authorization: 'Bearer tok' } },
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });

      expect(response.status).to.equal(200);
      expect(getBrandCompetitorsStub).to.not.have.been.called;
      expect(ciSyncStub).to.not.have.been.called;
    });

    it('returns 409 when demoting an active brand to pending (LLMO-5587)', async () => {
      // beforeEach mock resolves a persisted brand with status 'active'; a generic
      // PATCH carrying status:'pending' must be rejected (and emit BrandDemotionBlocked).
      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { status: 'pending' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(409);
    });

    it('emits the BrandDemotionBlocked metric on a rejected demotion (LLMO-5587)', async () => {
      // The EMF emitter writes the envelope to stdout via console.log; spy that
      // sink and assert the emitted metric rather than mocking the emitter.
      const logSpy = sinon.stub(console, 'log');
      try {
        const response = await brandsController.updateBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
          data: { status: 'pending' },
          dataAccess: mockDataAccess,
          pathInfo: { headers: { 'x-product': 'llmo' } },
          attributes: { authInfo: { profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(409);
        const emfLine = logSpy.getCalls()
          .map((c) => c.args[0])
          .find((l) => typeof l === 'string' && l.includes('BrandDemotionBlocked'));
        expect(emfLine, 'expected a BrandDemotionBlocked EMF line').to.be.a('string');
        const envelope = JSON.parse(emfLine);
        expect(envelope.BrandDemotionBlocked).to.equal(1);
        expect(envelope.Operation).to.equal('updateBrand');
        expect(envelope.Product).to.equal('llmo');
        // eslint-disable-next-line no-underscore-dangle
        expect(envelope._aws.CloudWatchMetrics[0].Namespace).to.equal('Mysticat/Brands');
      } finally {
        logSpy.restore();
      }
    });

    it('swallows a logging failure during emission and still returns 409 (LLMO-5587, best-effort)', async () => {
      // emitMetric is already best-effort; this proves emitBrandDemotionBlocked's own
      // catch keeps a logger failure from breaking the request path (covers the catch).
      const logSpy = sinon.stub(console, 'log');
      const throwingLogger = {
        info: sandbox.stub(),
        error: sandbox.stub(),
        warn: sandbox.stub().throws(new Error('log boom')),
        debug: sandbox.stub(),
      };
      const controller = BrandsController(context, throwingLogger, mockEnv);
      try {
        const response = await controller.updateBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
          data: { status: 'pending' },
          dataAccess: mockDataAccess,
          pathInfo: { headers: { 'x-product': 'llmo' } },
          attributes: { authInfo: { profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(409);
        expect(throwingLogger.warn).to.have.been.called;
      } finally {
        logSpy.restore();
      }
    });

    it('returns 400 when brandId is missing', async () => {
      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { name: 'Updated Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: undefined,
        data: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID },
        data: { name: 'Updated Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when brand guidance update fields have the wrong type', async () => {
      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { mentionSentimentGuidance: ['wrong'] },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when brand guidance update fields are longer than 4000 characters', async () => {
      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { brandContext: 'x'.repeat(4001) },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { name: 'Updated Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { name: 'Updated Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 404 when brand not found during resolve', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { name: 'Updated Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 404 when updateBrand returns null', async () => {
      const maybeSingleStub = sandbox.stub();
      // First call: resolveBrandUuid succeeds
      maybeSingleStub.onFirstCall().resolves({
        data: { id: BRAND_UUID },
        error: null,
      });
      // Second call: updateBrand returns null (brand update returns no data)
      maybeSingleStub.onSecondCall().resolves({ data: null, error: null });

      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: maybeSingleStub,
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { name: 'Updated Brand' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.updateBrandForOrg({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { name: 'Updated Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB connection lost')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { name: 'Updated Brand' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });

    describe('competitor self-reference guard', () => {
      it('strips a self-referential competitor on a FLAT brand update (own website URL)', async () => {
        // Flat brand (no semrushWorkspaceId): reserved domains = primary + own
        // website URLs. A competitor whose domain is one of those must be dropped
        // before persist (it would benchmark the brand against itself).
        const updateBrandStub = sinon.stub().resolves({ id: BRAND_UUID, name: 'Flat Brand' });
        const getBrandByIdStub = sinon.stub().resolves({
          id: BRAND_UUID,
          baseUrl: 'https://acme.com',
          urls: [{ value: 'https://shop.acme.com' }],
          semrushWorkspaceId: undefined,
        });
        const controller = await buildUpdateController({
          updateBrand: updateBrandStub,
          getBrandById: getBrandByIdStub,
        });

        const response = await controller.updateBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
          data: {
            competitors: [
              { name: 'Self', url: 'https://acme.com' },
              { name: 'Shop', url: 'https://shop.acme.com' },
              { name: 'Real Rival', url: 'https://rival.com' },
            ],
          },
          dataAccess: mockDataAccess,
          pathInfo: { headers: { authorization: 'Bearer tok' } },
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(200);
        // Both own-property competitors dropped; only the real rival persists.
        const { updates } = updateBrandStub.firstCall.firstArg;
        expect(updates.competitors.map((c) => c.url)).to.deep.equal(['https://rival.com']);
        expect(loggerStub.info).to.have.been.calledWithMatch(
          'brands: dropped self-referential competitor(s) on update',
        );
      });

      it('strips a self-referential competitor on a SEMRUSH brand update (a market/project domain)', async () => {
        // Semrush brand: reserved domains come from the project listing (every
        // market domain) plus the brand's own URLs. A competitor on a market
        // domain must be dropped.
        const updated = {
          id: BRAND_UUID,
          name: 'Semrush Brand',
          semrushWorkspaceId: 'ws-7',
          competitors: [{ name: 'Real Rival', url: 'https://rival.com' }],
        };
        const updateBrandStub = sinon.stub().resolves(updated);
        const getBrandByIdStub = sinon.stub().resolves({
          id: BRAND_UUID,
          baseUrl: null,
          urls: [],
          semrushWorkspaceId: 'ws-7',
        });
        const listProjectsStub = sinon.stub().resolves({
          items: [{ domain: 'market-de.acme.com' }, { domain: 'market-fr.acme.com' }],
        });
        const createTransportStub = sinon.stub().returns({ listProjects: listProjectsStub });
        const controller = await buildUpdateController({
          updateBrand: updateBrandStub,
          getBrandById: getBrandByIdStub,
          createSerenityTransport: createTransportStub,
        });

        const response = await controller.updateBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
          data: {
            competitors: [
              { name: 'Own Market', url: 'https://market-de.acme.com' },
              { name: 'Real Rival', url: 'https://rival.com' },
            ],
          },
          dataAccess: mockDataAccess,
          pathInfo: { headers: { authorization: 'Bearer tok' } },
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(200);
        // listProjects is read ONCE on a competitor edit: the pre-commit self-
        // reference guard lists the workspace and stashes the result, which the
        // post-commit shared sync reuses (same workspace id) instead of re-listing.
        expect(listProjectsStub).to.have.been.calledOnceWith('ws-7');
        const { updates } = updateBrandStub.firstCall.firstArg;
        expect(updates.competitors.map((c) => c.url)).to.deep.equal(['https://rival.com']);
        expect(loggerStub.info).to.have.been.calledWithMatch(
          'brands: dropped self-referential competitor(s) on update',
        );
      });

      it('uses the INCOMING urls (not the stored ones) when the same PATCH edits both urls and competitors', async () => {
        // The same PATCH changes urls AND competitors → the guard must reserve the
        // incoming urls (updates.urls !== undefined branch), so a competitor on a
        // freshly-added own URL is dropped even though it is not a stored URL.
        const updated = {
          id: BRAND_UUID,
          name: 'Flat Brand',
          semrushWorkspaceId: null,
          urls: [{ value: 'https://new.acme.com' }],
          socialAccounts: [],
          earnedContent: [],
          competitors: [{ name: 'Real Rival', url: 'https://rival.com' }],
        };
        const updateBrandStub = sinon.stub().resolves(updated);
        const getBrandByIdStub = sinon.stub().resolves({
          id: BRAND_UUID,
          baseUrl: 'https://acme.com',
          // Stored urls differ from the incoming ones; the guard must ignore these.
          urls: [{ value: 'https://old.acme.com' }],
          semrushWorkspaceId: undefined,
        });
        const controller = await buildUpdateController({
          updateBrand: updateBrandStub,
          getBrandById: getBrandByIdStub,
        });

        const response = await controller.updateBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
          data: {
            // Incoming urls (NOT the stored old.acme.com) drive the reserved set.
            urls: [{ value: 'https://new.acme.com' }],
            competitors: [
              { name: 'Incoming Own', url: 'https://new.acme.com' },
              { name: 'Real Rival', url: 'https://rival.com' },
            ],
          },
          dataAccess: mockDataAccess,
          pathInfo: { headers: { authorization: 'Bearer tok' } },
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(200);
        const { updates } = updateBrandStub.firstCall.firstArg;
        // The incoming own-URL competitor is dropped; the stored old URL is NOT
        // reserved (so a competitor on it would have survived).
        expect(updates.competitors.map((c) => c.url)).to.deep.equal(['https://rival.com']);
      });

      it('falls back to an empty own-URL set when the stored brand has no urls (competitor-only edit)', async () => {
        // Competitor-only PATCH (updates.urls === undefined → use stored), and the
        // stored brand has no `urls` field at all → brandState?.urls || [] fallback.
        const updateBrandStub = sinon.stub().resolves({ id: BRAND_UUID, name: 'Flat Brand' });
        const getBrandByIdStub = sinon.stub().resolves({
          id: BRAND_UUID,
          baseUrl: 'https://acme.com',
          // No `urls` key → brandState?.urls is undefined → `|| []` fallback.
          semrushWorkspaceId: undefined,
        });
        const controller = await buildUpdateController({
          updateBrand: updateBrandStub,
          getBrandById: getBrandByIdStub,
        });

        const response = await controller.updateBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
          data: {
            // No urls on the PATCH → updates.urls === undefined.
            competitors: [
              { name: 'Self', url: 'https://acme.com' },
              { name: 'Real Rival', url: 'https://rival.com' },
            ],
          },
          dataAccess: mockDataAccess,
          pathInfo: { headers: { authorization: 'Bearer tok' } },
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(200);
        const { updates } = updateBrandStub.firstCall.firstArg;
        // Only the baseUrl is reserved (no website URLs), so the primary self-ref
        // is dropped and the real rival survives.
        expect(updates.competitors.map((c) => c.url)).to.deep.equal(['https://rival.com']);
      });

      it('tolerates a listProjects result without an items array and an alias sync without a rejected list', async () => {
        // sharedListing has no `items` array → sharedProjects falls back to [];
        // syncBrandAliasesAcrossMarkets resolves undefined → rejected fallback [].
        const updated = {
          id: BRAND_UUID,
          name: 'Updated Brand',
          semrushWorkspaceId: 'ws-9',
          brandAliases: [{ name: 'Acme', regions: [] }],
        };
        const updateBrandStub = sinon.stub().resolves(updated);
        // Resolves an object with NO items key → Array.isArray(items) === false.
        const listProjectsStub = sinon.stub().resolves({});
        const createTransportStub = sinon.stub().returns({
          name: 't', listProjects: listProjectsStub,
        });
        // Resolves undefined → aliasResult?.rejected ?? [] hits the ?? fallback.
        const aliasSyncStub = sinon.stub().resolves(undefined);
        const controller = await buildUpdateController({
          updateBrand: updateBrandStub,
          createSerenityTransport: createTransportStub,
          syncBrandAliasesAcrossMarkets: aliasSyncStub,
        });

        const response = await controller.updateBrandForOrg({
          ...context,
          params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
          data: { brandAliases: [{ name: 'Acme', regions: [] }] },
          dataAccess: mockDataAccess,
          pathInfo: { headers: { authorization: 'Bearer tok' } },
          attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
        });

        expect(response.status).to.equal(200);
        expect(aliasSyncStub).to.have.been.calledOnce;
        // Empty fallback array passed to the alias sync (sharedProjects === []).
        expect(aliasSyncStub.firstCall.args[5]).to.deep.equal([]);
        const body = await response.json();
        // No rejected aliases accumulated (aliasResult?.rejected ?? [] → []), so
        // the response omits the semrushRejectedAliases key entirely.
        expect(body.semrushRejectedAliases).to.equal(undefined);
      });
    });
  });

  describe('activateBrandForOrg', () => {
    const BRAND_UUID = 'a1111111-1111-4111-b111-111111111111';

    // ---------------------------------------------------------------------------
    // Shared helpers
    // ---------------------------------------------------------------------------

    /**
     * Builds a controller with all dependencies mocked. Every option can be
     * overridden; sensible defaults are provided so individual tests only have
     * to vary the one thing they care about.
     */
    async function buildActivateController({
      hasAccess = async () => true,
      hasAdminAccess = () => true,
      isLLMOAdministrator = () => true,
      entitlement = { getTier: () => 'PAID' },
      resolveBrandUuidResult = BRAND_UUID,
      getBrandByIdResult = {
        id: BRAND_UUID,
        name: 'Acme',
        baseSiteId: SITE_ID,
        baseUrl: 'https://site1.com',
        region: ['us'],
        status: 'pending',
        urls: [],
      },
      updateBrandResult = { id: BRAND_UUID },
      getPromptStatsResult = { branded: 0, unbranded: 0, intents: {} },
      fakeDrsClient = {
        isConfigured: () => true,
        listJobs: sinon.stub().resolves([]),
        submitPromptGenerationJob: sinon.stub().resolves({ job_id: 'pg-1' }),
        createBrandPresenceSchedule: sinon.stub().resolves({ scheduleId: 'sch-1' }),
      },
    } = {}) {
      const getBrandByIdStub = typeof getBrandByIdResult === 'function'
        ? getBrandByIdResult
        : sinon.stub().resolves(getBrandByIdResult);
      const updateBrandStub = typeof updateBrandResult === 'function'
        ? updateBrandResult
        : sinon.stub().resolves(updateBrandResult);
      const getPromptStatsStub = typeof getPromptStatsResult === 'function'
        ? getPromptStatsResult
        : sinon.stub().resolves(getPromptStatsResult);
      const resolveBrandUuidStub = sinon.stub().resolves(resolveBrandUuidResult);
      const postLlmoAlertStub = sinon.stub().resolves();

      const Mocked = await esmock('../../src/controllers/brands.js', {
        '../../src/support/access-control-util.js': {
          default: {
            fromContext: () => ({
              hasAccess,
              hasAdminAccess,
              isLLMOAdministrator,
            }),
          },
        },
        '../../src/support/prompts-storage.js': {
          resolveBrandUuid: resolveBrandUuidStub,
          getPromptStats: getPromptStatsStub,
          // other prompts-storage exports needed by the controller at module level
          listPrompts: sinon.stub().resolves({ data: [], count: 0 }),
          getPromptById: sinon.stub().resolves(null),
          upsertPrompts: sinon.stub().resolves({}),
          updatePromptById: sinon.stub().resolves(null),
          deletePromptById: sinon.stub().resolves(false),
          bulkDeletePrompts: sinon.stub().resolves({}),
          checkPromptsExist: sinon.stub().resolves([]),
          findPromptsBlockingRegionRemoval: sinon.stub().resolves({}),
        },
        '../../src/support/brands-storage.js': {
          getBrandById: getBrandByIdStub,
          updateBrand: updateBrandStub,
          getBrandCompetitors: sinon.stub().resolves([]),
          listBrands: sinon.stub().resolves([]),
          upsertBrand: sinon.stub().resolves({}),
          deleteBrand: sinon.stub().resolves(true),
          getBrandBySite: sinon.stub().resolves(null),
        },
        '../../src/support/llmo-paid-gate.js': {
          hasPaidLlmoEntitlement: async () => Boolean(entitlement)
            && entitlement.getTier() === 'PAID',
        },
        '@adobe/spacecat-shared-drs-client': {
          default: {
            createFrom: () => fakeDrsClient,
          },
        },
        '../../src/controllers/llmo/llmo-onboarding.js': {
          postLlmoAlert: postLlmoAlertStub,
        },
      });

      return {
        controller: Mocked.default(context, loggerStub, mockEnv),
        getBrandByIdStub,
        updateBrandStub,
        getPromptStatsStub,
        resolveBrandUuidStub,
        postLlmoAlertStub,
        fakeDrsClient,
      };
    }

    /** Builds a minimal valid request context for activateBrandForOrg. */
    function buildActivateRequest({
      spaceCatId = ORGANIZATION_ID,
      brandId = BRAND_UUID,
      generatePrompts = true,
      dataAccessOverride,
    } = {}) {
      return {
        ...context,
        params: { spaceCatId, brandId },
        data: { generatePrompts },
        dataAccess: dataAccessOverride || mockDataAccess,
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
      };
    }

    // -------------------------------------------------------------------------
    // 1. Input validation — 400s
    // -------------------------------------------------------------------------

    it('returns 400 when spaceCatId is missing', async () => {
      const { controller } = await buildActivateController();
      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ spaceCatId: '' }),
      );
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Organization ID required');
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const { controller } = await buildActivateController();
      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ spaceCatId: 'not-a-uuid' }),
      );
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Organization ID must be a valid UUID');
    });

    it('returns 400 when brandId is missing', async () => {
      const { controller } = await buildActivateController();
      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ brandId: '' }),
      );
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Brand ID required');
    });

    it('returns 400 when generatePrompts is omitted (undefined)', async () => {
      const { controller } = await buildActivateController();
      const req = buildActivateRequest();
      req.data = {}; // omit generatePrompts entirely
      const response = await controller.activateBrandForOrg(req);
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('generatePrompts is required and must be a boolean');
    });

    it('returns 400 when generatePrompts is a string', async () => {
      const { controller } = await buildActivateController();
      const req = buildActivateRequest();
      req.data = { generatePrompts: 'true' };
      const response = await controller.activateBrandForOrg(req);
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('generatePrompts is required and must be a boolean');
    });

    // -------------------------------------------------------------------------
    // 2. Not-found paths — 404
    // -------------------------------------------------------------------------

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      const { controller } = await buildActivateController();
      const response = await controller.activateBrandForOrg(buildActivateRequest());
      expect(response.status).to.equal(404);
      mockDataAccess.Organization.findById.resolves(organizations[0]);
    });

    it('returns 404 when getBrandById returns null', async () => {
      const { controller } = await buildActivateController({ getBrandByIdResult: null });
      const response = await controller.activateBrandForOrg(buildActivateRequest());
      expect(response.status).to.equal(404);
    });

    it('returns 404 (does not resurrect) when the brand is soft-deleted', async () => {
      const { controller, updateBrandStub } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID,
          name: 'Acme',
          baseSiteId: SITE_ID,
          baseUrl: 'https://site1.com',
          region: ['us'],
          status: 'deleted',
          urls: [],
        },
      });
      const response = await controller.activateBrandForOrg(buildActivateRequest());
      expect(response.status).to.equal(404);
      expect(updateBrandStub).to.not.have.been.called;
    });

    // -------------------------------------------------------------------------
    // 3. Auth failures — 403
    // -------------------------------------------------------------------------

    it('returns 403 when hasAccess is false', async () => {
      const { controller } = await buildActivateController({
        hasAccess: async () => false,
      });
      const response = await controller.activateBrandForOrg(buildActivateRequest());
      expect(response.status).to.equal(403);
    });

    it('returns 403 when entitlement is null', async () => {
      const { controller } = await buildActivateController({ entitlement: null });
      const response = await controller.activateBrandForOrg(buildActivateRequest());
      expect(response.status).to.equal(403);
    });

    it('returns 403 when entitlement tier is FREE_TRIAL', async () => {
      const { controller } = await buildActivateController({
        entitlement: { getTier: () => 'FREE_TRIAL' },
      });
      const response = await controller.activateBrandForOrg(buildActivateRequest());
      expect(response.status).to.equal(403);
    });

    // -------------------------------------------------------------------------
    // 4. Service unavailability — 503
    // -------------------------------------------------------------------------

    it('returns 503 when postgrestClient.from is missing', async () => {
      const { controller } = await buildActivateController();
      const brokenDataAccess = {
        ...mockDataAccess,
        services: { postgrestClient: {} }, // no `from`
      };
      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ dataAccessOverride: brokenDataAccess }),
      );
      expect(response.status).to.equal(503);
    });

    // -------------------------------------------------------------------------
    // 5. Happy path — already-sited brand, generatePrompts:true
    // -------------------------------------------------------------------------

    it('returns 200 with promptGenerationJobId and scheduleId for already-sited brand with generatePrompts:true', async () => {
      const listJobsStub = sinon.stub().resolves([]);
      const submitJobStub = sinon.stub().resolves({ job_id: 'pg-1' });
      const scheduleStub = sinon.stub().resolves({ scheduleId: 'sch-1' });
      const fakeDrs = {
        isConfigured: () => true,
        listJobs: listJobsStub,
        submitPromptGenerationJob: submitJobStub,
        createBrandPresenceSchedule: scheduleStub,
      };
      const { controller, updateBrandStub } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID,
          name: 'Acme',
          baseSiteId: SITE_ID,
          baseUrl: 'https://site1.com',
          region: ['us'],
          status: 'pending',
          urls: [],
        },
        updateBrandResult: { id: BRAND_UUID },
        fakeDrsClient: fakeDrs,
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: true }),
      );

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.deep.equal({
        brandId: BRAND_UUID,
        status: 'active',
        baseSiteId: SITE_ID,
        promptGenerationJobId: 'pg-1',
        scheduleId: 'sch-1',
      });

      // updateBrand must be called with status:active + baseSiteId
      expect(updateBrandStub).to.have.been.calledOnce;
      const updateArg = updateBrandStub.firstCall.args[0];
      expect(updateArg.updates).to.deep.include({ status: 'active', baseSiteId: SITE_ID });

      // submitPromptGenerationJob must carry source:'brand-activation', region, siteId, imsOrgId
      expect(submitJobStub).to.have.been.calledOnce;
      const submitArg = submitJobStub.firstCall.args[0];
      expect(submitArg.source).to.equal('brand-activation');
      expect(submitArg.region).to.equal('us');
      expect(submitArg.siteId).to.equal(SITE_ID);
      expect(submitArg.imsOrgId).to.equal(IMS_ORG_ID);

      // createBrandPresenceSchedule must be called with correct ids
      expect(scheduleStub).to.have.been.calledOnceWith({
        siteId: SITE_ID,
        brandId: BRAND_UUID,
        orgId: ORGANIZATION_ID,
      });
    });

    // -------------------------------------------------------------------------
    // 6. Idempotency — reuse in-flight prompt-gen job
    // -------------------------------------------------------------------------

    it('reuses an in-flight RUNNING job instead of submitting a new one', async () => {
      const listJobsStub = sinon.stub().resolves([{ job_id: 'existing-1', status: 'RUNNING' }]);
      const submitJobStub = sinon.stub().resolves({ job_id: 'new-job' });
      const scheduleStub = sinon.stub().resolves({ scheduleId: 'sch-1' });
      const fakeDrs = {
        isConfigured: () => true,
        listJobs: listJobsStub,
        submitPromptGenerationJob: submitJobStub,
        createBrandPresenceSchedule: scheduleStub,
      };
      const { controller } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID, name: 'Acme', baseSiteId: SITE_ID, baseUrl: 'https://site1.com', region: ['us'], status: 'pending', urls: [],
        },
        fakeDrsClient: fakeDrs,
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: true }),
      );

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.promptGenerationJobId).to.equal('existing-1');
      expect(submitJobStub).to.not.have.been.called;
      expect(scheduleStub).to.have.been.calledOnce;
    });

    // -------------------------------------------------------------------------
    // 7. generatePrompts:false + brand has existing prompts → schedule is created
    // -------------------------------------------------------------------------

    it('creates schedule but skips prompt-gen when generatePrompts:false and brand has prompts', async () => {
      const listJobsStub = sinon.stub().resolves([]);
      const submitJobStub = sinon.stub().resolves({ job_id: 'pg-1' });
      const scheduleStub = sinon.stub().resolves({ scheduleId: 'sch-2' });
      const fakeDrs = {
        isConfigured: () => true,
        listJobs: listJobsStub,
        submitPromptGenerationJob: submitJobStub,
        createBrandPresenceSchedule: scheduleStub,
      };
      const { controller } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID, name: 'Acme', baseSiteId: SITE_ID, baseUrl: 'https://site1.com', region: ['us'], status: 'pending', urls: [],
        },
        getPromptStatsResult: { branded: 2, unbranded: 1, intents: {} },
        fakeDrsClient: fakeDrs,
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: false }),
      );

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('scheduleId', 'sch-2');
      expect(body).to.not.have.property('promptGenerationJobId');
      expect(listJobsStub).to.not.have.been.called;
      expect(submitJobStub).to.not.have.been.called;
      expect(scheduleStub).to.have.been.calledOnce;
    });

    // -------------------------------------------------------------------------
    // 8. generatePrompts:false + no existing prompts → no schedule
    // -------------------------------------------------------------------------

    it('skips both prompt-gen and schedule when generatePrompts:false and no prompts exist', async () => {
      const listJobsStub = sinon.stub().resolves([]);
      const submitJobStub = sinon.stub().resolves({ job_id: 'pg-1' });
      const scheduleStub = sinon.stub().resolves({ scheduleId: 'sch-3' });
      const fakeDrs = {
        isConfigured: () => true,
        listJobs: listJobsStub,
        submitPromptGenerationJob: submitJobStub,
        createBrandPresenceSchedule: scheduleStub,
      };
      const { controller } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID, name: 'Acme', baseSiteId: SITE_ID, baseUrl: 'https://site1.com', region: ['us'], status: 'pending', urls: [],
        },
        getPromptStatsResult: { branded: 0, unbranded: 0, intents: {} },
        fakeDrsClient: fakeDrs,
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: false }),
      );

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.deep.equal({
        brandId: BRAND_UUID,
        status: 'active',
        baseSiteId: SITE_ID,
      });
      expect(submitJobStub).to.not.have.been.called;
      expect(scheduleStub).to.not.have.been.called;
    });

    // -------------------------------------------------------------------------
    // 9. Pending brand with primaryUrl that resolves to null site → 400
    // -------------------------------------------------------------------------

    it('returns 400 when brand has no baseSiteId and primary URL does not resolve to an onboarded site', async () => {
      mockDataAccess.Site.findByBaseURL = sinon.stub().resolves(null);
      const { controller, updateBrandStub } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID,
          name: 'Acme',
          baseSiteId: null,
          baseUrl: null,
          pendingSemrushProvisioning: { primaryUrl: 'https://site1.com' },
          region: [],
          status: 'pending',
          urls: [],
        },
      });

      const response = await controller.activateBrandForOrg(buildActivateRequest());
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Brand has no onboarded primary site');
      expect(updateBrandStub).to.not.have.been.called;

      delete mockDataAccess.Site.findByBaseURL;
    });

    // -------------------------------------------------------------------------
    // 10. Pending brand resolves via stash primaryUrl
    // -------------------------------------------------------------------------

    it('resolves site via pendingSemrushProvisioning.primaryUrl and activates when generatePrompts:false + no prompts', async () => {
      mockDataAccess.Site.findByBaseURL = sinon.stub().resolves(sites[0]);
      const scheduleStub = sinon.stub().resolves({ scheduleId: 'sch-x' });
      const fakeDrs = {
        isConfigured: () => true,
        listJobs: sinon.stub().resolves([]),
        submitPromptGenerationJob: sinon.stub().resolves({}),
        createBrandPresenceSchedule: scheduleStub,
      };
      const { controller, updateBrandStub } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID,
          name: 'Acme',
          baseSiteId: null,
          baseUrl: null,
          pendingSemrushProvisioning: { primaryUrl: 'https://site1.com' },
          region: [],
          status: 'pending',
          urls: [],
        },
        getPromptStatsResult: { branded: 0, unbranded: 0, intents: {} },
        fakeDrsClient: fakeDrs,
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: false }),
      );

      expect(response.status).to.equal(200);
      const updateArg = updateBrandStub.firstCall.args[0];
      expect(updateArg.updates.baseSiteId).to.equal(SITE_ID);
      expect(scheduleStub).to.not.have.been.called;

      delete mockDataAccess.Site.findByBaseURL;
    });

    // -------------------------------------------------------------------------
    // 11. Pending brand with no baseSiteId and no stash → 400 (never guesses urls[])
    // -------------------------------------------------------------------------

    it('returns 400 and does NOT fall back to brand.urls[] when no baseSiteId and no stash primaryUrl', async () => {
      const findByBaseURLStub = sinon.stub().resolves(sites[0]);
      mockDataAccess.Site.findByBaseURL = findByBaseURLStub;
      const { controller, updateBrandStub } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID,
          name: 'Acme',
          baseSiteId: null,
          baseUrl: null,
          pendingSemrushProvisioning: null,
          region: [],
          status: 'pending',
          urls: [{ value: 'https://site1.com', type: 'base' }],
        },
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: false }),
      );

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Brand has no onboarded primary site');
      // urls[] must NOT be used as an activation anchor — no site lookup, no write.
      expect(findByBaseURLStub).to.not.have.been.called;
      expect(updateBrandStub).to.not.have.been.called;

      delete mockDataAccess.Site.findByBaseURL;
    });

    // -------------------------------------------------------------------------
    // 12. updateBrand throws with .status = 409 → 409 response
    // -------------------------------------------------------------------------

    it('returns 409 when updateBrand throws a conflict error', async () => {
      const conflictError = new Error('brands_base_site_unique constraint');
      conflictError.status = 409;
      const { controller } = await buildActivateController({
        updateBrandResult: sinon.stub().rejects(conflictError),
      });

      const response = await controller.activateBrandForOrg(buildActivateRequest());
      expect(response.status).to.equal(409);
    });

    // -------------------------------------------------------------------------
    // 13. updateBrand returns null → 404
    // -------------------------------------------------------------------------

    it('returns 404 when updateBrand resolves null (concurrent delete)', async () => {
      const { controller } = await buildActivateController({ updateBrandResult: null });
      const response = await controller.activateBrandForOrg(buildActivateRequest());
      expect(response.status).to.equal(404);
    });

    // -------------------------------------------------------------------------
    // 14. DRS not configured → 200 with no job/schedule
    // -------------------------------------------------------------------------

    it('returns 200 with no job or schedule when DRS client is not configured', async () => {
      const fakeDrs = {
        isConfigured: () => false,
        listJobs: sinon.stub().resolves([]),
        submitPromptGenerationJob: sinon.stub().resolves({ job_id: 'pg-x' }),
        createBrandPresenceSchedule: sinon.stub().resolves({ scheduleId: 'sch-x' }),
      };
      const { controller } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID, name: 'Acme', baseSiteId: SITE_ID, baseUrl: 'https://site1.com', region: ['us'], status: 'pending', urls: [],
        },
        fakeDrsClient: fakeDrs,
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: true }),
      );

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.deep.equal({
        brandId: BRAND_UUID,
        status: 'active',
        baseSiteId: SITE_ID,
      });
      expect(fakeDrs.listJobs).to.not.have.been.called;
      expect(fakeDrs.submitPromptGenerationJob).to.not.have.been.called;
      expect(fakeDrs.createBrandPresenceSchedule).to.not.have.been.called;
    });

    // -------------------------------------------------------------------------
    // 15. Region absent → submitPromptGenerationJob called without region key
    // -------------------------------------------------------------------------

    it('calls submitPromptGenerationJob without region when brand.region is empty', async () => {
      const submitJobStub = sinon.stub().resolves({ job_id: 'pg-nr' });
      const fakeDrs = {
        isConfigured: () => true,
        listJobs: sinon.stub().resolves([]),
        submitPromptGenerationJob: submitJobStub,
        createBrandPresenceSchedule: sinon.stub().resolves({ scheduleId: 'sch-nr' }),
      };
      const { controller } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID,
          name: 'Acme',
          baseSiteId: SITE_ID,
          baseUrl: 'https://site1.com',
          region: [], // empty → region is undefined
          status: 'pending',
          urls: [],
        },
        fakeDrsClient: fakeDrs,
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: true }),
      );

      expect(response.status).to.equal(200);
      expect(submitJobStub).to.have.been.calledOnce;
      const submitArg = submitJobStub.firstCall.args[0];
      expect(submitArg).to.not.have.property('region');
    });

    it('tolerates listJobs returning undefined and a non-array region (defensive fallbacks)', async () => {
      const submitJobStub = sinon.stub().resolves({ job_id: 'pg-def' });
      const fakeDrs = {
        isConfigured: () => true,
        listJobs: sinon.stub().resolves(undefined), // → (inFlight || []) fallback
        submitPromptGenerationJob: submitJobStub,
        createBrandPresenceSchedule: sinon.stub().resolves({ scheduleId: 'sch-def' }),
      };
      const { controller } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID,
          name: 'Acme',
          baseSiteId: SITE_ID,
          baseUrl: 'https://site1.com',
          region: null, // non-array → region resolves to undefined
          status: 'pending',
          urls: [],
        },
        fakeDrsClient: fakeDrs,
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: true }),
      );

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.promptGenerationJobId).to.equal('pg-def');
      expect(submitJobStub).to.have.been.calledOnce;
      // non-array region → no region key on the prompt-gen payload
      expect(submitJobStub.firstCall.args[0]).to.not.have.property('region');
    });

    // -------------------------------------------------------------------------
    // 16. baseSiteId set but baseUrl missing → re-look up the site for the URL (#7)
    // -------------------------------------------------------------------------

    it('re-looks up the site for baseUrl when baseSiteId is set but baseUrl is missing', async () => {
      mockDataAccess.Site.findById = sinon.stub().resolves(sites[0]);
      const submitJobStub = sinon.stub().resolves({ job_id: 'pg-rl' });
      const fakeDrs = {
        isConfigured: () => true,
        listJobs: sinon.stub().resolves([]),
        submitPromptGenerationJob: submitJobStub,
        createBrandPresenceSchedule: sinon.stub().resolves({ scheduleId: 'sch-rl' }),
      };
      const { controller } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID,
          name: 'Acme',
          baseSiteId: SITE_ID,
          baseUrl: null, // base_site embed didn't carry a URL
          region: ['us'],
          status: 'pending',
          urls: [],
        },
        fakeDrsClient: fakeDrs,
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: true }),
      );

      expect(response.status).to.equal(200);
      expect(mockDataAccess.Site.findById).to.have.been.calledWith(SITE_ID);
      // prompt-gen must use the re-looked-up base URL, never an empty string
      expect(submitJobStub).to.have.been.calledOnce;
      expect(submitJobStub.firstCall.args[0].baseUrl).to.equal(sites[0].getBaseURL());

      mockDataAccess.Site.findById = sinon.stub().resolves(sites[0]);
    });

    it('returns 400 when baseSiteId is set but the site cannot be re-looked up', async () => {
      mockDataAccess.Site.findById = sinon.stub().resolves(null);
      const { controller, updateBrandStub } = await buildActivateController({
        getBrandByIdResult: {
          id: BRAND_UUID,
          name: 'Acme',
          baseSiteId: SITE_ID,
          baseUrl: null,
          region: ['us'],
          status: 'pending',
          urls: [],
        },
      });

      const response = await controller.activateBrandForOrg(buildActivateRequest());
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Brand has no onboarded primary site');
      expect(updateBrandStub).to.not.have.been.called;

      mockDataAccess.Site.findById = sinon.stub().resolves(sites[0]);
    });

    // -------------------------------------------------------------------------
    // 17. DRS side-effect failure is non-fatal — 200 + ops alert carrying the
    //     real error (the client never sees the upstream detail) (#4, #5)
    // -------------------------------------------------------------------------

    it('returns 200 (brand active) and alerts ops with the error when prompt-gen fails', async () => {
      const drsError = new Error('DRS POST /jobs failed: 500 - upstream boom');
      const submitJobStub = sinon.stub().rejects(drsError);
      const scheduleStub = sinon.stub().resolves({ scheduleId: 'sch-x' });
      const fakeDrs = {
        isConfigured: () => true,
        listJobs: sinon.stub().resolves([]),
        submitPromptGenerationJob: submitJobStub,
        createBrandPresenceSchedule: scheduleStub,
      };
      const { controller, updateBrandStub, postLlmoAlertStub } = await buildActivateController({
        fakeDrsClient: fakeDrs,
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: true }),
      );

      // The brand IS active — a DRS failure must not fail the request.
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.deep.equal({
        brandId: BRAND_UUID,
        status: 'active',
        baseSiteId: SITE_ID,
      });
      expect(updateBrandStub).to.have.been.calledOnce;
      expect(scheduleStub).to.not.have.been.called; // short-circuited by the throw
      // The client body carries no upstream detail; the real error goes to ops.
      const warnCall = postLlmoAlertStub.getCalls().find(
        (c) => typeof c.args[0] === 'string' && c.args[0].includes(':warning:'),
      );
      expect(warnCall, 'a :warning: alert should be posted').to.exist;
      expect(warnCall.args[0]).to.include('DRS POST /jobs failed: 500 - upstream boom');
    });

    it('returns 200 with the prompt-gen job id when only the schedule fails', async () => {
      const submitJobStub = sinon.stub().resolves({ job_id: 'pg-ok' });
      const scheduleStub = sinon.stub().rejects(new Error('schedule service down'));
      const fakeDrs = {
        isConfigured: () => true,
        listJobs: sinon.stub().resolves([]),
        submitPromptGenerationJob: submitJobStub,
        createBrandPresenceSchedule: scheduleStub,
      };
      const { controller, postLlmoAlertStub } = await buildActivateController({
        fakeDrsClient: fakeDrs,
      });

      const response = await controller.activateBrandForOrg(
        buildActivateRequest({ generatePrompts: true }),
      );

      expect(response.status).to.equal(200);
      const body = await response.json();
      // prompt-gen succeeded before the schedule threw → its id is still returned
      expect(body).to.deep.equal({
        brandId: BRAND_UUID,
        status: 'active',
        baseSiteId: SITE_ID,
        promptGenerationJobId: 'pg-ok',
      });
      const warnCall = postLlmoAlertStub.getCalls().find(
        (c) => typeof c.args[0] === 'string' && c.args[0].includes(':warning:'),
      );
      expect(warnCall, 'a :warning: alert should be posted').to.exist;
    });
  });

  describe('deleteBrandForOrg', () => {
    const BRAND_UUID = 'a1111111-1111-4111-b111-111111111111';

    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: { id: BRAND_UUID }, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 204 when brand is deleted', async () => {
      const response = await brandsController.deleteBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(204);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.deleteBrandForOrg({
        ...context,
        params: undefined,
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.deleteBrandForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when brandId is missing', async () => {
      const response = await brandsController.deleteBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 404 when brand not found during resolve', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 404 when deleteBrand returns false', async () => {
      const maybeSingleStub = sandbox.stub();
      // First call: resolveBrandUuid succeeds
      maybeSingleStub.onFirstCall().resolves({ data: { id: BRAND_UUID }, error: null });
      // Second call: deleteBrand returns null (not found)
      maybeSingleStub.onSecondCall().resolves({ data: null, error: null });

      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: maybeSingleStub,
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.deleteBrandForOrg({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB connection lost')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });
  });

  describe('transitionBrandStatusForOrg', () => {
    const BRAND_UUID = 'a1111111-1111-4111-b111-111111111111';

    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          in: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({
            data: {
              id: BRAND_UUID,
              name: 'Express',
              status: 'pending',
              origin: 'human',
              updated_at: '2026-01-02T00:00:00Z',
              updated_by: 'user@test.com',
              brand_aliases: [],
              brand_social_accounts: [],
              brand_earned_sources: [],
              competitors: [],
              brand_sites: [],
            },
            error: null,
          }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('returns 200 and transitions status via the explicit path (LLMO-5587)', async () => {
      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { status: 'pending' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(200);
    });

    it('returns 400 when status is not active or pending', async () => {
      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { status: 'deleted' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when status is missing', async () => {
      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: {},
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when organization ID is missing', async () => {
      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { brandId: BRAND_UUID },
        data: { status: 'pending' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when spaceCatId is not a valid UUID', async () => {
      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { spaceCatId: 'not-a-uuid', brandId: BRAND_UUID },
        data: { status: 'pending' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when brandId is missing', async () => {
      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { status: 'pending' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { status: 'pending' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { status: 'pending' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(503);
    });

    it('returns 404 when brand not found during resolve', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: sandbox.stub().resolves({ data: null, error: null }),
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { status: 'pending' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 404 when the brand is soft-deleted (no resurrection via status transition)', async () => {
      const maybeSingleStub = sandbox.stub();
      // resolveBrandUuid succeeds...
      maybeSingleStub.onFirstCall().resolves({ data: { id: BRAND_UUID }, error: null });
      // ...but the status update is filtered out by .neq('status','deleted') → no row.
      maybeSingleStub.onSecondCall().resolves({ data: null, error: null });

      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: maybeSingleStub,
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { status: 'active' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const authContextUser = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const unauthorizedController = BrandsController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextUser,
      }, loggerStub, mockEnv);

      const response = await unauthorizedController.transitionBrandStatusForOrg({
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { status: 'pending' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(403);
    });

    it('returns 400 when activating a brand without a base site (chk_active_brand_has_site_id, lifted from #2504)', async () => {
      const maybeSingleStub = sandbox.stub();
      // resolveBrandUuid resolves the UUID...
      maybeSingleStub.onFirstCall().resolves({ data: { id: BRAND_UUID }, error: null });
      // ...then setBrandStatus hits the DB constraint on the update.
      maybeSingleStub.onSecondCall().resolves({
        data: null,
        error: {
          code: '23514',
          message: 'new row violates check constraint "chk_active_brand_has_site_id"',
        },
      });

      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          update: sandbox.stub().returnsThis(),
          ilike: sandbox.stub().returnsThis(),
          maybeSingle: maybeSingleStub,
        })),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { status: 'active' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 500 when storage throws', async () => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().throws(new Error('DB connection lost')),
      };
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.transitionBrandStatusForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, brandId: BRAND_UUID },
        data: { status: 'pending' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
    });
  });
});

describe('Brands Controller — region removal consistency guard (LLMO-5645)', () => {
  const ORG_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';
  const BRAND_UUID = 'a1111111-1111-4111-b111-111111111111';
  const loggerStub = {
    info: stub(), error: stub(), warn: stub(), debug: stub(),
  };
  const mockEnv = { BRAND_IMS_HOST: 'https://ims-na1.adobelogin.com' };

  function buildContext() {
    return {
      dataAccess: {
        Organization: { findById: stub().resolves({ getId: () => ORG_ID }) },
        services: { postgrestClient: { from: () => ({}) } },
      },
      attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
    };
  }

  async function mountController({ blocking = {}, oldRegion = ['US', 'DE'], updateBrand } = {}) {
    const findStub = stub().resolves(blocking);
    const updateStub = updateBrand || stub().resolves({ id: BRAND_UUID, region: ['US'] });
    const Mocked = await esmock('../../src/controllers/brands.js', {
      '../../src/support/prompts-storage.js': {
        resolveBrandUuid: stub().resolves(BRAND_UUID),
        findPromptsBlockingRegionRemoval: findStub,
      },
      '../../src/support/brands-storage.js': {
        getBrandById: stub().resolves({ id: BRAND_UUID, region: oldRegion }),
        updateBrand: updateStub,
      },
      '../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({ hasAccess: async () => true, hasAdminAccess: () => true }),
        },
      },
    });
    return { Mocked, findStub, updateStub };
  }

  it('allows the region change and updates the brand when no prompt blocks removal', async () => {
    const { Mocked, findStub, updateStub } = await mountController({ blocking: {} });
    const ctx = buildContext();
    const controller = Mocked(ctx, loggerStub, mockEnv);

    const response = await controller.updateBrandForOrg({
      ...ctx,
      params: { spaceCatId: ORG_ID, brandId: BRAND_UUID },
      data: { region: ['US'] },
    });

    expect(response.status).to.equal(200);
    expect(findStub).to.have.been.calledOnce;
    const arg = findStub.firstCall.args[0];
    expect(arg.oldRegions).to.deep.equal(['US', 'DE']);
    expect(arg.newRegions).to.deep.equal(['US']);
    expect(updateStub).to.have.been.calledOnce;
  });

  it('rejects with 400 and does NOT update when prompts still use a removed region', async () => {
    const { Mocked, updateStub } = await mountController({ blocking: { de: 3, fr: 1 } });
    const ctx = buildContext();
    const controller = Mocked(ctx, loggerStub, mockEnv);

    const response = await controller.updateBrandForOrg({
      ...ctx,
      params: { spaceCatId: ORG_ID, brandId: BRAND_UUID },
      data: { region: ['US'] },
    });

    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.message).to.contain('DE (3 prompts)');
    expect(body.message).to.contain('FR (1 prompt)');
    expect(body.message).to.contain('Reassign or delete those prompts first');
    // The brand must not be mutated when the guard rejects.
    expect(updateStub).to.not.have.been.called;
  });

  it('does not run the guard when the update carries no region change', async () => {
    const { Mocked, findStub, updateStub } = await mountController();
    const ctx = buildContext();
    const controller = Mocked(ctx, loggerStub, mockEnv);

    const response = await controller.updateBrandForOrg({
      ...ctx,
      params: { spaceCatId: ORG_ID, brandId: BRAND_UUID },
      data: { name: 'Renamed Brand' },
    });

    expect(response.status).to.equal(200);
    expect(findStub).to.not.have.been.called;
    expect(updateStub).to.have.been.calledOnce;
  });

  it('rejects clearing ALL regions (region: []) when any prompt still uses one', async () => {
    // Removing every region makes all old regions "removed"; the guard fires if
    // any prompt references one of them.
    const { Mocked, findStub, updateStub } = await mountController({
      oldRegion: ['US', 'DE'],
      blocking: { us: 5, de: 2 },
    });
    const ctx = buildContext();
    const controller = Mocked(ctx, loggerStub, mockEnv);

    const response = await controller.updateBrandForOrg({
      ...ctx,
      params: { spaceCatId: ORG_ID, brandId: BRAND_UUID },
      data: { region: [] },
    });

    expect(response.status).to.equal(400);
    expect(findStub.firstCall.args[0].newRegions).to.deep.equal([]);
    const body = await response.json();
    expect(body.message).to.contain('US (5 prompts)');
    expect(body.message).to.contain('DE (2 prompts)');
    expect(updateStub).to.not.have.been.called;
  });
});

describe('Brands Controller — defensive branch coverage', () => {
  const ORG_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';
  const BRAND_UUID = 'a1111111-1111-4111-b111-111111111111';
  const loggerStub = {
    info: stub(), error: stub(), warn: stub(), debug: stub(),
  };
  const mockEnv = {
    BRAND_IMS_HOST: 'https://ims-na1.adobelogin.com',
    BRAND_IMS_CLIENT_ID: 'client',
    BRAND_IMS_CLIENT_CODE: 'code',
    BRAND_IMS_CLIENT_SECRET: 'secret',
  };

  function buildContext() {
    return {
      pathInfo: { headers: { 'x-product': 'llmo' } },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
      dataAccess: {
        Organization: { findById: stub().resolves({ getId: () => ORG_ID }) },
        services: {
          postgrestClient: {
            from: stub().callsFake(() => ({
              select: stub().returnsThis(),
              eq: stub().returnsThis(),
              maybeSingle: stub().resolves({
                data: { id: BRAND_UUID, name: 'New Brand' },
                error: null,
              }),
              single: stub().resolves({ data: { id: BRAND_UUID }, error: null }),
            })),
          },
        },
      },
    };
  }

  async function mountController({
    provisionBrandSubworkspace = stub().resolves({ semrushWorkspaceId: 'ws-1' }),
    upsertBrand = stub().resolves({ id: BRAND_UUID, name: 'New Brand' }),
  } = {}) {
    const Mocked = await esmock('../../src/controllers/brands.js', {
      '../../src/support/serenity/brand-provisioning.js': { provisionBrandSubworkspace },
      '../../src/support/brands-storage.js': { upsertBrand },
    });
    const ctx = buildContext();
    return { controller: Mocked.default(ctx, loggerStub, mockEnv), ctx };
  }

  // Lines 102-103: brandDomainFromPayload catch block. The URL constructor throws
  // when the string is structurally invalid even after the 'https://' prefix is
  // prepended — for example a bare space is not a valid hostname.
  it('brandDomainFromPayload catch: returns 400 when the first URL is structurally invalid (new URL throws)', async () => {
    const { controller, ctx } = await mountController();

    // A semrushMarket create requires a parseable domain. Supplying a bare space
    // as the url value means `new URL('https:// ')` throws → brandDomainFromPayload
    // returns null → controller returns 400 "primary URL required".
    const response = await controller.createBrandForOrg({
      ...ctx,
      params: { spaceCatId: ORG_ID },
      data: {
        name: 'Brand X',
        urls: [{ value: ' ' }], // space is not a valid hostname → URL throws
        semrushMarket: { market: 'us', languageCode: 'en' },
        semrushModelIds: ['model-a'],
      },
      dataAccess: ctx.dataAccess,
    });

    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.message).to.match(/primary URL is required/i);
  });

  // brandAliases normalize: accepts both `{ name, regions }` objects and bare
  // strings (region-less), keeps `regions`, and filters entries without a name.
  // The create handler region-clamps them to the initial market downstream.
  it('brandAliases: normalizes objects + strings to { name, regions } and filters blanks', async () => {
    const provisionStub = stub().resolves({ semrushWorkspaceId: 'ws-1' });
    const upsertStub = stub().resolves({ id: BRAND_UUID, name: 'New Brand' });
    const { controller, ctx } = await mountController({
      provisionBrandSubworkspace: provisionStub,
      upsertBrand: upsertStub,
    });

    const response = await controller.createBrandForOrg({
      ...ctx,
      params: { spaceCatId: ORG_ID },
      data: {
        name: 'Brand X',
        urls: [{ value: 'https://x.com' }],
        semrushMarket: { market: 'us', languageCode: 'en' },
        semrushModelIds: ['model-a'],
        brandAliases: [
          { name: 'Brand Alias Co', regions: ['us'] }, // object → keeps regions
          'plain string alias', // string → region-less
          { noName: true }, // object with no name → filtered out
        ],
      },
      dataAccess: ctx.dataAccess,
      attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
    });

    expect(response.status).to.equal(201);
    const provisionArgs = provisionStub.firstCall.args[1];
    expect(provisionArgs.brandAliases).to.deep.equal([
      { name: 'Brand Alias Co', regions: ['us'] },
      { name: 'plain string alias', regions: [] },
    ]);
  });

  // Line 91 else: `Array.isArray(brandData?.urls) ? brandData.urls : []` — fires
  // when urls is absent or not an array. brandDomainFromPayload then finds no first
  // URL and returns null → controller returns 400 "primary URL required".
  it('brandDomainFromPayload else-branch: treats absent urls as empty (no-array fallback → 400)', async () => {
    const { controller, ctx } = await mountController();

    const response = await controller.createBrandForOrg({
      ...ctx,
      params: { spaceCatId: ORG_ID },
      data: {
        name: 'Brand X',
        // urls is a string (not an array) — triggers the `[]` else branch at line 91
        urls: 'https://x.com',
        semrushMarket: { market: 'us', languageCode: 'en' },
        semrushModelIds: ['model-a'],
      },
      dataAccess: ctx.dataAccess,
    });

    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.message).to.match(/primary URL is required/i);
  });

  // Line 93 object-value branch: `typeof u === 'string' ? u : u?.value` — fires
  // when a URL entry is an object like {value: '...'}. Already covered by the catch
  // test above (space URL is an object entry). Adding an explicit test where the
  // object yields a valid hostname to cover the non-throw path of line 93.
  it('brandDomainFromPayload object-url: extracts hostname from {value} entry (line 93 u?.value branch)', async () => {
    const provisionStub = stub().resolves({ semrushWorkspaceId: 'ws-1' });
    const upsertStub = stub().resolves({ id: BRAND_UUID, name: 'New Brand' });
    const { controller, ctx } = await mountController({
      provisionBrandSubworkspace: provisionStub,
      upsertBrand: upsertStub,
    });

    const response = await controller.createBrandForOrg({
      ...ctx,
      params: { spaceCatId: ORG_ID },
      data: {
        name: 'Brand X',
        urls: [{ value: 'https://brand.example.com' }], // object entry → u?.value branch
        semrushMarket: { market: 'us', languageCode: 'en' },
        semrushModelIds: ['model-a'],
      },
      dataAccess: ctx.dataAccess,
      attributes: { authInfo: { getType: () => 'ims', profile: { email: 'user@test.com' } } },
    });

    expect(response.status).to.equal(201);
    expect(provisionStub.firstCall.args[1].brandDomain).to.equal('brand.example.com');
  });

  // Line 100: `url.hostname || null` — the null branch fires when URL parsing
  // succeeds but yields an empty hostname. `file:///path` contains '://' so it is
  // used as-is in new URL(...); file URLs have an empty hostname → || null fires →
  // returns null → controller returns 400 "primary URL required".
  it('brandDomainFromPayload null-hostname: file:// URL has empty hostname → null → 400', async () => {
    const { controller, ctx } = await mountController();

    const response = await controller.createBrandForOrg({
      ...ctx,
      params: { spaceCatId: ORG_ID },
      data: {
        name: 'Brand X',
        // file:///path contains '://' so it bypasses the https:// prefix, but
        // new URL('file:///path').hostname is '' → url.hostname || null → null.
        urls: ['file:///local/path'],
        semrushMarket: { market: 'us', languageCode: 'en' },
        semrushModelIds: ['model-a'],
      },
      dataAccess: ctx.dataAccess,
    });

    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.message).to.match(/primary URL is required/i);
  });

  // Line 684: checkPromptsByBrand — `context.data || {}` — fires when context.data
  // is undefined. The handler then extracts `prompts` from {}, finds no array, and
  // returns 400.
  it('checkPromptsByBrand: falls back to {} when context.data is absent', async () => {
    const Mocked = await esmock('../../src/controllers/brands.js', {
      '../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({ hasAccess: async () => true, hasAdminAccess: () => true }),
        },
      },
      '../../src/support/prompts-storage.js': {
        resolveBrandUuid: stub().resolves(BRAND_UUID),
        checkPromptsExist: stub().resolves([]),
        listPrompts: stub().resolves({ data: [], count: 0 }),
        getPromptById: stub().resolves(null),
        upsertPrompts: stub().resolves({}),
        updatePromptById: stub().resolves(null),
        deletePromptById: stub().resolves(false),
        bulkDeletePrompts: stub().resolves({}),
        getPromptStats: stub().resolves({}),
        findPromptsBlockingRegionRemoval: stub().resolves({}),
      },
    });
    const ctx = buildContext();
    const controller = Mocked.default(ctx, loggerStub, mockEnv);

    const response = await controller.checkPromptsByBrand({
      ...ctx,
      params: { spaceCatId: ORG_ID, brandId: BRAND_UUID },
      data: undefined, // exercises context.data || {} at line 684
    });

    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.message).to.match(/prompts.*array required/i);
  });

  // Line 737: getPromptStatsByBrand — `context.params || {}` — fires when
  // context.params is undefined. spaceCatId and brandId are both undefined →
  // first validation check returns 400.
  it('getPromptStatsByBrand: falls back to {} when context.params is absent', async () => {
    const Mocked = await esmock('../../src/controllers/brands.js', {
      '../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({ hasAccess: async () => true, hasAdminAccess: () => true }),
        },
      },
      '../../src/support/prompts-storage.js': {
        resolveBrandUuid: stub().resolves(BRAND_UUID),
        checkPromptsExist: stub().resolves([]),
        listPrompts: stub().resolves({ data: [], count: 0 }),
        getPromptById: stub().resolves(null),
        upsertPrompts: stub().resolves({}),
        updatePromptById: stub().resolves(null),
        deletePromptById: stub().resolves(false),
        bulkDeletePrompts: stub().resolves({}),
        getPromptStats: stub().resolves({}),
        findPromptsBlockingRegionRemoval: stub().resolves({}),
      },
    });
    const ctx = buildContext();
    const controller = Mocked.default(ctx, loggerStub, mockEnv);

    const response = await controller.getPromptStatsByBrand({
      ...ctx,
      params: undefined, // exercises context.params || {} at line 737
    });

    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.message).to.match(/Organization ID required/i);
  });

  // Lines 1539-1540: updateBrandForOrg — `before?.region || []` and
  // `updates.region || []`. These fire when the before-brand has no region field
  // and the updates payload has no region (null/undefined/not set). In practice
  // `updates.region` is undefined when the caller sets region to something; here
  // we test the [] fallback.
  it('updateBrandForOrg: before.region || [] and updates.region || [] fallback when both are absent', async () => {
    const findPromptsStub = stub().resolves({});
    const updateBrandStubLocal = stub().resolves({ id: BRAND_UUID });
    const Mocked = await esmock('../../src/controllers/brands.js', {
      '../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({ hasAccess: async () => true, hasAdminAccess: () => true }),
        },
      },
      '../../src/support/prompts-storage.js': {
        resolveBrandUuid: stub().resolves(BRAND_UUID),
        findPromptsBlockingRegionRemoval: findPromptsStub,
        listPrompts: stub().resolves({ data: [], count: 0 }),
        getPromptById: stub().resolves(null),
        upsertPrompts: stub().resolves({}),
        updatePromptById: stub().resolves(null),
        deletePromptById: stub().resolves(false),
        bulkDeletePrompts: stub().resolves({}),
        checkPromptsExist: stub().resolves([]),
        getPromptStats: stub().resolves({}),
      },
      '../../src/support/brands-storage.js': {
        getBrandById: stub().resolves({ id: BRAND_UUID }), // no region field → undefined
        updateBrand: updateBrandStubLocal,
        getBrandCompetitors: stub().resolves([]),
        listBrands: stub().resolves([]),
        upsertBrand: stub().resolves({}),
        deleteBrand: stub().resolves(true),
        getBrandBySite: stub().resolves(null),
      },
    });
    const ctx = buildContext();
    const controller = Mocked.default(ctx, loggerStub, mockEnv);

    await controller.updateBrandForOrg({
      ...ctx,
      params: { spaceCatId: ORG_ID, brandId: BRAND_UUID },
      data: { region: null }, // sets updates.region to null → || [] fires at line 1540
    });

    // The brand row returned null (not found) → 404; the important thing is
    // that both || [] branches were exercised on the way to findPromptsBlockingRegionRemoval.
    expect(findPromptsStub).to.have.been.calledOnce;
    const arg = findPromptsStub.firstCall.args[0];
    expect(arg.oldRegions).to.deep.equal([]); // before?.region was undefined → line 1539
    expect(arg.newRegions).to.deep.equal([]); // updates.region was null → line 1540
  });
});
