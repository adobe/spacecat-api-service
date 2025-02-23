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
import { hasText } from '@adobe/spacecat-shared-utils';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';
import nock from 'nock';
import sinonChai from 'sinon-chai';
import sinon, { stub } from 'sinon';

import SitesController from '../../src/controllers/sites.js';

use(chaiAsPromised);
use(sinonChai);

describe('Sites Controller', () => {
  const sandbox = sinon.createSandbox();

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
  };

  const SITE_IDS = ['0b4dcf79-fe5f-410b-b11f-641f0bf56da3', 'c4420c67-b4e8-443d-b7ab-0099cfd5da20'];

  const sites = [
    {
      siteId: SITE_IDS[0], baseURL: 'https://site1.com', deliveryType: 'aem_edge', deliveryConfig: {}, config: Config({}), hlxConfig: {},
    },
    {
      siteId: SITE_IDS[1], baseURL: 'https://site2.com', deliveryType: 'aem_edge', config: Config({}), hlxConfig: {},
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
                gitHubURL: { type: 'string', name: 'gitHubURL', get: (value) => value },
                isLive: { type: 'boolean', name: 'isLive', get: (value) => value },
                organizationId: { type: 'string', name: 'organizationId', get: (value) => value },
                hlxConfig: { type: 'any', name: 'hlxConfig', get: (value) => value },
                deliveryConfig: { type: 'any', name: 'deliveryConfig', get: (value) => value },
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
    };
    nock('https://secretsmanager.us-east-1.amazonaws.com/')
      .post('/', (body) => body.SecretId === '/helix-deploy/spacecat-services/customer-secrets/site1_com/ci')
      .reply(200, {
        SecretString: JSON.stringify({
          RUM_DOMAIN_KEY: '42',
        }),
      });
    sitesController = SitesController(mockDataAccess, loggerStub, context.env);
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

  it('throws an error if data access is not an object', () => {
    expect(() => SitesController()).to.throw('Data access required');
  });

  it('creates a site', async () => {
    const response = await sitesController.createSite({ data: { baseURL: 'https://site1.com' } });

    expect(mockDataAccess.Site.create).to.have.been.calledOnce;
    expect(response.status).to.equal(201);

    const site = await response.json();
    expect(site).to.have.property('id', SITE_IDS[0]);
    expect(site).to.have.property('baseURL', 'https://site1.com');
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

  it('returns bad request when updating a site if id not provided', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({ params: {} });
    const error = await response.json();

    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns not found when updating a non-existing site', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    mockDataAccess.Site.findById.resolves(null);

    const response = await sitesController.updateSite({ params: { siteId: SITE_IDS[0] } });
    const error = await response.json();

    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('returns bad request when updating a site without payload', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({ params: { siteId: SITE_IDS[0] } });
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
    });
    const error = await response.json();

    expect(site.save).to.have.not.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('removes a site', async () => {
    const site = sites[0];
    site.remove = sandbox.stub();
    const response = await sitesController.removeSite({ params: { siteId: SITE_IDS[0] } });

    expect(site.remove).to.have.been.calledOnce;
    expect(response.status).to.equal(204);
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

  it('gets all sites by delivery type', async () => {
    mockDataAccess.Site.allByDeliveryType.resolves(sites);

    const result = await sitesController.getAllByDeliveryType({ params: { deliveryType: 'aem_edge' } });
    const resultSites = await result.json();

    expect(mockDataAccess.Site.allByDeliveryType).to.have.been.calledOnce;
    expect(resultSites).to.be.an('array').with.lengthOf(2);
    expect(resultSites[0]).to.have.property('id', SITE_IDS[0]);
    expect(resultSites[0]).to.have.property('deliveryType', 'other');
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

  it('gets all sites as XLS', async () => {
    const result = await sitesController.getAllAsXLS();

    // expect(mockDataAccess.getSites.calledOnce).to.be.true;
    expect(result).to.not.be.null;
  });

  it('gets a site by ID', async () => {
    const result = await sitesController.getByID({ params: { siteId: SITE_IDS[0] } });
    const site = await result.json();

    expect(mockDataAccess.Site.findById).to.have.been.calledOnce;

    expect(site).to.be.an('object');
    expect(site).to.have.property('id', SITE_IDS[0]);
    expect(site).to.have.property('baseURL', 'https://site1.com');
  });

  it('gets a site by base URL', async () => {
    const result = await sitesController.getByBaseURL({ params: { baseURL: 'aHR0cHM6Ly9zaXRlMS5jb20K' } });
    const site = await result.json();

    expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledOnceWith('https://site1.com');

    expect(site).to.be.an('object');
    expect(site).to.have.property('id', SITE_IDS[0]);
    expect(site).to.have.property('baseURL', 'https://site1.com');
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
        .default(mockDataAccess, context.log)
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
        .default(mockDataAccess, context.log)
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

    const resp = await (await sitesControllerMock.default(mockDataAccess).getSiteMetricsBySource({
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

    const resp = await (await sitesControllerMock.default(mockDataAccess).getPageMetricsBySource({
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
      params: { siteId, metric, source },
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

  it('updates a site name', async () => {
    const site = sites[0];
    site.save = sandbox.spy(site.save);
    const response = await sitesController.updateSite({
      params: { siteId: SITE_IDS[0] },
      data: {
        name: 'new-name',
      },
    });

    expect(site.save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);

    const updatedSite = await response.json();
    expect(updatedSite).to.have.property('id', SITE_IDS[0]);
    expect(updatedSite).to.have.property('name', 'new-name');
  });
});
