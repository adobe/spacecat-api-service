/*
 * Copyright 2023 Adobe. All rights reserved.
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
import TierClient from '@adobe/spacecat-shared-tier-client';

import { fileURLToPath } from 'url';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';
import nock from 'nock';
import sinonChai from 'sinon-chai';
import sinon, { stub } from 'sinon';

import SitesController, { resolveOrgDefaultSite } from '../../src/controllers/sites.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Sites Controller', () => {
  const sandbox = sinon.createSandbox();

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
    debug: sandbox.stub(),
  };

  const SITE_IDS = ['0b4dcf79-fe5f-410b-b11f-641f0bf56da3', 'c4420c67-b4e8-443d-b7ab-0099cfd5da20'];
  const BRAND_PROFILE_TRIGGER_MODULE = fileURLToPath(new URL('../../src/support/brand-profile-trigger.js', import.meta.url));
  const ACCESS_CONTROL_MODULE = fileURLToPath(new URL('../../src/support/access-control-util.js', import.meta.url));

  const defaultAuthAttributes = {
    attributes: {
      authInfo: new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'admin' }])
        .withProfile({ is_admin: true, email: 'test@test.com' })
        .withAuthenticated(true),
    },
  };

  const apikeyAuthAttributes = {
    attributes: {
      authInfo: new AuthInfo()
        .withType('apikey')
        .withScopes([{ name: 'admin' }])
        .withProfile({ name: 'api-key' })
        .withAuthenticated(true),
    },
  };

  const buildSites = () => ([
    {
      siteId: SITE_IDS[0], baseURL: 'https://site1.com', deliveryType: 'aem_edge', authoringType: 'cs/crosswalk', deliveryConfig: {}, config: Config({}), hlxConfig: {}, isSandbox: false, code: null,
    },
    {
      siteId: SITE_IDS[1], baseURL: 'https://site2.com', deliveryType: 'aem_edge', authoringType: 'cs/crosswalk', config: Config({}), hlxConfig: {}, isSandbox: false, code: null,
    },
  ]).map((site) => new Site(
    {
      entities: {
        site: {
          model: {
            indexes: {},
            schema: {
              attributes: {
                name: { type: 'string', name: 'name', get: (value) => value },
                config: { type: 'any', name: 'config', get: (value) => Config(value) },
                deliveryType: { type: 'string', name: 'deliveryType', get: (value) => value },
                authoringType: { type: 'string', name: 'authoringType', get: (value) => value },
                gitHubURL: { type: 'string', name: 'gitHubURL', get: (value) => value },
                isLive: { type: 'boolean', name: 'isLive', get: (value) => value },
                isSandbox: { type: 'boolean', name: 'isSandbox', get: (value) => value },
                organizationId: { type: 'string', name: 'organizationId', get: (value) => value },
                hlxConfig: { type: 'any', name: 'hlxConfig', get: (value) => value },
                deliveryConfig: { type: 'any', name: 'deliveryConfig', get: (value) => value },
                updatedBy: { type: 'string', name: 'updatedBy', get: (value) => value },
                code: { type: 'any', name: 'code', get: (value) => value },
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
        applyUpdateWatchers: (record, updates) => ({ record, updates }),
        updateByKeys: stub().resolves(),
      }),
    },
    SiteSchema,
    site,
    loggerStub,
  ));

  let sites;

  const siteFunctions = [
    'createSite',
    'getAll',
    'getAllByDeliveryType',
    'getAllWithLatestAudit',
    'getLatestSiteMetrics',
    'getAllAsCSV',
    'getAllAsXLS',
    'getAuditForSite',
    'getByBaseURL',
    'getByID',
    'getIdentity',
    'getBrandProfile',
    'removeSite',
    'updateSite',
    'updateCdnLogsConfig',
    'getScraperConfig',
    'updateScraperConfig',
    'getPageCitabilityCounts',
    'getTopPages',
    'getSiteMetricsBySource',
    'getPageMetricsBySource',
    'resolveSite',
    'triggerBrandProfile',
    'getGraph',
  ];

  let mockDataAccess;
  let sitesController;
  let context;
  let updateRumConfigStub;
  let getBrandBySiteStub;
  let isSemrushMarketMirrorSiteStub;
  let SitesControllerMocked;

  before(async () => {
    updateRumConfigStub = sandbox.stub().resolves(true);
    getBrandBySiteStub = sandbox.stub().resolves(null);
    isSemrushMarketMirrorSiteStub = sandbox.stub().resolves(false);
    SitesControllerMocked = (await esmock('../../src/controllers/sites.js', {
      '../../src/support/rum-config-service.js': {
        updateRumConfig: updateRumConfigStub,
      },
      '../../src/support/brands-storage.js': {
        getBrandBySite: getBrandBySiteStub,
        isSemrushMarketMirrorSite: isSemrushMarketMirrorSiteStub,
      },
    })).default;
  });

  beforeEach(() => {
    sites = buildSites();

    // Reset the brand-attachment stubs to their permissive defaults here (rather than
    // at the END of individual tests) so an aborted test can never leak contaminated
    // stub state into the next one.
    getBrandBySiteStub.reset();
    getBrandBySiteStub.resolves(null);
    isSemrushMarketMirrorSiteStub.reset();
    isSemrushMarketMirrorSiteStub.resolves(false);

    mockDataAccess = {
      Audit: {
        findBySiteIdAndAuditTypeAndAuditedAt: sandbox.stub().resolves({
          getAuditResult: sandbox.stub().resolves({}),
          getAuditType: sandbox.stub().returns('lhs-mobile'),
          getAuditedAt: sandbox.stub().returns('2021-01-01T00:00:00.000Z'),
          getFullAuditRef: sandbox.stub().returns('https://site1.com/lighthouse/20210101T000000.000Z/lhs-mobile.json'),
          getIsError: sandbox.stub().returns(false),
          getIsLive: sandbox.stub().returns(true),
          getSiteId: sandbox.stub().returns(SITE_IDS[0]),
          getInvocationId: sandbox.stub().returns('some-invocation-id'),
        }),
      },
      Site: {
        all: sandbox.stub().resolves(sites),
        allByDeliveryType: sandbox.stub().resolves(sites),
        allWithLatestAudit: sandbox.stub().resolves(sites),
        allByOrganizationId: sandbox.stub().resolves(sites),
        create: sandbox.stub().resolves(sites[0]),
        // NOTE: findByBaseURL defaults to returning sites[0] (existing site).
        // eslint-disable-next-line max-len
        // Tests calling createSite should override this with .resolves(null) to test site creation path.
        findByBaseURL: sandbox.stub().resolves(sites[0]),
        findById: sandbox.stub().resolves(sites[0]),
      },
      SiteTopPage: {
        allBySiteId: sandbox.stub().resolves([]),
        allBySiteIdAndSource: sandbox.stub().resolves([]),
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves([]),
      },
      PageCitability: {
        allBySiteId: sandbox.stub().resolves([]),
      },
      Organization: {
        findById: sandbox.stub().resolves(null),
        findByImsOrgId: sandbox.stub().resolves(null),
      },
      PlgOnboarding: {
        allByImsOrgId: sandbox.stub().resolves([]),
      },
      SiteEnrollment: {
        allByEntitlementId: sandbox.stub().resolves([]),
        allBySiteId: sandbox.stub().resolves([]),
        create: sandbox.stub().resolves({ getId: () => 'enrollment-created' }),
      },
    };

    context = {
      runtime: { name: 'aws-lambda', region: 'us-east-1' },
      func: { package: 'spacecat-services', version: 'ci', name: 'test' },
      rumApiClient: {
        query: sandbox.stub(),
      },
      log: loggerStub,
      env: {
        DEFAULT_ORGANIZATION_ID: 'default',
        ORGANIZATION_ID_FRIENDS_FAMILY: 'friends-family',
        AGENT_WORKFLOW_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123456789012:stateMachine:agent-workflow',
      },
      dataAccess: mockDataAccess,
      pathInfo: {
        headers: { 'x-product': 'abcd' },
      },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true, email: 'test@test.com' })
          .withAuthenticated(true),
      },
    };
    nock('https://secretsmanager.us-east-1.amazonaws.com/')
      .post('/', (body) => body.SecretId === '/helix-deploy/spacecat-services/customer-secrets/site1_com/ci')
      .reply(200, {
        SecretString: JSON.stringify({
          RUM_DOMAIN_KEY: '42',
        }),
      });
    sitesController = SitesControllerMocked(context, loggerStub, context.env);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    siteFunctions.forEach((funcName) => {
      expect(sitesController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(sitesController).forEach((funcName) => {
      expect(siteFunctions).to.include(funcName);
    });
  });

  it('throws an error if context is not an object', () => {
    expect(() => SitesController()).to.throw('Context required');
  });

  it('throws an error if data access is not an object', () => {
    expect(() => SitesController({ dataAccess: {} })).to.throw('Data access required');
  });

  it('creates a site', async () => {
    mockDataAccess.Site.findByBaseURL.resolves(null); // No existing site found
    const response = await sitesController.createSite({ data: { baseURL: 'https://site1.com' } });

    expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledOnceWith('https://site1.com');
    expect(mockDataAccess.Site.create).to.have.been.calledOnce;
    expect(response.status).to.equal(201);

    const site = await response.json();
    expect(site).to.have.property('id', SITE_IDS[0]);
    expect(site).to.have.property('baseURL', 'https://site1.com');
  });

  it('returns 201 even when RUM config update fails after site creation', async () => {
    mockDataAccess.Site.findByBaseURL.resolves(null);
    updateRumConfigStub.rejects(new Error('RUM API unavailable'));

    const response = await sitesController.createSite({ data: { baseURL: 'https://site1.com' } });

    expect(mockDataAccess.Site.create).to.have.been.calledOnce;
    expect(response.status).to.equal(201);
  });

  it('creates a site for a non-admin user', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const response = await sitesController.createSite({ data: { baseURL: 'https://site1.com' } });

    expect(mockDataAccess.Site.create).to.have.not.been.called;
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'Only admins can create new sites');
  });

  it('returns forbidden for read-only admin when creating a site', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false, is_read_only_admin: true });
    const response = await sitesController.createSite({ data: { baseURL: 'https://site1.com' } });

    expect(mockDataAccess.Site.create).to.have.not.been.called;
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'Only admins can create new sites');
  });

  describe('POST /sites - S2S site:create capability', () => {
    function makeS2SConsumer({ clientId = 'svc-sandbox', imsOrgId = 'AAA111111111111111111111@AdobeOrg' } = {}) {
      return { getClientId: () => clientId, getImsOrgId: () => imsOrgId };
    }

    function makeFreshConsumer({
      id = 'consumer-id-sandbox',
      capabilities = ['site:write'],
      status = 'ACTIVE',
      revoked = false,
    } = {}) {
      return {
        getId: () => id,
        getCapabilities: () => capabilities,
        getStatus: () => status,
        isRevoked: () => revoked,
      };
    }

    beforeEach(() => {
      context.attributes.authInfo.withProfile({ is_admin: false });
      mockDataAccess.Consumer = { findByClientIdAndImsOrgId: sandbox.stub() };
    });

    it('grants access to S2S consumer with capabilities: [site:create]', async () => {
      context.s2sConsumer = makeS2SConsumer();
      mockDataAccess.Consumer.findByClientIdAndImsOrgId
        .resolves(makeFreshConsumer({ capabilities: ['site:create'] }));
      mockDataAccess.Site.findByBaseURL.resolves(null);

      const result = await sitesController.createSite({ data: { baseURL: 'https://newsite.com' } });

      expect(result.status).to.equal(201);
      expect(mockDataAccess.Site.create).to.have.been.calledOnce;
    });

    it('denies S2S consumer without capability (missing-capability) → 403', async () => {
      context.s2sConsumer = makeS2SConsumer();
      mockDataAccess.Consumer.findByClientIdAndImsOrgId
        .resolves(makeFreshConsumer({ capabilities: [] }));

      const result = await sitesController.createSite({ data: { baseURL: 'https://newsite.com' } });
      const body = await result.json();

      expect(result.status).to.equal(403);
      expect(body).to.have.property('message', 'Only admins can create new sites');
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[acl\] Denied POST \/sites - reason=missing-capability/,
      );
    });

    it('denies non-S2S non-admin caller (not-s2s) → 403', async () => {
      const result = await sitesController.createSite({ data: { baseURL: 'https://newsite.com' } });
      const body = await result.json();

      expect(result.status).to.equal(403);
      expect(body).to.have.property('message', 'Only admins can create new sites');
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[acl\] Denied POST \/sites - reason=not-s2s/,
      );
    });

    it('admin user bypasses capability check entirely → 201', async () => {
      context.attributes.authInfo.withProfile({ is_admin: true });
      mockDataAccess.Site.findByBaseURL.resolves(null);

      const result = await sitesController.createSite({ data: { baseURL: 'https://newsite.com' } });

      expect(result.status).to.equal(201);
      expect(mockDataAccess.Consumer.findByClientIdAndImsOrgId).to.not.have.been.called;
    });

    it('denies revoked S2S consumer (revoked) → 403', async () => {
      context.s2sConsumer = makeS2SConsumer();
      mockDataAccess.Consumer.findByClientIdAndImsOrgId
        .resolves(makeFreshConsumer({ revoked: true }));

      const result = await sitesController.createSite({ data: { baseURL: 'https://newsite.com' } });
      const body = await result.json();

      expect(result.status).to.equal(403);
      expect(body).to.have.property('message', 'Only admins can create new sites');
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[acl\] Denied POST \/sites - reason=revoked/,
      );
    });

    it('denies suspended S2S consumer (not-active) → 403', async () => {
      context.s2sConsumer = makeS2SConsumer();
      mockDataAccess.Consumer.findByClientIdAndImsOrgId
        .resolves(makeFreshConsumer({ status: 'SUSPENDED' }));

      const result = await sitesController.createSite({ data: { baseURL: 'https://newsite.com' } });
      const body = await result.json();

      expect(result.status).to.equal(403);
      expect(body).to.have.property('message', 'Only admins can create new sites');
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[acl\] Denied POST \/sites - reason=not-active/,
      );
    });
  });

  it('returns bad request when creating a site without baseURL', async () => {
    const response = await sitesController.createSite({ data: {} });

    expect(mockDataAccess.Site.findByBaseURL).to.have.not.been.called;
    expect(mockDataAccess.Site.create).to.have.not.been.called;
    expect(response.status).to.equal(400);

    const error = await response.json();
    expect(error).to.have.property('message', 'Base URL required');
  });

  it('returns bad request when creating a site with null baseURL', async () => {
    const response = await sitesController.createSite({ data: { baseURL: null } });

    expect(mockDataAccess.Site.findByBaseURL).to.have.not.been.called;
    expect(mockDataAccess.Site.create).to.have.not.been.called;
    expect(response.status).to.equal(400);

    const error = await response.json();
    expect(error).to.have.property('message', 'Base URL required');
  });

  it('returns bad request when creating a site with empty string baseURL', async () => {
    const response = await sitesController.createSite({ data: { baseURL: '' } });

    expect(mockDataAccess.Site.findByBaseURL).to.have.not.been.called;
    expect(mockDataAccess.Site.create).to.have.not.been.called;
    expect(response.status).to.equal(400);

    const error = await response.json();
    expect(error).to.have.property('message', 'Base URL required');
  });

  it('returns existing site when creating a site with duplicate baseURL', async () => {
    // findByBaseURL is already stubbed to return sites[0] in beforeEach
    const response = await sitesController.createSite({ data: { baseURL: 'https://site1.com' } });

    expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledOnceWith('https://site1.com');
    expect(mockDataAccess.Site.create).to.have.not.been.called;
    expect(response.status).to.equal(200);

    const site = await response.json();
    expect(site).to.have.property('id', SITE_IDS[0]);
    expect(site).to.have.property('baseURL', 'https://site1.com');
  });

  it('normalizes baseURL using composeBaseURL when checking for duplicates', async () => {
    // Test with URL that needs normalization (www, trailing slash, uppercase)
    const response = await sitesController.createSite({ data: { baseURL: 'https://WWW.site1.com/' } });

    // composeBaseURL should normalize to 'https://site1.com' (lowercase, no www, no trailing slash)
    expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledOnceWith('https://site1.com');
    expect(mockDataAccess.Site.create).to.have.not.been.called;
    expect(response.status).to.equal(200);

    const site = await response.json();
    expect(site).to.have.property('id', SITE_IDS[0]);
  });

  it('creates a site with normalized baseURL when URL needs normalization', async () => {
    mockDataAccess.Site.findByBaseURL.resolves(null); // No existing site found
    // Provide URL that needs normalization
    const response = await sitesController.createSite({ data: { baseURL: 'https://WWW.site1.com/' } });

    // Should check for duplicates with normalized URL
    expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledOnceWith('https://site1.com');

    // Should create site with normalized URL (context.data.baseURL is overridden)
    expect(mockDataAccess.Site.create).to.have.been.calledOnce;
    const createCallArg = mockDataAccess.Site.create.firstCall.args[0];
    expect(createCallArg).to.have.property('baseURL', 'https://site1.com');

    expect(response.status).to.equal(201);
  });

  it('handles database errors when checking for duplicate baseURL', async () => {
    const dbError = new Error('Database connection failed');
    mockDataAccess.Site.findByBaseURL.rejects(dbError);

    const response = await sitesController.createSite({ data: { baseURL: 'https://site1.com' } });

    // Should attempt to check for duplicates
    expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledOnceWith('https://site1.com');
    // Should not attempt to create site if findByBaseURL throws
    expect(mockDataAccess.Site.create).to.have.not.been.called;
    // Should return internal server error
    expect(response.status).to.equal(500);

    const error = await response.json();
    expect(error).to.have.property('message', 'Failed to create site');
  });

  describe('createSite auto-enrollment via x-product header', () => {
    let tierClientStub;

    beforeEach(() => {
      tierClientStub = {
        checkValidEntitlement: sandbox.stub().resolves({
          entitlement: null,
          siteEnrollment: null,
        }),
        createEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'entitlement-123' },
          siteEnrollment: { getId: () => 'enrollment-123' },
        }),
      };
      sandbox.stub(TierClient, 'createForSite').resolves(tierClientStub);
    });

    it('creates entitlement and enrollment for a newly created site when x-product header is set', async () => {
      mockDataAccess.Site.findByBaseURL.resolves(null);

      const response = await sitesController.createSite({
        data: { baseURL: 'https://site1.com' },
        pathInfo: { headers: { 'x-product': 'ASO' } },
      });

      expect(response.status).to.equal(201);
      expect(TierClient.createForSite).to.have.been.calledOnce;
      expect(TierClient.createForSite).to.have.been.calledWith(
        sinon.match.object,
        sinon.match.object,
        'ASO',
      );
      expect(tierClientStub.createEntitlement).to.have.been.calledOnceWith('FREE_TRIAL');
      expect(loggerStub.info).to.have.been.calledWithMatch(/Ensured ASO entitlement entitlement-123 and enrollment enrollment-123/);
    });

    it('skips auto-enrollment for an existing site when x-product header is set', async () => {
      const response = await sitesController.createSite({
        data: { baseURL: 'https://site1.com' },
        pathInfo: { headers: { 'x-product': 'ASO' } },
      });

      expect(response.status).to.equal(200);
      expect(mockDataAccess.Site.create).to.have.not.been.called;
      expect(TierClient.createForSite).to.have.not.been.called;
    });

    it('skips auto-enrollment when x-product header is missing', async () => {
      mockDataAccess.Site.findByBaseURL.resolves(null);

      const response = await sitesController.createSite({
        data: { baseURL: 'https://site1.com' },
        pathInfo: { headers: {} },
      });

      expect(response.status).to.equal(201);
      expect(TierClient.createForSite).to.have.not.been.called;
    });

    it('skips auto-enrollment when x-product header is an empty string', async () => {
      mockDataAccess.Site.findByBaseURL.resolves(null);

      const response = await sitesController.createSite({
        data: { baseURL: 'https://site1.com' },
        pathInfo: { headers: { 'x-product': '' } },
      });

      expect(response.status).to.equal(201);
      expect(TierClient.createForSite).to.have.not.been.called;
    });

    it('returns 400 for an invalid x-product header', async () => {
      mockDataAccess.Site.findByBaseURL.resolves(null);

      const response = await sitesController.createSite({
        data: { baseURL: 'https://site1.com' },
        pathInfo: { headers: { 'x-product': 'NOT_A_PRODUCT' } },
      });

      expect(response.status).to.equal(400);
      expect(TierClient.createForSite).to.have.not.been.called;
      const body = await response.json();
      expect(body.message).to.match(/Unsupported product code/);
    });

    it('does not call TierClient for non-admin callers even when x-product is set', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });

      const response = await sitesController.createSite({
        data: { baseURL: 'https://site1.com' },
        pathInfo: { headers: { 'x-product': 'ASO' } },
      });

      expect(response.status).to.equal(403);
      expect(TierClient.createForSite).to.have.not.been.called;
    });

    it('uses existing PRE_ONBOARD tier when provisioning a newly created site', async () => {
      mockDataAccess.Site.findByBaseURL.resolves(null);
      tierClientStub.checkValidEntitlement.resolves({
        entitlement: { getId: () => 'entitlement-pre', getTier: () => 'PRE_ONBOARD' },
        siteEnrollment: null,
      });

      const response = await sitesController.createSite({
        data: { baseURL: 'https://site1.com' },
        pathInfo: { headers: { 'x-product': 'ASO' } },
      });

      expect(response.status).to.equal(201);
      expect(tierClientStub.createEntitlement).to.have.been.calledOnceWith('PRE_ONBOARD');
    });

    it('returns 500 when TierClient.createEntitlement throws for a newly created site', async () => {
      mockDataAccess.Site.findByBaseURL.resolves(null);
      tierClientStub.createEntitlement.rejects(new Error('Database error'));

      const response = await sitesController.createSite({
        data: { baseURL: 'https://site1.com' },
        pathInfo: { headers: { 'x-product': 'ASO' } },
      });

      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body).to.have.property('message', 'Failed to ensure entitlement/enrollment for site');
      expect(loggerStub.error).to.have.been.calledWithMatch(/event=site_orphaned_after_create/);
    });
  });

  it('updates a site', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        isLive: false,
        deliveryType: 'other',
        authoringType: 'cs',
        deliveryConfig: {
          programId: '12652',
          environmentId: '16854',
          authorURL: 'https://author-p12652-e16854-cmstg.adobeaemcloud.com/',
          siteId: '1234',
        },
        gitHubURL: 'https://github.com/blah/bluh',
        config: {},
        hlxConfig: {
          field: true,
        },
      },
      ...defaultAuthAttributes,
    });

    expect(site.save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);

    const updatedSite = await response.json();
    expect(updatedSite).to.have.property('id', SITE_IDS[0]);
    expect(updatedSite).to.have.property('baseURL', 'https://site1.com');
    expect(updatedSite).to.have.property('deliveryType', 'other');
    expect(updatedSite).to.have.property('gitHubURL', 'https://github.com/blah/bluh');
    expect(updatedSite.hlxConfig).to.deep.equal({ field: true });
    expect(updatedSite.deliveryConfig).to.deep.equal({
      programId: '12652',
      environmentId: '16854',
      authorURL: 'https://author-p12652-e16854-cmstg.adobeaemcloud.com/',
      siteId: '1234',
    });
  });

  it('updates a site with api key', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        isLive: false,
        deliveryType: 'other',
        authoringType: 'cs',
        deliveryConfig: {
          programId: '12652',
          environmentId: '16854',
          authorURL: 'https://author-p12652-e16854-cmstg.adobeaemcloud.com/',
          siteId: '1234',
        },
        gitHubURL: 'https://github.com/blah/bluh',
        config: {},
        hlxConfig: {
          field: true,
        },
      },
      ...apikeyAuthAttributes,
    });

    expect(site.save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);

    const updatedSite = await response.json();
    expect(updatedSite).to.have.property('id', SITE_IDS[0]);
    expect(updatedSite).to.have.property('baseURL', 'https://site1.com');
    expect(updatedSite).to.have.property('deliveryType', 'other');
    expect(updatedSite).to.have.property('gitHubURL', 'https://github.com/blah/bluh');
    expect(updatedSite).to.have.property('updatedBy', 'system');
    expect(updatedSite.hlxConfig).to.deep.equal({ field: true });
    expect(updatedSite.deliveryConfig).to.deep.equal({
      programId: '12652',
      environmentId: '16854',
      authorURL: 'https://author-p12652-e16854-cmstg.adobeaemcloud.com/',
      siteId: '1234',
    });
  });

  it('returns forbidden when trying to update organizationId', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        organizationId: 'b2c41adf-49c9-4d03-a84f-694491368723',
        isLive: false,
      },
      ...defaultAuthAttributes,
    });
    const error = await response.json();

    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(403);
    expect(error).to.have.property('message', 'Updating organization ID is not allowed');
  });

  it('returns forbidden when changing the URL of a site attached to a Semrush-managed brand', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    getBrandBySiteStub.reset();
    getBrandBySiteStub.resolves({ semrushSubWorkspaceId: 'sub-ws-123' });
    const postgrestClient = { from: () => {} };

    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: { baseURL: 'https://changed.example.com', deliveryType: 'other' },
      dataAccess: { services: { postgrestClient } },
      ...defaultAuthAttributes,
    });
    const error = await response.json();

    expect(getBrandBySiteStub).to.have.been.calledOnce;
    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(403);
    expect(error).to.have.property(
      'message',
      'Updating the URL of a site attached to a Semrush-managed brand is not allowed',
    );
  });

  it('allows changing the URL of a site not attached to a Semrush-managed brand', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    getBrandBySiteStub.reset();
    getBrandBySiteStub.resolves(null);
    const postgrestClient = { from: () => {} };

    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: { baseURL: 'https://changed.example.com', deliveryType: 'other' },
      dataAccess: { services: { postgrestClient } },
      ...defaultAuthAttributes,
    });

    expect(getBrandBySiteStub).to.have.been.calledOnce;
    expect(site.save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);
  });

  it('does not check brand attachment when the URL is unchanged', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    getBrandBySiteStub.reset();
    const postgrestClient = { from: () => {} };

    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      // baseURL equals the site's current URL, so the URL-immutability guard is skipped.
      data: { baseURL: 'https://site1.com', deliveryType: 'other' },
      dataAccess: { services: { postgrestClient } },
      ...defaultAuthAttributes,
    });

    expect(getBrandBySiteStub).to.have.not.been.called;
    expect(site.save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);
  });

  it('returns forbidden when changing the URL of a Semrush market-mirror site (linked via brand_sites)', async () => {
    // A serenity brand shell has no brands.site_id, so getBrandBySite finds
    // nothing; the market mirror is reachable only via the brand_sites lookup.
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    getBrandBySiteStub.reset();
    getBrandBySiteStub.resolves(null);
    isSemrushMarketMirrorSiteStub.reset();
    isSemrushMarketMirrorSiteStub.resolves(true);
    const postgrestClient = { from: () => {} };

    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: { baseURL: 'https://changed.example.com', deliveryType: 'other' },
      dataAccess: { services: { postgrestClient } },
      ...defaultAuthAttributes,
    });
    const error = await response.json();

    expect(isSemrushMarketMirrorSiteStub).to.have.been.calledOnce;
    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(403);
    expect(error).to.have.property(
      'message',
      'Updating the URL of a site attached to a Semrush-managed brand is not allowed',
    );
  });

  it('returns 500 (not an opaque throw) when the brand-attachment lookup fails', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    getBrandBySiteStub.reset();
    getBrandBySiteStub.rejects(new Error('postgrest down'));
    const postgrestClient = { from: () => {} };

    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: { baseURL: 'https://changed.example.com', deliveryType: 'other' },
      dataAccess: { services: { postgrestClient } },
      ...defaultAuthAttributes,
    });
    const error = await response.json();

    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(500);
    expect(error).to.have.property(
      'message',
      'Could not verify whether this site URL is editable; please retry',
    );
  });

  it('returns bad request when updating a site if id not provided', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({ params: {}, ...defaultAuthAttributes });
    const error = await response.json();

    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns not found when updating a non-existing site', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    mockDataAccess.Site.findById.resolves(null);

    const response = await sitesController.updateSite(
      { params: { siteId: SITE_IDS[0] }, ...defaultAuthAttributes },
    );
    const error = await response.json();

    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('returns bad request when updating a site without payload', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite(
      {
        params: { siteId: SITE_IDS[0] },
        ...defaultAuthAttributes,
      },
    );
    const error = await response.json();

    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Request body required');
  });

  it('returns bad request when updating a site without modifications', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {},
      ...defaultAuthAttributes,
    });
    const error = await response.json();

    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('returns bad request when updating a site for non belonging to the organization', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const response = await sitesController.updateSite(
      { params: { siteId: SITE_IDS[0] }, ...defaultAuthAttributes },
    );
    const error = await response.json();

    expect(response.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can update its sites');
  });

  it('gets all sites with slim DTO', async () => {
    mockDataAccess.Site.all.resolves(sites);

    const result = await sitesController.getAll();
    const resultSites = await result.json();

    expect(mockDataAccess.Site.all).to.have.been.calledOnce;
    expect(resultSites).to.be.an('array').with.lengthOf(2);
    expect(resultSites[0]).to.have.property('id', SITE_IDS[0]);
    expect(resultSites[0]).to.have.property('baseURL', 'https://site1.com');
    expect(resultSites[1]).to.have.property('id', SITE_IDS[1]);
    expect(resultSites[1]).to.have.property('baseURL', 'https://site2.com');

    expect(resultSites[0]).to.not.have.any.keys('hlxConfig', 'authoringType', 'deliveryConfig', 'pageTypes', 'projectId', 'isPrimaryLocale', 'language', 'code', 'audits', 'updatedBy', 'isLiveToggledAt');
  });

  it('projects sites to the requested fields when ?fields= is passed (legacy shape)', async () => {
    mockDataAccess.Site.all.resolves(sites);

    const result = await sitesController.getAll({ ...context, data: { fields: 'baseURL' } });
    const resultSites = await result.json();

    expect(result.status).to.equal(200);
    expect(resultSites).to.be.an('array').with.lengthOf(2);
    expect(Object.keys(resultSites[0]).sort()).to.deep.equal(['baseURL', 'id']);
    expect(resultSites[0]).to.not.have.any.keys('config', 'deliveryType', 'name');
  });

  it('projects the sites array inside the paginated shape when ?fields= is passed', async () => {
    mockDataAccess.Site.all.resolves({ data: sites, cursor: null });

    const result = await sitesController.getAll({ ...context, data: { limit: '10', fields: 'baseURL' } });
    const body = await result.json();

    expect(result.status).to.equal(200);
    expect(body).to.have.property('pagination');
    expect(body.sites).to.be.an('array').with.lengthOf(2);
    expect(Object.keys(body.sites[0]).sort()).to.deep.equal(['baseURL', 'id']);
  });

  it('returns 400 when ?fields= matches no known site field', async () => {
    mockDataAccess.Site.all.resolves(sites);

    const result = await sitesController.getAll({ ...context, data: { fields: 'nope' } });
    expect(result.status).to.equal(400);
    const error = await result.json();
    expect(error).to.have.property('message', 'Invalid fields: nope');
  });

  it('emits [sites][legacy-shape] log on every legacy-path hit', async () => {
    // The [sites][legacy-shape] marker is the sunset gate for removing the legacy
    // branch — Coralogix must show zero hits before removal. Pin the format here so
    // a rename or accidental drop is caught by tests, not 30 days of silent lying.
    mockDataAccess.Site.all.resolves(sites);

    await sitesController.getAll({ ...context, invocation: { id: 'req-legacy-1' } });

    expect(loggerStub.info).to.have.been.calledWithMatch(
      /\[sites\]\[legacy-shape\] GET \/sites called without limit\/cursor requestId=req-legacy-1/,
    );
  });

  it('gets all sites for a read-only admin user', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false, is_read_only_admin: true });
    mockDataAccess.Site.all.resolves(sites);

    const result = await sitesController.getAll();
    const resultSites = await result.json();

    expect(result.status).to.equal(200);
    expect(resultSites).to.be.an('array').with.lengthOf(2);
  });

  it('gets all sites for a non-admin user', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    mockDataAccess.Site.all.resolves(sites);

    const result = await sitesController.getAll();
    const error = await result.json();

    expect(mockDataAccess.Site.all).to.have.not.been.called;
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Forbidden: admin access or site:readAll capability required');
  });

  it('gets all sites for a legacy API-key caller (non-JWT/non-IMS)', async () => {
    // Legacy API-key auth has type !== 'jwt' && !== 'ims', which makes hasAdminAccess() true.
    context.attributes.authInfo = new AuthInfo()
      .withType('api_key')
      .withScopes([])
      .withProfile({ user_id: 'api-key-svc' })
      .withAuthenticated(true);
    mockDataAccess.Site.all.resolves(sites);
    sitesController = SitesControllerMocked(context, loggerStub, context.env);

    const result = await sitesController.getAll();
    const body = await result.json();

    expect(result.status).to.equal(200);
    expect(body).to.be.an('array').with.lengthOf(2);
  });

  describe('GET /sites - cursor-based pagination', () => {
    it('returns paginated envelope when limit is provided', async () => {
      mockDataAccess.Site.all.resolves({ data: sites, cursor: null });

      const result = await sitesController.getAll({ ...context, data: { limit: '100' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body).to.have.all.keys('sites', 'pagination');
      expect(body.sites).to.be.an('array').with.lengthOf(2);
      expect(body.pagination).to.deep.equal({
        limit: 100,
        cursor: null,
        hasMore: false,
      });
    });

    it('returns paginated envelope when only cursor is provided', async () => {
      mockDataAccess.Site.all.resolves({ data: sites, cursor: null });

      const result = await sitesController.getAll({ ...context, data: { cursor: 'some-cursor' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body).to.have.all.keys('sites', 'pagination');
      expect(body.pagination.limit).to.equal(100); // DEFAULT_LIMIT
    });

    it('returns flat array when no limit or cursor is provided (legacy)', async () => {
      mockDataAccess.Site.all.resolves(sites);

      const result = await sitesController.getAll(context);
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body).to.be.an('array').with.lengthOf(2);
    });

    it('routes an empty-string cursor to the legacy path (no envelope)', async () => {
      // `?cursor=` coerces to null via `|| null`, so hasText() is false and the
      // request falls through to the legacy flat-array shape. Pinned so a future
      // switch from `||` to `??` (which would keep "") is caught.
      mockDataAccess.Site.all.resolves(sites);

      const result = await sitesController.getAll({ ...context, data: { cursor: '' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body).to.be.an('array').with.lengthOf(2);
      expect(mockDataAccess.Site.all).to.have.been.calledWithMatch(
        {},
        sinon.match({ fetchAllPages: true }),
      );
    });

    it('uses provided limit and returns cursor when more pages exist', async () => {
      mockDataAccess.Site.all.resolves({ data: sites, cursor: 'next-page-cursor' });

      const result = await sitesController.getAll({ ...context, data: { limit: '1' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.pagination).to.deep.equal({
        limit: 1,
        cursor: 'next-page-cursor',
        hasMore: true,
      });
    });

    it('clamps limit to MAX_LIMIT (500)', async () => {
      mockDataAccess.Site.all.resolves({ data: sites, cursor: null });

      const result = await sitesController.getAll({ ...context, data: { limit: '9999' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.pagination.limit).to.equal(500);
    });

    ['abc', '0', '-1', '-100'].forEach((badLimit) => {
      it(`returns 400 when limit is "${badLimit}"`, async () => {
        mockDataAccess.Site.all.resolves({ data: sites, cursor: null });

        const result = await sitesController.getAll({ ...context, data: { limit: badLimit } });
        const error = await result.json();

        expect(result.status).to.equal(400);
        expect(error).to.have.property('message', 'limit must be a positive integer');
        expect(mockDataAccess.Site.all).to.not.have.been.called;
      });
    });

    it('passes limit, cursor, and returnCursor to data access', async () => {
      mockDataAccess.Site.all.resolves({ data: sites, cursor: null });

      await sitesController.getAll({ ...context, data: { limit: '10', cursor: 'some-cursor' } });

      expect(mockDataAccess.Site.all).to.have.been.calledWithMatch(
        {},
        sinon.match({ limit: 10, cursor: 'some-cursor', returnCursor: true }),
      );
    });

    it('rejects cursor longer than 256 characters with 400', async () => {
      const longCursor = 'a'.repeat(257);

      const result = await sitesController.getAll({ ...context, data: { cursor: longCursor } });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'cursor exceeds maximum length');
      expect(mockDataAccess.Site.all).to.not.have.been.called;
    });

    it('accepts cursor of exactly 256 characters (boundary)', async () => {
      mockDataAccess.Site.all.resolves({ data: sites, cursor: null });
      const exactCursor = 'a'.repeat(256);

      const result = await sitesController.getAll({ ...context, data: { cursor: exactCursor } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.sites).to.be.an('array');
      expect(mockDataAccess.Site.all).to.have.been.calledWithMatch(
        {},
        sinon.match({ cursor: exactCursor }),
      );
    });

    [
      { label: 'number', value: 42 },
      { label: 'array', value: [1, 2, 3] },
      { label: 'object', value: { foo: 'bar' } },
    ].forEach(({ label, value }) => {
      it(`rejects non-string cursor (${label}) with 400`, async () => {
        const result = await sitesController.getAll({ ...context, data: { cursor: value } });
        const error = await result.json();

        expect(result.status).to.equal(400);
        expect(error).to.have.property('message', 'cursor must be a string');
        expect(mockDataAccess.Site.all).to.not.have.been.called;
      });
    });

    it('returns sites with slim DTO shape in paginated response', async () => {
      mockDataAccess.Site.all.resolves({ data: sites, cursor: null });

      const result = await sitesController.getAll({ ...context, data: { limit: '100' } });
      const body = await result.json();

      expect(body.sites[0]).to.have.property('id', SITE_IDS[0]);
      expect(body.sites[0]).to.have.property('baseURL', 'https://site1.com');
      expect(body.sites[0]).to.not.have.any.keys('hlxConfig', 'authoringType', 'deliveryConfig', 'pageTypes', 'projectId', 'isPrimaryLocale', 'language', 'code', 'audits', 'updatedBy', 'isLiveToggledAt');
    });

    it('denies non-admin caller in paginated path', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });

      const result = await sitesController.getAll({ ...context, data: { limit: '10' } });
      const error = await result.json();

      expect(result.status).to.equal(403);
      expect(error).to.have.property('message', 'Forbidden: admin access or site:readAll capability required');
      expect(mockDataAccess.Site.all).to.not.have.been.called;
    });

    [
      { label: 'null', value: null },
      { label: 'undefined', value: undefined },
      { label: 'empty object', value: {} },
    ].forEach(({ label, value }) => {
      it(`logs an error and returns an empty paginated envelope when Site.all resolves ${label}`, async () => {
        mockDataAccess.Site.all.resolves(value);

        const result = await sitesController.getAll({ ...context, data: { limit: '10' } });
        const body = await result.json();

        expect(result.status).to.equal(200);
        expect(body.sites).to.be.an('array').with.lengthOf(0);
        expect(body.pagination).to.deep.equal({ limit: 10, cursor: null, hasMore: false });
        expect(loggerStub.error).to.have.been.calledWithMatch(
          /\[sites\] Site\.all returned unexpected shape with returnCursor=true/,
        );
      });
    });
  });

  describe('GET /sites - baseUrlContains substring search', () => {
    it('queries Site.all with an ilike where clause, order asc, and limit N+1', async () => {
      mockDataAccess.Site.all.resolves(sites);

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site', limit: '10' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body).to.have.all.keys('sites', 'pagination');
      expect(body.sites).to.be.an('array').with.lengthOf(2);
      expect(body.pagination).to.deep.equal({
        limit: 10, offset: 0, hasMore: false, baseUrlContains: 'site',
      });

      expect(mockDataAccess.Site.all).to.have.been.calledOnce;
      const [firstArg, opts] = mockDataAccess.Site.all.firstCall.args;
      expect(firstArg).to.deep.equal({});
      expect(opts.order).to.equal('asc');
      expect(opts.limit).to.equal(11); // effectiveLimit (10) + 1

      // Invoke the captured `where` builder with the real (attrs, op) signature:
      // attrs maps model fields to DB columns (baseURL -> base_url), op carries operators.
      const attrs = { baseURL: 'base_url' };
      const op = { ilike: sinon.stub().returnsThis() };
      opts.where(attrs, op);
      expect(op.ilike).to.have.been.calledOnceWithExactly('base_url', '%site%');
    });

    it('uses default limit of 50 when no limit param is provided', async () => {
      mockDataAccess.Site.all.resolves(sites);

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.pagination).to.deep.equal({
        limit: 50, offset: 0, hasMore: false, baseUrlContains: 'site',
      });
      const [, opts] = mockDataAccess.Site.all.firstCall.args;
      expect(opts.limit).to.equal(51); // 50 + 1
    });

    it('defaults offset to 0 and passes an offset-encoded cursor when offset is omitted', async () => {
      mockDataAccess.Site.all.resolves(sites);

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.pagination.offset).to.equal(0);
      const [, opts] = mockDataAccess.Site.all.firstCall.args;
      expect(opts.cursor).to.equal(Buffer.from(JSON.stringify({ offset: 0 })).toString('base64'));
    });

    it('translates offset into an offset-encoded cursor and echoes offset in pagination', async () => {
      mockDataAccess.Site.all.resolves(sites);

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site', limit: '10', offset: '50' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.pagination).to.deep.equal({
        limit: 10, offset: 50, hasMore: false, baseUrlContains: 'site',
      });
      const [, opts] = mockDataAccess.Site.all.firstCall.args;
      // The data-access layer paginates by an offset-encoded cursor; the controller
      // builds base64(JSON.stringify({ offset })) to reach that offset.
      expect(opts.cursor).to.equal(Buffer.from(JSON.stringify({ offset: 50 })).toString('base64'));
    });

    ['-1', 'abc'].forEach((badOffset) => {
      it(`returns 400 when offset is negative or non-integer ("${badOffset}")`, async () => {
        mockDataAccess.Site.all.resolves(sites);

        const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site', offset: badOffset } });
        const error = await result.json();

        expect(result.status).to.equal(400);
        expect(error).to.have.property('message', 'offset must be a non-negative integer');
        expect(mockDataAccess.Site.all).to.not.have.been.called;
      });
    });

    it('sets hasMore:true and trims the body to the limit when N+1 rows are returned', async () => {
      // effectiveLimit = 1, so fetching limit+1 = 2 rows means "more exists".
      mockDataAccess.Site.all.resolves(sites); // 2 rows

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site', limit: '1' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.sites).to.be.an('array').with.lengthOf(1); // trimmed to limit
      expect(body.pagination).to.deep.equal({
        limit: 1, offset: 0, hasMore: true, baseUrlContains: 'site',
      });
    });

    it('escapes LIKE wildcards in the user input', async () => {
      mockDataAccess.Site.all.resolves(sites);

      await sitesController.getAll({ ...context, data: { baseUrlContains: 'a%b_c\\d' } });

      const [, opts] = mockDataAccess.Site.all.firstCall.args;
      const attrs = { baseURL: 'base_url' };
      const op = { ilike: sinon.stub().returnsThis() };
      opts.where(attrs, op);
      expect(op.ilike).to.have.been.calledOnceWithExactly('base_url', '%a\\%b\\_c\\\\d%');
    });

    it('returns the slim DTO shape for matched sites', async () => {
      mockDataAccess.Site.all.resolves(sites);

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site' } });
      const body = await result.json();

      expect(body.sites[0]).to.have.property('id', SITE_IDS[0]);
      expect(body.sites[0]).to.have.property('baseURL', 'https://site1.com');
      expect(body.sites[0]).to.not.have.any.keys('hlxConfig', 'authoringType', 'deliveryConfig', 'pageTypes', 'projectId', 'isPrimaryLocale', 'language', 'code', 'audits', 'updatedBy', 'isLiveToggledAt');
    });

    it('accepts a non-array (cursor-shaped) result by reading rows.data', async () => {
      mockDataAccess.Site.all.resolves({ data: sites });

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site', limit: '10' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.sites).to.be.an('array').with.lengthOf(2);
      expect(body.pagination).to.deep.equal({
        limit: 10, offset: 0, hasMore: false, baseUrlContains: 'site',
      });
    });

    it('returns an empty list with hasMore:false and the baseUrlContains echo when Site.all resolves []', async () => {
      mockDataAccess.Site.all.resolves([]);

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'nomatch' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.sites).to.be.an('array').that.is.empty;
      expect(body.pagination).to.deep.equal({
        limit: 50, offset: 0, hasMore: false, baseUrlContains: 'nomatch',
      });
    });

    it('echoes the trimmed query in pagination.baseUrlContains', async () => {
      mockDataAccess.Site.all.resolves(sites);

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: '  Adobe  ', limit: '10' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      // The echo is the trimmed query, not the raw padded input.
      expect(body.pagination.baseUrlContains).to.equal('Adobe');
      const [, opts] = mockDataAccess.Site.all.firstCall.args;
      const attrs = { baseURL: 'base_url' };
      const op = { ilike: sinon.stub().returnsThis() };
      opts.where(attrs, op);
      expect(op.ilike).to.have.been.calledOnceWithExactly('base_url', '%Adobe%');
    });

    it('accepts an exactly-3-char query (inclusive lower boundary) and calls Site.all', async () => {
      mockDataAccess.Site.all.resolves(sites);

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'abc' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(mockDataAccess.Site.all).to.have.been.calledOnce;
      expect(body.pagination.baseUrlContains).to.equal('abc');
    });

    it('returns 400 when baseUrlContains exceeds 256 chars after trimming', async () => {
      mockDataAccess.Site.all.resolves(sites);
      const longValue = 'a'.repeat(257);

      const result = await sitesController.getAll({
        ...context,
        data: { baseUrlContains: longValue },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'baseUrlContains exceeds maximum length');
      expect(mockDataAccess.Site.all).to.not.have.been.called;
    });

    ['ab', 'a', '', '  x '].forEach((shortValue) => {
      it(`returns 400 when baseUrlContains trims to fewer than 3 chars ("${shortValue}")`, async () => {
        mockDataAccess.Site.all.resolves(sites);
        const result = await sitesController.getAll({
          ...context,
          data: { baseUrlContains: shortValue },
        });

        if (shortValue.trim() === '') {
          // empty/whitespace-only is not "text" -> falls through to the
          // legacy path rather than the search branch.
          expect(result.status).to.equal(200);
          return;
        }
        const error = await result.json();
        expect(result.status).to.equal(400);
        expect(error).to.have.property('message', 'baseUrlContains must be at least 3 characters');
        expect(mockDataAccess.Site.all).to.not.have.been.called;
      });
    });

    it('returns 400 when baseUrlContains is valid but limit is invalid', async () => {
      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site', limit: 'abc' } });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'limit must be a positive integer');
      expect(mockDataAccess.Site.all).to.not.have.been.called;
    });

    it('clamps the search limit to MAX_LIMIT (500)', async () => {
      mockDataAccess.Site.all.resolves(sites);

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site', limit: '9999' } });
      const body = await result.json();

      expect(body.pagination.limit).to.equal(500);
      const [, opts] = mockDataAccess.Site.all.firstCall.args;
      expect(opts.limit).to.equal(501); // 500 + 1
    });

    it('denies a non-admin/non-S2S caller with 403 even with baseUrlContains', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site' } });
      const error = await result.json();

      expect(result.status).to.equal(403);
      expect(error).to.have.property('message', 'Forbidden: admin access or site:readAll capability required');
      expect(mockDataAccess.Site.all).to.not.have.been.called;
    });

    it('returns 400 when baseUrlContains is combined with a cursor (cursor is not silently discarded)', async () => {
      const result = await sitesController.getAll({
        ...context,
        data: { baseUrlContains: 'site', cursor: 'abc' },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'cursor is not supported with baseUrlContains; use offset');
      expect(mockDataAccess.Site.all).to.not.have.been.called;
    });

    it('warns and returns an empty list when Site.all returns an unexpected shape', async () => {
      mockDataAccess.Site.all.resolves({ unexpected: true });

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site' } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.sites).to.be.an('array').that.is.empty;
      expect(body.pagination).to.deep.equal({
        limit: 50, offset: 0, hasMore: false, baseUrlContains: 'site',
      });
      expect(loggerStub.warn).to.have.been.calledWithMatch(/\[sites\]\[baseUrlContains\] unexpected Site\.all shape/);
    });

    it('logs a prefixed error and re-throws when the Site.all search query rejects', async () => {
      const boom = new Error('boom');
      mockDataAccess.Site.all.rejects(boom);

      await expect(
        sitesController.getAll({ ...context, data: { baseUrlContains: 'site' } }),
      ).to.be.rejectedWith('boom');

      expect(loggerStub.error).to.have.been.calledWithMatch(/\[sites\]\[baseUrlContains\] query failed/);
    });
  });

  describe('GET /sites - S2S readAll capability', () => {
    function makeS2SConsumer({ clientId = 'svc-1', imsOrgId = 'AAA111111111111111111111@AdobeOrg' } = {}) {
      return { getClientId: () => clientId, getImsOrgId: () => imsOrgId };
    }

    function makeFreshConsumer({
      id = 'consumer-id-1',
      capabilities = ['site:readAll'],
      status = 'ACTIVE',
      revoked = false,
    } = {}) {
      return {
        getId: () => id,
        getCapabilities: () => capabilities,
        getStatus: () => status,
        isRevoked: () => revoked,
      };
    }

    beforeEach(() => {
      // Non-admin S2S caller
      context.attributes.authInfo.withProfile({ is_admin: false });
      mockDataAccess.Consumer = { findByClientIdAndImsOrgId: sandbox.stub() };
      mockDataAccess.Site.all.resolves(sites);
    });

    it('grants access to S2S consumer with site:readAll', async () => {
      context.s2sConsumer = makeS2SConsumer();
      context.invocation = { id: 'req-abc-123' };
      mockDataAccess.Consumer.findByClientIdAndImsOrgId
        .resolves(makeFreshConsumer({ capabilities: ['site:readAll'] }));

      const result = await sitesController.getAll(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.be.an('array').with.lengthOf(2);
      expect(mockDataAccess.Consumer.findByClientIdAndImsOrgId).to.have.been.calledOnce;
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[s2s-readall\] GET \/sites granted clientId=svc-1 consumerId=consumer-id-1 capability=site:readAll count=2 requestId=req-abc-123/,
      );
    });

    it('grants access to S2S consumer with site:readAll on the paginated path', async () => {
      context.s2sConsumer = makeS2SConsumer();
      context.invocation = { id: 'req-paginated-1' };
      mockDataAccess.Consumer.findByClientIdAndImsOrgId
        .resolves(makeFreshConsumer({ capabilities: ['site:readAll'] }));
      mockDataAccess.Site.all.resolves({ data: sites, cursor: null });

      const result = await sitesController.getAll({ ...context, data: { limit: '10' } });

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.sites).to.be.an('array').with.lengthOf(2);
      expect(body.pagination).to.deep.equal({ limit: 10, cursor: null, hasMore: false });
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[s2s-readall\] GET \/sites granted clientId=svc-1 consumerId=consumer-id-1 capability=site:readAll count=2 requestId=req-paginated-1/,
      );
    });

    it('grants access to S2S consumer with site:readAll on the baseUrlContains search path', async () => {
      context.s2sConsumer = makeS2SConsumer();
      context.invocation = { id: 'req-s2s-baseurlcontains-1' };
      mockDataAccess.Consumer.findByClientIdAndImsOrgId
        .resolves(makeFreshConsumer({ capabilities: ['site:readAll'] }));

      const result = await sitesController.getAll({ ...context, data: { baseUrlContains: 'site' } });

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.pagination).to.include({ baseUrlContains: 'site' });
      expect(body.pagination).to.not.have.property('cursor');
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[s2s-readall\] GET \/sites \(baseUrlContains\) granted clientId=svc-1 consumerId=consumer-id-1 capability=site:readAll count=2 requestId=req-s2s-baseurlcontains-1/,
      );
    });

    it('logs clientId=unknown-s2s on the legacy path when a granted consumer has no clientId', async () => {
      // Granted S2S consumer (non-admin) reaching the legacy flat-array path with a
      // falsy clientId: the log marker falls back to `unknown-s2s` (not `admin-bypass`).
      context.s2sConsumer = makeS2SConsumer({ clientId: '' });
      context.invocation = { id: 'req-unknown-s2s-1' };
      mockDataAccess.Consumer.findByClientIdAndImsOrgId
        .resolves(makeFreshConsumer({ capabilities: ['site:readAll'] }));

      const result = await sitesController.getAll(context);
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body).to.be.an('array').with.lengthOf(2);
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[sites\]\[legacy-shape\] GET \/sites called without limit\/cursor requestId=req-unknown-s2s-1 clientId=unknown-s2s/,
      );
    });

    it('denies S2S consumer with only site:read (no readAll)', async () => {
      context.s2sConsumer = makeS2SConsumer();
      mockDataAccess.Consumer.findByClientIdAndImsOrgId
        .resolves(makeFreshConsumer({ capabilities: ['site:read'] }));

      const result = await sitesController.getAll(context);
      const body = await result.json();

      expect(result.status).to.equal(403);
      expect(body).to.have.property('message', 'Forbidden: admin access or site:readAll capability required');
      expect(mockDataAccess.Site.all).to.not.have.been.called;
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[acl\] Denied GET \/sites - reason=missing-capability clientId=svc-1 consumerId=consumer-id-1/,
      );
    });

    it('denies S2S consumer that was revoked between L1 and L2', async () => {
      context.s2sConsumer = makeS2SConsumer();
      mockDataAccess.Consumer.findByClientIdAndImsOrgId
        .resolves(makeFreshConsumer({ revoked: true }));

      const result = await sitesController.getAll(context);

      expect(result.status).to.equal(403);
      expect(mockDataAccess.Site.all).to.not.have.been.called;
      expect(loggerStub.info).to.have.been.calledWithMatch(/reason=revoked/);
    });

    it('denies S2S consumer that was suspended between L1 and L2', async () => {
      context.s2sConsumer = makeS2SConsumer();
      mockDataAccess.Consumer.findByClientIdAndImsOrgId
        .resolves(makeFreshConsumer({ status: 'SUSPENDED' }));

      const result = await sitesController.getAll(context);

      expect(result.status).to.equal(403);
      expect(loggerStub.info).to.have.been.calledWithMatch(/reason=not-active/);
    });

    it('denies S2S consumer whose row was deleted between L1 and L2', async () => {
      context.s2sConsumer = makeS2SConsumer();
      mockDataAccess.Consumer.findByClientIdAndImsOrgId.resolves(null);

      const result = await sitesController.getAll(context);

      expect(result.status).to.equal(403);
      expect(loggerStub.info).to.have.been.calledWithMatch(/reason=not-found clientId=svc-1/);
    });

    it('logs reason=not-s2s when no s2sConsumer is set', async () => {
      // No s2sConsumer set: hasS2SCapability short-circuits with reason=not-s2s.
      const result = await sitesController.getAll(context);

      expect(result.status).to.equal(403);
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[acl\] Denied GET \/sites - reason=not-s2s clientId=n\/a consumerId=n\/a/,
      );
    });
  });

  it('gets all sites by delivery type', async () => {
    mockDataAccess.Site.allByDeliveryType.resolves(sites);

    const result = await sitesController.getAllByDeliveryType({ params: { deliveryType: 'aem_edge' } });
    const resultSites = await result.json();

    expect(mockDataAccess.Site.allByDeliveryType).to.have.been.calledOnce;
    expect(resultSites).to.be.an('array').with.lengthOf(2);
    expect(resultSites[0]).to.have.property('id', SITE_IDS[0]);
    expect(resultSites[0]).to.have.property('deliveryType', 'aem_edge');
  });

  it('gets all sites by delivery type for a non-admin user', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    mockDataAccess.Site.allByDeliveryType.resolves(sites);

    const result = await sitesController.getAllByDeliveryType({ params: { deliveryType: 'aem_edge' } });
    const error = await result.json();

    expect(mockDataAccess.Site.allByDeliveryType).to.have.not.been.called;
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can view all sites');
  });

  it('gets all sites with latest audit', async () => {
    const audit = {
      getAuditedAt: () => '2021-01-01T00:00:00.000Z',
      getAuditResult: () => ({ totalBlockingTime: 12, thirdPartySummary: [] }),
      getAuditType: () => 'lhs-mobile',
      getFullAuditRef: () => 'https://site1.com/lighthouse/20210101T000000.000Z/lhs-mobile.json',
      getIsError: () => false,
      getIsLive: () => true,
      getSiteId: () => SITE_IDS[0],
      getInvocationId: () => 'some-invocation-id',
    };
    sites.forEach((site) => {
      // eslint-disable-next-line no-param-reassign
      site.getLatestAuditByAuditType = sandbox.stub().resolves(audit);
    });
    const result = await sitesController.getAllWithLatestAudit({ params: { auditType: 'lhs-mobile' } });
    const resultSites = await result.json();

    expect(mockDataAccess.Site.allWithLatestAudit).to.have.been.calledOnceWith('lhs-mobile', 'desc');
    expect(resultSites).to.be.an('array').with.lengthOf(2);
    expect(resultSites[0]).to.have.property('id', SITE_IDS[0]);
    expect(resultSites[0]).to.have.property('baseURL', 'https://site1.com');
    expect(resultSites[1]).to.have.property('id', SITE_IDS[1]);
    expect(resultSites[1]).to.have.property('baseURL', 'https://site2.com');
  });

  it('gets all sites with latest audit with ascending true', async () => {
    const audit = {
      getAuditedAt: () => '2021-01-01T00:00:00.000Z',
      getAuditResult: () => ({}),
      getAuditType: () => 'lhs-mobile',
      getFullAuditRef: () => '',
      getIsError: () => false,
      getIsLive: () => true,
      getSiteId: () => SITE_IDS[0],
      getInvocationId: () => 'invocation-id',
    };
    sites.forEach((site) => {
      // eslint-disable-next-line no-param-reassign
      site.getLatestAuditByAuditType = sandbox.stub().resolves(audit);
    });
    await sitesController.getAllWithLatestAudit({ params: { auditType: 'lhs-mobile', ascending: 'true' } });

    expect(mockDataAccess.Site.allWithLatestAudit).to.have.been.calledWith('lhs-mobile', 'asc');
  });

  it('gets all sites with latest audit with ascending true for a non-admin user', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const result = await sitesController.getAllWithLatestAudit({ params: { auditType: 'lhs-mobile', ascending: 'true' } });
    const error = await result.json();

    expect(mockDataAccess.Site.allWithLatestAudit).to.have.not.been.called;
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can view all sites');
  });

  it('gets all sites with latest audit with ascending false', async () => {
    const audit = {
      getAuditedAt: () => '2021-01-01T00:00:00.000Z',
      getAuditResult: () => ({}),
      getAuditType: () => 'lhs-mobile',
      getFullAuditRef: () => '',
      getIsError: () => false,
      getIsLive: () => true,
      getSiteId: () => SITE_IDS[0],
      getInvocationId: () => 'invocation-id',
    };
    sites.forEach((site) => {
      // eslint-disable-next-line no-param-reassign
      site.getLatestAuditByAuditType = sandbox.stub().resolves(audit);
    });
    await sitesController.getAllWithLatestAudit({ params: { auditType: 'lhs-mobile', ascending: 'false' } });

    expect(mockDataAccess.Site.allWithLatestAudit).to.have.been.calledWith('lhs-mobile', 'desc');
  });

  it('returns bad request if delivery type is not provided', async () => {
    const result = await sitesController.getAllByDeliveryType({ params: {} });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Delivery type required');
  });

  it('returns bad request if audit type is not provided', async () => {
    const result = await sitesController.getAllWithLatestAudit({ params: {} });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Audit type required');
  });

  it('gets all sites as CSV', async () => {
    const result = await sitesController.getAllAsCSV();

    // expect(mockDataAccess.getSites.calledOnce).to.be.true;
    expect(result).to.not.be.null;
  });

  it('gets all sites as CSV for a non-admin user', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const result = await sitesController.getAllAsCSV();
    const error = await result.json();

    expect(mockDataAccess.Site.all).to.have.not.been.called;
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can view all sites');
  });

  it('gets all sites as XLS', async () => {
    const result = await sitesController.getAllAsXLS();

    // expect(mockDataAccess.getSites.calledOnce).to.be.true;
    expect(result).to.not.be.null;
  });

  it('gets all sites as XLS for a non-admin user', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const result = await sitesController.getAllAsXLS();
    const error = await result.json();

    expect(mockDataAccess.Site.all).to.have.not.been.called;
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can view all sites');
  });

  it('gets a site by ID', async () => {
    const result = await sitesController.getByID({ params: { siteId: SITE_IDS[0] } });
    const site = await result.json();

    expect(mockDataAccess.Site.findById).to.have.been.calledOnce;

    expect(site).to.be.an('object');
    expect(site).to.have.property('id', SITE_IDS[0]);
    expect(site).to.have.property('baseURL', 'https://site1.com');
  });

  it('gets a site by ID for non belonging to the organization', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const result = await sitesController.getByID({ params: { siteId: SITE_IDS[0] } });
    const error = await result.json();

    expect(mockDataAccess.Site.findById).to.have.been.calledOnce;
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can view its sites');
  });

  describe('getIdentity (GET /sites/:siteId/identity)', () => {
    const ORG_ID = '11111111-1111-4111-b111-111111111111';

    function makeS2SConsumer({ clientId = 'svc-1', imsOrgId = 'AAA111111111111111111111@AdobeOrg' } = {}) {
      return { getClientId: () => clientId, getImsOrgId: () => imsOrgId };
    }

    function makeFreshConsumer({
      id = 'consumer-id-1',
      capabilities = ['site:readAll'],
      status = 'ACTIVE',
      revoked = false,
    } = {}) {
      return {
        getId: () => id,
        getCapabilities: () => capabilities,
        getStatus: () => status,
        isRevoked: () => revoked,
      };
    }

    it('admin: returns the site identity and resolves imsOrgId via the org join', async () => {
      sites[0].getOrganizationId = () => ORG_ID;
      mockDataAccess.Organization.findById.resolves({ getImsOrgId: () => 'ABC123DEF456@AdobeOrg' });

      const result = await sitesController.getIdentity({ params: { siteId: SITE_IDS[0] } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(mockDataAccess.Site.findById).to.have.been.calledOnceWith(SITE_IDS[0]);
      expect(mockDataAccess.Organization.findById).to.have.been.calledOnceWith(ORG_ID);
      expect(body).to.deep.equal({
        siteId: SITE_IDS[0],
        organizationId: ORG_ID,
        imsOrgId: 'ABC123DEF456@AdobeOrg',
        baseURL: 'https://site1.com',
        deliveryType: 'aem_edge',
      });
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[acl\] GET \/sites\/:siteId\/identity granted via admin bypass siteId=.* requestId=unknown/,
      );
    });

    it('returns 404 for an unknown site without touching the org lookup', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const result = await sitesController.getIdentity({ params: { siteId: SITE_IDS[0] } });
      const error = await result.json();

      expect(result.status).to.equal(404);
      expect(error).to.have.property('message', 'Site not found');
      expect(mockDataAccess.Organization.findById).to.not.have.been.called;
    });

    it('returns 400 for an invalid site id', async () => {
      const result = await sitesController.getIdentity({ params: { siteId: 'not-a-uuid' } });

      expect(result.status).to.equal(400);
      expect(mockDataAccess.Site.findById).to.not.have.been.called;
    });

    it('returns 200 with imsOrgId null when the owning org has no imsOrgId', async () => {
      sites[0].getOrganizationId = () => ORG_ID;
      mockDataAccess.Organization.findById.resolves({ getImsOrgId: () => null });

      const result = await sitesController.getIdentity({ params: { siteId: SITE_IDS[0] } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.organizationId).to.equal(ORG_ID);
      expect(body.imsOrgId).to.equal(null);
    });

    it('returns 200 with imsOrgId null when the organizationId is orphaned (org not found)', async () => {
      sites[0].getOrganizationId = () => ORG_ID;
      mockDataAccess.Organization.findById.resolves(null);

      const result = await sitesController.getIdentity({ params: { siteId: SITE_IDS[0] } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(mockDataAccess.Organization.findById).to.have.been.calledOnceWith(ORG_ID);
      expect(body.organizationId).to.equal(ORG_ID);
      expect(body.imsOrgId).to.equal(null);
    });

    it('returns 200 with null ids when the site has no organization', async () => {
      sites[0].getOrganizationId = () => undefined;

      const result = await sitesController.getIdentity({ params: { siteId: SITE_IDS[0] } });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.organizationId).to.equal(null);
      expect(body.imsOrgId).to.equal(null);
      expect(mockDataAccess.Organization.findById).to.not.have.been.called;
    });

    it('propagates a data-access failure to the error wrapper (no silent swallow)', async () => {
      // Documents the contract: like getByID, getIdentity does not try/catch the data
      // layer - a thrown Organization.findById propagates and is mapped to a 500 by the
      // middleware error wrapper rather than being swallowed into a misleading 200.
      sites[0].getOrganizationId = () => ORG_ID;
      mockDataAccess.Organization.findById.rejects(new Error('boom'));

      await expect(
        sitesController.getIdentity({ params: { siteId: SITE_IDS[0] } }),
      ).to.be.rejectedWith('boom');
    });

    it('grants access to an S2S consumer holding site:readAll', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });
      context.s2sConsumer = makeS2SConsumer();
      context.invocation = { id: 'req-identity-1' };
      mockDataAccess.Consumer = {
        findByClientIdAndImsOrgId: sandbox.stub().resolves(makeFreshConsumer()),
      };
      sites[0].getOrganizationId = () => ORG_ID;
      mockDataAccess.Organization.findById.resolves({ getImsOrgId: () => 'ABC123DEF456@AdobeOrg' });

      const result = await sitesController.getIdentity({
        ...context, params: { siteId: SITE_IDS[0] },
      });
      const body = await result.json();

      expect(result.status).to.equal(200);
      expect(body.imsOrgId).to.equal('ABC123DEF456@AdobeOrg');
      expect(mockDataAccess.Consumer.findByClientIdAndImsOrgId).to.have.been.calledOnce;
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[s2s-readall\] GET \/sites\/:siteId\/identity granted clientId=svc-1 consumerId=consumer-id-1 capability=site:readAll siteId=.* requestId=req-identity-1/,
      );
    });

    it('denies an S2S consumer that only holds site:read', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });
      context.s2sConsumer = makeS2SConsumer();
      mockDataAccess.Consumer = {
        findByClientIdAndImsOrgId: sandbox.stub().resolves(makeFreshConsumer({ capabilities: ['site:read'] })),
      };

      const result = await sitesController.getIdentity({
        ...context, params: { siteId: SITE_IDS[0] },
      });
      const error = await result.json();

      expect(result.status).to.equal(403);
      expect(error).to.have.property('message', 'Forbidden: admin access or site:readAll capability required');
      expect(mockDataAccess.Site.findById).to.not.have.been.called;
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[acl\] Denied GET \/sites\/:siteId\/identity - reason=missing-capability clientId=svc-1 consumerId=consumer-id-1/,
      );
    });

    it('denies a non-admin caller with no s2sConsumer and logs clientId/consumerId as n/a', async () => {
      // No s2sConsumer set: hasS2SCapability short-circuits with reason=not-s2s and
      // undefined clientId/consumerId, so the deny log falls back to `n/a`.
      context.attributes.authInfo.withProfile({ is_admin: false });

      const result = await sitesController.getIdentity({
        ...context, params: { siteId: SITE_IDS[0] },
      });
      const error = await result.json();

      expect(result.status).to.equal(403);
      expect(error).to.have.property('message', 'Forbidden: admin access or site:readAll capability required');
      expect(mockDataAccess.Site.findById).to.not.have.been.called;
      expect(loggerStub.info).to.have.been.calledWithMatch(
        /\[acl\] Denied GET \/sites\/:siteId\/identity - reason=not-s2s clientId=n\/a consumerId=n\/a/,
      );
    });
  });

  it('gets a site by base URL', async () => {
    const result = await sitesController.getByBaseURL({ params: { baseURL: 'aHR0cHM6Ly9zaXRlMS5jb20K' } });
    const site = await result.json();

    expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledOnceWith('https://site1.com');

    expect(site).to.be.an('object');
    expect(site).to.have.property('id', SITE_IDS[0]);
    expect(site).to.have.property('baseURL', 'https://site1.com');
  });

  it('gets a site by base URL for non belonging to the organization', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const result = await sitesController.getByBaseURL({ params: { baseURL: 'aHR0cHM6Ly9zaXRlMS5jb20K' } });
    const error = await result.json();

    expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledOnceWith('https://site1.com');
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can view its sites');
  });

  it('gets the latest site metrics', async () => {
    context.rumApiClient.query.onCall(0).resolves({
      totalCTR: 0.20,
      totalClicks: 4901,
      totalPageViews: 24173,
      totalLCP: 1500,
      totalEngagement: 5000,
    });
    context.rumApiClient.query.onCall(1).resolves({
      totalCTR: 0.19,
      totalClicks: 4560,
      totalPageViews: 24000,
      totalLCP: 1600,
      totalEngagement: 4800,
    });
    const storedMetrics = [{
      siteId: '123',
      source: 'seo',
      time: '2023-03-13T00:00:00Z',
      metric: 'organic-traffic',
      value: 200,
      cost: 10,
    }];

    const getStoredMetrics = sinon.stub();
    getStoredMetrics.resolves(storedMetrics);

    const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
      '@adobe/spacecat-shared-utils': {
        getStoredMetrics,
      },
    });
    const result = await (
      await sitesControllerMock
        .default(context, context.log)
        .getLatestSiteMetrics({ ...context, params: { siteId: SITE_IDS[0] } })
    );
    const metrics = await result.json();

    expect(metrics).to.deep.equal({
      ctrChange: 5.263157894736847,
      pageViewsChange: 0.7208333333333333,
      projectedTrafficValue: 0.036041666666666666,
      currentPageViews: 24173,
      currentLCP: 1500,
      currentEngagement: 5000,
      previousPageViews: 24000,
      previousEngagement: 4800,
      previousLCP: 1600,
      currentConversion: 4901,
      previousConversion: 4560,
    });
  });

  it('passes the locale path prefix to both RUM queries for locale-specific sites', async () => {
    context.rumApiClient.query.onCall(0).resolves({
      totalCTR: 0.20,
      totalClicks: 4901,
      totalPageViews: 24173,
      totalLCP: 1500,
      totalEngagement: 5000,
    });
    context.rumApiClient.query.onCall(1).resolves({
      totalCTR: 0.19,
      totalClicks: 4560,
      totalPageViews: 24000,
      totalLCP: 1600,
      totalEngagement: 4800,
    });

    const getStoredMetrics = sinon.stub().resolves([]);
    const getBaseURLPathPrefix = sinon.stub().returns('/de');

    const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
      '@adobe/spacecat-shared-utils': {
        getStoredMetrics,
        getBaseURLPathPrefix,
      },
    });
    await sitesControllerMock
      .default(context, context.log)
      .getLatestSiteMetrics({ ...context, params: { siteId: SITE_IDS[0] } });

    expect(getBaseURLPathPrefix).to.have.been.calledOnce;
    expect(context.rumApiClient.query).to.have.been.calledTwice;
    expect(context.rumApiClient.query.firstCall.args[1]).to.include({ pathPrefix: '/de' });
    expect(context.rumApiClient.query.secondCall.args[1]).to.include({ pathPrefix: '/de' });
  });

  it('gets the latest site metrics with no stored metrics', async () => {
    context.rumApiClient.query.onCall(0).resolves({
      totalCTR: 0.20,
      totalClicks: 4901,
      totalPageViews: 24173,
      totalLCP: 1500,
      totalEngagement: 5000,
    });
    context.rumApiClient.query.onCall(1).resolves({
      totalCTR: 0.19,
      totalClicks: 4560,
      totalPageViews: 24000,
      totalLCP: 1600,
      totalEngagement: 4800,
    });
    const storedMetrics = [];

    const getStoredMetrics = sinon.stub();
    getStoredMetrics.resolves(storedMetrics);

    const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
      '@adobe/spacecat-shared-utils': {
        getStoredMetrics,
      },
    });
    const result = await (
      await sitesControllerMock
        .default(context, context.log)
        .getLatestSiteMetrics({ ...context, params: { siteId: SITE_IDS[0] } })
    );
    const metrics = await result.json();

    expect(metrics).to.deep.equal({
      ctrChange: 5.263157894736847,
      pageViewsChange: 0.7208333333333333,
      projectedTrafficValue: 0,
      currentPageViews: 24173,
      currentLCP: 1500,
      currentEngagement: 5000,
      previousPageViews: 24000,
      previousEngagement: 4800,
      previousLCP: 1600,
      currentConversion: 4901,
      previousConversion: 4560,
    });
  });

  it('handles zero previous page views without division error', async () => {
    context.rumApiClient.query.onCall(0).resolves({
      totalCTR: 0.20,
      totalClicks: 4901,
      totalPageViews: 24173,
      totalLCP: 1500,
      totalEngagement: 5000,
    });
    context.rumApiClient.query.onCall(1).resolves({
      totalCTR: 0.19,
      totalClicks: 0,
      totalPageViews: 0,
      totalLCP: 1600,
      totalEngagement: 4800,
    });
    const storedMetrics = [];

    const getStoredMetrics = sinon.stub();
    getStoredMetrics.resolves(storedMetrics);

    const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
      '@adobe/spacecat-shared-utils': {
        getStoredMetrics,
      },
    });
    const result = await (
      await sitesControllerMock
        .default(context, context.log)
        .getLatestSiteMetrics({ ...context, params: { siteId: SITE_IDS[0] } })
    );
    const metrics = await result.json();

    expect(metrics).to.deep.equal({
      ctrChange: 5.263157894736847,
      pageViewsChange: 0,
      projectedTrafficValue: 0,
      currentPageViews: 24173,
      currentLCP: 1500,
      currentEngagement: 5000,
      previousPageViews: 0,
      previousEngagement: 4800,
      previousLCP: 1600,
      currentConversion: 4901,
      previousConversion: 0,
    });
  });

  it('handles zero previous CTR without division error', async () => {
    context.rumApiClient.query.onCall(0).resolves({
      totalCTR: 0.20,
      totalClicks: 4901,
      totalPageViews: 24173,
      totalLCP: 1500,
      totalEngagement: 5000,
    });
    context.rumApiClient.query.onCall(1).resolves({
      totalCTR: 0,
      totalClicks: 0,
      totalPageViews: 24000,
      totalLCP: 1600,
      totalEngagement: 4800,
    });
    const storedMetrics = [];

    const getStoredMetrics = sinon.stub();
    getStoredMetrics.resolves(storedMetrics);

    const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
      '@adobe/spacecat-shared-utils': {
        getStoredMetrics,
      },
    });
    const result = await (
      await sitesControllerMock
        .default(context, context.log)
        .getLatestSiteMetrics({ ...context, params: { siteId: SITE_IDS[0] } })
    );
    const metrics = await result.json();

    expect(metrics).to.deep.equal({
      ctrChange: 0,
      pageViewsChange: 0.7208333333333333,
      projectedTrafficValue: 0,
      currentPageViews: 24173,
      currentLCP: 1500,
      currentEngagement: 5000,
      previousPageViews: 24000,
      previousEngagement: 4800,
      previousLCP: 1600,
      currentConversion: 4901,
      previousConversion: 0,
    });
  });

  it('handles missing engagement values by defaulting to zero', async () => {
    context.rumApiClient.query.onCall(0).resolves({
      totalCTR: 0.20,
      totalClicks: 4901,
      totalPageViews: 24173,
      totalLCP: 1500,
    });
    context.rumApiClient.query.onCall(1).resolves({
      totalCTR: 0.19,
      totalClicks: 4560,
      totalPageViews: 24000,
      totalLCP: 1600,
    });
    const storedMetrics = [];

    const getStoredMetrics = sinon.stub();
    getStoredMetrics.resolves(storedMetrics);

    const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
      '@adobe/spacecat-shared-utils': {
        getStoredMetrics,
      },
    });
    const result = await (
      await sitesControllerMock
        .default(context, context.log)
        .getLatestSiteMetrics({ ...context, params: { siteId: SITE_IDS[0] } })
    );
    const metrics = await result.json();

    expect(metrics).to.deep.equal({
      ctrChange: 5.263157894736847,
      pageViewsChange: 0.7208333333333333,
      projectedTrafficValue: 0,
      currentPageViews: 24173,
      currentLCP: 1500,
      currentEngagement: 0,
      previousPageViews: 24000,
      previousEngagement: 0,
      previousLCP: 1600,
      currentConversion: 4901,
      previousConversion: 4560,
    });
  });

  it('handles missing conversion values by defaulting to zero', async () => {
    context.rumApiClient.query.onCall(0).resolves({
      totalCTR: 0.20,
      totalPageViews: 24173,
      totalLCP: 1500,
      totalEngagement: 5000,
    });
    context.rumApiClient.query.onCall(1).resolves({
      totalCTR: 0.19,
      totalPageViews: 24000,
      totalLCP: 1600,
      totalEngagement: 4800,
    });
    const storedMetrics = [];

    const getStoredMetrics = sinon.stub();
    getStoredMetrics.resolves(storedMetrics);

    const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
      '@adobe/spacecat-shared-utils': {
        getStoredMetrics,
      },
    });
    const result = await (
      await sitesControllerMock
        .default(context, context.log)
        .getLatestSiteMetrics({ ...context, params: { siteId: SITE_IDS[0] } })
    );
    const metrics = await result.json();

    expect(metrics).to.deep.equal({
      ctrChange: 5.263157894736847,
      pageViewsChange: 0.7208333333333333,
      projectedTrafficValue: 0,
      currentPageViews: 24173,
      currentLCP: 1500,
      currentEngagement: 5000,
      previousPageViews: 24000,
      previousEngagement: 4800,
      previousLCP: 1600,
      currentConversion: 0,
      previousConversion: 0,
    });
  });

  it('logs error and returns zeroed metrics when rum query fails', async () => {
    const rumApiClient = {
      query: sandbox.stub().rejects(new Error('RUM query failed')),
      retrieveDomainkey: sandbox.stub().resolves('domain-key'),
    };
    const s3 = {
      s3Client: { send: sandbox.stub().resolves({ Body: { transformToString: () => '[]' } }) },
      s3Bucket: 'test-bucket',
    };

    const result = await sitesController.getLatestSiteMetrics(
      {
        ...context, params: { siteId: SITE_IDS[0] }, rumApiClient, s3,
      },
    );
    const metrics = await result.json();

    expect(context.log.error).to.have.been.calledWithMatch('Error getting latest metrics for site 0b4dcf79-fe5f-410b-b11f-641f0bf56da3: RUM query failed');
    expect(metrics).to.deep.equal({
      ctrChange: 0,
      pageViewsChange: 0,
      projectedTrafficValue: 0,
      currentLCP: null,
      previousPageViews: 0,
      currentPageViews: 0,
      previousLCP: null,
      previousEngagement: 0,
      currentEngagement: 0,
      currentConversion: 0,
      previousConversion: 0,
    });
  });

  it('returns zeroed metrics when domain resolution fails', async () => {
    const rumApiClient = {
      query: sandbox.stub(),
      retrieveDomainkey: sandbox.stub().rejects(new Error('connect ETIMEDOUT')),
    };

    const result = await sitesController.getLatestSiteMetrics(
      { ...context, params: { siteId: SITE_IDS[0] }, rumApiClient },
    );
    const metrics = await result.json();

    expect(context.log.error).to.have.been.calledWithMatch('Error getting latest metrics for site 0b4dcf79-fe5f-410b-b11f-641f0bf56da3:');
    expect(result.status).to.equal(200);
    expect(metrics).to.deep.equal({
      ctrChange: 0,
      pageViewsChange: 0,
      projectedTrafficValue: 0,
      currentLCP: null,
      previousPageViews: 0,
      currentPageViews: 0,
      previousLCP: null,
      previousEngagement: 0,
      currentEngagement: 0,
      currentConversion: 0,
      previousConversion: 0,
    });
  });

  it('returns bad request if site ID is not provided', async () => {
    const response = await sitesController.getLatestSiteMetrics({
      params: {},
    });

    const error = await response.json();

    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns not found if site does not exist', async () => {
    mockDataAccess.Site.findById.resolves(null);

    const response = await sitesController.getLatestSiteMetrics({
      params: { siteId: SITE_IDS[0] },
    });

    const error = await response.json();

    expect(response.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('get latest site metrics for non belonging to the organization', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);

    const result = await sitesController.getLatestSiteMetrics({
      params: { siteId: SITE_IDS[0] },
    });
    const error = await result.json();

    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can view its metrics');
  });

  it('gets optimization report graph data successfully', async () => {
    const mockGraphData = {
      data: [
        { date: '2024-01-01', value: 100 },
        { date: '2024-01-02', value: 150 },
      ],
    };

    context.rumApiClient.query.resolves(mockGraphData);

    const result = await sitesController.getGraph({
      ...context,
      params: { siteId: SITE_IDS[0] },
      data: {
        urls: ['https://site1.com/page1', 'https://site1.com/page2'],
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        granularity: 'day',
      },
    });
    const graphData = await result.json();

    expect(result.status).to.equal(200);
    expect(context.rumApiClient.query).to.have.been.calledOnce;
    expect(context.rumApiClient.query).to.have.been.calledWith('optimization-report-graph', {
      domain: 'www.site1.com',
      urls: ['https://site1.com/page1', 'https://site1.com/page2'],
      startTime: '2024-01-01',
      endTime: '2024-01-31',
      granularity: 'day',
    });
    expect(graphData).to.deep.equal(mockGraphData);
  });

  it('returns bad request if site ID is not provided for graph', async () => {
    const result = await sitesController.getGraph({
      ...context,
      params: {},
      data: {
        urls: ['https://site1.com/page1'],
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        granularity: 'day',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns not found if site does not exist for graph', async () => {
    mockDataAccess.Site.findById.resolves(null);

    const result = await sitesController.getGraph({
      ...context,
      params: { siteId: SITE_IDS[0] },
      data: {
        urls: ['https://site1.com/page1'],
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        granularity: 'day',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('returns forbidden if user does not have access for graph', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);

    const result = await sitesController.getGraph({
      ...context,
      params: { siteId: SITE_IDS[0] },
      data: {
        urls: ['https://site1.com/page1'],
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        granularity: 'day',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can view graph data');
  });

  it('returns bad request if urls array is missing', async () => {
    const result = await sitesController.getGraph({
      ...context,
      params: { siteId: SITE_IDS[0] },
      data: {
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        granularity: 'day',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'urls array is required and must not be empty');
  });

  it('returns bad request if urls array is empty', async () => {
    const result = await sitesController.getGraph({
      ...context,
      params: { siteId: SITE_IDS[0] },
      data: {
        urls: [],
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        granularity: 'day',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'urls array is required and must not be empty');
  });

  it('returns bad request if startDate is missing', async () => {
    const result = await sitesController.getGraph({
      ...context,
      params: { siteId: SITE_IDS[0] },
      data: {
        urls: ['https://site1.com/page1'],
        endDate: '2024-01-31',
        granularity: 'day',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'startDate is required');
  });

  it('returns bad request if endDate is missing', async () => {
    const result = await sitesController.getGraph({
      ...context,
      params: { siteId: SITE_IDS[0] },
      data: {
        urls: ['https://site1.com/page1'],
        startDate: '2024-01-01',
        granularity: 'day',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'endDate is required');
  });

  it('returns bad request if granularity is missing', async () => {
    const result = await sitesController.getGraph({
      ...context,
      params: { siteId: SITE_IDS[0] },
      data: {
        urls: ['https://site1.com/page1'],
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'granularity is required');
  });

  it('returns internal server error when RUM API query fails for graph', async () => {
    context.rumApiClient.query.rejects(new Error('RUM API error'));

    const result = await sitesController.getGraph({
      ...context,
      params: { siteId: SITE_IDS[0] },
      data: {
        urls: ['https://site1.com/page1'],
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        granularity: 'day',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(500);
    expect(error).to.have.property('message', 'Failed to retrieve graph data');
    expect(context.log.error).to.have.been.calledWithMatch(`Error getting optimization report graph for site ${SITE_IDS[0]}: RUM API error`);
  });

  it('returns bad request when data object is undefined for graph', async () => {
    const result = await sitesController.getGraph({
      ...context,
      params: { siteId: SITE_IDS[0] },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'urls array is required and must not be empty');
  });

  it('gets specific audit for a site', async () => {
    const result = await sitesController.getAuditForSite({
      params: {
        siteId: SITE_IDS[0],
        auditType: 'lhs-mobile',
        auditedAt: '2021-01-01T00:00:00.000Z',
      },
    });
    const audit = await result.json();

    expect(mockDataAccess.Audit.findBySiteIdAndAuditTypeAndAuditedAt).to.have.been.calledOnce;

    expect(audit).to.be.an('object');
    expect(audit).to.have.property('siteId', SITE_IDS[0]);
    expect(audit).to.have.property('auditType', 'lhs-mobile');
    expect(audit).to.have.property('auditedAt', '2021-01-01T00:00:00.000Z');
    expect(audit).to.have.property('fullAuditRef', 'https://site1.com/lighthouse/20210101T000000.000Z/lhs-mobile.json');
    expect(audit).to.have.property('auditResult');
  });

  it('gets specific audit for a site for non belonging to the organization', async () => {
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const result = await sitesController.getAuditForSite({
      params: {
        siteId: SITE_IDS[0],
        auditType: 'lhs-mobile',
        auditedAt: '2021-01-01T00:00:00.000Z',
      },
    });
    const error = await result.json();
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can view its audits');
  });

  it('returns bad request if site ID is not provided when getting audit for site', async () => {
    const result = await sitesController.getAuditForSite({
      params: {
        auditType: 'lhs-mobile',
        auditedAt: '2021-01-01T00:00:00.000Z',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns bad request if audit type is not provided when getting audit for site', async () => {
    const result = await sitesController.getAuditForSite({
      params: {
        siteId: SITE_IDS[0],
        auditedAt: '2021-01-01T00:00:00.000Z',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Audit type required');
  });

  it('returns bad request if audit date is not provided when getting audit for site', async () => {
    const result = await sitesController.getAuditForSite({
      params: {
        siteId: SITE_IDS[0],
        auditType: 'lhs-mobile',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Audited at required');
  });

  it('returns not found if audit for site is not found', async () => {
    mockDataAccess.Audit.findBySiteIdAndAuditTypeAndAuditedAt.returns(null);

    const result = await sitesController.getAuditForSite({
      params: {
        siteId: SITE_IDS[0],
        auditType: 'lhs-mobile',
        auditedAt: '2021-01-01T00:00:00.000Z',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Audit not found');
  });

  it('returns Site found when geting audit for non-existing site', async () => {
    mockDataAccess.Site.findById.resolves(null);

    const result = await sitesController.getAuditForSite({
      params: {
        siteId: SITE_IDS[0],
        auditType: 'lhs-mobile',
        auditedAt: '2021-01-01T00:00:00.000Z',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('returns not found when site is not found by id', async () => {
    mockDataAccess.Site.findById.resolves(null);

    const result = await sitesController.getByID({ params: { siteId: SITE_IDS[0] } });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('returns bad request if site ID is not provided', async () => {
    const result = await sitesController.getByID({ params: {} });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns 404 when site is not found by baseURL', async () => {
    mockDataAccess.Site.findByBaseURL.returns(null);

    const result = await sitesController.getByBaseURL({ params: { baseURL: 'https://site1.com' } });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('returns bad request if base URL is not provided', async () => {
    const result = await sitesController.getByBaseURL({ params: {} });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Base URL required');
  });

  it('get site metrics by source returns list of metrics', async () => {
    const siteId = sites[0].getId();
    const source = 'seo';
    const metric = 'organic-traffic';
    const storedMetrics = [{
      siteId: '123',
      source: 'seo',
      time: '2023-03-12T00:00:00Z',
      metric: 'organic-traffic',
      value: 100,
    }, {
      siteId: '123',
      source: 'seo',
      time: '2023-03-13T00:00:00Z',
      metric: 'organic-traffic',
      value: 200,
    }];

    const getStoredMetrics = sinon.stub();
    getStoredMetrics.resolves(storedMetrics);

    const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
      '@adobe/spacecat-shared-utils': {
        getStoredMetrics,
      },
    });

    const controller = sitesControllerMock.default(context, loggerStub, context.env);
    const resp = await (await controller.getSiteMetricsBySource({
      params: { siteId, source, metric },
    })).json();

    expect(resp).to.deep.equal(storedMetrics);
  });

  it('get site metrics by sources returns bad request when siteId is missing', async () => {
    const source = 'seo';
    const metric = 'organic-traffic';

    const result = await sitesController.getSiteMetricsBySource({
      params: { source, metric },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('get site metrics by sources returns bad request when source is missing', async () => {
    const siteId = sites[0].getId();
    const metric = 'organic-traffic';

    const result = await sitesController.getSiteMetricsBySource({
      params: { siteId, metric },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'source required');
  });

  it('get site metrics by sources returns bad request when metric is missing', async () => {
    const siteId = sites[0].getId();
    const source = 'seo';

    const result = await sitesController.getSiteMetricsBySource({
      params: { siteId, source },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'metric required');
  });

  it('get site metrics by source returns not found when site is not found', async () => {
    const siteId = sites[0].getId();
    const source = 'seo';
    const metric = 'organic-traffic';
    mockDataAccess.Site.findById.resolves(null);

    const result = await sitesController.getSiteMetricsBySource({
      params: { siteId, source, metric },
    });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('get site metrics for non belonging to the organization', async () => {
    const siteId = sites[0].getId();
    const source = 'seo';
    const metric = 'organic-traffic';
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);

    const result = await sitesController.getSiteMetricsBySource({
      params: { siteId, source, metric },
    });
    const error = await result.json();

    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can view its metrics');
  });

  // Metrics filtering tests
  describe('Metrics filtering by top pageViews', () => {
    it('filters metrics to top 100 by pageViews when filterByTop100PageViews=true', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      // Create mock metrics with pageviews - 150 total, unsorted
      const mockMetrics = Array.from({ length: 150 }, (_, i) => ({
        url: `https://example.com/page${i}`,
        pageviews: Math.floor(Math.random() * 10000),
        lcp: 1500 + i,
        cls: 0.1,
      }));

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTop100PageViews: 'true' },
      });

      const response = await result.json();

      // Should filter to top 100
      expect(response).to.have.length(100);

      // Verify they are sorted by pageviews descending
      response.slice(0, -1).forEach((item, index) => {
        expect(item.pageviews).to.be.at.least(response[index + 1].pageviews);
      });
    });

    it('filters out metrics without pageViews when filterByTop100PageViews=true', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://example.com/page2', pageviews: 3000, lcp: 2000 },
        { url: 'https://example.com/page3', lcp: 1800 }, // No pageviews
        { url: 'https://example.com/page4', pageviews: 4000, lcp: 2200 },
      ];

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTop100PageViews: 'true' },
      });

      const response = await result.json();

      // Should only include 3 metrics with pageviews, sorted by pageviews descending
      expect(response).to.have.length(3);
      expect(response[0].url).to.equal('https://example.com/page1'); // 5000
      expect(response[1].url).to.equal('https://example.com/page4'); // 4000
      expect(response[2].url).to.equal('https://example.com/page2'); // 3000
    });

    it('does not filter when filterByTop100PageViews is not set', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/page1', lcp: 1500, cls: 0.1 },
        { url: 'https://example.com/page2', lcp: 2000, cls: 0.2 },
      ];

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        // No data.filterByTop100PageViews parameter
      });

      const response = await result.json();

      // Should return all unfiltered metrics (no filtering applied)
      expect(response).to.have.length(2);
    });

    it('works with different metric types when filterByTop100PageViews=true', async () => {
      const siteId = sites[0].getId();
      const source = 'seo';
      const metric = 'organic-traffic';

      const mockMetrics = [
        { url: 'https://example.com/page1', pageviews: 100, views: 100 },
        { url: 'https://example.com/page2', pageviews: 200, views: 200 },
        { url: 'https://example.com/page3', pageviews: 150, views: 150 },
      ];

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTop100PageViews: 'true' },
      });

      const response = await result.json();

      // Should return top 3 by pageviews, sorted descending
      expect(response).to.have.length(3);
      expect(response[0].url).to.equal('https://example.com/page2'); // 200 pageviews
      expect(response[1].url).to.equal('https://example.com/page3'); // 150 pageviews
      expect(response[2].url).to.equal('https://example.com/page1'); // 100 pageviews
    });

    it('returns all metrics when less than 100 have pageviews', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      // Create only 50 metrics with pageviews
      const mockRumMetrics = Array.from({ length: 50 }, (_, i) => ({
        url: `https://example.com/page${i}`,
        pageviews: 1000 - i,
        lcp: 1500,
        cls: 0.1,
      }));

      const getStoredMetrics = sandbox.stub().resolves(mockRumMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTop100PageViews: 'true' },
      });

      const response = await result.json();

      // Should return all 50 metrics (less than the 100 limit)
      expect(response).to.have.length(50);

      // Verify they are sorted by pageviews descending
      expect(response[0].pageviews).to.equal(1000);
      expect(response[49].pageviews).to.equal(951);
    });

    it('handles null and zero pageviews correctly in sorting', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/page1', pageviews: 100, lcp: 1500 },
        { url: 'https://example.com/page2', pageviews: null, lcp: 2000 },
        { url: 'https://example.com/page3', pageviews: 0, lcp: 1800 },
        { url: 'https://example.com/page4', pageviews: 50, lcp: 2200 },
        { url: 'https://example.com/page5', pageviews: 0, lcp: 1600 },
      ];

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTop100PageViews: 'true' },
      });

      const response = await result.json();

      // Should include only metrics where pageviews !== undefined
      // null !== undefined is true, so null is kept
      expect(response).to.have.length(5);
      // Sorted: page1 (100), page4 (50), then pageviews that are 0 or null (falsy)
      // The || 0 operator converts null to 0 for sorting
      expect(response[0].pageviews).to.equal(100);
      expect(response[1].pageviews).to.equal(50);
      // Remaining items have pageviews that are falsy (0 or null)
      // They all get treated as 0 in the sort, so order among them doesn't matter
      expect([0, null]).to.include(response[2].pageviews);
      expect([0, null]).to.include(response[3].pageviews);
      expect([0, null]).to.include(response[4].pageviews);
    });
  });

  // Metadata wrapper format tests with objectResponseDataKey parameter
  describe('Metrics with objectResponseDataKey parameter', () => {
    it('extracts and filters array from object when objectResponseDataKey=data is provided', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-last-week';

      // Create mock metadata wrapper with 150 items
      const mockData = Array.from({ length: 150 }, (_, i) => ({
        url: `https://example.com/page${i}`,
        pageviews: 150 - i,
        metrics: [],
      }));

      const mockMetricsWrapper = {
        label: 'last-week',
        startTime: '2026-01-05T12:00:00.000Z',
        endTime: '2026-01-12T12:00:00.000Z',
        data: mockData,
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetricsWrapper);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { objectResponseDataKey: 'data', filterByTop100PageViews: 'true' },
      });

      const response = await result.json();

      // Should preserve wrapper format
      expect(response).to.have.property('label', 'last-week');
      expect(response).to.have.property('startTime', '2026-01-05T12:00:00.000Z');
      expect(response).to.have.property('endTime', '2026-01-12T12:00:00.000Z');
      expect(response).to.have.property('data');

      // Should filter data to top 100
      expect(response.data).to.have.length(100);

      // Should be sorted by pageviews descending
      expect(response.data[0].pageviews).to.equal(150);
      expect(response.data[99].pageviews).to.equal(51);
    });

    it('extracts array from object when objectResponseDataKey=data without filtering', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'user-engagement-7d-last-to-last-week';

      const mockMetricsWrapper = {
        label: 'last-to-last-week',
        startTime: '2025-12-29T12:00:00.000Z',
        endTime: '2026-01-05T12:00:00.000Z',
        data: [
          { url: 'https://example.com/page1', engagement: 0.8 },
          { url: 'https://example.com/page2', engagement: 0.6 },
        ],
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetricsWrapper);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { objectResponseDataKey: 'data' },
      });

      const response = await result.json();

      // Should preserve entire wrapper
      expect(response).to.have.property('label', 'last-to-last-week');
      expect(response).to.have.property('startTime', '2025-12-29T12:00:00.000Z');
      expect(response).to.have.property('endTime', '2026-01-05T12:00:00.000Z');
      expect(response).to.have.property('data');
      expect(response.data).to.have.length(2);
    });

    it('handles object with empty data array when objectResponseDataKey=data', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-last-week';

      const mockMetricsWrapper = {
        label: 'last-week',
        startTime: '2026-01-05T12:00:00.000Z',
        endTime: '2026-01-12T12:00:00.000Z',
        data: [],
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetricsWrapper);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { objectResponseDataKey: 'data', filterByTop100PageViews: 'true' },
      });

      const response = await result.json();

      // Should preserve wrapper with empty data
      expect(response).to.have.property('label', 'last-week');
      expect(response).to.have.property('data');
      expect(response.data).to.have.length(0);
    });

    it('returns plain array when objectResponseDataKey is not provided (backward compatibility)', async () => {
      const siteId = sites[0].getId();
      const source = 'seo';
      const metric = 'organic-traffic';

      const mockMetricsArray = [
        { url: 'https://example.com/page1', pageviews: 1000 },
        { url: 'https://example.com/page2', pageviews: 800 },
      ];

      const getStoredMetrics = sandbox.stub().resolves(mockMetricsArray);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
      });

      const response = await result.json();

      // Should return array directly (no wrapper)
      expect(response).to.be.an('array');
      expect(response).to.have.length(2);
      expect(response).to.not.have.property('label');
    });

    it('returns plain array when stored data is object but objectResponseDataKey is not provided', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-last-week';

      const mockMetricsWrapper = {
        label: 'last-week',
        startTime: '2026-01-05T12:00:00.000Z',
        endTime: '2026-01-12T12:00:00.000Z',
        data: [
          { url: 'https://example.com/page1', pageviews: 100 },
          { url: 'https://example.com/page2', pageviews: 200 },
        ],
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetricsWrapper);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        // No objectResponseDataKey provided
      });

      const response = await result.json();

      // Should return the object as-is (backward compatible - treats object as data)
      expect(response).to.be.an('object');
      expect(response).to.have.property('label');
      expect(response).to.have.property('data');
    });

    it('works with custom objectResponseDataKey other than "data"', async () => {
      const siteId = sites[0].getId();
      const source = 'custom';
      const metric = 'custom-metric';

      const mockMetricsWrapper = {
        label: 'custom-label',
        items: [
          { url: 'https://example.com/page1', pageviews: 500 },
          { url: 'https://example.com/page2', pageviews: 300 },
          { url: 'https://example.com/page3', pageviews: 400 },
        ],
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetricsWrapper);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { objectResponseDataKey: 'items', filterByTop100PageViews: 'true' },
      });

      const response = await result.json();

      // Should use 'items' key
      expect(response).to.have.property('label', 'custom-label');
      expect(response).to.have.property('items');
      expect(response.items).to.have.length(3);
      // Should be sorted by pageviews descending
      expect(response.items[0].pageviews).to.equal(500);
      expect(response.items[1].pageviews).to.equal(400);
      expect(response.items[2].pageviews).to.equal(300);
    });

    it('filters metrics by site baseURL when filterByBaseURL=true', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://site1.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://other.com/page2', pageviews: 3000, lcp: 2000 },
        { url: 'https://site1.com/page3', pageviews: 4000, lcp: 1800 },
        { url: 'https://different.com/page4', pageviews: 2000, lcp: 2200 },
      ];

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByBaseURL: 'true' },
      });

      const response = await result.json();

      // Should only include metrics from site1.com (site baseURL)
      expect(response).to.have.length(2);
      expect(response[0].url).to.equal('https://site1.com/page1');
      expect(response[1].url).to.equal('https://site1.com/page3');
    });

    it('normalizes www prefix when filtering by baseURL', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      // Test: Site baseURL is "https://site1.com" (no www)
      // Metrics include both with and without www - all should match
      const mockMetrics = [
        { url: 'https://www.site1.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'http://site1.com/page2', pageviews: 4000, lcp: 1600 },
        { url: 'https://site1.com/page3', pageviews: 3000, lcp: 1700 },
        { url: 'https://www.other.com/page4', pageviews: 2000, lcp: 1800 },
        { url: 'http://www.site1.com/page5', pageviews: 1000, lcp: 1900 },
      ];

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByBaseURL: 'true' },
      });

      const response = await result.json();

      // Should match all site1.com URLs regardless of www prefix or protocol
      expect(response).to.have.length(4);
      expect(response[0].url).to.equal('https://www.site1.com/page1');
      expect(response[1].url).to.equal('http://site1.com/page2');
      expect(response[2].url).to.equal('https://site1.com/page3');
      expect(response[3].url).to.equal('http://www.site1.com/page5');
    });

    it('applies filterByBaseURL before top100 filtering', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      // Create 150 metrics: 75 from site1.com, 75 from other.com
      const mockMetrics = [
        ...Array.from({ length: 75 }, (_, i) => ({
          url: `https://site1.com/page${i}`,
          pageviews: 1000 + i,
          lcp: 1500,
        })),
        ...Array.from({ length: 75 }, (_, i) => ({
          url: `https://other.com/page${i}`,
          pageviews: 2000 + i,
          lcp: 1500,
        })),
      ];

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: {
          filterByBaseURL: 'true',
          filterByTop100PageViews: 'true',
        },
      });

      const response = await result.json();

      // Should filter to site1.com first (75 items), then take top 75
      // (since less than 100)
      expect(response).to.have.length(75);
      response.forEach((item) => {
        expect(item.url).to.include('site1.com');
      });
    });

    it('handles missing url field gracefully when filterByBaseURL=true', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://site1.com/page1', pageviews: 5000 },
        { pageviews: 3000 }, // Missing url
        { url: 'https://site1.com/page3', pageviews: 4000 },
      ];

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByBaseURL: 'true' },
      });

      const response = await result.json();

      // Should only include valid entries with URLs matching baseURL
      expect(response).to.have.length(2);
      expect(response[0].url).to.equal('https://site1.com/page1');
      expect(response[1].url).to.equal('https://site1.com/page3');
    });

    it('filters by path when baseURL includes a path', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      // Override site baseURL to include a path
      sites[0].getBaseURL = () => 'https://site1.com/book';

      const mockMetrics = [
        { url: 'https://site1.com/book/flights', pageviews: 5000 },
        { url: 'https://site1.com/book/hotels', pageviews: 4000 },
        { url: 'https://site1.com/other/page', pageviews: 3000 },
        { url: 'https://www.site1.com/book/cars', pageviews: 2000 },
      ];

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByBaseURL: 'true' },
      });

      const response = await result.json();

      // Should only include URLs that start with site1.com/book
      expect(response).to.have.length(3);
      expect(response[0].url).to.equal('https://site1.com/book/flights');
      expect(response[1].url).to.equal('https://site1.com/book/hotels');
      expect(response[2].url).to.equal('https://www.site1.com/book/cars');
    });
  });

  describe('Metrics filtering by top organic search pages', () => {
    it('filters metrics by top N organic search pages from SEO data', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://example.com/page2', pageviews: 3000, lcp: 2000 },
        { url: 'https://example.com/page3', pageviews: 4000, lcp: 1800 },
        { url: 'https://example.com/page4', pageviews: 2000, lcp: 2200 },
        { url: 'https://example.com/page5', pageviews: 1000, lcp: 1600 },
      ];

      // Mock top pages from SEO data
      const mockTopPages = [
        { getUrl: () => 'https://example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://example.com/page3', getTraffic: () => 8000 },
        { getUrl: () => 'https://example.com/page5', getTraffic: () => 6000 },
        { getUrl: () => 'https://example.com/page6', getTraffic: () => 4000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '2' },
      });

      const response = await result.json();

      // Should only include pages that are in top 2 SEO pages (page1, page3)
      expect(response).to.have.length(2);
      expect(response.find((m) => m.url === 'https://example.com/page1')).to.exist;
      expect(response.find((m) => m.url === 'https://example.com/page3')).to.exist;
      expect(mockSiteTopPage.allBySiteIdAndSourceAndGeo).to.have.been.calledWith(siteId, 'seo', 'global');
    });

    it('handles URL variations with trailing slashes', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/page1/', pageviews: 5000, lcp: 1500 },
        { url: 'https://example.com/page2', pageviews: 3000, lcp: 2000 },
      ];

      const mockTopPages = [
        { getUrl: () => 'https://example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://example.com/page2/', getTraffic: () => 8000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '2' },
      });

      const response = await result.json();

      // Both pages should match regardless of trailing slash differences
      expect(response).to.have.length(2);
    });

    it('handles URL variations with protocol differences (http vs https)', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'http://example.com/page2', pageviews: 3000, lcp: 2000 },
        { url: 'https://example.com/page3', pageviews: 4000, lcp: 1800 },
      ];

      const mockTopPages = [
        { getUrl: () => 'http://example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://example.com/page2', getTraffic: () => 8000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '2' },
      });

      const response = await result.json();

      // Should match page1 and page2 regardless of protocol differences
      expect(response).to.have.length(2);
      expect(response.find((m) => m.url === 'https://example.com/page1')).to.exist;
      expect(response.find((m) => m.url === 'http://example.com/page2')).to.exist;
    });

    it('handles URL variations with www subdomain differences', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://www.example.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://example.com/page2', pageviews: 3000, lcp: 2000 },
        { url: 'https://www2.example.com/page3', pageviews: 4000, lcp: 1800 },
        { url: 'https://example.com/page4', pageviews: 2000, lcp: 2200 },
      ];

      const mockTopPages = [
        { getUrl: () => 'https://example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://www.example.com/page2', getTraffic: () => 9000 },
        { getUrl: () => 'https://example.com/page3', getTraffic: () => 8000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '3' },
      });

      const response = await result.json();

      // Should match page1, page2, and page3 regardless of www variants
      expect(response).to.have.length(3);
      expect(response.find((m) => m.url === 'https://www.example.com/page1')).to.exist;
      expect(response.find((m) => m.url === 'https://example.com/page2')).to.exist;
      expect(response.find((m) => m.url === 'https://www2.example.com/page3')).to.exist;
    });

    it('handles URL variations with case differences', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/Page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://EXAMPLE.COM/page2', pageviews: 3000, lcp: 2000 },
        { url: 'https://Example.Com/PAGE3', pageviews: 4000, lcp: 1800 },
      ];

      const mockTopPages = [
        { getUrl: () => 'https://Example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://example.com/PAGE2', getTraffic: () => 8000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '2' },
      });

      const response = await result.json();

      // Should match page1 and page2 regardless of case differences
      expect(response).to.have.length(2);
      expect(response.find((m) => m.url === 'https://example.com/Page1')).to.exist;
      expect(response.find((m) => m.url === 'https://EXAMPLE.COM/page2')).to.exist;
    });

    it('handles combined URL variations (protocol, www, trailing slash, case)', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://www.example.com/Page1/', pageviews: 5000, lcp: 1500 },
        { url: 'http://Example.com/page2', pageviews: 3000, lcp: 2000 },
        { url: 'https://www2.EXAMPLE.com/page3/', pageviews: 4000, lcp: 1800 },
      ];

      const mockTopPages = [
        { getUrl: () => 'http://example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://www.example.com/PAGE2/', getTraffic: () => 9000 },
        { getUrl: () => 'http://www.example.com/Page3', getTraffic: () => 8000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '3' },
      });

      const response = await result.json();

      // Should match all 3 pages regardless of combined URL variations
      expect(response).to.have.length(3);
    });

    it('deduplicates metrics with same normalized URL to prevent exceeding requested limit', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      // RUM data contains duplicate URLs (with and without trailing slash)
      const mockMetrics = [
        { url: 'https://example.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://example.com/page1/', pageviews: 100, lcp: 1600 }, // Duplicate
        { url: 'https://example.com/page2', pageviews: 3000, lcp: 2000 },
        { url: 'https://example.com/page2/', pageviews: 50, lcp: 2100 }, // Duplicate
        { url: 'https://example.com/page3', pageviews: 2000, lcp: 1800 },
      ];

      const mockTopPages = [
        { getUrl: () => 'https://example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://example.com/page2', getTraffic: () => 8000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '2' },
      });

      const response = await result.json();

      // Should return exactly 2 entries, not 4 (even though 4 URLs match when normalized)
      expect(response).to.have.length(2);
      // Should only include the first occurrence of each normalized URL
      expect(response.find((m) => m.url === 'https://example.com/page1')).to.exist;
      expect(response.find((m) => m.url === 'https://example.com/page2')).to.exist;
      // Should not include the duplicate entries
      expect(response.find((m) => m.url === 'https://example.com/page1/')).to.not.exist;
      expect(response.find((m) => m.url === 'https://example.com/page2/')).to.not.exist;
    });

    it('returns error for non-numeric filterByTopOrganicSearchPages value', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const controller = SitesController(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: 'invalid' },
      });

      const error = await result.json();
      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'filterByTopOrganicSearchPages must be a positive integer');
    });

    it('returns error for negative filterByTopOrganicSearchPages value', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const controller = SitesController(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '-1' },
      });

      const error = await result.json();
      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'filterByTopOrganicSearchPages must be a positive integer');
    });

    it('returns error for zero filterByTopOrganicSearchPages value', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const controller = SitesController(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '0' },
      });

      const error = await result.json();
      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'filterByTopOrganicSearchPages must be a positive integer');
    });

    it('returns empty array when no SEO pages found', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://example.com/page2', pageviews: 3000, lcp: 2000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves([]),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '10' },
      });

      const response = await result.json();

      // Should return empty array when user requested filtering but no SEO pages exist
      expect(response).to.have.length(0);
      expect(loggerStub.warn).to.have.been.called;
    });

    it('returns internal server error when SEO data fetch fails', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/page1', pageviews: 5000, lcp: 1500 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().rejects(new Error('Database error')),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '10' },
      });

      // Should return 500 error when user requested filtering but it fails
      expect(result.status).to.equal(500);
      const response = await result.json();
      expect(response.message).to.include('Database error');
    });

    it('returns empty array when no SEO pages match base URL filter', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://site1.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://site1.com/page2', pageviews: 3000, lcp: 2000 },
      ];

      // Top pages only have other.com domain, none match site1.com base URL
      const mockTopPages = [
        { getUrl: () => 'https://other.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://other.com/page2', getTraffic: () => 8000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: {
          filterByBaseURL: 'true',
          filterByTopOrganicSearchPages: '10',
        },
      });

      const response = await result.json();

      // Should return empty array when no pages match base URL
      expect(response).to.have.length(0);
      expect(loggerStub.warn).to.have.been.calledWith(
        sinon.match(/No SEO top pages match base URL/),
      );
    });

    it('combines filterByTopOrganicSearchPages with filterByBaseURL', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://site1.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://site1.com/page2', pageviews: 3000, lcp: 2000 },
        { url: 'https://other.com/page3', pageviews: 4000, lcp: 1800 },
      ];

      // Top pages include both site1.com and other.com domains
      // With baseURL filter, only site1.com pages should be considered
      const mockTopPages = [
        { getUrl: () => 'https://site1.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://other.com/page3', getTraffic: () => 8000 }, // Should be filtered out by baseURL
        { getUrl: () => 'https://site1.com/page2', getTraffic: () => 7000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: {
          filterByBaseURL: 'true',
          filterByTopOrganicSearchPages: '2',
        },
      });

      const response = await result.json();

      // Should include page1 and page2 (top 2 from site1.com only)
      // page3 from other.com is excluded by baseURL filter on top pages
      expect(response).to.have.length(2);
      expect(response.find((m) => m.url === 'https://site1.com/page1')).to.exist;
      expect(response.find((m) => m.url === 'https://site1.com/page2')).to.exist;
      expect(response.find((m) => m.url === 'https://other.com/page3')).to.not.exist;
    });

    it('handles null URLs in top pages when combining filterByTopOrganicSearchPages with filterByBaseURL', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://site1.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://site1.com/page2', pageviews: 3000, lcp: 2000 },
      ];

      // Top pages include entries with null/undefined URLs
      const mockTopPages = [
        { getUrl: () => 'https://site1.com/page1', getTraffic: () => 10000 },
        { getUrl: () => null, getTraffic: () => 9000 }, // null URL should be skipped
        { getUrl: () => 'https://site1.com/page2', getTraffic: () => 8000 },
        { getUrl: () => undefined, getTraffic: () => 7000 }, // undefined URL should be skipped
        { getUrl: () => '', getTraffic: () => 6000 }, // empty string URL should be skipped
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: {
          filterByBaseURL: 'true',
          filterByTopOrganicSearchPages: '5',
        },
      });

      const response = await result.json();

      // Should only include pages with valid URLs (page1 and page2)
      // Pages with null/undefined/empty URLs should be filtered out
      expect(response).to.have.length(2);
      expect(response.find((m) => m.url === 'https://site1.com/page1')).to.exist;
      expect(response.find((m) => m.url === 'https://site1.com/page2')).to.exist;
    });

    it('handles null traffic values in top pages', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://example.com/page2', pageviews: 3000, lcp: 2000 },
        { url: 'https://example.com/page3', pageviews: 4000, lcp: 1800 },
      ];

      // Top pages with null/undefined traffic values should be sorted as 0
      const mockTopPages = [
        { getUrl: () => 'https://example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://example.com/page2', getTraffic: () => null }, // null traffic should be treated as 0
        { getUrl: () => 'https://example.com/page3', getTraffic: () => undefined }, // undefined traffic should be treated as 0
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: {
          filterByTopOrganicSearchPages: '3',
        },
      });

      const response = await result.json();

      // All pages should be included, with page1 ranked first
      expect(response).to.have.length(3);
      expect(response[0].url).to.equal('https://example.com/page1');
    });

    it('combines all three filters: baseURL, topOrganicSearchPages, and top100PageViews', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      // Create 150 metrics with varying properties
      const mockMetrics = Array.from({ length: 150 }, (_, i) => ({
        url: i < 100 ? `https://site1.com/page${i}` : `https://other.com/page${i}`,
        pageviews: 1000 - i, // Descending pageviews
        lcp: 1500 + i,
      }));

      // Top organic pages include pages 0-19 from site1.com
      const mockTopPages = Array.from({ length: 20 }, (_, i) => ({
        getUrl: () => `https://site1.com/page${i}`,
        getTraffic: () => 10000 - i * 100,
      }));

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: {
          filterByBaseURL: 'true',
          filterByTopOrganicSearchPages: '20',
          filterByTop100PageViews: 'true',
        },
      });

      const response = await result.json();

      // Should apply all three filters in order:
      // 1. baseURL (keeps site1.com pages 0-99)
      // 2. topOrganicSearchPages (further filters to pages 0-19)
      // 3. top100PageViews (takes top 20 by pageviews from remaining)
      expect(response).to.have.length(20);
      // All should be from site1.com
      response.forEach((item) => {
        expect(item.url).to.include('site1.com');
      });
      // Should be sorted by pageviews descending
      response.slice(0, -1).forEach((item, index) => {
        expect(item.pageviews).to.be.at.least(response[index + 1].pageviews);
      });
    });

    it('includes top organic pages without RUM data with null metrics', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      // RUM metrics only has page1 and page3
      const mockMetrics = [
        {
          url: 'https://example.com/page1', pageviews: 5000, lcp: 1500, cls: 0.1,
        },
        {
          url: 'https://example.com/page3', pageviews: 4000, lcp: 1800, cls: 0.15,
        },
      ];

      // But top 3 SEO pages include page2 which has no RUM data
      const mockTopPages = [
        { getUrl: () => 'https://example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://example.com/page2', getTraffic: () => 9000 },
        { getUrl: () => 'https://example.com/page3', getTraffic: () => 8000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '3' },
      });

      const response = await result.json();

      // Should include all 3 pages
      expect(response).to.have.length(3);

      // Page1 and page3 should have their original data
      const page1 = response.find((m) => m.url === 'https://example.com/page1');
      expect(page1).to.exist;
      expect(page1.pageviews).to.equal(5000);
      expect(page1.lcp).to.equal(1500);

      const page3 = response.find((m) => m.url === 'https://example.com/page3');
      expect(page3).to.exist;
      expect(page3.pageviews).to.equal(4000);
      expect(page3.lcp).to.equal(1800);

      // Page2 should be included with null metrics (no RUM data)
      const page2 = response.find((m) => m.url === 'https://example.com/page2');
      expect(page2).to.exist;
      expect(page2.type).to.equal('url');
      expect(page2.pageviews).to.be.null;
      expect(page2.organic).to.be.null;
      expect(page2.metrics).to.be.an('array').that.is.empty;
    });

    it('works with objectResponseDataKey wrapper format', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-last-week';

      const mockMetricsWrapper = {
        label: 'last-week',
        startTime: '2026-01-05T12:00:00.000Z',
        endTime: '2026-01-12T12:00:00.000Z',
        data: [
          { url: 'https://example.com/page1', pageviews: 5000, lcp: 1500 },
          { url: 'https://example.com/page2', pageviews: 3000, lcp: 2000 },
          { url: 'https://example.com/page3', pageviews: 4000, lcp: 1800 },
        ],
      };

      const mockTopPages = [
        { getUrl: () => 'https://example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://example.com/page3', getTraffic: () => 8000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetricsWrapper);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: {
          objectResponseDataKey: 'data',
          filterByTopOrganicSearchPages: '2',
        },
      });

      const response = await result.json();

      // Should preserve wrapper format
      expect(response).to.have.property('label', 'last-week');
      expect(response).to.have.property('startTime', '2026-01-05T12:00:00.000Z');
      expect(response).to.have.property('endTime', '2026-01-12T12:00:00.000Z');
      expect(response).to.have.property('data');

      // Should filter the data array
      expect(response.data).to.have.length(2);
      expect(response.data.find((m) => m.url === 'https://example.com/page1')).to.exist;
      expect(response.data.find((m) => m.url === 'https://example.com/page3')).to.exist;
    });

    it('handles top pages with null or undefined URLs', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/page1', pageviews: 5000, lcp: 1500 },
        { url: 'https://example.com/page2', pageviews: 3000, lcp: 2000 },
      ];

      const mockTopPages = [
        { getUrl: () => 'https://example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => null, getTraffic: () => 8000 }, // null URL should be skipped
        { getUrl: () => 'https://example.com/page2', getTraffic: () => 6000 },
        { getUrl: () => undefined, getTraffic: () => 4000 }, // undefined URL should be skipped
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '10' },
      });

      const response = await result.json();

      // Should only include pages with valid URLs (page1 and page2)
      expect(response).to.have.length(2);
      expect(response.find((m) => m.url === 'https://example.com/page1')).to.exist;
      expect(response.find((m) => m.url === 'https://example.com/page2')).to.exist;
    });

    it('handles metrics with null or undefined URLs', async () => {
      const siteId = sites[0].getId();
      const source = 'rum';
      const metric = 'cwv-hourly-7d-2025-11-02';

      const mockMetrics = [
        { url: 'https://example.com/page1', pageviews: 5000, lcp: 1500 },
        { url: null, pageviews: 3000, lcp: 2000 }, // null URL should be skipped
        { url: 'https://example.com/page2', pageviews: 4000, lcp: 1800 },
        { pageviews: 2000, lcp: 2200 }, // missing URL property should be skipped
      ];

      const mockTopPages = [
        { getUrl: () => 'https://example.com/page1', getTraffic: () => 10000 },
        { getUrl: () => 'https://example.com/page2', getTraffic: () => 8000 },
        { getUrl: () => 'https://example.com/page3', getTraffic: () => 6000 },
      ];

      const mockSiteTopPage = {
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves(mockTopPages),
      };

      const getStoredMetrics = sandbox.stub().resolves(mockMetrics);
      const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
        '@adobe/spacecat-shared-utils': { getStoredMetrics },
      });

      context.dataAccess.SiteTopPage = mockSiteTopPage;

      const controller = sitesControllerMock.default(context, loggerStub, context.env);
      const result = await controller.getSiteMetricsBySource({
        params: { siteId, source, metric },
        data: { filterByTopOrganicSearchPages: '3' },
      });

      const response = await result.json();

      // Should include metrics for top pages, including page3 from top pages
      expect(response).to.have.length(3);
      expect(response.find((m) => m.url === 'https://example.com/page1')).to.exist;
      expect(response.find((m) => m.url === 'https://example.com/page2')).to.exist;
      expect(response.find((m) => m.url === 'https://example.com/page3')).to.exist;
    });
  });

  describe('canonicalizeUrl utility function', () => {
    let canonicalizeUrl;

    before(async () => {
      const utilsModule = await import('@adobe/spacecat-shared-utils');
      canonicalizeUrl = utilsModule.canonicalizeUrl;
    });

    it('strips query parameters when stripQuery is true', () => {
      const url = 'https://example.com/page?utm_source=test&utm_medium=email';
      const result = canonicalizeUrl(url, { stripQuery: true });
      expect(result).to.equal('example.com/page');
    });

    it('strips fragments when stripQuery is true', () => {
      const url = 'https://example.com/page#section';
      const result = canonicalizeUrl(url, { stripQuery: true });
      expect(result).to.equal('example.com/page');
    });

    it('strips both query parameters and fragments when stripQuery is true', () => {
      const url = 'https://example.com/page?query=value#section';
      const result = canonicalizeUrl(url, { stripQuery: true });
      expect(result).to.equal('example.com/page');
    });

    it('keeps query parameters and fragments when stripQuery is false or omitted', () => {
      const url = 'https://example.com/page?query=value#section';
      const resultDefault = canonicalizeUrl(url);
      const resultFalse = canonicalizeUrl(url, { stripQuery: false });
      expect(resultDefault).to.equal('example.com/page?query=value#section');
      expect(resultFalse).to.equal('example.com/page?query=value#section');
    });
  });

  it('get page metrics by source returns list of metrics', async () => {
    const siteId = sites[0].getId();
    const source = 'seo';
    const metric = 'organic-traffic';
    const base64PageUrl = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9mb28vYmFy';

    const storedMetrics = [{
      siteId: '123',
      source: 'seo',
      time: '2023-03-12T00:00:00Z',
      metric: 'organic-traffic',
      value: 100,
      url: 'https://example.com/foo/bar',
    },
    {
      siteId: '123',
      source: 'seo',
      time: '2023-03-13T00:00:00Z',
      metric: 'organic-traffic',
      value: 400,
      url: 'https://example.com/foo/baz',
    },
    {
      siteId: '123',
      source: 'seo',
      time: '2023-03-13T00:00:00Z',
      metric: 'organic-traffic',
      value: 200,
      url: 'https://example.com/foo/bar',
    }];

    const getStoredMetrics = sinon.stub();
    getStoredMetrics.resolves(storedMetrics);

    const sitesControllerMock = await esmock('../../src/controllers/sites.js', {
      '@adobe/spacecat-shared-utils': {
        getStoredMetrics,
      },
    });

    const resp = await (await sitesControllerMock.default(context).getPageMetricsBySource({
      params: {
        siteId, source, metric, base64PageUrl,
      },
      log: {
        info: sandbox.spy(),
        warn: sandbox.spy(),
        error: sandbox.spy(),
      },
      s3: {
        s3Client: {
          send: sinon.stub(),
        },
        s3Bucket: 'test-bucket',
        region: 'us-west-2',
      },
    })).json();

    expect(resp).to.deep.equal([storedMetrics[0], storedMetrics[2]]);
  });

  it('get page metrics by sources returns bad request when siteId is missing', async () => {
    const source = 'seo';
    const metric = 'organic-traffic';
    const base64PageUrl = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9mb28vYmFy';

    const result = await sitesController.getPageMetricsBySource({
      params: { source, metric, base64PageUrl },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('get page metrics by sources returns bad request when source is missing', async () => {
    const siteId = sites[0].getId();
    const metric = 'organic-traffic';
    const base64PageUrl = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9mb28vYmFy';

    const result = await sitesController.getPageMetricsBySource({
      params: { siteId, metric, base64PageUrl },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'source required');
  });

  it('get page metrics by sources returns bad request when metric is missing', async () => {
    const siteId = sites[0].getId();
    const source = 'seo';
    const base64PageUrl = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9mb28vYmFy';

    const result = await sitesController.getPageMetricsBySource({
      params: { siteId, source, base64PageUrl },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'metric required');
  });

  it('get page metrics by sources returns bad request when base64PageUrl is missing', async () => {
    const siteId = sites[0].getId();
    const source = 'seo';
    const metric = 'organic-traffic';

    const result = await sitesController.getPageMetricsBySource({
      params: { siteId, source, metric },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'base64PageUrl required');
  });

  it('get page metrics by source returns not found when site is not found', async () => {
    const siteId = sites[0].getId();
    const source = 'seo';
    const metric = 'organic-traffic';
    const base64PageUrl = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9mb28vYmFy';

    mockDataAccess.Site.findById.resolves(null);

    const result = await sitesController.getPageMetricsBySource({
      params: {
        siteId,
        source,
        metric,
        base64PageUrl,
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('get page metrics for non belonging to the organization', async () => {
    const siteId = sites[0].getId();
    const source = 'seo';
    const metric = 'organic-traffic';
    const base64PageUrl = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9mb28vYmFy';
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);

    const result = await sitesController.getPageMetricsBySource({
      params: {
        siteId, source, metric, base64PageUrl,
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can view its metrics');
  });

  it('updates a site name', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        name: 'new-name',
      },
      ...defaultAuthAttributes,
    });

    expect(site.save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);

    const updatedSite = await response.json();
    expect(updatedSite).to.have.property('id', SITE_IDS[0]);
    expect(updatedSite).to.have.property('name', 'new-name');
  });

  it('updates a site isSandbox to true', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        isSandbox: true,
      },
      ...defaultAuthAttributes,
    });

    expect(site.save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);

    const updatedSite = await response.json();
    expect(updatedSite).to.have.property('id', SITE_IDS[0]);
    expect(updatedSite).to.have.property('isSandbox', true);
  });

  it('updates a site isSandbox to false', async () => {
    const site = sites[0];
    // Set the initial isSandbox value to true so we can test changing it to false
    site.setIsSandbox(true);
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        isSandbox: false,
      },
      ...defaultAuthAttributes,
    });

    expect(site.save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);

    const updatedSite = await response.json();
    expect(updatedSite).to.have.property('id', SITE_IDS[0]);
    expect(updatedSite).to.have.property('isSandbox', false);
  });

  it('does not update site when isSandbox is the same', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        isSandbox: false, // Same as initial value
      },
      ...defaultAuthAttributes,
    });

    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(400);

    const error = await response.json();
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('updates site with isSandbox and other fields', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        isSandbox: true,
        name: 'updated-name',
        isLive: true,
      },
      ...defaultAuthAttributes,
    });

    expect(site.save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);

    const updatedSite = await response.json();
    expect(updatedSite).to.have.property('id', SITE_IDS[0]);
    expect(updatedSite).to.have.property('isSandbox', true);
    expect(updatedSite).to.have.property('name', 'updated-name');
    expect(updatedSite).to.have.property('isLive', true);
  });

  it('updates a site with code config', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const codeConfig = {
      type: 'github',
      owner: 'test-owner',
      repo: 'test-repo',
      ref: 'main',
      url: 'https://github.com/test-owner/test-repo',
    };

    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        code: codeConfig,
      },
      ...defaultAuthAttributes,
    });

    expect(site.save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);

    const updatedSite = await response.json();
    expect(updatedSite).to.have.property('id', SITE_IDS[0]);
    expect(updatedSite).to.have.property('code');
    expect(updatedSite.code).to.deep.equal(codeConfig);
  });

  it('sets config when site has no existing config', async () => {
    const site = sites[0];
    site.getConfig = sandbox.stub().returns(null);
    site.setConfig = sandbox.stub();
    site.save = sandbox.stub().resolves(site);

    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        config: { slack: { channel: '#new' } },
      },
      ...defaultAuthAttributes,
    });

    expect(response.status).to.equal(200);
    expect(site.setConfig).to.have.been.calledOnce;

    const mergedConfig = site.setConfig.firstCall.args[0];
    expect(mergedConfig).to.deep.equal({ slack: { channel: '#new' } });
  });

  it('sets config when toDynamoItem returns null for existing config', async () => {
    const site = sites[0];
    site.getConfig = sandbox.stub().returns({ something: true });
    site.setConfig = sandbox.stub();
    site.save = sandbox.stub().resolves(site);

    const toDynamoStub = sandbox.stub(Config, 'toDynamoItem').returns(null);

    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        config: { slack: { channel: '#new' } },
      },
      ...defaultAuthAttributes,
    });

    expect(response.status).to.equal(200);
    expect(toDynamoStub).to.have.been.called;
    expect(site.setConfig).to.have.been.calledOnce;

    const mergedConfig = site.setConfig.firstCall.args[0];
    expect(mergedConfig).to.deep.equal({ slack: { channel: '#new' } });
  });

  it('shallow-merges config so partial update preserves existing keys', async () => {
    const site = sites[0];
    const existingConfig = Config({
      slack: { channel: '#test' },
      llmo: { dataFolder: '/data', brand: 'Test' },
      handlers: { 'meta-tags': { excludedURLs: [] } },
    });
    site.getConfig = sandbox.stub().returns(existingConfig);
    site.setConfig = sandbox.stub();
    site.save = sandbox.stub().resolves(site);

    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        config: { slack: { channel: '#updated' } },
      },
      ...defaultAuthAttributes,
    });

    expect(response.status).to.equal(200);
    expect(site.setConfig).to.have.been.calledOnce;

    const mergedConfig = site.setConfig.firstCall.args[0];
    expect(mergedConfig.slack).to.deep.equal({ channel: '#updated' });
    expect(mergedConfig.llmo).to.deep.equal({ dataFolder: '/data', brand: 'Test' });
    expect(mergedConfig.handlers).to.deep.equal({ 'meta-tags': { excludedURLs: [] } });
  });

  it('deep-merges llmo sub-keys so a partial llmo patch preserves siblings like cdnBucketConfig', async () => {
    const site = sites[0];
    const existingConfig = Config({
      llmo: {
        dataFolder: '/data',
        brand: 'Test',
        detectedCdn: 'byocdn-akamai',
        cdnBucketConfig: { cdnProvider: 'akamai', bucketName: 'tui-cdn-logs', region: 'us-east-1' },
        tags: ['opportunitiesReviewed'],
      },
    });
    site.getConfig = sandbox.stub().returns(existingConfig);
    site.setConfig = sandbox.stub();
    site.save = sandbox.stub().resolves(site);

    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        config: {
          llmo: {
            dataFolder: '/data',
            brand: 'Test',
            detectedCdn: 'byocdn-other',
            tags: ['opportunitiesReviewed'],
          },
        },
      },
      ...defaultAuthAttributes,
    });

    expect(response.status).to.equal(200);
    const mergedConfig = site.setConfig.firstCall.args[0];
    expect(mergedConfig.llmo.detectedCdn).to.equal('byocdn-other');
    expect(mergedConfig.llmo.cdnBucketConfig).to.deep.equal({
      cdnProvider: 'akamai',
      bucketName: 'tui-cdn-logs',
      region: 'us-east-1',
    });
  });

  describe('auditTargetURLs validation', () => {
    it('returns bad request when manual URL hostname does not match site base URL', async () => {
      const site = sites[0];
      site.getConfig = sandbox.stub().returns(Config({ slack: { channel: '#x' } }));
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub();

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: {
          config: {
            auditTargetURLs: {
              manual: [{ url: 'https://example.com/path1' }],
            },
          },
        },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const err = await response.json();
      expect(err.message).to.include('Invalid audit target URL at manual[0] (https://example.com/path1):');
      expect(err.message).to.include('site domain (site1.com, with or without www.)');
      expect(site.setConfig).to.have.not.been.called;
    });

    it('accepts manual URLs on the site hostname', async () => {
      const site = sites[0];
      site.getConfig = sandbox.stub().returns(Config({}));
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: {
          config: {
            auditTargetURLs: {
              manual: [{ url: 'https://site1.com/path1' }, { url: 'https://site1.com/path2' }],
            },
          },
        },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      const merged = site.setConfig.firstCall.args[0];
      expect(merged.auditTargetURLs.manual).to.deep.equal([
        { url: 'https://site1.com/path1' },
        { url: 'https://site1.com/path2' },
      ]);
    });

    it('deep-merges auditTargetURLs sub-keys so patching one source preserves others', async () => {
      const site = sites[0];
      site.getConfig = sandbox.stub().returns(Config({}));
      // Stub toDynamoItem so the existing config includes moneyPages regardless of whether
      // the installed shared package's Joi schema knows about that source yet.
      sandbox.stub(Config, 'toDynamoItem').returns({
        auditTargetURLs: {
          manual: [{ url: 'https://site1.com/existing' }],
          moneyPages: [{ url: 'https://site1.com/money1' }],
        },
      });
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: {
          config: {
            auditTargetURLs: {
              manual: [{ url: 'https://site1.com/updated' }],
            },
          },
        },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      const merged = site.setConfig.firstCall.args[0];
      expect(merged.auditTargetURLs.manual).to.deep.equal([{ url: 'https://site1.com/updated' }]);
      expect(merged.auditTargetURLs.moneyPages).to.deep.equal([{ url: 'https://site1.com/money1' }]);
    });

    it('does not validate auditTargetURLs when key is omitted from config patch', async () => {
      const site = sites[0];
      const existingConfig = Config({
        auditTargetURLs: { manual: [{ url: 'https://wrong.example/' }] },
      });
      site.getConfig = sandbox.stub().returns(existingConfig);
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { config: { slack: { channel: '#only' } } },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      const merged = site.setConfig.firstCall.args[0];
      expect(merged.auditTargetURLs.manual[0].url).to.equal('https://wrong.example/');
    });
  });

  describe('detectedCdn validation', () => {
    it('accepts a valid enum value', async () => {
      const site = sites[0];
      site.getConfig = sandbox.stub().returns(Config({}));
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { config: { llmo: { detectedCdn: 'aem-cs-fastly' } } },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      const merged = site.setConfig.firstCall.args[0];
      expect(merged.llmo.detectedCdn).to.equal('aem-cs-fastly');
    });

    it('rejects an array value', async () => {
      const site = sites[0];
      site.getConfig = sandbox.stub().returns(Config({}));
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub();

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { config: { llmo: { detectedCdn: ['Adobe-managed Fastly'] } } },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const err = await response.json();
      expect(err.message).to.include('config.llmo.detectedCdn must be one of');
      expect(site.setConfig).to.have.not.been.called;
    });

    it('rejects a stringified array (prod marriottvacationclubs.com case)', async () => {
      const site = sites[0];
      site.getConfig = sandbox.stub().returns(Config({}));
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub();

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { config: { llmo: { detectedCdn: '["Adobe-managed Fastly"]' } } },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const err = await response.json();
      expect(err.message).to.include('config.llmo.detectedCdn must be one of');
      expect(site.setConfig).to.have.not.been.called;
    });

    it('rejects a human display name', async () => {
      const site = sites[0];
      site.getConfig = sandbox.stub().returns(Config({}));
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub();

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { config: { llmo: { detectedCdn: 'Adobe-managed Fastly' } } },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const err = await response.json();
      expect(err.message).to.include('config.llmo.detectedCdn must be one of');
      expect(site.setConfig).to.have.not.been.called;
    });

    it('does not validate detectedCdn when llmo patch omits it', async () => {
      const site = sites[0];
      // Pre-existing (possibly legacy) value must not be re-rejected by an unrelated llmo patch.
      sandbox.stub(Config, 'toDynamoItem').returns({
        llmo: { detectedCdn: 'Adobe-managed Fastly', brand: 'Old' },
      });
      site.getConfig = sandbox.stub().returns(Config({}));
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { config: { llmo: { brand: 'New' } } },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      const merged = site.setConfig.firstCall.args[0];
      expect(merged.llmo.brand).to.equal('New');
      expect(merged.llmo.detectedCdn).to.equal('Adobe-managed Fastly');
    });
  });

  describe('enableMoneyPageUrls config flag', () => {
    it('allows disabling money page URLs via config patch', async () => {
      const site = sites[0];
      site.getConfig = sandbox.stub().returns(Config({}));
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: {
          config: { enableMoneyPageUrls: false },
        },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      const merged = site.setConfig.firstCall.args[0];
      expect(merged.enableMoneyPageUrls).to.equal(false);
    });

    it('allows re-enabling money page URLs via config patch', async () => {
      const site = sites[0];
      site.getConfig = sandbox.stub().returns(Config({ enableMoneyPageUrls: false }));
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: {
          config: { enableMoneyPageUrls: true },
        },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      const merged = site.setConfig.firstCall.args[0];
      expect(merged.enableMoneyPageUrls).to.equal(true);
    });

    it('preserves enableMoneyPageUrls when patching other config keys', async () => {
      const site = sites[0];
      site.getConfig = sandbox.stub().returns(Config({}));
      // Stub toDynamoItem so the existing config includes enableMoneyPageUrls regardless
      // of whether the installed shared package's schema knows about the field yet.
      sandbox.stub(Config, 'toDynamoItem').returns({
        enableMoneyPageUrls: false,
        slack: { channel: '#old' },
      });
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: {
          config: { slack: { channel: '#updated' } },
        },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      const merged = site.setConfig.firstCall.args[0];
      expect(merged.enableMoneyPageUrls).to.equal(false);
      expect(merged.slack).to.deep.equal({ channel: '#updated' });
    });
  });

  it('allows removing a config key by explicitly setting it to null', async () => {
    const site = sites[0];
    const existingConfig = Config({
      slack: { channel: '#test' },
      llmo: { dataFolder: '/data' },
    });
    site.getConfig = sandbox.stub().returns(existingConfig);
    site.setConfig = sandbox.stub();
    site.save = sandbox.stub().resolves(site);

    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        config: { slack: { channel: '#updated' }, llmo: null },
      },
      ...defaultAuthAttributes,
    });

    expect(response.status).to.equal(200);
    const mergedConfig = site.setConfig.firstCall.args[0];
    expect(mergedConfig.slack).to.deep.equal({ channel: '#updated' });
    expect(mergedConfig.llmo).to.equal(null);
  });

  describe('pageTypes validation', () => {
    it('updates site with valid pageTypes', async () => {
      const site = sites[0];
      site.pageTypes = sandbox.stub().returns([]);
      site.setPageTypes = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const validPageTypes = [
        { name: 'homepage | Homepage', pattern: '^(/([a-z]{2}-[a-z]{2}))?/?$' },
        { name: 'product | Product Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/product/[a-z0-9\\-]+$' },
        { name: 'other | Other Pages', pattern: '.*' },
      ];

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { pageTypes: validPageTypes },
        ...defaultAuthAttributes,
      });

      expect(site.setPageTypes).to.have.been.calledWith(validPageTypes);
      expect(site.save).to.have.been.calledOnce;
      expect(response.status).to.equal(200);
    });

    it('returns bad request when pageType is not an object', async () => {
      const invalidPageTypes = [
        { name: 'homepage', pattern: '^/$' },
        'invalid-page-type',
      ];

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { pageTypes: invalidPageTypes },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'pageTypes[1] must be an object');
    });

    it('returns bad request when pageType missing name', async () => {
      const invalidPageTypes = [
        { pattern: '^/$' }, // Missing name
      ];

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { pageTypes: invalidPageTypes },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'pageTypes[0] must have a name');
    });

    it('returns bad request when pageType has empty name', async () => {
      const invalidPageTypes = [
        { name: '', pattern: '^/$' },
      ];

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { pageTypes: invalidPageTypes },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'pageTypes[0] must have a name');
    });

    it('returns bad request when pageType missing pattern', async () => {
      const invalidPageTypes = [
        { name: 'homepage' }, // Missing pattern
      ];

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { pageTypes: invalidPageTypes },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'pageTypes[0] must have a pattern');
    });

    it('returns bad request when pageType has empty pattern', async () => {
      const invalidPageTypes = [
        { name: 'homepage', pattern: '' },
      ];

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { pageTypes: invalidPageTypes },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'pageTypes[0] must have a pattern');
    });

    it('returns bad request when pageType has invalid regex pattern', async () => {
      const invalidPageTypes = [
        { name: 'homepage', pattern: '^/$' },
        { name: 'invalid', pattern: '[invalid-regex' }, // Invalid regex - unclosed bracket
      ];

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { pageTypes: invalidPageTypes },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error.message).to.include('pageTypes[1] has invalid regex pattern:');
    });

    it('returns bad request for complex invalid regex patterns', async () => {
      const invalidPageTypes = [
        { name: 'invalid-quantifier', pattern: '*invalid' }, // Invalid quantifier
      ];

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { pageTypes: invalidPageTypes },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error.message).to.include('pageTypes[0] has invalid regex pattern:');
    });

    it('does not update site when pageTypes are the same', async () => {
      const site = sites[0];
      const existingPageTypes = [
        { name: 'homepage', pattern: '^/$' },
      ];

      site.getPageTypes = sandbox.stub().returns(existingPageTypes);
      site.save = sandbox.spy(site.save);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { pageTypes: existingPageTypes },
        ...defaultAuthAttributes,
      });

      expect(site.save).to.have.not.been.called;
      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'No updates provided');
    });

    it('validates all pageTypes and returns first error', async () => {
      const invalidPageTypes = [
        { name: 'homepage', pattern: '^/$' }, // Valid
        { pattern: '^/about$' }, // Missing name (first error)
        { name: 'invalid', pattern: '[invalid' }, // Invalid regex (would be second error)
      ];

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { pageTypes: invalidPageTypes },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'pageTypes[1] must have a name');
    });
  });

  describe('projectId, isPrimaryLocale, language, and region updates', () => {
    it('returns forbidden when trying to update projectId', async () => {
      const site = sites[0];
      const currentProjectId = '550e8400-e29b-41d4-a716-446655440000';
      const newProjectId = '650e8400-e29b-41d4-a716-446655440000';
      site.getProjectId = sandbox.stub().returns(currentProjectId);
      site.setProjectId = sandbox.stub();
      site.save = sandbox.spy(site.save);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { projectId: newProjectId },
        ...defaultAuthAttributes,
      });
      const error = await response.json();

      expect(site.setProjectId).to.have.not.been.called;
      expect(site.save).to.have.not.been.called;
      expect(response.status).to.equal(403);
      expect(error).to.have.property('message', 'Updating project ID is not allowed');
    });

    it('ignores projectId when it matches the current projectId', async () => {
      const site = sites[0];
      const currentProjectId = '550e8400-e29b-41d4-a716-446655440000';
      site.getProjectId = sandbox.stub().returns(currentProjectId);
      site.setProjectId = sandbox.stub();
      site.getIsPrimaryLocale = sandbox.stub().returns(false);
      site.setIsPrimaryLocale = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { projectId: currentProjectId, isPrimaryLocale: true },
        ...defaultAuthAttributes,
      });

      expect(site.setProjectId).to.have.not.been.called;
      expect(site.save).to.have.been.calledOnce;
      expect(response.status).to.equal(200);
    });

    it('ignores an empty-string projectId (guarded by hasText)', async () => {
      const site = sites[0];
      site.getProjectId = sandbox.stub().returns('550e8400-e29b-41d4-a716-446655440000');
      site.setProjectId = sandbox.stub();
      site.getIsPrimaryLocale = sandbox.stub().returns(false);
      site.setIsPrimaryLocale = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { projectId: '', isPrimaryLocale: true },
        ...defaultAuthAttributes,
      });

      // Empty string is not "text", so the guard is skipped — no 403 — and the
      // other field still saves.
      expect(site.setProjectId).to.have.not.been.called;
      expect(site.save).to.have.been.calledOnce;
      expect(response.status).to.equal(200);
    });

    it('updates site with isPrimaryLocale', async () => {
      const site = sites[0];
      site.getIsPrimaryLocale = sandbox.stub().returns(false);
      site.setIsPrimaryLocale = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { isPrimaryLocale: true },
        ...defaultAuthAttributes,
      });

      expect(site.setIsPrimaryLocale).to.have.been.calledWith(true);
      expect(site.save).to.have.been.calledOnce;
      expect(response.status).to.equal(200);
    });

    it('updates site with valid language in ISO 639-1 format', async () => {
      const site = sites[0];
      site.getLanguage = sandbox.stub().returns('en');
      site.setLanguage = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { language: 'fr' },
        ...defaultAuthAttributes,
      });

      expect(site.setLanguage).to.have.been.calledWith('fr');
      expect(site.save).to.have.been.calledOnce;
      expect(response.status).to.equal(200);
    });

    it('returns bad request for invalid language format', async () => {
      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { language: 'EN' }, // Should be lowercase
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Language must be in ISO 639-1 format (2 lowercase letters)');
    });

    it('returns bad request for language with wrong length', async () => {
      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { language: 'eng' }, // Should be 2 letters
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Language must be in ISO 639-1 format (2 lowercase letters)');
    });

    it('updates site with valid region in ISO 3166-1 alpha-2 format', async () => {
      const site = sites[0];
      site.getRegion = sandbox.stub().returns('US');
      site.setRegion = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { region: 'FR' },
        ...defaultAuthAttributes,
      });

      expect(site.setRegion).to.have.been.calledWith('FR');
      expect(site.save).to.have.been.calledOnce;
      expect(response.status).to.equal(200);
    });

    it('returns bad request for invalid region format', async () => {
      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { region: 'us' }, // Should be uppercase
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Region must be in ISO 3166-1 alpha-2 format (2 uppercase letters)');
    });

    it('returns bad request for region with wrong length', async () => {
      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { region: 'USA' }, // Should be 2 letters
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Region must be in ISO 3166-1 alpha-2 format (2 uppercase letters)');
    });
  });

  describe('updateCdnLogsConfig', () => {
    it('updates CDN logs config successfully', async () => {
      const site = sites[0];
      const originalConfig = Config({ existingConfig: 'value' });
      const cdnLogsConfig = {
        bucketName: 'test-bucket',
        outputLocation: 'test-output-location',
        filters: [{ key: 'test-key', value: ['test-value'] }],
      };

      let currentConfig = originalConfig;
      site.getConfig = sandbox.stub().callsFake(() => currentConfig);
      site.setConfig = sandbox.stub().callsFake((newConfig) => {
        currentConfig = Config(newConfig);
      });
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: SITE_IDS[0] },
        data: { cdnLogsConfig },
        ...defaultAuthAttributes,
      });

      expect(site.save).to.have.been.calledOnce;
      expect(response.status).to.equal(200);

      const updatedSite = await response.json();
      expect(updatedSite).to.have.property('id', SITE_IDS[0]);
      expect(updatedSite.config).to.have.property('cdnLogsConfig');
      expect(updatedSite.config.cdnLogsConfig).to.deep.include({
        bucketName: 'test-bucket',
        outputLocation: 'test-output-location',
      });
    });

    it('returns bad request when site ID is not provided', async () => {
      const response = await sitesController.updateCdnLogsConfig({
        params: {},
        data: { cdnLogsConfig: { enabled: true } },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site ID required');
    });

    it('returns bad request when site ID is invalid', async () => {
      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: 'invalid-uuid' },
        data: { cdnLogsConfig: { enabled: true } },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site ID required');
    });

    it('returns bad request when cdnLogsConfig is not provided', async () => {
      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: SITE_IDS[0] },
        data: {},
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Cdn logs config required');
    });

    it('returns bad request when cdnLogsConfig is not an object', async () => {
      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: SITE_IDS[0] },
        data: { cdnLogsConfig: 'not-an-object' },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Cdn logs config required');
    });

    it('returns bad request when cdnLogsConfig is null', async () => {
      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: SITE_IDS[0] },
        data: { cdnLogsConfig: null },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Cdn logs config required');
    });

    it('returns not found when site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: SITE_IDS[0] },
        data: { cdnLogsConfig: { bucketName: 'test-bucket' } },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site not found');
    });

    it('merges cdnLogsConfig with existing config', async () => {
      const site = sites[0];
      const existingConfig = Config({
        existingField: 'value',
        anotherField: 'another-value',
      });
      const cdnLogsConfig = {
        bucketName: 'my-bucket',
        outputLocation: 'my-output',
      };

      site.getConfig = sandbox.stub().returns(existingConfig);
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: SITE_IDS[0] },
        data: { cdnLogsConfig },
        ...defaultAuthAttributes,
      });

      expect(site.setConfig).to.have.been.calledOnce;
      expect(site.save).to.have.been.calledOnce;
      expect(response.status).to.equal(200);
    });

    it('overwrites existing cdnLogsConfig when updating', async () => {
      const site = sites[0];
      const existingConfig = Config({
        existingField: 'value',
        cdnLogsConfig: {
          bucketName: 'old-bucket',
          outputLocation: 'old-output',
          filters: [{ key: 'old-key', value: ['old-value'] }],
        },
      });
      const newCdnLogsConfig = {
        bucketName: 'new-bucket',
        outputLocation: 'new-output',
        filters: [{ key: 'new-key', value: ['new-value'] }],
      };

      site.getConfig = sandbox.stub().returns(existingConfig);
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: SITE_IDS[0] },
        data: { cdnLogsConfig: newCdnLogsConfig },
        ...defaultAuthAttributes,
      });

      expect(site.setConfig).to.have.been.calledOnce;
      expect(site.save).to.have.been.calledOnce;
      expect(response.status).to.equal(200);
    });

    it('returns forbidden when user does not have access to the site', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);

      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: SITE_IDS[0] },
        data: { cdnLogsConfig: { enabled: true } },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(403);
      const error = await response.json();
      expect(error).to.have.property('message', 'Only users belonging to the organization can update its sites');
    });

    it('handles missing context data gracefully', async () => {
      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: SITE_IDS[0] },
        // No data property
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Cdn logs config required');
    });

    it('handles errors during config update', async () => {
      const site = sites[0];
      const cdnLogsConfig = { bucketName: 'test-bucket' };

      site.getConfig = sandbox.stub().throws(new Error('Config update failed'));

      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: SITE_IDS[0] },
        data: { cdnLogsConfig },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Failed to update CDN logs config');
    });

    it('handles errors during site save', async () => {
      const site = sites[0];
      const cdnLogsConfig = { bucketName: 'test-bucket' };

      site.getConfig = sandbox.stub().returns(Config({}));
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().rejects(new Error('Save failed'));

      const response = await sitesController.updateCdnLogsConfig({
        params: { siteId: SITE_IDS[0] },
        data: { cdnLogsConfig },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Failed to update CDN logs config');
    });
  });

  describe('getScraperConfig', () => {
    /* eslint-disable no-param-reassign */
    const stubSiteWithScraperConfig = (site, headers) => {
      const wrapped = Object.create(Config({}));
      Object.defineProperty(wrapped, 'getScraperConfig', {
        value: () => (headers ? { headers } : undefined),
        writable: true,
        configurable: true,
      });
      site.getConfig = sandbox.stub().returns(wrapped);
      return wrapped;
    };
    /* eslint-enable no-param-reassign */

    it('returns the persisted scraperConfig in the narrow response shape', async () => {
      const site = sites[0];
      const headers = { 'Accept-Language': 'en-US,en;q=0.9' };
      stubSiteWithScraperConfig(site, headers);

      const response = await sitesController.getScraperConfig({
        params: { siteId: SITE_IDS[0] },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.deep.equal({
        siteId: SITE_IDS[0],
        scraperConfig: { headers },
      });
    });

    it('returns an empty object when no scraperConfig is persisted', async () => {
      const site = sites[0];
      stubSiteWithScraperConfig(site, null);

      const response = await sitesController.getScraperConfig({
        params: { siteId: SITE_IDS[0] },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      // Lock the "no missing case" contract: callers always get an object.
      expect(body).to.deep.equal({ siteId: SITE_IDS[0], scraperConfig: {} });
    });

    it('returns bad request when site ID is invalid', async () => {
      const response = await sitesController.getScraperConfig({
        params: { siteId: 'not-a-uuid' },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('Invalid site ID');
    });

    it('returns not found when the site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const response = await sitesController.getScraperConfig({
        params: { siteId: SITE_IDS[0] },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(404);
      expect((await response.json()).message).to.equal('Site not found');
    });

    it('returns forbidden when the user lacks access to the site', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);

      const response = await sitesController.getScraperConfig({
        params: { siteId: SITE_IDS[0] },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(403);
    });

    it('treats a null site.getConfig() as the documented "nothing persisted" case', async () => {
      // Locks defensive-optional-chain behavior: even when the model returns
      // null from getConfig() (which happens for sites without a persisted
      // config row), the endpoint must not throw — it should return the
      // documented `{}` envelope.
      const site = sites[0];
      site.getConfig = sandbox.stub().returns(null);

      const response = await sitesController.getScraperConfig({
        params: { siteId: SITE_IDS[0] },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      expect(await response.json()).to.deep.equal({
        siteId: SITE_IDS[0],
        scraperConfig: {},
      });
    });

    it('logs a warning when scraperConfig is null (vs undefined) and still returns empty', async () => {
      // null specifically — vs the undefined "never written" case — should
      // produce a forensics breadcrumb without changing the response shape.
      const site = sites[0];
      const wrapped = Object.create(Config({}));
      Object.defineProperty(wrapped, 'getScraperConfig', {
        value: () => null, writable: true, configurable: true,
      });
      site.getConfig = sandbox.stub().returns(wrapped);

      const response = await sitesController.getScraperConfig({
        params: { siteId: SITE_IDS[0] },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(200);
      expect(await response.json()).to.deep.equal({
        siteId: SITE_IDS[0],
        scraperConfig: {},
      });
      expect(loggerStub.warn).to.have.been.calledWithMatch(
        sinon.match((val) => typeof val === 'string'
          && val.includes('null scraperConfig')
          && val.includes(SITE_IDS[0])),
      );
    });

    it('propagates findById failures as 5xx after logging', async () => {
      // Transient infra errors (DB throttling, IMS hiccup on hasAccess, etc.)
      // must produce a CloudWatch breadcrumb so the on-call can find them.
      const failure = new Error('Transient DB error');
      mockDataAccess.Site.findById.rejects(failure);

      await expect(sitesController.getScraperConfig({
        params: { siteId: SITE_IDS[0] },
        ...defaultAuthAttributes,
      })).to.be.rejectedWith(/Transient DB error/);

      expect(loggerStub.error).to.have.been.calledWithMatch(
        sinon.match((val) => typeof val === 'string'
          && val.includes('Error getting scraper config for site')
          && val.includes(SITE_IDS[0])),
      );
    });
  });

  describe('updateScraperConfig', () => {
    const scraperConfig = {
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    };

    // Wrap a real Config so toDynamoItem still works against the published
    // shared package, while attaching sinon stubs for updateScraperConfig and
    // getScraperConfig (neither exists on the installed version yet).
    // The stubbed updateScraperConfig captures the persisted value so the
    // matching getScraperConfig returns it — matching the contract the
    // controller now relies on for the response payload.
    /* eslint-disable no-param-reassign */
    const stubSiteConfig = (site) => {
      const wrapped = Object.create(Config({}));
      let persisted;
      const updateStub = sandbox.stub().callsFake((value) => {
        persisted = value;
      });
      // Use defineProperty so we can override methods inherited from the
      // frozen Config prototype (Object.freeze marks them non-writable).
      Object.defineProperty(wrapped, 'updateScraperConfig', {
        value: updateStub, writable: true, configurable: true,
      });
      Object.defineProperty(wrapped, 'getScraperConfig', {
        value: () => persisted, writable: true, configurable: true,
      });
      site.getConfig = sandbox.stub().returns(wrapped);
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().resolves(site);
      return { updateScraperConfig: updateStub };
    };
    /* eslint-enable no-param-reassign */

    it('updates scraper config successfully and returns a narrow response', async () => {
      const site = sites[0];
      const fakeSiteConfig = stubSiteConfig(site);

      const response = await sitesController.updateScraperConfig({
        params: { siteId: SITE_IDS[0] },
        data: { scraperConfig },
        ...defaultAuthAttributes,
      });

      expect(fakeSiteConfig.updateScraperConfig).to.have.been.calledOnceWith(scraperConfig);
      expect(site.save).to.have.been.calledOnce;
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.deep.equal({ siteId: SITE_IDS[0], scraperConfig });
    });

    it('returns bad request when site ID is invalid', async () => {
      const response = await sitesController.updateScraperConfig({
        params: { siteId: 'not-a-uuid' },
        data: { scraperConfig },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('Invalid site ID');
    });

    it('returns bad request when scraperConfig is not provided', async () => {
      const response = await sitesController.updateScraperConfig({
        params: { siteId: SITE_IDS[0] },
        data: {},
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('Scraper config required');
    });

    it('returns bad request when scraperConfig is not an object', async () => {
      const response = await sitesController.updateScraperConfig({
        params: { siteId: SITE_IDS[0] },
        data: { scraperConfig: 'nope' },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('Scraper config required');
    });

    it('accepts empty scraperConfig to clear stored config', async () => {
      const site = sites[0];
      const fakeSiteConfig = stubSiteConfig(site);

      const response = await sitesController.updateScraperConfig({
        params: { siteId: SITE_IDS[0] },
        data: { scraperConfig: {} },
        ...defaultAuthAttributes,
      });

      expect(fakeSiteConfig.updateScraperConfig).to.have.been.calledOnceWith({});
      expect(response.status).to.equal(200);
    });

    it('uses replace (not merge) semantics on the persisted config', async () => {
      const site = sites[0];
      const fakeSiteConfig = stubSiteConfig(site);

      const partialUpdate = { headers: { 'X-New': 'value' } };
      const response = await sitesController.updateScraperConfig({
        params: { siteId: SITE_IDS[0] },
        data: { scraperConfig: partialUpdate },
        ...defaultAuthAttributes,
      });

      // The setter is called with exactly the payload supplied by the caller -
      // nothing is merged with a prior scraperConfig at this layer.
      expect(fakeSiteConfig.updateScraperConfig).to.have.been.calledOnceWith(partialUpdate);
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.scraperConfig).to.deep.equal(partialUpdate);
    });

    it('returns not found when site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const response = await sitesController.updateScraperConfig({
        params: { siteId: SITE_IDS[0] },
        data: { scraperConfig },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(404);
      expect((await response.json()).message).to.equal('Site not found');
    });

    it('returns forbidden when user does not have access to the site', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);

      const response = await sitesController.updateScraperConfig({
        params: { siteId: SITE_IDS[0] },
        data: { scraperConfig },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(403);
    });

    it('returns 400 when the shared schema rejects the config', async () => {
      const site = sites[0];
      const wrapped = Object.create(Config({}));
      Object.defineProperty(wrapped, 'updateScraperConfig', {
        value: sandbox.stub().throws(
          new Error('Configuration validation error: bad'),
        ),
        writable: true,
        configurable: true,
      });
      site.getConfig = sandbox.stub().returns(wrapped);

      const response = await sitesController.updateScraperConfig({
        params: { siteId: SITE_IDS[0] },
        data: { scraperConfig },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.match(/Configuration validation error/);
    });

    it('propagates unexpected errors (e.g. save failures) as 5xx', async () => {
      const site = sites[0];
      const wrapped = Object.create(Config({}));
      Object.defineProperty(wrapped, 'updateScraperConfig', {
        value: sandbox.stub(), writable: true, configurable: true,
      });
      site.getConfig = sandbox.stub().returns(wrapped);
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().rejects(new Error('DDB throttle'));

      await expect(sitesController.updateScraperConfig({
        params: { siteId: SITE_IDS[0] },
        data: { scraperConfig },
        ...defaultAuthAttributes,
      })).to.be.rejectedWith('DDB throttle');
    });

    it('returns bad request when context.data is missing entirely', async () => {
      // No `data` property on the context at all: `context.data || {}` defaults to
      // `{}`, so `scraperConfig` is undefined and the request fails the object guard.
      const response = await sitesController.updateScraperConfig({
        params: { siteId: SITE_IDS[0] },
        ...defaultAuthAttributes,
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('Scraper config required');
    });

    it('logs an empty header list when an unexpected error fires for a headerless config', async () => {
      // Re-throw path (non-validation error) for a scraperConfig with no `headers`:
      // `scraperConfig.headers || {}` falls back to `{}` so the error log lists no headers.
      const site = sites[0];
      const wrapped = Object.create(Config({}));
      Object.defineProperty(wrapped, 'updateScraperConfig', {
        value: sandbox.stub(), writable: true, configurable: true,
      });
      site.getConfig = sandbox.stub().returns(wrapped);
      site.setConfig = sandbox.stub();
      site.save = sandbox.stub().rejects(new Error('DDB throttle'));

      await expect(sitesController.updateScraperConfig({
        params: { siteId: SITE_IDS[0] },
        data: { scraperConfig: { someOtherKey: 'value' } },
        ...defaultAuthAttributes,
      })).to.be.rejectedWith('DDB throttle');

      expect(loggerStub.error).to.have.been.calledWithMatch(
        /Error updating scraper config for site .* \(headers=\):/,
      );
    });
  });

  describe('getPageCitabilityCounts', () => {
    it('returns bad request when site ID is missing', async () => {
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: undefined },
        data: {},
      });
      const error = await result.json();
      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Site ID required');
    });

    it('returns bad request for an invalid groupBy field', async () => {
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'invalidField' },
      });
      const error = await result.json();
      expect(result.status).to.equal(400);
      expect(error.message).to.include('Invalid groupBy field');
    });

    it('returns not found when the site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: {},
      });
      const error = await result.json();
      expect(result.status).to.equal(404);
      expect(error).to.have.property('message', 'Site not found');
    });

    it('returns forbidden when user does not have access to the site', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: {},
      });
      const error = await result.json();
      expect(result.status).to.equal(403);
      expect(error).to.have.property('message', 'Only users belonging to the organization can view its page citability records');
    });

    it('returns empty counts when no records exist', async () => {
      mockDataAccess.PageCitability.allBySiteId.resolves([]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: {},
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({});
    });

    it('defaults to groupBy=updatedBy when groupBy is not specified', async () => {
      mockDataAccess.PageCitability.allBySiteId.resolves([
        { getUpdatedBy: () => 'prerender' },
        { getUpdatedBy: () => 'page-citability' },
      ]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: {},
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({ prerender: 1, 'page-citability': 1 });
    });

    it('returns counts grouped by updatedBy', async () => {
      mockDataAccess.PageCitability.allBySiteId.resolves([
        { getUpdatedBy: () => 'prerender' },
        { getUpdatedBy: () => 'prerender' },
        { getUpdatedBy: () => 'page-citability' },
        { getUpdatedBy: () => 'spacecat' },
      ]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedBy' },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({ prerender: 2, 'page-citability': 1, spacecat: 1 });
    });

    it('returns counts grouped by url', async () => {
      mockDataAccess.PageCitability.allBySiteId.resolves([
        { getUrl: () => 'https://example.com/a' },
        { getUrl: () => 'https://example.com/a' },
        { getUrl: () => 'https://example.com/b' },
      ]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'url' },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({ 'https://example.com/a': 2, 'https://example.com/b': 1 });
    });

    it('returns counts grouped by updatedAt', async () => {
      mockDataAccess.PageCitability.allBySiteId.resolves([
        { getUpdatedAt: () => '2025-01-01' },
        { getUpdatedAt: () => '2025-01-01' },
        { getUpdatedAt: () => '2025-01-02' },
      ]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedAt' },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({ '2025-01-01': 2, '2025-01-02': 1 });
    });

    it('falls back to direct property when getter is absent', async () => {
      mockDataAccess.PageCitability.allBySiteId.resolves([
        { updatedBy: 'prerender' },
      ]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedBy' },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({ prerender: 1 });
    });

    it('falls back to "unknown" when neither getter nor property is present', async () => {
      mockDataAccess.PageCitability.allBySiteId.resolves([{}]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedBy' },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({ unknown: 1 });
    });

    it('returns bad request when period and from are both provided', async () => {
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { period: '7d', from: '2025-01-01' },
      });
      const error = await result.json();
      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'period and from/to are mutually exclusive');
    });

    it('returns bad request for an invalid period value', async () => {
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { period: '3d' },
      });
      const error = await result.json();
      expect(result.status).to.equal(400);
      expect(error.message).to.include('Invalid period');
    });

    it('returns bad request for an invalid from date', async () => {
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { from: 'not-a-date' },
      });
      const error = await result.json();
      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Invalid from date');
    });

    it('returns bad request for an invalid to date', async () => {
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { to: 'not-a-date' },
      });
      const error = await result.json();
      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Invalid to date');
    });

    it('filters records by period=7d', async () => {
      // DB handles the between filter — mock returns only what would survive it
      mockDataAccess.PageCitability.allBySiteId.resolves([
        { getUpdatedBy: () => 'prerender' },
      ]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedBy', period: '7d' },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({ prerender: 1 });
    });

    it('returns all records for period=all', async () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      mockDataAccess.PageCitability.allBySiteId.resolves([
        { getUpdatedBy: () => 'prerender', getUpdatedAt: () => tenDaysAgo },
        { getUpdatedBy: () => 'page-citability', getUpdatedAt: () => tenDaysAgo },
      ]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedBy', period: 'all' },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({ prerender: 1, 'page-citability': 1 });
    });

    it('filters records by explicit from/to date range', async () => {
      // DB handles the between filter — mock returns only what would survive it
      mockDataAccess.PageCitability.allBySiteId.resolves([
        { getUpdatedBy: () => 'prerender' },
      ]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedBy', from: '2025-02-01', to: '2025-02-28' },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({ prerender: 1 });
    });

    it('filters records with only from date', async () => {
      // DB handles the between filter — mock returns only what would survive it
      mockDataAccess.PageCitability.allBySiteId.resolves([
        { getUpdatedBy: () => 'prerender' },
      ]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedBy', from: '2025-02-01' },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({ prerender: 1 });
    });

    it('filters records with only to date', async () => {
      // DB handles the between filter — mock returns only what would survive it
      mockDataAccess.PageCitability.allBySiteId.resolves([
        { getUpdatedBy: () => 'prerender' },
      ]);
      const result = await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedBy', to: '2025-02-01' },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.deep.equal({ prerender: 1 });
    });

    it('passes between option to allBySiteId when from and to are provided', async () => {
      mockDataAccess.PageCitability.allBySiteId.resolves([{ getUpdatedBy: () => 'prerender' }]);
      await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedBy', from: '2025-02-01', to: '2025-02-28' },
      });
      const [, options] = mockDataAccess.PageCitability.allBySiteId.firstCall.args;
      expect(options).to.have.nested.property('between.attribute', 'updatedAt');
      expect(options).to.have.nested.property('between.start');
      expect(options).to.have.nested.property('between.end');
    });

    it('passes between option to allBySiteId when period is set', async () => {
      mockDataAccess.PageCitability.allBySiteId.resolves([]);
      await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedBy', period: '7d' },
      });
      const [, options] = mockDataAccess.PageCitability.allBySiteId.firstCall.args;
      expect(options).to.have.nested.property('between.attribute', 'updatedAt');
    });

    it('passes no options to allBySiteId when no time filter is set', async () => {
      mockDataAccess.PageCitability.allBySiteId.resolves([]);
      await sitesController.getPageCitabilityCounts({
        params: { siteId: SITE_IDS[0] },
        data: { groupBy: 'updatedBy' },
      });
      const [, options] = mockDataAccess.PageCitability.allBySiteId.firstCall.args;
      expect(options).to.deep.equal({});
    });
  });

  describe('getTopPages', () => {
    it('returns bad request when site ID is missing', async () => {
      const result = await sitesController.getTopPages({
        params: {
          siteId: undefined,
        },
      });
      const error = await result.json();
      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Site ID required');
    });

    it('returns forbidden when user does not have access to the site', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      const result = await sitesController.getTopPages({
        params: {
          siteId: SITE_IDS[0],
        },
      });
      const error = await result.json();
      expect(result.status).to.equal(403);
      expect(error).to.have.property('message', 'Only users belonging to the organization can view its top pages');
    });

    it('returns not found when the site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await sitesController.getTopPages({
        params: {
          siteId: SITE_IDS[0],
        },
      });
      const error = await result.json();
      expect(result.status).to.equal(404);
      expect(error).to.have.property('message', 'Site not found');
    });

    it('retrieves top pages for a site', async () => {
      const result = await sitesController.getTopPages({
        params: {
          siteId: SITE_IDS[0],
        },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.be.an('array');
      expect(mockDataAccess.SiteTopPage.allBySiteId).to.have.been.calledWith(SITE_IDS[0]);
    });

    it('retrieves top pages by source for a site', async () => {
      const result = await sitesController.getTopPages({
        params: {
          siteId: SITE_IDS[0],
          source: 'seo',
        },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.be.an('array');
      expect(mockDataAccess.SiteTopPage.allBySiteIdAndSource).to.have.been.calledWith(SITE_IDS[0], 'seo');
    });

    it('retrieves top pages by source and geo for a site', async () => {
      const result = await sitesController.getTopPages({
        params: {
          siteId: SITE_IDS[0],
          source: 'seo',
          geo: 'US',
        },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.be.an('array');
      expect(mockDataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo).to.have.been.calledWith(SITE_IDS[0], 'seo', 'US');
    });
  });

  describe('resolveSite', () => {
    let mockTierClientStub;
    let tierClientStub;
    let accessControlStub;
    let testOrganizations;
    let testSites;

    // Must include Config methods because OrganizationDto.toJSON calls Config.toDynamoItem.
    const makeConfigWithDefault = (siteId) => ({
      getDefaults: () => ({ abcd: { siteId } }),
      getSlackConfig: () => undefined,
      getHandlers: () => undefined,
      getContentAiConfig: () => undefined,
      getImports: () => undefined,
      getFetchConfig: () => undefined,
      getBrandConfig: () => undefined,
      getBrandProfile: () => undefined,
      getCdnLogsConfig: () => undefined,
      getScraperConfig: () => undefined,
      getLlmoConfig: () => undefined,
      getTokowakaConfig: () => undefined,
      getEdgeOptimizeConfig: () => undefined,
    });

    beforeEach(() => {
      accessControlStub = sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(true);
      testOrganizations = [
        {
          organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28',
          name: 'Org 1',
          imsOrgId: '1234567890ABCDEF12345678@AdobeOrg',
          config: Config({}),
        },
        {
          organizationId: '5f3b3626-029c-476e-924b-0c1bba2e871f',
          name: 'Org 2',
          imsOrgId: '2234567890ABCDEF12345678@AdobeOrg',
          config: Config({}),
        },
        {
          organizationId: 'org3',
          name: 'Org 3',
          imsOrgId: '9876567890ABCDEF12345678@AdobeOrg',
          config: Config({}),
        },
        {
          organizationId: '7033554c-de8a-44ac-a356-09b51af8cc28',
          name: 'Org 4',
          imsOrgId: '1176567890ABCDEF12345678@AdobeOrg',
          config: Config({}),
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
        org,
        console,
      ));

      // Create test sites with organizationId
      testSites = [
        {
          siteId: SITE_IDS[0],
          organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28',
          baseURL: 'https://test-site-1.com',
          deliveryType: 'aem_edge',
          config: Config({}),
        },
        {
          siteId: SITE_IDS[1],
          organizationId: '7033554c-de8a-44ac-a356-09b51af8cc28',
          baseURL: 'https://test-site-2.com',
          deliveryType: 'aem_edge',
          config: Config({}),
        },
      ].map((site) => new Site(
        { entities: { site: { model: {} } } },
        {
          log: console,
          getCollection: stub().returns({
            schema: SiteSchema,
            findById: stub(),
          }),
        },
        SiteSchema,
        site,
        console,
      ));

      mockTierClientStub = {
        checkValidEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'entitlement-123', getTier: () => 'FREE_TRIAL' },
        }),
        getFirstEnrollment: sandbox.stub().resolves({
          entitlement: { getId: () => 'entitlement-123', getTier: () => 'FREE_TRIAL' },
          enrollment: { getId: () => 'enrollment-123', getSiteId: () => SITE_IDS[0] },
          site: testSites[0],
        }),
        getAllEnrollment: sandbox.stub().resolves({
          entitlement: { getId: () => 'entitlement-123', getTier: () => 'FREE_TRIAL' },
          enrollments: [{ getId: () => 'enrollment-123', getSiteId: () => SITE_IDS[0] }],
        }),
      };
      tierClientStub = sandbox.stub(TierClient, 'createForOrg').returns(mockTierClientStub);
      sandbox.stub(TierClient, 'createForSite').returns(mockTierClientStub);

      mockDataAccess.Configuration = {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite: sandbox.stub().returns(true),
        }),
      };
      mockDataAccess.Entitlement = {
        findByOrganizationIdAndProductCode: sandbox.stub().resolves({
          getTier: () => 'PLG',
        }),
      };
    });

    afterEach(() => {
      if (accessControlStub) {
        accessControlStub.restore();
      }
      if (tierClientStub) {
        tierClientStub.restore();
      }
    });

    it('should return bad request if no product code header provided', async () => {
      context.pathInfo.headers = {};
      context.data = {};
      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('Product code required');
    });

    it('should return bad request if no query parameters provided', async () => {
      context.data = {};
      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('Either organizationId or imsOrg must be provided');
    });

    it('should return site data for valid organizationId with enrolled sites', async () => {
      context.data = { organizationId: testOrganizations[0].getId() };
      mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
      mockDataAccess.Site.findById.resolves(testSites[0]);

      mockTierClientStub.getFirstEnrollment.resolves({
        entitlement: { getId: () => 'entitlement-123', getTier: () => 'FREE_TRIAL' },
        enrollment: { getId: () => 'enrollment-1', getSiteId: () => SITE_IDS[0] },
        site: testSites[0],
      });

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('data');
      expect(body.data).to.have.property('organization');
      expect(body.data).to.have.property('site');
    });

    it('should include isSummitPlgEnabled in response when site is resolved', async () => {
      context.data = { organizationId: testOrganizations[0].getId() };
      mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
      mockDataAccess.Site.findById.resolves(testSites[0]);
      mockTierClientStub.getFirstEnrollment.resolves({
        entitlement: { getId: () => 'entitlement-123', getTier: () => 'FREE_TRIAL' },
        enrollment: { getId: () => 'enrollment-1', getSiteId: () => SITE_IDS[0] },
        site: testSites[0],
      });

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.data).to.have.property('isSummitPlgEnabled', true);
    });

    it('should set isSummitPlgEnabled to false when entitlement is not PLG', async () => {
      mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves({
        getTier: () => 'FREE_TRIAL',
      });

      context.data = { organizationId: testOrganizations[0].getId() };
      mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
      mockDataAccess.Site.findById.resolves(testSites[0]);
      mockTierClientStub.getFirstEnrollment.resolves({
        entitlement: { getId: () => 'entitlement-123', getTier: () => 'FREE_TRIAL' },
        enrollment: { getId: () => 'enrollment-1', getSiteId: () => SITE_IDS[0] },
        site: testSites[0],
      });

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.data).to.have.property('isSummitPlgEnabled', false);
    });

    it('should return 404 with no_entitlement_for_product resolveStatus for non-existent imsOrg (external caller)', async () => {
      context.data = { imsOrg: 'nonexistent@AdobeOrg' };
      mockDataAccess.Organization.findByImsOrgId.resolves(null);

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.resolveStatus).to.equal('no_entitlement_for_product');
      expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledWith('nonexistent@AdobeOrg');
    });

    it('should return 404 with site_not_enrolled when imsOrg not in DB and caller is internal', async () => {
      const internalUuid = '9033554c-de8a-44ac-a356-09b51af8cc28';
      const internalIms = '1234567890ABCDEF12345678@AdobeOrg';
      context.data = { imsOrg: 'unknown@AdobeOrg', callerImsOrg: internalIms };
      context.env = { ...context.env, ASO_PLG_EXCLUDED_ORGS: internalUuid };
      const internalOrg = { getId: () => internalUuid };
      mockDataAccess.Organization.findByImsOrgId.withArgs(internalIms).resolves(internalOrg);
      mockDataAccess.Organization.findByImsOrgId.withArgs('unknown@AdobeOrg').resolves(null);

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.resolveStatus).to.equal('site_not_enrolled');
    });

    it('should treat callerImsOrg as non-internal when its org lookup throws', async () => {
      context.data = { imsOrg: 'customer@AdobeOrg', callerImsOrg: 'caller@AdobeOrg' };
      mockDataAccess.Organization.findByImsOrgId.withArgs('caller@AdobeOrg').rejects(new Error('DB error'));
      mockDataAccess.Organization.findByImsOrgId.withArgs('customer@AdobeOrg').resolves(null);

      const response = await sitesController.resolveSite(context);

      // callerIsInternal stays false (fail-open) → external-caller path
      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.resolveStatus).to.equal('no_entitlement_for_product');
    });

    it('should return 404 with site_not_enrolled when imsOrg has visible entitlement but no enrolled site', async () => {
      context.data = { imsOrg: testOrganizations[2].getImsOrgId() };
      mockDataAccess.Organization.findByImsOrgId.resolves(testOrganizations[2]);
      mockTierClientStub.getFirstEnrollment.resolves({
        entitlement: { getTier: () => 'FREE_TRIAL' },
        site: null,
      });

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.resolveStatus).to.equal('site_not_enrolled');
    });

    it('should return 200 via imsOrg path when non-admin has visible entitlement and enrolled site', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(false);
      context.data = { imsOrg: testOrganizations[2].getImsOrgId() };
      mockDataAccess.Organization.findByImsOrgId.resolves(testOrganizations[2]);
      mockTierClientStub.getFirstEnrollment.resolves({
        entitlement: { getTier: () => 'FREE_TRIAL' },
        site: testSites[0],
      });

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.data).to.have.property('site');
    });

    it('should call proper methods for valid imsOrg', async () => {
      context.data = { imsOrg: testOrganizations[0].getImsOrgId() };
      mockDataAccess.Organization.findByImsOrgId.resolves(testOrganizations[0]);
      mockDataAccess.Site.findById.resolves(testSites[0]);

      mockTierClientStub.getFirstEnrollment.resolves({
        entitlement: null,
        enrollment: null,
        site: null,
      });

      const response = await sitesController.resolveSite(context);

      expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledWith(
        testOrganizations[0].getImsOrgId(),
      );
      // Response can be 200 or 404 depending on enrollment data
      expect(response.status).to.be.oneOf([200, 404]);
    });

    it('should return not found when organization has no enrolled sites', async () => {
      context.data = { organizationId: testOrganizations[0].getId() };
      mockDataAccess.Organization.findById.resolves(testOrganizations[0]);

      mockTierClientStub.getFirstEnrollment.resolves({
        entitlement: null,
        enrollment: null,
        site: null,
      });

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.include('No site found for the provided parameters');
    });

    it('should handle errors gracefully', async () => {
      context.data = { siteId: SITE_IDS[0], imsOrg: testOrganizations[0].getImsOrgId() };
      mockDataAccess.Site.findById.rejects(new Error('Database error'));

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('Failed to resolve site');
    });

    it('should return site data for valid siteId with matching enrollment', async () => {
      const validSiteId = SITE_IDS[1];
      const targetOrgId = testOrganizations[3].getId();
      const entitlementId = 'entitlement-siteId-path';

      context.data = { siteId: validSiteId, imsOrg: testOrganizations[3].getImsOrgId() };
      context.pathInfo = { headers: { 'x-product': 'ASO' } };

      const mockEntitlement = {
        getId: () => entitlementId,
        getProductCode: () => 'ASO',
        getTier: () => 'FREE_TRIAL',
      };

      mockTierClientStub.getAllEnrollment.resolves({
        entitlement: mockEntitlement,
        enrollments: [{
          getEntitlementId: () => entitlementId,
          getId: () => 'enrollment-siteId',
          getSiteId: () => validSiteId,
        }],
      });

      mockDataAccess.Site.findById.resolves(testSites[1]);

      mockDataAccess.Organization.findById.resolves(testOrganizations[3]);

      const response = await sitesController.resolveSite(context);

      expect(mockDataAccess.Organization.findById.calledWith(targetOrgId)).to.be.true;

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('data');
      expect(body.data).to.have.property('organization');
      expect(body.data).to.have.property('site');
    });

    it('should return 404 not found when organization does not exist', async () => {
      const validSiteId = SITE_IDS[1];
      const targetOrgId = testOrganizations[3].getId();
      const entitlementId = 'entitlement-siteId-path';

      context.data = { siteId: validSiteId, organizationId: 'nonexistent-organization-id' };
      context.pathInfo = { headers: { 'x-product': 'ASO' } };

      const mockEntitlement = {
        getId: () => entitlementId,
        getProductCode: () => 'ASO',
        getTier: () => 'FREE_TRIAL',
      };

      mockTierClientStub.getAllEnrollment.resolves({
        entitlement: mockEntitlement,
        enrollments: [{
          getEntitlementId: () => entitlementId,
          getId: () => 'enrollment-siteId',
          getSiteId: () => validSiteId,
        }],
      });

      mockDataAccess.Site.findById.resolves(testSites[1]);

      mockDataAccess.Organization.findById.resolves(testOrganizations[3]);

      const response = await sitesController.resolveSite(context);

      expect(mockDataAccess.Organization.findById.calledWith(targetOrgId)).to.be.true;

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.include('No site found for the provided parameters');
    });

    it('should return 404 not found when ims org does not exist', async () => {
      const validSiteId = SITE_IDS[1];
      const entitlementId = 'entitlement-siteId-path';
      const targetOrgId = testOrganizations[3].getId();

      context.data = { siteId: validSiteId, imsOrg: 'nonexistent@AdobeOrg' };
      context.pathInfo = { headers: { 'x-product': 'ASO' } };

      const mockEntitlement = {
        getId: () => entitlementId,
        getProductCode: () => 'ASO',
        getTier: () => 'FREE_TRIAL',
      };

      mockTierClientStub.getAllEnrollment.resolves({
        entitlement: mockEntitlement,
        enrollments: [{
          getEntitlementId: () => entitlementId,
          getId: () => 'enrollment-siteId',
          getSiteId: () => validSiteId,
        }],
      });

      mockDataAccess.Site.findById.resolves(testSites[1]);

      mockDataAccess.Organization.findById.resolves(testOrganizations[3]);

      const response = await sitesController.resolveSite(context);

      expect(mockDataAccess.Organization.findById.calledWith(targetOrgId)).to.be.true;

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.include('No site found for the provided parameters');
    });

    it('should return site data for valid imsOrg with matching enrollment', async () => {
      context.data = { imsOrg: testOrganizations[2].getImsOrgId() };

      const mockEntitlement = {
        getId: () => 'entitlement-456',
        getProductCode: () => 'ASO',
        getTier: () => 'FREE_TRIAL',
      };

      const mockTierClient = {
        getFirstEnrollment: sandbox.stub().resolves({
          entitlement: mockEntitlement,
          enrollment: { getId: () => 'enrollment-2', getSiteId: () => SITE_IDS[0] },
          site: testSites[0],
        }),
      };
      TierClient.createForOrg.returns(mockTierClient);

      mockDataAccess.Organization.findByImsOrgId.resolves(testOrganizations[2]);
      mockDataAccess.Site.findById.resolves(testSites[0]);

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('data');
      expect(body.data).to.have.property('organization');
      expect(body.data).to.have.property('site');
      expect(body.data.organization.imsOrgId).to.equal('9876567890ABCDEF12345678@AdobeOrg');
    });

    it('should return 404 with aso_pre_onboard resolveStatus for PRE_ONBOARD-tier site via siteId path', async () => {
      const validSiteId = SITE_IDS[1];

      context.data = { siteId: validSiteId, imsOrg: testOrganizations[3].getImsOrgId() };
      context.pathInfo = { headers: { 'x-product': 'ASO' } };

      mockTierClientStub.getAllEnrollment.resolves({
        entitlement: {
          getId: () => 'entitlement-pre-onboard',
          getProductCode: () => 'ASO',
          getTier: () => 'PRE_ONBOARD',
        },
        enrollments: [{
          getId: () => 'enrollment-pre-onboard',
          getSiteId: () => validSiteId,
        }],
      });

      mockDataAccess.Site.findById.resolves(testSites[1]);
      mockDataAccess.Organization.findById.resolves(testOrganizations[3]);

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.include('No site found for the provided parameters');
      expect(body.resolveStatus).to.equal('aso_pre_onboard');
      expect(body.details).to.deep.include({ productCode: 'ASO' });
      expect(body.details).to.not.have.property('tier');
    });

    it('should return 404 with no_entitlement_for_product resolveStatus when product has no entitlement', async () => {
      const validSiteId = SITE_IDS[1];

      context.data = { siteId: validSiteId, imsOrg: testOrganizations[3].getImsOrgId() };
      context.pathInfo = { headers: { 'x-product': 'ASO' } };

      mockTierClientStub.getAllEnrollment.resolves({
        entitlement: null,
        enrollments: [],
      });

      mockDataAccess.Site.findById.resolves(testSites[1]);
      mockDataAccess.Organization.findById.resolves(testOrganizations[3]);

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.resolveStatus).to.equal('no_entitlement_for_product');
      expect(body.details).to.deep.include({ productCode: 'ASO' });
    });

    it('should return 404 with site_not_enrolled resolveStatus when entitlement is visible but site has no enrollment', async () => {
      const validSiteId = SITE_IDS[1];

      context.data = { siteId: validSiteId, imsOrg: testOrganizations[3].getImsOrgId() };
      context.pathInfo = { headers: { 'x-product': 'ASO' } };

      mockTierClientStub.getAllEnrollment.resolves({
        entitlement: {
          getId: () => 'entitlement-visible',
          getProductCode: () => 'ASO',
          getTier: () => 'FREE_TRIAL',
        },
        enrollments: [],
      });

      mockDataAccess.Site.findById.resolves(testSites[1]);
      mockDataAccess.Organization.findById.resolves(testOrganizations[3]);

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.resolveStatus).to.equal('site_not_enrolled');
      expect(body.details).to.deep.include({ productCode: 'ASO' });
    });

    it('should return 404 with aso_pre_onboard for PRE_ONBOARD-tier site via organizationId path for non-admin', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(false);
      context.data = { organizationId: testOrganizations[0].getId() };
      mockDataAccess.Organization.findById.resolves(testOrganizations[0]);

      mockTierClientStub.getFirstEnrollment.resolves({
        entitlement: {
          getId: () => 'entitlement-pre-onboard',
          getTier: () => 'PRE_ONBOARD',
        },
        enrollment: { getId: () => 'enrollment-pre-onboard', getSiteId: () => SITE_IDS[0] },
        site: testSites[0],
      });

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.include('No site found for the provided parameters');
      expect(body.resolveStatus).to.equal('aso_pre_onboard');
    });

    it('should return 200 for PRE_ONBOARD-tier site via organizationId path for admin', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(true);
      context.data = { organizationId: testOrganizations[0].getId() };
      mockDataAccess.Organization.findById.resolves(testOrganizations[0]);

      mockTierClientStub.getFirstEnrollment.resolves({
        entitlement: {
          getId: () => 'entitlement-pre-onboard',
          getTier: () => 'PRE_ONBOARD',
        },
        enrollment: { getId: () => 'enrollment-pre-onboard', getSiteId: () => SITE_IDS[0] },
        site: testSites[0],
      });

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('data');
      expect(body.data).to.have.property('organization');
      expect(body.data).to.have.property('site');
    });

    it('should return 404 for PRE_ONBOARD-tier site via imsOrg path for non-admin', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(false);
      context.data = { imsOrg: testOrganizations[2].getImsOrgId() };
      mockDataAccess.Organization.findByImsOrgId.resolves(testOrganizations[2]);

      const mockTierClient = {
        getFirstEnrollment: sandbox.stub().resolves({
          entitlement: {
            getId: () => 'entitlement-pre-onboard',
            getTier: () => 'PRE_ONBOARD',
          },
          enrollment: { getId: () => 'enrollment-pre-onboard', getSiteId: () => SITE_IDS[0] },
          site: testSites[0],
        }),
      };
      TierClient.createForOrg.returns(mockTierClient);

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.include('No site found for the provided parameters');
    });

    it('should return 200 for PRE_ONBOARD-tier site via imsOrg path for admin', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(true);
      context.data = { imsOrg: testOrganizations[2].getImsOrgId() };
      mockDataAccess.Organization.findByImsOrgId.resolves(testOrganizations[2]);

      const mockTierClient = {
        getFirstEnrollment: sandbox.stub().resolves({
          entitlement: {
            getId: () => 'entitlement-pre-onboard',
            getTier: () => 'PRE_ONBOARD',
          },
          enrollment: { getId: () => 'enrollment-pre-onboard', getSiteId: () => SITE_IDS[0] },
          site: testSites[0],
        }),
      };
      TierClient.createForOrg.returns(mockTierClient);

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.property('data');
      expect(body.data).to.have.property('organization');
      expect(body.data).to.have.property('site');
    });

    it('should return 404 with no_entitlement_for_product for admin when organizationId path has no entitlement', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(true);
      context.data = { organizationId: testOrganizations[0].getId() };
      mockDataAccess.Organization.findById.resolves(testOrganizations[0]);

      mockTierClientStub.getFirstEnrollment.resolves({
        entitlement: null,
        enrollment: null,
        site: null,
      });

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.include('No site found for the provided parameters');
      expect(body.resolveStatus).to.equal('no_entitlement_for_product');
    });

    it('should return 404 for admin when imsOrg path has no enrolled site', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(true);
      context.data = { imsOrg: testOrganizations[2].getImsOrgId() };
      mockDataAccess.Organization.findByImsOrgId.resolves(testOrganizations[2]);

      const mockTierClient = {
        getFirstEnrollment: sandbox.stub().resolves({
          entitlement: null,
          enrollment: null,
          site: null,
        }),
      };
      TierClient.createForOrg.returns(mockTierClient);

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.include('No site found for the provided parameters');
    });

    describe('config.defaults resolution', () => {
      it('uses config.defaults site when organizationId is provided', async () => {
        sandbox.stub(testOrganizations[0], 'getConfig').returns(makeConfigWithDefault(SITE_IDS[0]));
        context.data = { organizationId: testOrganizations[0].getId() };
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'FREE_TRIAL' },
          enrollments: [{ getId: () => 'enrollment-1' }],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(200);
        const body = await response.json();
        expect(body.data.site.id).to.equal(SITE_IDS[0]);
        expect(mockTierClientStub.getFirstEnrollment).to.not.have.been.called;
      });

      it('uses config.defaults site when imsOrg is provided', async () => {
        sandbox.stub(testOrganizations[0], 'getConfig').returns(makeConfigWithDefault(SITE_IDS[0]));
        context.data = { imsOrg: testOrganizations[0].getImsOrgId() };
        mockDataAccess.Organization.findByImsOrgId.resolves(testOrganizations[0]);
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'FREE_TRIAL' },
          enrollments: [{ getId: () => 'enrollment-1' }],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(200);
        const body = await response.json();
        expect(body.data.site.id).to.equal(SITE_IDS[0]);
        expect(mockTierClientStub.getFirstEnrollment).to.not.have.been.called;
      });

      it('falls back to first-enrolled site when config.defaults has no entry for the product', async () => {
        sandbox.stub(testOrganizations[0], 'getConfig').returns(Config({}));
        context.data = { organizationId: testOrganizations[0].getId() };
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getFirstEnrollment.resolves({
          entitlement: { getTier: () => 'FREE_TRIAL' },
          site: testSites[0],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(200);
        const body = await response.json();
        expect(body.data.site.id).to.equal(SITE_IDS[0]);
      });
    });

    describe('resolveOrgDefaultSite', () => {
      const productCode = 'abcd';
      let mockCtx;
      let org;
      let mockAccessControlUtil;

      let resolveDefault;

      beforeEach(() => {
        [org] = testOrganizations;
        mockCtx = { dataAccess: mockDataAccess, log: { warn: sandbox.stub() } };
        mockAccessControlUtil = { hasAdminAccess: sandbox.stub().returns(false) };
        sandbox.stub(org, 'getConfig').returns(makeConfigWithDefault(SITE_IDS[0]));
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'FREE_TRIAL' },
          enrollments: [{ getId: () => 'enrollment-1' }],
        });
        const args = [org, productCode, context, mockCtx, mockAccessControlUtil];
        resolveDefault = () => resolveOrgDefaultSite(...args);
      });

      it('returns null when org has no default configured for the product', async () => {
        org.getConfig.returns({ getDefaults: () => ({}) });

        const result = await resolveDefault();

        expect(result).to.be.null;
        expect(mockDataAccess.Site.findById).to.not.have.been.called;
      });

      it('returns null and warns when the configured site no longer exists', async () => {
        mockDataAccess.Site.findById.resolves(null);

        const result = await resolveDefault();

        expect(result).to.be.null;
        expect(mockCtx.log.warn).to.have.been.called;
      });

      it('returns null and warns when the configured site belongs to a different org', async () => {
        mockDataAccess.Site.findById.resolves(testSites[1]);

        const result = await resolveDefault();

        expect(result).to.be.null;
        expect(mockCtx.log.warn).to.have.been.called;
      });

      it('returns null when the configured site has no active enrollments', async () => {
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'FREE_TRIAL' },
          enrollments: [],
        });

        const result = await resolveDefault();

        expect(result).to.be.null;
      });

      it('returns null when the configured site is on a non-customer-visible tier for non-admin', async () => {
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'PRE_ONBOARD' },
          enrollments: [{ getId: () => 'enrollment-1' }],
        });

        const result = await resolveDefault();

        expect(result).to.be.null;
      });

      it('returns data when the configured site is on a non-customer-visible tier for admin', async () => {
        mockAccessControlUtil.hasAdminAccess.returns(true);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'PRE_ONBOARD' },
          enrollments: [{ getId: () => 'enrollment-1' }],
        });

        const result = await resolveDefault();

        expect(result).to.not.be.null;
      });

      it('returns null gracefully when TierClient throws', async () => {
        TierClient.createForSite.throws(new Error('tier service unavailable'));

        const result = await resolveDefault();

        expect(result).to.be.null;
        expect(mockCtx.log.warn).to.have.been.called;
      });
    });

    it('should return 404 with no_entitlement_for_product for non-existent organizationId (external caller)', async () => {
      context.data = { organizationId: '00000000-0000-0000-0000-000000000000' };
      mockDataAccess.Organization.findById.resolves(null);

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.include('No site found for the provided parameters');
      expect(body.resolveStatus).to.equal('no_entitlement_for_product');
    });

    it('should return 404 with site_not_enrolled for non-existent organizationId when caller is internal', async () => {
      const internalUuid = '9033554c-de8a-44ac-a356-09b51af8cc28';
      const internalIms = '1234567890ABCDEF12345678@AdobeOrg';
      context.env = { ...context.env, ASO_PLG_EXCLUDED_ORGS: internalUuid };
      context.data = {
        organizationId: '00000000-0000-0000-0000-000000000000',
        callerImsOrg: internalIms,
      };
      mockDataAccess.Organization.findByImsOrgId
        .withArgs(internalIms).resolves({ getId: () => internalUuid });
      mockDataAccess.Organization.findById.resolves(null);

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.resolveStatus).to.equal('site_not_enrolled');
    });

    it('should return 404 with site_not_enrolled when organizationId has visible entitlement but no enrolled site', async () => {
      context.data = { organizationId: testOrganizations[0].getId() };
      mockDataAccess.Organization.findById.resolves(testOrganizations[0]);

      mockTierClientStub.getFirstEnrollment.resolves({
        entitlement: { getId: () => 'entitlement-free-trial', getTier: () => 'FREE_TRIAL' },
        enrollment: null,
        site: null,
      });

      const response = await sitesController.resolveSite(context);

      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.include('No site found for the provided parameters');
      expect(body.resolveStatus).to.equal('site_not_enrolled');
    });

    describe('ASO_PLG_EXCLUDED_ORGS — internal/demo caller remapping (siteId path)', () => {
      // testOrganizations[0]: Spacecat UUID '9033554c-...', imsOrgId '1234567890...@AdobeOrg'
      // testSites[0] belongs to testOrganizations[0] (the internal org)
      const INTERNAL_ORG_SPACECAT_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';
      const INTERNAL_ORG_IMS_ID = '1234567890ABCDEF12345678@AdobeOrg';
      const CUSTOMER_ORG_IMS_ID = '1176567890ABCDEF12345678@AdobeOrg'; // testOrganizations[3]

      beforeEach(() => {
        context.env = { ...context.env, ASO_PLG_EXCLUDED_ORGS: INTERNAL_ORG_SPACECAT_ID };
        // Top-level callerImsOrg lookup
        mockDataAccess.Organization.findByImsOrgId.withArgs(INTERNAL_ORG_IMS_ID)
          .resolves(testOrganizations[0]);
        mockDataAccess.Organization.findByImsOrgId.withArgs(CUSTOMER_ORG_IMS_ID)
          .resolves(testOrganizations[3]);
      });

      // ────────────────────────────────────────────────────────────────────────────
      // Internal caller (callerImsOrg → org in ASO_PLG_EXCLUDED_ORGS)
      // PLG-wizard triggers are remapped to site_not_enrolled
      // ────────────────────────────────────────────────────────────────────────────

      it('internal caller, PRE_ONBOARD + not enrolled → 404 site_not_enrolled (tier check skipped, enrollment decides)', async () => {
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'PRE_ONBOARD' },
          enrollments: [],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('internal caller, PRE_ONBOARD + WAITING_FOR_IP_ALLOWLISTING → 404 no_entitlement_for_product (PLG wizard preserved)', async () => {
        context.pathInfo = { headers: { 'x-product': 'ASO' } };
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'PRE_ONBOARD' },
          enrollments: [],
        });
        mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([
          { getStatus: () => 'WAITING_FOR_IP_ALLOWLISTING' },
        ]);

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('no_entitlement_for_product');
      });

      it('internal caller, PRE_ONBOARD + enrolled → 200 (tier check skipped, site shown)', async () => {
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'PRE_ONBOARD' },
          enrollments: [{ getId: () => 'enr-1' }],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(200);
      });

      it('internal caller, no entitlement → 404 site_not_enrolled (remapped from no_entitlement_for_product)', async () => {
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({ entitlement: null, enrollments: [] });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('internal caller, no entitlement + WAITING_FOR_IP_ALLOWLISTING → 404 no_entitlement_for_product (PLG wizard preserved)', async () => {
        context.pathInfo = { headers: { 'x-product': 'ASO' } };
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({ entitlement: null, enrollments: [] });
        mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([
          { getStatus: () => 'WAITING_FOR_IP_ALLOWLISTING' },
        ]);

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('no_entitlement_for_product');
      });

      it('internal caller, non-ASO product + WAITING_FOR_IP_ALLOWLISTING → 404 site_not_enrolled (PLG check skipped)', async () => {
        context.pathInfo = { headers: { 'x-product': 'LLMO' } };
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({ entitlement: null, enrollments: [] });
        mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([
          { getStatus: () => 'WAITING_FOR_IP_ALLOWLISTING' },
        ]);

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('internal caller, no entitlement + other PlgOnboarding records (not WAITING) → 404 site_not_enrolled (remap preserved)', async () => {
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({ entitlement: null, enrollments: [] });
        mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([
          { getStatus: () => 'ONBOARDED' },
          { getStatus: () => 'INACTIVE' },
        ]);

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('internal caller, visible tier but no enrollment → 404 site_not_enrolled (unchanged)', async () => {
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'FREE_TRIAL' },
          enrollments: [],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('internal caller, visible tier + enrollment → 200 (normal success path, no remap)', async () => {
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'FREE_TRIAL' },
          enrollments: [{ getId: () => 'enr-1' }],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(200);
      });

      it('internal caller accessing CUSTOMER site (admin) with PRE_ONBOARD + not enrolled → 404 site_not_enrolled', async () => {
        // Caller-based check: bypass fires even when the site lives in a customer org.
        // PRE_ONBOARD tier check skipped for internal caller; no enrollment → site_not_enrolled.
        sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(true);
        context.data = {
          siteId: SITE_IDS[1],
          imsOrg: CUSTOMER_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[1]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[3]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'PRE_ONBOARD' },
          enrollments: [],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('internal caller accessing CUSTOMER site (admin) with PRE_ONBOARD + enrolled → 200', async () => {
        sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(true);
        context.data = {
          siteId: SITE_IDS[1],
          imsOrg: CUSTOMER_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[1]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[3]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'PRE_ONBOARD' },
          enrollments: [{ getId: () => 'enr-1' }],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(200);
      });

      // ────────────────────────────────────────────────────────────────────────────
      // Customer caller: existing resolveStatus values are preserved (NO remap)
      // ────────────────────────────────────────────────────────────────────────────

      it('customer caller, PRE_ONBOARD → 404 aso_pre_onboard (unchanged, NOT remapped)', async () => {
        context.data = {
          siteId: SITE_IDS[1],
          imsOrg: CUSTOMER_ORG_IMS_ID,
          callerImsOrg: CUSTOMER_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[1]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[3]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'PRE_ONBOARD' },
          enrollments: [],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('aso_pre_onboard');
      });

      it('customer caller, no entitlement → 404 no_entitlement_for_product (unchanged, NOT remapped)', async () => {
        context.data = {
          siteId: SITE_IDS[1],
          imsOrg: CUSTOMER_ORG_IMS_ID,
          callerImsOrg: CUSTOMER_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[1]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[3]);
        mockTierClientStub.getAllEnrollment.resolves({ entitlement: null, enrollments: [] });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('no_entitlement_for_product');
      });

      // ────────────────────────────────────────────────────────────────────────────
      // No callerImsOrg: backwards-compat — behaves exactly like before this PR
      // ────────────────────────────────────────────────────────────────────────────

      it('no callerImsOrg, PRE_ONBOARD → 404 aso_pre_onboard (no remap, original behavior)', async () => {
        context.data = { siteId: SITE_IDS[0], imsOrg: INTERNAL_ORG_IMS_ID };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'PRE_ONBOARD' },
          enrollments: [],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('aso_pre_onboard');
      });

      it('callerImsOrg points to org not found in DB → no remap (treated as not internal)', async () => {
        const unknownIms = 'unknown-ims@AdobeOrg';
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: unknownIms,
        };
        mockDataAccess.Organization.findByImsOrgId.withArgs(unknownIms).resolves(null);
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getTier: () => 'PRE_ONBOARD' },
          enrollments: [],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('aso_pre_onboard');
      });

      // ────────────────────────────────────────────────────────────────────────────
      // organizationId / imsOrg paths: no special handling (original flow preserved)
      // ────────────────────────────────────────────────────────────────────────────

      it('internal caller, organizationId path: no entitlement → 404 site_not_enrolled', async () => {
        context.data = {
          organizationId: INTERNAL_ORG_SPACECAT_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getFirstEnrollment.resolves({ entitlement: null, site: null });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('internal caller, organizationId path: no entitlement + WAITING_FOR_IP_ALLOWLISTING → 404 no_entitlement_for_product', async () => {
        context.pathInfo = { headers: { 'x-product': 'ASO' } };
        context.data = {
          organizationId: INTERNAL_ORG_SPACECAT_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getFirstEnrollment.resolves({ entitlement: null, site: null });
        mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([
          { getStatus: () => 'WAITING_FOR_IP_ALLOWLISTING' },
        ]);

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('no_entitlement_for_product');
      });

      it('internal caller, organizationId path: PRE_ONBOARD + WAITING_FOR_IP_ALLOWLISTING → 404 no_entitlement_for_product', async () => {
        context.pathInfo = { headers: { 'x-product': 'ASO' } };
        context.data = {
          organizationId: INTERNAL_ORG_SPACECAT_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getFirstEnrollment.resolves({
          entitlement: { getTier: () => 'PRE_ONBOARD' },
          site: null,
        });
        mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([
          { getStatus: () => 'WAITING_FOR_IP_ALLOWLISTING' },
        ]);

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('no_entitlement_for_product');
      });

      it('internal caller, PlgOnboarding lookup throws → 404 site_not_enrolled (fail-open)', async () => {
        context.pathInfo = { headers: { 'x-product': 'ASO' } };
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({ entitlement: null, enrollments: [] });
        mockDataAccess.PlgOnboarding.allByImsOrgId.rejects(new Error('DB error'));

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('internal caller, PlgOnboarding returns null records → 404 site_not_enrolled (null-safe)', async () => {
        context.pathInfo = { headers: { 'x-product': 'ASO' } };
        context.data = {
          siteId: SITE_IDS[0],
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({ entitlement: null, enrollments: [] });
        mockDataAccess.PlgOnboarding.allByImsOrgId.resolves(null);

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('internal caller, organizationId path: PlgOnboarding lookup throws → 404 site_not_enrolled (fail-open)', async () => {
        context.pathInfo = { headers: { 'x-product': 'ASO' } };
        context.data = {
          organizationId: INTERNAL_ORG_SPACECAT_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getFirstEnrollment.resolves({ entitlement: null, site: null });
        mockDataAccess.PlgOnboarding.allByImsOrgId.rejects(new Error('DB error'));

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('internal caller, organizationId path: PlgOnboarding returns null records → 404 site_not_enrolled (null-safe)', async () => {
        context.pathInfo = { headers: { 'x-product': 'ASO' } };
        context.data = {
          organizationId: INTERNAL_ORG_SPACECAT_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getFirstEnrollment.resolves({ entitlement: null, site: null });
        mockDataAccess.PlgOnboarding.allByImsOrgId.resolves(null);

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('internal caller, imsOrg path (no siteId): no entitlement → 404 site_not_enrolled', async () => {
        context.data = {
          imsOrg: INTERNAL_ORG_IMS_ID,
          callerImsOrg: INTERNAL_ORG_IMS_ID,
        };
        mockTierClientStub.getFirstEnrollment.resolves({ entitlement: null, site: null });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });
    });

    describe('resolveSite — ReBAC collection filter', () => {
      function fakeFacsPostgrest(rows) {
        const builder = {
          select: () => builder,
          eq: () => builder,
          is: () => builder,
          order: () => builder,
          range: () => builder,
          then: (onF, onR) => Promise.resolve({ data: rows, error: null }).then(onF, onR),
        };
        return { from: () => builder };
      }

      it('resolveByOrg: picks first viewable enrolled site (not first enrolled)', async () => {
        context.data = { organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' };
        context.dataAccess.services = {
          postgrestClient: fakeFacsPostgrest([
            // Only the SECOND site is granted can_view.
            { resource_id: SITE_IDS[1], granted_capabilities: ['aso/can_view'] },
          ]),
        };

        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockDataAccess.Site.findById.resolves(testSites[1]);

        // Two enrollments: first is SITE_IDS[0] (not viewable), second is SITE_IDS[1] (viewable).
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getId: () => 'entitlement-123', getTier: () => 'FREE_TRIAL' },
          enrollments: [
            { getId: () => 'e1', getSiteId: () => SITE_IDS[0] },
            { getId: () => 'e2', getSiteId: () => SITE_IDS[1] },
          ],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(200);
        const body = await response.json();
        expect(body.data.site.id).to.equal(SITE_IDS[1]);
      });

      it('resolveByOrg: returns 404 site_not_enrolled when no enrolled site is viewable', async () => {
        context.data = { organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' };
        context.dataAccess.services = {
          postgrestClient: fakeFacsPostgrest([]), // no can_view grants
        };

        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);

        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getId: () => 'entitlement-123', getTier: () => 'FREE_TRIAL' },
          enrollments: [{ getId: () => 'e1', getSiteId: () => SITE_IDS[0] }],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('siteId path: returns 404 site_not_enrolled when specific site is not viewable', async () => {
        const validSiteId = SITE_IDS[0];
        context.data = { siteId: validSiteId, organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' };
        context.dataAccess.services = {
          postgrestClient: fakeFacsPostgrest([]), // caller has no can_view on this site
        };

        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);

        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getId: () => 'entitlement-123', getTier: () => 'FREE_TRIAL' },
          enrollments: [{ getId: () => 'e1', getSiteId: () => validSiteId }],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('skips filter when JWT carries the federal can_view grant', async () => {
        context.data = { organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' };
        // JWT carries the federal can_view → no PostgREST query needed.
        context.attributes.authInfo = new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true, email: 'test@test.com', facs_permissions: ['aso/can_view'] })
          .withAuthenticated(true);

        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockDataAccess.Site.findById.resolves(testSites[0]);
        // No context.dataAccess.services — if code tries PostgREST it would 503.

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(200);
        const body = await response.json();
        expect(body.data.site.id).to.equal(SITE_IDS[0]);
      });

      it('resolveByOrg: returns 503 when PostgREST is unavailable', async () => {
        context.data = { organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' };
        context.dataAccess.services = {}; // no postgrestClient

        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(503);
      });

      it('resolveByOrg: returns admin-configured default site when it is viewable', async () => {
        // Stub org config to advertise SITE_IDS[0] as the per-product default site.
        const configStub = sandbox.stub(testOrganizations[0], 'getConfig')
          .returns(makeConfigWithDefault(SITE_IDS[0]));

        context.data = { organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' };
        context.dataAccess.services = {
          postgrestClient: fakeFacsPostgrest([
            { resource_id: SITE_IDS[0], granted_capabilities: ['aso/can_view'] },
          ]),
        };

        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockDataAccess.Site.findById.resolves(testSites[0]);

        const response = await sitesController.resolveSite(context);

        configStub.restore();
        expect(response.status).to.equal(200);
        const body = await response.json();
        expect(body.data.site.id).to.equal(SITE_IDS[0]);
      });

      it('resolveByOrg: returns 404 no_entitlement_for_product when org has no entitlement', async () => {
        context.data = { organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' };
        context.dataAccess.services = {
          postgrestClient: fakeFacsPostgrest([
            { resource_id: SITE_IDS[0], granted_capabilities: ['aso/can_view'] },
          ]),
        };

        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({ entitlement: null, enrollments: [] });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('no_entitlement_for_product');
      });

      it('resolveByOrg: returns 404 aso_pre_onboard for non-admin on pre-onboard tier', async () => {
        const hasAdminStub = sandbox.stub(AccessControlUtil.prototype, 'hasAdminAccess').returns(false);

        context.data = { organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' };
        context.dataAccess.services = {
          postgrestClient: fakeFacsPostgrest([
            { resource_id: SITE_IDS[0], granted_capabilities: ['aso/can_view'] },
          ]),
        };

        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getId: () => 'ent-1', getTier: () => 'PRE_ONBOARD' },
          enrollments: [{ getId: () => 'e1', getSiteId: () => SITE_IDS[0] }],
        });

        const response = await sitesController.resolveSite(context);

        hasAdminStub.restore();
        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('aso_pre_onboard');
      });

      it('resolveByOrg: admin bypasses tier check and returns first viewable site', async () => {
        // Default ctx has is_admin: true → hasAdminAccess() is true → skips aso_pre_onboard.
        context.data = { organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' };
        context.dataAccess.services = {
          postgrestClient: fakeFacsPostgrest([
            { resource_id: SITE_IDS[0], granted_capabilities: ['aso/can_view'] },
          ]),
        };

        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getId: () => 'ent-1', getTier: () => 'PRE_ONBOARD' },
          enrollments: [{ getId: () => 'e1', getSiteId: () => SITE_IDS[0] }],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(200);
        const body = await response.json();
        expect(body.data.site.id).to.equal(SITE_IDS[0]);
      });

      it('resolveByOrg: returns 404 when viewable enrollment found but Site.findById returns null', async () => {
        context.data = { organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' };
        context.dataAccess.services = {
          postgrestClient: fakeFacsPostgrest([
            { resource_id: SITE_IDS[0], granted_capabilities: ['aso/can_view'] },
          ]),
        };

        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockDataAccess.Site.findById.resolves(null); // enrollment found but site was deleted
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getId: () => 'ent-1', getTier: () => 'FREE_TRIAL' },
          enrollments: [{ getId: () => 'e1', getSiteId: () => SITE_IDS[0] }],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(404);
        const body = await response.json();
        expect(body.resolveStatus).to.equal('site_not_enrolled');
      });

      it('siteId path: returns 503 when PostgREST is unavailable', async () => {
        context.data = { siteId: SITE_IDS[0], organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'ASO', subjectId: 'user@AdobeID' };
        context.dataAccess.services = {}; // no postgrestClient

        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockTierClientStub.getAllEnrollment.resolves({
          entitlement: { getId: () => 'ent-1', getTier: () => 'FREE_TRIAL' },
          enrollments: [{ getId: () => 'e1', getSiteId: () => SITE_IDS[0] }],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(503);
      });

      it('skips the site filter under LLMO (site is not a ReBAC resource for LLMO)', async () => {
        // LLMO ReBAC-scopes `brand`, not `site` — resolveSite must not apply the
        // per-site filter. No postgrestClient: if the filter engaged it would 503.
        context.data = { organizationId: testOrganizations[0].getId() };
        context.attributes.facs = { enabled: true, product: 'LLMO', subjectId: 'user@AdobeID' };

        mockDataAccess.Organization.findById.resolves(testOrganizations[0]);
        mockDataAccess.Site.findById.resolves(testSites[0]);
        mockTierClientStub.getFirstEnrollment.resolves({
          entitlement: { getId: () => 'ent-1', getTier: () => 'FREE_TRIAL' },
          site: testSites[0],
        });

        const response = await sitesController.resolveSite(context);

        expect(response.status).to.equal(200);
        const body = await response.json();
        expect(body.data.site.id).to.equal(SITE_IDS[0]);
      });
    });
  });

  describe('getBrandProfile', () => {
    it('returns 400 when siteId is invalid', async () => {
      const response = await sitesController.getBrandProfile({ params: { siteId: 'abc' } });
      const error = await response.json();

      expect(response.status).to.equal(400);
      expect(error.message).to.equal('Site ID required');
    });

    it('returns 404 when site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const response = await sitesController.getBrandProfile({ params: { siteId: SITE_IDS[0] } });
      const error = await response.json();

      expect(response.status).to.equal(404);
      expect(error.message).to.equal('Site not found');

      mockDataAccess.Site.findById.resolves(sites[0]);
    });

    it('returns 403 when user lacks access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').resolves(false);

      const response = await sitesController.getBrandProfile({ params: { siteId: SITE_IDS[0] } });
      const error = await response.json();

      expect(response.status).to.equal(403);
      expect(error.message).to.equal('Only users belonging to the organization can view its sites');
    });

    it('returns 204 when no brand profile is stored', async () => {
      const site = sites[0];
      sandbox.stub(site, 'getConfig').returns({
        getBrandProfile: () => null,
      });

      const response = await sitesController.getBrandProfile({ params: { siteId: SITE_IDS[0] } });

      expect(response.status).to.equal(204);
    });

    it('returns the stored brand profile', async () => {
      const site = sites[0];
      const profile = { version: 2, summary: 'test profile' };
      sandbox.stub(site, 'getConfig').returns({
        getBrandProfile: () => profile,
      });

      const response = await sitesController.getBrandProfile({ params: { siteId: SITE_IDS[0] } });
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body).to.deep.equal({ brandProfile: profile });
    });
  });

  describe('triggerBrandProfile', () => {
    let controllerFactory;
    let helperStub;
    let setHasAccess;

    before(async function beforeTriggerBrandProfile() {
      this.timeout(15000);
      helperStub = sinon.stub().resolves('exec-123');
      let hasAccess = true;
      const moduleMocks = {
        [BRAND_PROFILE_TRIGGER_MODULE]: {
          triggerBrandProfileAgent: (...args) => helperStub(...args),
        },
        [ACCESS_CONTROL_MODULE]: {
          default: class MockAccessControlUtil {
            static fromContext() {
              return new MockAccessControlUtil();
            }

            // eslint-disable-next-line class-methods-use-this
            hasAdminAccess() {
              return true;
            }

            // eslint-disable-next-line class-methods-use-this
            async hasAccess() {
              return hasAccess;
            }
          },
        },
      };
      const controllerModule = await esmock('../../src/controllers/sites.js', {}, moduleMocks);
      controllerFactory = () => controllerModule.default(context, context.log, context.env);
      setHasAccess = (value) => {
        hasAccess = value;
      };
    });

    beforeEach(() => {
      helperStub.resetHistory();
      helperStub.resolves('exec-123');
      setHasAccess(true);
    });

    it('returns 400 when siteId is invalid', async () => {
      const controller = controllerFactory();
      const response = await controller.triggerBrandProfile({ params: { siteId: 'xyz' } });
      const error = await response.json();

      expect(response.status).to.equal(400);
      expect(error.message).to.equal('Site ID required');
      expect(helperStub).to.not.have.been.called;
    });

    it('returns 404 when site is not found', async () => {
      const controller = controllerFactory();
      mockDataAccess.Site.findById.resolves(null);

      const response = await controller.triggerBrandProfile({ params: { siteId: SITE_IDS[0] } });
      const error = await response.json();

      expect(response.status).to.equal(404);
      expect(error.message).to.equal('Site not found');
      expect(helperStub).to.not.have.been.called;

      mockDataAccess.Site.findById.resolves(sites[0]);
    });

    it('returns 403 when user lacks access', async () => {
      setHasAccess(false);
      const controller = controllerFactory();

      const response = await controller.triggerBrandProfile({ params: { siteId: SITE_IDS[0] } });
      const error = await response.json();

      expect(response.status).to.equal(403);
      expect(error.message).to.equal('Only users belonging to the organization can view its sites');
      expect(helperStub).to.not.have.been.called;
    });

    it('returns 202 and triggers workflow with provided idempotencyKey', async () => {
      const controller = controllerFactory();

      const response = await controller.triggerBrandProfile({
        params: { siteId: SITE_IDS[0] },
        data: { idempotencyKey: 'manual-key' },
      });
      const payload = await response.json();

      expect(response.status).to.equal(202);
      expect(payload).to.deep.equal({
        executionName: 'exec-123',
        siteId: SITE_IDS[0],
      });
      expect(helperStub).to.have.been.calledOnce;
      const args = helperStub.firstCall.args[0];
      expect(args).to.include({
        context,
        site: sites[0],
        reason: 'sites-http',
      });
    });

    it('generates an idempotency key when one is not provided', async () => {
      helperStub.resolves('exec-456');
      const controller = controllerFactory();

      const response = await controller.triggerBrandProfile({
        params: { siteId: SITE_IDS[0] },
      });

      expect(response.status).to.equal(202);
      expect(helperStub).to.have.been.calledOnce;
    });

    it('returns 500 when helper invocation fails', async () => {
      helperStub.rejects(new Error('boom'));
      const controller = controllerFactory();

      const response = await controller.triggerBrandProfile({
        params: { siteId: SITE_IDS[0] },
      });
      const error = await response.json();

      expect(response.status).to.equal(500);
      expect(error.message).to.equal('Failed to trigger brand profile agent');
    });

    it('returns 500 when helper resolves null', async () => {
      helperStub.resolves(null);
      const controller = controllerFactory();

      const response = await controller.triggerBrandProfile({
        params: { siteId: SITE_IDS[0] },
      });
      const error = await response.json();

      expect(response.status).to.equal(500);
      expect(error.message).to.equal('Failed to trigger brand profile agent');
    });

    it('throw restricted operation when user try to delete site', async () => {
      const controller = controllerFactory();
      const response = await controller.removeSite({ params: { siteId: SITE_IDS[0] } });
      const error = await response.json();

      expect(response.status).to.equal(403);
      expect(error.message).to.equal('Restricted Operation');
    });
  });
});
