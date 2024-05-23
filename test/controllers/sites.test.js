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

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import esmock from 'esmock';

import { createKeyEvent, KEY_EVENT_TYPES } from '@adobe/spacecat-shared-data-access/src/models/key-event.js';
import { hasText } from '@adobe/spacecat-shared-utils';
import SitesController from '../../src/controllers/sites.js';
import { SiteDto } from '../../src/dto/site.js';

chai.use(chaiAsPromised);

const { expect } = chai;

describe('Sites Controller', () => {
  const sandbox = sinon.createSandbox();
  const sites = [
    { id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge' },
    { id: 'site2', baseURL: 'https://site2.com', deliveryType: 'aem_edge' },
  ].map((site) => SiteDto.fromJson(site));

  const keyEvents = [
    createKeyEvent({
      siteId: sites[0].getId(), name: 'some-key-event', type: KEY_EVENT_TYPES.CODE, time: new Date().toISOString(),
    }),
    createKeyEvent({
      siteId: sites[0].getId(), name: 'other-key-event', type: KEY_EVENT_TYPES.SEO, time: new Date().toISOString(),
    }),
  ];

  const sitesWithLatestAudits = [
    {
      id: 'site1',
      baseURL: 'https://site1.com',
      deliveryType: 'aem_edge',
      audits: [{
        siteId: 'site1',
        auditType: 'lhs-mobile',
        auditedAt: '2021-01-01T00:00:00.000Z',
        fullAuditRef: 'https://site1.com/lighthouse/20210101T000000.000Z/lhs-mobile.json',
        auditResult: {
          scores: {
            performance: 0.5,
            accessibility: 0.5,
            'best-practices': 0.5,
            seo: 0.5,
          },
        },
      }],
    },
    {
      id: 'site2',
      baseURL: 'https://site2.com',
      deliveryType: 'aem_edge',
      audits: [{
        siteId: 'site2',
        auditType: 'lhs-mobile',
        auditedAt: '2021-01-01T00:00:00.000Z',
        fullAuditRef: 'https://site2.com/lighthouse/20210101T000000.000Z/lhs-mobile.json',
        auditResult: {
          scores: {
            performance: 0.4,
            accessibility: 0.4,
            'best-practices': 0.4,
            seo: 0.4,
          },
        },
      }],
    },
    { id: 'site3', baseURL: 'https://site3.com', audits: [] },
  ].map((site) => SiteDto.fromJson(site));

  const siteFunctions = [
    'createSite',
    'getAll',
    'getAllByDeliveryType',
    'getAllWithLatestAudit',
    'bulkUpdateSitesConfig',
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
  ];

  let mockDataAccess;
  let sitesController;

  beforeEach(() => {
    mockDataAccess = {
      addSite: sandbox.stub().resolves(sites[0]),
      updateSite: sandbox.stub().resolves(sites[0]),
      removeSite: sandbox.stub().resolves(),
      getSites: sandbox.stub().resolves(sites),
      getSitesByDeliveryType: sandbox.stub().resolves(sites),
      getSitesWithLatestAudit: sandbox.stub().resolves(sitesWithLatestAudits),
      getSiteByBaseURL: sandbox.stub().resolves(sites[0]),
      getSiteByID: sandbox.stub().resolves(sites[0]),
      getAuditForSite: sandbox.stub().resolves(sitesWithLatestAudits[0].getAudits()[0]),
      createKeyEvent: sandbox.stub(),
      getKeyEventsForSite: sandbox.stub(),
      removeKeyEvent: sandbox.stub(),
    };

    sitesController = SitesController(mockDataAccess);
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

    expect(mockDataAccess.addSite.calledOnce).to.be.true;
    expect(response.status).to.equal(201);

    const site = await response.json();
    expect(site).to.have.property('id', 'site1');
    expect(site).to.have.property('baseURL', 'https://site1.com');
  });

  it('updates a site', async () => {
    const response = await sitesController.updateSite({
      params: { siteId: 'site1' },
      data: {
        organizationId: 'abcd124',
        isLive: false,
        deliveryType: 'other',
        gitHubURL: 'https://github.com/blah/bluh',
        config: {},
      },
    });

    expect(mockDataAccess.updateSite.calledOnce).to.be.true;
    expect(response.status).to.equal(200);

    const site = await response.json();
    expect(site).to.have.property('id', 'site1');
    expect(site).to.have.property('baseURL', 'https://site1.com');
    expect(site).to.have.property('deliveryType', 'other');
    expect(site).to.have.property('gitHubURL', 'https://github.com/blah/bluh');
  });

  it('returns bad request when updating a site if id not provided', async () => {
    const response = await sitesController.updateSite({ params: {} });
    const error = await response.json();

    expect(mockDataAccess.removeSite.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('returns not found when updating a non-existing site', async () => {
    mockDataAccess.getSiteByID.resolves(null);

    const response = await sitesController.updateSite({ params: { siteId: 'site1' } });
    const error = await response.json();

    expect(mockDataAccess.removeSite.calledOnce).to.be.false;
    expect(response.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('returns bad request when updating a site without payload', async () => {
    const response = await sitesController.updateSite({ params: { siteId: 'site1' } });
    const error = await response.json();

    expect(mockDataAccess.removeSite.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Request body required');
  });

  it('returns bad request when updating a site without modifications', async () => {
    const response = await sitesController.updateSite({ params: { siteId: 'site1' }, data: {} });
    const error = await response.json();

    expect(mockDataAccess.removeSite.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('removes a site', async () => {
    const response = await sitesController.removeSite({ params: { siteId: 'site1' } });

    expect(mockDataAccess.removeSite.calledOnce).to.be.true;
    expect(response.status).to.equal(204);
  });

  it('returns bad request when removing a site if id not provided', async () => {
    const response = await sitesController.removeSite({ params: {} });
    const error = await response.json();

    expect(mockDataAccess.removeSite.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Site ID required');
  });

  it('gets all sites', async () => {
    mockDataAccess.getSites.resolves(sites);

    const result = await sitesController.getAll();
    const resultSites = await result.json();

    expect(mockDataAccess.getSites.calledOnce).to.be.true;
    expect(resultSites).to.be.an('array').with.lengthOf(2);
    expect(resultSites[0]).to.have.property('id', 'site1');
    expect(resultSites[0]).to.have.property('baseURL', 'https://site1.com');
    expect(resultSites[1]).to.have.property('id', 'site2');
    expect(resultSites[1]).to.have.property('baseURL', 'https://site2.com');
  });

  it('gets all sites by delivery type', async () => {
    mockDataAccess.getSites.resolves(sites);

    const result = await sitesController.getAllByDeliveryType({ params: { deliveryType: 'aem_edge' } });
    const resultSites = await result.json();

    expect(mockDataAccess.getSitesByDeliveryType.calledOnce).to.be.true;
    expect(resultSites).to.be.an('array').with.lengthOf(2);
    expect(resultSites[0]).to.have.property('id', 'site1');
    expect(resultSites[0]).to.have.property('deliveryType', 'other');
  });

  it('gets all sites with latest audit', async () => {
    const result = await sitesController.getAllWithLatestAudit({ params: { auditType: 'lhs-mobile' } });
    const resultSites = await result.json();

    expect(mockDataAccess.getSitesWithLatestAudit.calledOnce).to.be.true;
    expect(mockDataAccess.getSitesWithLatestAudit.firstCall.args[0]).to.equal('lhs-mobile');
    expect(mockDataAccess.getSitesWithLatestAudit.firstCall.args[1]).to.equal(true);
    expect(resultSites).to.be.an('array').with.lengthOf(3);
    expect(resultSites[0]).to.have.property('id', 'site1');
    expect(resultSites[0]).to.have.property('baseURL', 'https://site1.com');
    expect(resultSites[0]).to.have.property('audits').with.lengthOf(1);
    expect(resultSites[1]).to.have.property('id', 'site2');
    expect(resultSites[1]).to.have.property('baseURL', 'https://site2.com');
  });

  it('gets all sites with latest audit with ascending true', async () => {
    await sitesController.getAllWithLatestAudit({ params: { auditType: 'lhs-mobile', ascending: 'true' } });

    expect(mockDataAccess.getSitesWithLatestAudit.calledOnce).to.be.true;
    expect(mockDataAccess.getSitesWithLatestAudit.firstCall.args[0]).to.equal('lhs-mobile');
    expect(mockDataAccess.getSitesWithLatestAudit.firstCall.args[1]).to.equal(true);
  });

  it('gets all sites with latest audit with ascending false', async () => {
    await sitesController.getAllWithLatestAudit({ params: { auditType: 'lhs-mobile', ascending: 'false' } });

    expect(mockDataAccess.getSitesWithLatestAudit.calledOnce).to.be.true;
    expect(mockDataAccess.getSitesWithLatestAudit.firstCall.args[0]).to.equal('lhs-mobile');
    expect(mockDataAccess.getSitesWithLatestAudit.firstCall.args[1]).to.equal(false);
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
    const result = await sitesController.getByID({ params: { siteId: 'site1' } });
    const site = await result.json();

    expect(mockDataAccess.getSiteByID.calledOnce).to.be.true;

    expect(site).to.be.an('object');
    expect(site).to.have.property('id', 'site1');
    expect(site).to.have.property('baseURL', 'https://site1.com');
  });

  it('gets a site by base URL', async () => {
    const result = await sitesController.getByBaseURL({ params: { baseURL: 'aHR0cHM6Ly9zaXRlMS5jb20K' } });
    const site = await result.json();

    expect(mockDataAccess.getSiteByBaseURL.calledOnceWith('https://site1.com')).to.be.true;

    expect(site).to.be.an('object');
    expect(site).to.have.property('id', 'site1');
    expect(site).to.have.property('baseURL', 'https://site1.com');
  });

  it('gets specific audit for a site', async () => {
    const result = await sitesController.getAuditForSite({
      params: {
        siteId: 'site1',
        auditType: 'lhs-mobile',
        auditedAt: '2021-01-01T00:00:00.000Z',
      },
    });
    const audit = await result.json();

    expect(mockDataAccess.getAuditForSite.calledOnce).to.be.true;

    expect(audit).to.be.an('object');
    expect(audit).to.have.property('siteId', 'site1');
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
        siteId: 'site1',
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
        siteId: 'site1',
        auditType: 'lhs-mobile',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Audited at required');
  });

  it('returns not found if audit for site is not found', async () => {
    mockDataAccess.getAuditForSite.resolves(null);

    const result = await sitesController.getAuditForSite({
      params: {
        siteId: 'site1',
        auditType: 'lhs-mobile',
        auditedAt: '2021-01-01T00:00:00.000Z',
      },
    });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Audit not found');
  });

  it('returns not found when site is not found by id', async () => {
    mockDataAccess.getSiteByID.resolves(null);

    const result = await sitesController.getByID({ params: { siteId: 'site1' } });
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
    mockDataAccess.getSiteByBaseURL.resolves(null);

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

  it('updates audit configurations for a site', async () => {
    const siteId = 'site1';
    const auditConfigUpdate = {
      auditsDisabled: true,
      auditTypeConfigs: {
        type1: { disabled: true },
        type2: { disabled: false },
      },
    };

    const response = await sitesController.updateSite({
      params: { siteId },
      data: { auditConfig: auditConfigUpdate },
    });

    expect(mockDataAccess.updateSite.calledOnce).to.be.true;
    expect(response.status).to.equal(200);

    const updatedSite = await response.json();
    expect(updatedSite.auditConfig.auditsDisabled).to.be.true;
    expect(updatedSite.auditConfig.auditTypeConfigs.type1.disabled).to.be.true;
    expect(updatedSite.auditConfig.auditTypeConfigs.type2.disabled).to.be.false;
  });

  it('create key event returns created key event', async () => {
    const siteId = sites[0].getId();
    const keyEvent = keyEvents[0];

    mockDataAccess.createKeyEvent.withArgs({
      siteId, name: keyEvent.getName(), type: keyEvent.getType(), time: keyEvent.getTime(),
    }).resolves(keyEvent);

    const resp = await (await sitesController.createKeyEvent({
      params: { siteId },
      data: { name: keyEvent.getName(), type: keyEvent.getType(), time: keyEvent.getTime() },
    })).json();

    expect(mockDataAccess.createKeyEvent.calledOnce).to.be.true;
    expect(hasText(resp.id)).to.be.true;
    expect(resp.name).to.equal(keyEvent.getName());
    expect(resp.type).to.equal(keyEvent.getType());
    expect(resp.time).to.equal(keyEvent.getTime());
  });

  it('get key events returns list of key events', async () => {
    const siteId = sites[0].getId();

    mockDataAccess.getKeyEventsForSite.withArgs(siteId).resolves(keyEvents);

    const resp = await (await sitesController.getKeyEventsBySiteID({
      params: { siteId },
    })).json();

    expect(mockDataAccess.getKeyEventsForSite.calledOnce).to.be.true;
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
    mockDataAccess.getSiteByID.resolves(null);

    const result = await sitesController.getKeyEventsBySiteID({
      params: { siteId },
    });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });

  it('remove key events endpoint call', async () => {
    const keyEventId = keyEvents[0].getId();

    await sitesController.removeKeyEvent({
      params: { keyEventId },
    });

    expect(mockDataAccess.removeKeyEvent.calledOnce).to.be.true;
    expect(mockDataAccess.removeKeyEvent.calledWith(keyEventId)).to.be.true;
  });

  it('remove key events returns bad request when keyEventId is missing', async () => {
    const result = await sitesController.removeKeyEvent({
      params: {},
    });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Key Event ID required');
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
      '../../src/support/metrics-store.js': {
        getStoredMetrics,
      },
    });

    const resp = await (await sitesControllerMock.default(mockDataAccess).getSiteMetricsBySource({
      params: { siteId, source, metric },
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
    mockDataAccess.getSiteByID.resolves(null);

    const result = await sitesController.getSiteMetricsBySource({
      params: { siteId, source, metric },
    });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Site not found');
  });
  describe('bulkUpdateSitesConfig', () => {
    it('updates multiple sites and returns their responses', async () => {
      const baseURLs = ['https://site1.com', 'https://site2.com'];
      const enableAudits = true;
      const auditTypes = ['type1', 'type2'];

      const site1 = SiteDto.fromJson({ id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge' });
      const site2 = SiteDto.fromJson({ id: 'site2', baseURL: 'https://site2.com', deliveryType: 'aem_edge' });

      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(site1);
      mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(site2);

      const response = await sitesController.bulkUpdateSitesConfig({
        data: { baseURLs, enableAudits, auditTypes },
      });

      expect(mockDataAccess.getSiteByBaseURL.calledTwice).to.be.true;
      expect(mockDataAccess.updateSite.calledTwice).to.be.true;
      expect(response.status).to.equal(207);
      const multiResponse = await response.json();
      expect(multiResponse).to.be.an('array').with.lengthOf(2);
      expect(multiResponse[0].baseURL).to.equal('https://site1.com');
      expect(multiResponse[0].response.status).to.equal(200);
      expect(multiResponse[1].baseURL).to.equal('https://site2.com');
      expect(multiResponse[1].response.status).to.equal(200);
    });

    it('returns bad request when baseURLs is not provided', async () => {
      const response = await sitesController.bulkUpdateSitesConfig({ data: {} });
      const error = await response.json();

      expect(response.status).to.equal(400);
      expect(error).to.have.property('message', 'Base URLs are required');
    });

    it('returns bad request when auditTypes is not provided', async () => {
      const response = await sitesController.bulkUpdateSitesConfig({ data: { baseURLs: ['https://site1.com'] } });
      const error = await response.json();

      expect(response.status).to.equal(400);
      expect(error).to.have.property('message', 'Audit types are required');
    });

    it('returns bad request when enableAudits is not provided', async () => {
      const response = await sitesController.bulkUpdateSitesConfig({ data: { baseURLs: ['https://site1.com'], auditTypes: ['type1'] } });
      const error = await response.json();

      expect(response.status).to.equal(400);
      expect(error).to.have.property('message', 'enableAudits is required');
    });

    it('returns not found when site is not found', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(null);

      const response = await sitesController.bulkUpdateSitesConfig({
        data: { baseURLs: ['https://site1.com'], enableAudits: true, auditTypes: ['type1'] },
      });
      const responses = await response.json();

      expect(responses).to.be.an('array').with.lengthOf(1);
      expect(responses[0].baseURL).to.equal('https://site1.com');
      expect(responses[0].response.status).to.equal(404);
      expect(responses[0].response.message).to.equal('Site with baseURL: https://site1.com not found');
    });
  });
});
