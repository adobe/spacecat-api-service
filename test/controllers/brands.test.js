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
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
      };
      mockDataAccess.services.postgrestClient.from = sandbox.stub().callsFake((table) => {
        if (table === 'prompts') {
          const insertChain = { select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) };
          return {
            select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
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
    beforeEach(() => {
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          upsert: sandbox.stub().returnsThis(),
          single: sandbox.stub().resolves({
            data: {
              id: 'cat-uuid',
              category_id: 'my-category',
              name: 'My Category',
              status: 'active',
              origin: 'human',
              updated_at: '2026-01-01T00:00:00Z',
              updated_by: 'user@test.com',
            },
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
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
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

    it('returns 409 when the storage layer throws a duplicate-name error', async () => {
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
              message: 'duplicate key value violates unique constraint "uq_category_name_per_org"',
              details: 'Key (organization_id, name)=(..., DupTest) already exists.',
              hint: '',
            },
          }),
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

      expect(response.status).to.equal(409);
      const body = await response.json();
      expect(body.message).to.match(/already exists/i);
    });

    it('returns 500 when the storage layer returns a non-23505 PostgREST error', async () => {
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
              code: '23503',
              message: 'insert or update on table "categories" violates foreign key constraint "categories_org_fk"',
              details: '',
              hint: '',
            },
          }),
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
      expect(body.message).to.match(/Failed to create category/);
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
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
        data: { name: 'Updated Category' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
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
        params: { spaceCatId: 'not-a-uuid', categoryId: 'my-category' },
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

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.updateCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
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
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
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
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'nonexistent' },
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
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
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
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
        data: { name: 'Updated' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(500);
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
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
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
        params: { spaceCatId: 'not-a-uuid', categoryId: 'my-category' },
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

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(404);
    });

    it('returns 503 when postgrestClient is unavailable', async () => {
      mockDataAccess.services.postgrestClient = null;
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.deleteCategoryForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
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
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'nonexistent' },
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
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
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
        params: { spaceCatId: ORGANIZATION_ID, categoryId: 'my-category' },
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
      mockDataAccess.services.postgrestClient = {
        from: sandbox.stub().callsFake(() => ({
          select: sandbox.stub().returnsThis(),
          eq: sandbox.stub().returnsThis(),
          neq: sandbox.stub().returnsThis(),
          order: sandbox.stub().returnsThis(),
          upsert: sandbox.stub().returnsThis(),
          single: sandbox.stub().resolves({
            data: {
              id: 'topic-uuid',
              topic_id: 'my-topic',
              name: 'My Topic',
              description: null,
              status: 'active',
              brand_id: null,
              updated_at: '2026-01-01T00:00:00Z',
              updated_by: 'user@test.com',
            },
            error: null,
          }),
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
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
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
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
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
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
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
              status: 'active',
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
        data: { name: 'New Brand' },
        dataAccess: mockDataAccess,
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(201);
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

    it('returns 400 when brand name is missing', async () => {
      const response = await brandsController.createBrandForOrg({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
        data: { description: 'No name' },
        dataAccess: mockDataAccess,
      });
      expect(response.status).to.equal(400);
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
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
      });
      expect(response.status).to.equal(200);
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
        attributes: { authInfo: { profile: { email: 'user@test.com' } } },
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

  describe('triggerConfigSync', () => {
    let sqsStub;
    const SYNC_SITE_ID = '00000000-0000-0000-0000-000000000001';

    beforeEach(() => {
      sqsStub = sinon.stub().resolves();
      mockEnv.AUDIT_JOBS_QUEUE_URL = 'https://sqs.example.com/queue';
      mockDataAccess.Site.findById.withArgs(SYNC_SITE_ID).resolves(sites[0]);
      brandsController = BrandsController(context, loggerStub, mockEnv);
    });

    it('enqueues SQS message for a valid site', async () => {
      const response = await brandsController.triggerConfigSync({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SYNC_SITE_ID },
        sqs: { sendMessage: sqsStub },
        env: mockEnv,
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.message).to.equal('Config sync triggered');
      expect(body.siteId).to.equal(SYNC_SITE_ID);
      expect(sqsStub).to.have.been.calledWith(
        'https://sqs.example.com/queue',
        { type: 'llmo-config-db-sync', siteId: SYNC_SITE_ID },
      );
    });

    it('enqueues SQS message with dryRun flag when dryRun=true query param is provided', async () => {
      const response = await brandsController.triggerConfigSync({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SYNC_SITE_ID },
        invocation: { event: { rawQueryString: 'dryRun=true' } },
        sqs: { sendMessage: sqsStub },
        env: mockEnv,
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.message).to.equal('Config sync (dry run) triggered');
      expect(body.siteId).to.equal(SYNC_SITE_ID);
      expect(body.dryRun).to.be.true;
      expect(sqsStub).to.have.been.calledWith(
        'https://sqs.example.com/queue',
        { type: 'llmo-config-db-sync', siteId: SYNC_SITE_ID, dryRun: true },
      );
    });

    it('returns 400 when organization ID is missing', async () => {
      const response = await brandsController.triggerConfigSync({
        ...context,
        params: {},
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when params is undefined', async () => {
      const response = await brandsController.triggerConfigSync({
        ...context,
        params: undefined,
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when organization ID is not a UUID', async () => {
      const response = await brandsController.triggerConfigSync({
        ...context,
        params: { spaceCatId: 'not-a-uuid' },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.triggerConfigSync({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });
      expect(response.status).to.equal(404);
    });

    it('returns 400 when siteId is missing', async () => {
      const response = await brandsController.triggerConfigSync({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when siteId is not a valid UUID', async () => {
      const response = await brandsController.triggerConfigSync({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: 'not-a-uuid' },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 404 when site is not found', async () => {
      mockDataAccess.Site.findById.withArgs(SYNC_SITE_ID).resolves(null);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.triggerConfigSync({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SYNC_SITE_ID },
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when site does not belong to the organization', async () => {
      const otherOrgSite = {
        getOrganizationId: () => 'other-org-id',
        getConfig: () => ({}),
      };
      mockDataAccess.Site.findById.withArgs(SYNC_SITE_ID).resolves(otherOrgSite);
      brandsController = BrandsController(context, loggerStub, mockEnv);

      const response = await brandsController.triggerConfigSync({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SYNC_SITE_ID },
      });
      expect(response.status).to.equal(403);
    });

    it('returns 400 when site is not in ALLOWED_SITE_IDS', async () => {
      const response = await brandsController.triggerConfigSync({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SITE_ID },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 403 when user does not have access to the organization', async () => {
      const noAccessAuth = {
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([{ name: 'user' }])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };
      const noAccessContext = { ...context, ...noAccessAuth };
      const ctrl = BrandsController(noAccessContext, loggerStub, mockEnv);

      const response = await ctrl.triggerConfigSync({
        ...noAccessContext,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SYNC_SITE_ID },
      });
      expect(response.status).to.equal(403);
    });

    it('returns 500 when SQS sendMessage throws', async () => {
      const response = await brandsController.triggerConfigSync({
        ...context,
        params: { spaceCatId: ORGANIZATION_ID, siteId: SYNC_SITE_ID },
        sqs: { sendMessage: sinon.stub().rejects(new Error('SQS failure')) },
        env: mockEnv,
      });
      expect(response.status).to.equal(500);
    });
  });
});
