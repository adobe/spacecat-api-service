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

/* eslint-env mocha */

import { KeyEvent, Site } from '@adobe/spacecat-shared-data-access';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import KeyEventSchema from '@adobe/spacecat-shared-data-access/src/models/key-event/key-event.schema.js';
import SiteSchema from '@adobe/spacecat-shared-data-access/src/models/site/site.schema.js';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { hasText } from '@adobe/spacecat-shared-utils';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';
import nock from 'nock';
import sinonChai from 'sinon-chai';
import sinon, { stub } from 'sinon';

import SitesController from '../../src/controllers/sites.js';
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

  const sites = [
    {
      siteId: SITE_IDS[0], baseURL: 'https://site1.com', deliveryType: 'aem_edge', authoringType: 'cs/crosswalk', deliveryConfig: {}, config: Config({}), hlxConfig: {}, isSandbox: false, code: null,
    },
    {
      siteId: SITE_IDS[1], baseURL: 'https://site2.com', deliveryType: 'aem_edge', authoringType: 'cs/crosswalk', config: Config({}), hlxConfig: {}, isSandbox: false, code: null,
    },
  ].map((site) => new Site(
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
      }),
    },
    SiteSchema,
    site,
    loggerStub,
  ));

  const keyEvents = [{
    keyEventId: 'k1', siteId: sites[0].getId(), name: 'some-key-event', type: KeyEvent.KEY_EVENT_TYPES.CODE, time: new Date().toISOString(),
  },
  {
    keyEventId: 'k2', siteId: sites[0].getId(), name: 'other-key-event', type: KeyEvent.KEY_EVENT_TYPES.SEO, time: new Date().toISOString(),
  },
  ].map((keyEvent) => new KeyEvent(
    {
      entities: {
        keyEvent: {
          model: {
            indexes: {},
            schema: {},
          },
        },
      },
    },
    {
      log: loggerStub,
      getCollection: stub().returns({
        schema: KeyEventSchema,
      }),
    },
    KeyEventSchema,
    keyEvent,
    loggerStub,
  ));

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
    'removeSite',
    'updateSite',
    'updateCdnLogsConfig',
    'getTopPages',
    'createKeyEvent',
    'getKeyEventsBySiteID',
    'removeKeyEvent',
    'getSiteMetricsBySource',
    'getPageMetricsBySource',
  ];

  let mockDataAccess;
  let sitesController;
  let context;

  beforeEach(() => {
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
        }),
      },
      KeyEvent: {
        allBySiteId: sandbox.stub().resolves(keyEvents),
        findById: stub().resolves(keyEvents[0]),
        create: sandbox.stub().resolves(keyEvents[0]),
      },
      Site: {
        all: sandbox.stub().resolves(sites),
        allByDeliveryType: sandbox.stub().resolves(sites),
        allWithLatestAudit: sandbox.stub().resolves(sites),
        create: sandbox.stub().resolves(sites[0]),
        findByBaseURL: sandbox.stub().resolves(sites[0]),
        findById: sandbox.stub().resolves(sites[0]),
      },
      SiteTopPage: {
        allBySiteId: sandbox.stub().resolves([]),
        allBySiteIdAndSource: sandbox.stub().resolves([]),
        allBySiteIdAndSourceAndGeo: sandbox.stub().resolves([]),
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
    sitesController = SitesController(context, loggerStub, context.env);
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
    const response = await sitesController.createSite({ data: { baseURL: 'https://site1.com' } });

    expect(mockDataAccess.Site.create).to.have.been.calledOnce;
    expect(response.status).to.equal(201);

    const site = await response.json();
    expect(site).to.have.property('id', SITE_IDS[0]);
    expect(site).to.have.property('baseURL', 'https://site1.com');
  });

  it('creates a site for a non-admin user', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const response = await sitesController.createSite({ data: { baseURL: 'https://site1.com' } });

    expect(mockDataAccess.Site.create).to.have.not.been.called;
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'Only admins can create new sites');
  });

  it('updates a site', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        organizationId: 'b2c41adf-49c9-4d03-a84f-694491368723',
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
        organizationId: 'b2c41adf-49c9-4d03-a84f-694491368723',
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

  it('removes a site', async () => {
    const site = sites[0];
    site.remove = sandbox.stub();
    const response = await sitesController.removeSite(
      { params: { siteId: SITE_IDS[0] }, ...defaultAuthAttributes },
    );

    expect(site.remove).to.have.been.calledOnce;
    expect(response.status).to.equal(204);
  });

  it('removes a site for a non-admin user ', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const site = sites[0];
    site.remove = sandbox.stub();
    const response = await sitesController.removeSite(
      { params: { siteId: SITE_IDS[0] }, ...defaultAuthAttributes },
    );

    expect(site.remove).to.have.not.been.called;
    expect(response.status).to.equal(403);
    const error = await response.json();
    expect(error).to.have.property('message', 'Only admins can remove sites');
  });

  it('returns bad request when removing a site if id not provided', async () => {
    const site = sites[0];
    site.remove = sandbox.stub();
    const response = await sitesController.removeSite({ params: {} });
    const error = await response.json();

    expect(site.remove).to.have.not.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns not found when removing a non-existing site', async () => {
    const site = sites[0];
    site.remove = sandbox.stub();
    mockDataAccess.Site.findById.resolves(null);

    const response = await sitesController.removeSite({ params: { siteId: SITE_IDS[0] } });
    const error = await response.json();

    expect(site.remove).to.have.not.been.called;
    expect(response.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('gets all sites', async () => {
    mockDataAccess.Site.all.resolves(sites);

    const result = await sitesController.getAll();
    const resultSites = await result.json();

    expect(mockDataAccess.Site.all).to.have.been.calledOnce;
    expect(resultSites).to.be.an('array').with.lengthOf(2);
    expect(resultSites[0]).to.have.property('id', SITE_IDS[0]);
    expect(resultSites[0]).to.have.property('baseURL', 'https://site1.com');
    expect(resultSites[1]).to.have.property('id', SITE_IDS[1]);
    expect(resultSites[1]).to.have.property('baseURL', 'https://site2.com');
  });

  it('gets all sites for a non-admin user', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    mockDataAccess.Site.all.resolves(sites);

    const result = await sitesController.getAll();
    const error = await result.json();

    expect(mockDataAccess.Site.all).to.have.not.been.called;
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can view all sites');
  });

  it('gets all sites by delivery type', async () => {
    mockDataAccess.Site.allByDeliveryType.resolves(sites);

    const result = await sitesController.getAllByDeliveryType({ params: { deliveryType: 'aem_edge' } });
    const resultSites = await result.json();

    expect(mockDataAccess.Site.allByDeliveryType).to.have.been.calledOnce;
    expect(resultSites).to.be.an('array').with.lengthOf(2);
    expect(resultSites[0]).to.have.property('id', SITE_IDS[0]);
    expect(resultSites[0]).to.have.property('deliveryType', 'other');
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
    });
    context.rumApiClient.query.onCall(1).resolves({
      totalCTR: 0.21,
      totalClicks: 9723,
      totalPageViews: 46944,
    });
    const storedMetrics = [{
      siteId: '123',
      source: 'ahrefs',
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
      ctrChange: -5.553712152633755,
      pageViewsChange: 6.156954020464625,
      projectedTrafficValue: 0.3078477010232313,
    });
  });

  it('gets the latest site metrics with no stored metrics', async () => {
    context.rumApiClient.query.onCall(0).resolves({
      totalCTR: 0.20,
      totalClicks: 4901,
      totalPageViews: 24173,
    });
    context.rumApiClient.query.onCall(1).resolves({
      totalCTR: 0.21,
      totalClicks: 9723,
      totalPageViews: 46944,
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
      ctrChange: -5.553712152633755,
      pageViewsChange: 6.156954020464625,
      projectedTrafficValue: 0,
    });
  });

  it('logs error and returns zeroed metrics when rum query fails', async () => {
    const rumApiClient = {
      query: sandbox.stub().rejects(new Error('RUM query failed')),
    };

    const result = await sitesController.getLatestSiteMetrics(
      { ...context, params: { siteId: SITE_IDS[0] }, rumApiClient },
    );
    const metrics = await result.json();

    expect(context.log.error).to.have.been.calledWithMatch('Error getting RUM metrics for site 0b4dcf79-fe5f-410b-b11f-641f0bf56da3: RUM query failed');
    expect(metrics).to.deep.equal({
      ctrChange: 0,
      pageViewsChange: 0,
      projectedTrafficValue: 0,
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

  it('create key event returns created key event', async () => {
    const siteId = sites[0].getId();
    const keyEvent = keyEvents[0];

    mockDataAccess.KeyEvent.create.withArgs({
      siteId, name: keyEvent.getName(), type: keyEvent.getType(), time: keyEvent.getTime(),
    }).resolves(keyEvent);

    const resp = await (await sitesController.createKeyEvent({
      params: { siteId },
      data: { name: keyEvent.getName(), type: keyEvent.getType(), time: keyEvent.getTime() },
    })).json();

    expect(mockDataAccess.KeyEvent.create).to.have.been.calledOnce;
    expect(hasText(resp.id)).to.be.true;
    expect(resp.name).to.equal(keyEvent.getName());
    expect(resp.type).to.equal(keyEvent.getType());
    expect(resp.time).to.equal(keyEvent.getTime());
  });

  it('create key event returns not found when site does not exist', async () => {
    const siteId = 'site-id';
    const keyEvent = keyEvents[0];

    mockDataAccess.Site.findById.resolves(null);

    const result = await sitesController.createKeyEvent({
      params: { siteId },
      data: { name: keyEvent.getName(), type: keyEvent.getType(), time: keyEvent.getTime() },
    });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('create key event returns forbidden when site does not exist', async () => {
    const siteId = 'site-id';
    const keyEvent = keyEvents[0];
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const result = await sitesController.createKeyEvent({
      params: { siteId },
      data: { name: keyEvent.getName(), type: keyEvent.getType(), time: keyEvent.getTime() },
    });
    const error = await result.json();

    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can create key events');
  });

  it('get key events returns list of key events', async () => {
    const site = sites[0];
    site.getKeyEvents = sandbox.stub().resolves(keyEvents);
    const siteId = sites[0].getId();

    mockDataAccess.KeyEvent.allBySiteId.withArgs(siteId).resolves(keyEvents);

    const resp = await (await sitesController.getKeyEventsBySiteID({
      params: { siteId },
    })).json();

    expect(site.getKeyEvents).to.have.been.calledOnce;
    expect(resp.length).to.equal(keyEvents.length);
  });

  it('get key events returns list of key events for non belonging to the organization', async () => {
    const site = sites[0];
    site.getKeyEvents = sandbox.stub().resolves(keyEvents);
    const siteId = sites[0].getId();
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);

    const result = await sitesController.getKeyEventsBySiteID({
      params: { siteId },
    });
    const error = await result.json();

    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can view its key events');
  });

  it('get key events returns bad request when siteId is missing', async () => {
    const result = await sitesController.getKeyEventsBySiteID({
      params: {},
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('get key events returns not found when site is not found', async () => {
    const siteId = sites[0].getId();
    mockDataAccess.Site.findById.resolves(null);

    const result = await sitesController.getKeyEventsBySiteID({
      params: { siteId },
    });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('remove key events endpoint call', async () => {
    const keyEvent = keyEvents[0];
    keyEvent.remove = sinon.stub().resolves();
    const keyEventId = keyEvent.getId();

    await sitesController.removeKeyEvent({
      params: { keyEventId },
    });

    expect(keyEvent.remove).to.have.been.calledOnce;
  });

  it('remove key events endpoint call for a non-admin user', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const keyEvent = keyEvents[0];
    keyEvent.remove = sinon.stub().resolves();
    const keyEventId = keyEvent.getId();
    const result = await sitesController.removeKeyEvent({
      params: { keyEventId },
    });
    const error = await result.json();

    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can remove key events');
  });

  it('remove key events returns bad request when keyEventId is missing', async () => {
    const result = await sitesController.removeKeyEvent({
      params: {},
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Key Event ID required');
  });

  it('remove key events returns not found when key event is not found', async () => {
    const keyEventId = 'key-event-id';
    mockDataAccess.KeyEvent.findById.resolves(null);

    const result = await sitesController.removeKeyEvent({
      params: { keyEventId },
    });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Key Event not found');
  });

  it('get site metrics by source returns list of metrics', async () => {
    const siteId = sites[0].getId();
    const source = 'ahrefs';
    const metric = 'organic-traffic';
    const storedMetrics = [{
      siteId: '123',
      source: 'ahrefs',
      time: '2023-03-12T00:00:00Z',
      metric: 'organic-traffic',
      value: 100,
    }, {
      siteId: '123',
      source: 'ahrefs',
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

    const resp = await (await sitesControllerMock.default(context).getSiteMetricsBySource({
      params: { siteId, source, metric },
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

    expect(resp).to.deep.equal(storedMetrics);
  });

  it('get site metrics by sources returns bad request when siteId is missing', async () => {
    const source = 'ahrefs';
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
    const source = 'ahrefs';

    const result = await sitesController.getSiteMetricsBySource({
      params: { siteId, source },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'metric required');
  });

  it('get site metrics by source returns not found when site is not found', async () => {
    const siteId = sites[0].getId();
    const source = 'ahrefs';
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
    const source = 'ahrefs';
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

  it('get page metrics by source returns list of metrics', async () => {
    const siteId = sites[0].getId();
    const source = 'ahrefs';
    const metric = 'organic-traffic';
    const base64PageUrl = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9mb28vYmFy';

    const storedMetrics = [{
      siteId: '123',
      source: 'ahrefs',
      time: '2023-03-12T00:00:00Z',
      metric: 'organic-traffic',
      value: 100,
      url: 'https://example.com/foo/bar',
    },
    {
      siteId: '123',
      source: 'ahrefs',
      time: '2023-03-13T00:00:00Z',
      metric: 'organic-traffic',
      value: 400,
      url: 'https://example.com/foo/baz',
    },
    {
      siteId: '123',
      source: 'ahrefs',
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
    const source = 'ahrefs';
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
    const source = 'ahrefs';
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
    const source = 'ahrefs';
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
    const source = 'ahrefs';
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
    const source = 'ahrefs';
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

  describe('isPrimaryLocale, language, and region updates', () => {
    it('updates site with projectId', async () => {
      const site = sites[0];
      const currentProjectId = '550e8400-e29b-41d4-a716-446655440000';
      const newProjectId = '650e8400-e29b-41d4-a716-446655440000';
      site.getProjectId = sandbox.stub().returns(currentProjectId);
      site.setProjectId = sandbox.stub();
      site.save = sandbox.stub().resolves(site);

      const response = await sitesController.updateSite({
        params: { siteId: SITE_IDS[0] },
        data: { projectId: newProjectId },
        ...defaultAuthAttributes,
      });

      expect(site.setProjectId).to.have.been.calledWith(newProjectId);
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
          source: 'ahrefs',
        },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.be.an('array');
      expect(mockDataAccess.SiteTopPage.allBySiteIdAndSource).to.have.been.calledWith(SITE_IDS[0], 'ahrefs');
    });

    it('retrieves top pages by source and geo for a site', async () => {
      const result = await sitesController.getTopPages({
        params: {
          siteId: SITE_IDS[0],
          source: 'ahrefs',
          geo: 'US',
        },
      });
      const response = await result.json();
      expect(result.status).to.equal(200);
      expect(response).to.be.an('array');
      expect(mockDataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo).to.have.been.calledWith(SITE_IDS[0], 'ahrefs', 'US');
    });
  });
});
