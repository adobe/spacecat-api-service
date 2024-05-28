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

import { expect } from 'chai';
import sinon from 'sinon';

import getRouteHandlers from '../../src/routes/index.js';

describe('getRouteHandlers', () => {
  const mockAuditsController = {
    getAllForSite: sinon.stub(),
    getAllLatest: sinon.stub(),
    getAllLatestForSite: sinon.stub(),
    getLatestForSite: sinon.stub(),
  };

  const mockConfigurationController = {
    getAll: sinon.stub(),
    getByVersion: sinon.stub(),
    getLatest: sinon.stub(),
    updateConfiguration: sinon.stub(),
  };

  const mockHooksController = {
  };

  const mockSitesController = {
    getAll: sinon.stub(),
    getAllByDeliveryType: sinon.stub(),
    getAllAsCsv: sinon.stub(),
    getAllAsExcel: sinon.stub(),
    getAllWithLatestAudit: sinon.stub(),
    getByID: sinon.stub(),
    getByBaseURL: sinon.stub(),
  };

  const mockOrganizationsController = {
    getAll: sinon.stub(),
    getByID: sinon.stub(),
    getSitesForOrganization: sinon.stub(),
    getByImsOrgID: sinon.stub(),
    getSlackConfigByImsOrgID: sinon.stub(),
  };

  const mockSlackController = {
    handleEvent: sinon.stub(),
  };

  const mockTrigger = sinon.stub();

  const mockFulfillmentController = {
    processFulfillmentEvents: sinon.stub(),
  };

  const mockImportController = {
    createImportJob: sinon.stub(),
    getImportJobStatus: sinon.stub(),
    getImportJobResult: sinon.stub(),
  };

  it('segregates static and dynamic routes', () => {
    const { staticRoutes, dynamicRoutes } = getRouteHandlers(
      mockAuditsController,
      mockConfigurationController,
      mockHooksController,
      mockOrganizationsController,
      mockSitesController,
      mockSlackController,
      mockTrigger,
      mockFulfillmentController,
      mockImportController,
    );

    expect(staticRoutes).to.have.all.keys(
      'GET /configurations',
      'GET /configurations/latest',
      'PUT /configurations/latest',
      'GET /organizations',
      'POST /organizations',
      'GET /sites',
      'POST /sites',
      'GET /sites.csv',
      'GET /sites.xlsx',
      'GET /slack/events',
      'POST /slack/events',
      'GET /trigger',
      'POST /event/fulfillment',
      'POST /slack/channels/invite-by-user-id',
      'POST /tools/import',
    );

    expect(staticRoutes['GET /configurations']).to.equal(mockConfigurationController.getAll);
    expect(staticRoutes['GET /configurations/latest']).to.equal(mockConfigurationController.getLatest);
    expect(staticRoutes['PUT /configurations/latest']).to.equal(mockConfigurationController.updateConfiguration);
    expect(staticRoutes['GET /organizations']).to.equal(mockOrganizationsController.getAll);
    expect(staticRoutes['POST /organizations']).to.equal(mockOrganizationsController.createOrganization);
    expect(staticRoutes['GET /sites']).to.equal(mockSitesController.getAll);
    expect(staticRoutes['POST /sites']).to.equal(mockSitesController.createSite);
    expect(staticRoutes['GET /sites.csv']).to.equal(mockSitesController.getAllAsCsv);
    expect(staticRoutes['GET /sites.xlsx']).to.equal(mockSitesController.getAllAsExcel);
    expect(staticRoutes['GET /trigger']).to.equal(mockTrigger);

    expect(dynamicRoutes).to.have.all.keys(
      'GET /audits/latest/:auditType',
      'GET /configurations/:version',
      'POST /hooks/site-detection/cdn/:hookSecret',
      'POST /hooks/site-detection/rum/:hookSecret',
      'GET /organizations/:organizationId',
      'GET /organizations/:organizationId/sites',
      'GET /organizations/by-ims-org-id/:imsOrgId',
      'GET /organizations/by-ims-org-id/:imsOrgId/slack-config',
      'PATCH /organizations/:organizationId',
      'DELETE /organizations/:organizationId',
      'GET /sites/:siteId',
      'PATCH /sites/:siteId',
      'DELETE /sites/:siteId',
      'GET /sites/by-delivery-type/:deliveryType',
      'GET /sites/by-base-url/:baseURL',
      'GET /sites/with-latest-audit/:auditType',
      'GET /sites/:siteId/audits',
      'GET /sites/:siteId/audits/:auditType',
      'GET /sites/:siteId/audits/:auditType/:auditedAt',
      'GET /sites/:siteId/audits/latest',
      'GET /sites/:siteId/latest-audit/:auditType',
      'GET /sites/:siteId/key-events',
      'POST /sites/:siteId/key-events',
      'DELETE /sites/:siteId/key-events/:keyEventId',
      'GET /sites/:siteId/metrics/:metric/:source',
      'GET /tools/import/:jobId',
      'GET /tools/import/:jobId/import-result.zip',
    );

    expect(dynamicRoutes['GET /audits/latest/:auditType'].handler).to.equal(mockAuditsController.getAllLatest);
    expect(dynamicRoutes['GET /audits/latest/:auditType'].paramNames).to.deep.equal(['auditType']);
    expect(dynamicRoutes['GET /configurations/:version'].handler).to.equal(mockConfigurationController.getByVersion);
    expect(dynamicRoutes['GET /configurations/:version'].paramNames).to.deep.equal(['version']);
    expect(dynamicRoutes['GET /organizations/:organizationId'].handler).to.equal(mockOrganizationsController.getByID);
    expect(dynamicRoutes['GET /organizations/:organizationId'].paramNames).to.deep.equal(['organizationId']);
    expect(dynamicRoutes['GET /organizations/:organizationId/sites'].handler).to.equal(mockOrganizationsController.getSitesForOrganization);
    expect(dynamicRoutes['GET /organizations/:organizationId/sites'].paramNames).to.deep.equal(['organizationId']);
    expect(dynamicRoutes['GET /organizations/by-ims-org-id/:imsOrgId'].handler).to.equal(mockOrganizationsController.getByImsOrgID);
    expect(dynamicRoutes['GET /organizations/by-ims-org-id/:imsOrgId'].paramNames).to.deep.equal(['imsOrgId']);
    expect(dynamicRoutes['GET /organizations/by-ims-org-id/:imsOrgId/slack-config'].handler).to.equal(mockOrganizationsController.getSlackConfigByImsOrgID);
    expect(dynamicRoutes['GET /organizations/by-ims-org-id/:imsOrgId/slack-config'].paramNames).to.deep.equal(['imsOrgId']);
    expect(dynamicRoutes['GET /sites/:siteId'].handler).to.equal(mockSitesController.getByID);
    expect(dynamicRoutes['GET /sites/:siteId'].paramNames).to.deep.equal(['siteId']);
    expect(dynamicRoutes['GET /sites/by-delivery-type/:deliveryType'].handler).to.equal(mockSitesController.getAllByDeliveryType);
    expect(dynamicRoutes['GET /sites/by-delivery-type/:deliveryType'].paramNames).to.deep.equal(['deliveryType']);
    expect(dynamicRoutes['GET /sites/by-base-url/:baseURL'].handler).to.equal(mockSitesController.getByBaseURL);
    expect(dynamicRoutes['GET /sites/by-base-url/:baseURL'].paramNames).to.deep.equal(['baseURL']);
    expect(dynamicRoutes['GET /sites/with-latest-audit/:auditType'].handler).to.equal(mockSitesController.getAllWithLatestAudit);
    expect(dynamicRoutes['GET /sites/with-latest-audit/:auditType'].paramNames).to.deep.equal(['auditType']);
    expect(dynamicRoutes['GET /sites/:siteId/audits'].handler).to.equal(mockAuditsController.getAllForSite);
    expect(dynamicRoutes['GET /sites/:siteId/audits'].paramNames).to.deep.equal(['siteId']);
    expect(dynamicRoutes['GET /sites/:siteId/audits/:auditType'].handler).to.equal(mockAuditsController.getAllForSite);
    expect(dynamicRoutes['GET /sites/:siteId/audits/:auditType'].paramNames).to.deep.equal(['siteId', 'auditType']);
    expect(dynamicRoutes['GET /sites/:siteId/audits/:auditType/:auditedAt'].paramNames).to.deep.equal(['siteId', 'auditType', 'auditedAt']);
    expect(dynamicRoutes['GET /sites/:siteId/audits/latest'].handler).to.equal(mockAuditsController.getAllLatestForSite);
    expect(dynamicRoutes['GET /sites/:siteId/audits/latest'].paramNames).to.deep.equal(['siteId']);
    expect(dynamicRoutes['GET /sites/:siteId/latest-audit/:auditType'].handler).to.equal(mockAuditsController.getLatestForSite);
    expect(dynamicRoutes['GET /sites/:siteId/latest-audit/:auditType'].paramNames).to.deep.equal(['siteId', 'auditType']);
  });
});
