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

  const mockExperimentsController = {
    getExperiments: sinon.stub(),
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
    getImportJobProgress: sinon.stub(),
    getImportJobsByDateRange: sinon.stub(),
    stopImportJob: sinon.stub(),
  };

  const mockScrapeJobController = {
    createScrapeJob: sinon.stub(),
    getScrapeJobStatus: sinon.stub(),
    getScrapeJobResult: sinon.stub(),
    getScrapeJobProgress: sinon.stub(),
    getScrapeJobsByDateRange: sinon.stub(),
  };

  const mockApiKeyController = {
    createApiKey: sinon.stub(),
    deleteApiKey: sinon.stub(),
    getApiKeys: sinon.stub(),
  };

  const mockSitesAuditsToggleController = {
    execute: sinon.stub(),
  };

  const mockOpportunitiesController = {
    getAllForSite: sinon.stub(),
    getByStatus: sinon.stub(),
    getBySiteId: sinon.stub(),
    createOpportunity: sinon.stub(),
    patchOpportunity: sinon.stub(),
    removeOpportunity: sinon.stub(),
  };

  const mockSuggestionsController = {
    getAllForOpportunity: sinon.stub(),
    getByStatus: sinon.stub(),
    getByID: sinon.stub(),
    createSuggestions: sinon.stub(),
    patchSuggestion: sinon.stub(),
    patchSuggestionsStatus: sinon.stub(),
  };

  const mockBrandsController = {
    getBrandsForOrganization: sinon.stub(),
    getBrandGuidelinesForSite: sinon.stub(),
  };

  const mockPreflightController = {
    createPreflightJob: sinon.stub(),
    getPreflightJobStatusAndResult: sinon.stub(),
  };

  const mockDemoController = {
    getScreenshots: sinon.stub(),
  };

  const mockMcpController = {
    handleRpc: sinon.stub(),
    handleSseRequest: sinon.stub(),
  };

  const mockScrapeController = {
    getFileByKey: sinon.stub(),
    listScrapedContentFiles: sinon.stub(),
  };
  const mockPaidController = {
    getTopPaidPages: sinon.stub(),
  };

  const mockTrafficController = {
    getPaidTrafficByCampaignUrlDevice: sinon.stub(),
    getPaidTrafficByCampaignDevice: sinon.stub(),
    getPaidTrafficByCampaignUrl: sinon.stub(),
    getPaidTrafficByCampaign: sinon.stub(),
    getPaidTrafficByTypeChannelCampaign: sinon.stub(),
    getPaidTrafficByTypeChannel: sinon.stub(),
    getPaidTrafficByTypeCampaign: sinon.stub(),
    getPaidTrafficByType: sinon.stub(),
    getPaidTrafficByPageTypePlatformCampaign: sinon.stub(),
    getPaidTrafficByUrlPageTypeCampaignDevice: sinon.stub(),
    getPaidTrafficByUrlPageTypePlatformCampaignDevice: sinon.stub(),
    getPaidTrafficPageTypePlatformCampaignDevice: sinon.stub(),
    getPaidTrafficByUrlPageTypeDevice: sinon.stub(),
    getPaidTrafficByUrlPageTypeCampaign: sinon.stub(),
    getPaidTrafficByUrlPageTypePlatform: sinon.stub(),
    getPaidTrafficByUrlPageTypeCampaignPlatform: sinon.stub(),
    getPaidTrafficByUrlPageTypePlatformDevice: sinon.stub(),
    getPaidTrafficByPageTypeCampaignDevice: sinon.stub(),
    getPaidTrafficByPageTypeDevice: sinon.stub(),
    getPaidTrafficByPageTypeCampaign: sinon.stub(),
    getPaidTrafficByPageTypePlatform: sinon.stub(),
    getPaidTrafficByPageTypePlatformDevice: sinon.stub(),
  };

  const mockFixesController = {
    getAllForOpportunity: () => null,
    getByStatus: () => null,
    getByID: () => null,
    getAllSuggestionsForFix: () => null,
    createFixes: () => null,
    patchFixesStatus: () => null,
    patchFix: () => null,
    removeFix: () => null,
  };

  const mockLlmoController = {
    getLlmoSheetData: () => null,
  };

  it('segregates static and dynamic routes', () => {
    const { staticRoutes, dynamicRoutes } = getRouteHandlers(
      mockAuditsController,
      mockConfigurationController,
      mockHooksController,
      mockOrganizationsController,
      mockSitesController,
      mockExperimentsController,
      mockSlackController,
      mockTrigger,
      mockFulfillmentController,
      mockImportController,
      mockApiKeyController,
      mockSitesAuditsToggleController,
      mockOpportunitiesController,
      mockSuggestionsController,
      mockBrandsController,
      mockPreflightController,
      mockDemoController,
      mockScrapeController,
      mockScrapeJobController,
      mockMcpController,
      mockPaidController,
      mockTrafficController,
      mockFixesController,
      mockLlmoController,
    );

    expect(staticRoutes).to.have.all.keys(
      'GET /configurations',
      'GET /configurations/latest',
      'PUT /configurations/latest',
      'PATCH /configurations/sites/audits',
      'GET /organizations',
      'POST /organizations',
      'POST /preflight/jobs',
      'GET /sites',
      'POST /sites',
      'GET /sites.csv',
      'GET /sites.xlsx',
      'GET /slack/events',
      'POST /slack/events',
      'GET /trigger',
      'POST /event/fulfillment',
      'POST /slack/channels/invite-by-user-id',
      'POST /tools/api-keys',
      'GET /tools/api-keys',
      'POST /tools/import/jobs',
      'POST /tools/scrape/jobs',
      'GET /screenshots',
      'POST /screenshots',
      'GET /mcp',
      'POST /mcp',
    );

    expect(staticRoutes['GET /configurations']).to.equal(mockConfigurationController.getAll);
    expect(staticRoutes['GET /configurations/latest']).to.equal(mockConfigurationController.getLatest);
    expect(staticRoutes['PUT /configurations/latest']).to.equal(mockConfigurationController.updateConfiguration);
    expect(staticRoutes['PATCH /configurations/sites/audits']).to.equal(mockSitesAuditsToggleController.execute);
    expect(staticRoutes['GET /organizations']).to.equal(mockOrganizationsController.getAll);
    expect(staticRoutes['POST /organizations']).to.equal(mockOrganizationsController.createOrganization);
    expect(staticRoutes['GET /sites']).to.equal(mockSitesController.getAll);
    expect(staticRoutes['POST /sites']).to.equal(mockSitesController.createSite);
    expect(staticRoutes['GET /sites.csv']).to.equal(mockSitesController.getAllAsCsv);
    expect(staticRoutes['GET /sites.xlsx']).to.equal(mockSitesController.getAllAsExcel);
    expect(staticRoutes['GET /trigger']).to.equal(mockTrigger);
    expect(staticRoutes['POST /tools/api-keys']).to.equal(mockApiKeyController.createApiKey);
    expect(staticRoutes['GET /tools/api-keys']).to.equal(mockApiKeyController.getApiKeys);
    expect(staticRoutes['GET /screenshots']).to.equal(mockDemoController.getScreenshots);
    expect(staticRoutes['GET /mcp']).to.equal(mockMcpController.handleSseRequest);
    expect(staticRoutes['POST /mcp']).to.equal(mockMcpController.handleRpc);
    expect(staticRoutes['POST /tools/scrape/jobs']).to.equal(mockScrapeJobController.createScrapeJob);

    expect(dynamicRoutes).to.have.all.keys(
      'GET /audits/latest/:auditType',
      'GET /configurations/:version',
      'POST /hooks/site-detection/cdn/:hookSecret',
      'POST /hooks/site-detection/rum/:hookSecret',
      'GET /organizations/:organizationId',
      'GET /organizations/:organizationId/brands',
      'GET /organizations/:organizationId/sites',
      'GET /organizations/by-ims-org-id/:imsOrgId',
      'GET /organizations/by-ims-org-id/:imsOrgId/slack-config',
      'PATCH /organizations/:organizationId',
      'DELETE /organizations/:organizationId',
      'GET /preflight/jobs/:jobId',
      'GET /sites/:siteId',
      'PATCH /sites/:siteId',
      'DELETE /sites/:siteId',
      'GET /sites/by-delivery-type/:deliveryType',
      'GET /sites/by-base-url/:baseURL',
      'GET /sites/with-latest-audit/:auditType',
      'GET /sites/:siteId/audits',
      'GET /sites/:siteId/audits/:auditType',
      'GET /sites/:siteId/audits/:auditType/:auditedAt',
      'PATCH /sites/:siteId/:auditType',
      'GET /sites/:siteId/audits/latest',
      'GET /sites/:siteId/latest-audit/:auditType',
      'GET /sites/:siteId/latest-metrics',
      'GET /sites/:siteId/experiments',
      'GET /sites/:siteId/key-events',
      'POST /sites/:siteId/key-events',
      'DELETE /sites/:siteId/key-events/:keyEventId',
      'GET /sites/:siteId/metrics/:metric/:source',
      'GET /sites/:siteId/metrics/:metric/:source/by-url/:base64PageUrl',
      'DELETE /tools/api-keys/:id',
      'GET /tools/import/jobs/:jobId',
      'PATCH /tools/import/jobs/:jobId',
      'POST /tools/import/jobs/:jobId/result',
      'GET /tools/import/jobs/:jobId/progress',
      'GET /tools/import/jobs/by-date-range/:startDate/:endDate/all-jobs',
      'DELETE /tools/import/jobs/:jobId',
      'GET /sites/:siteId/brand-guidelines',
      'GET /sites/:siteId/opportunities',
      'GET /sites/:siteId/opportunities/by-status/:status',
      'GET /sites/:siteId/opportunities/:opportunityId',
      'POST /sites/:siteId/opportunities',
      'PATCH /sites/:siteId/opportunities/:opportunityId',
      'DELETE /sites/:siteId/opportunities/:opportunityId',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions',
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/auto-fix',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId',
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions',
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId',
      'DELETE /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId',
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/status',
      'GET /sites/:siteId/scraped-content/:type',
      'GET /sites/:siteId/top-pages',
      'GET /sites/:siteId/top-pages/:source',
      'GET /sites/:siteId/top-pages/:source/:geo',
      'GET /sites/:siteId/files',
      'POST /event/fulfillment/:eventType',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/by-status/:status',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId/suggestions',
      'POST /sites/:siteId/opportunities/:opportunityId/fixes',
      'PATCH /sites/:siteId/opportunities/:opportunityId/status',
      'PATCH /sites/:siteId/opportunities/:opportunityId/fixes/:fixId',
      'DELETE /sites/:siteId/opportunities/:opportunityId/fixes/:fixId',
      'GET /sites/:siteId/traffic/paid',
      'GET /sites/:siteId/traffic/paid/campaign',
      'GET /sites/:siteId/traffic/paid/campaign-url-device',
      'GET /sites/:siteId/traffic/paid/campaign-device',
      'GET /sites/:siteId/traffic/paid/campaign-url',
      'GET /sites/:siteId/traffic/paid/type',
      'GET /sites/:siteId/traffic/paid/type-channel-campaign',
      'GET /sites/:siteId/traffic/paid/type-channel',
      'GET /sites/:siteId/traffic/paid/type-campaign',
      'GET /sites/:siteId/traffic/paid/page-type',
      'GET /sites/:siteId/traffic/paid/page-type-platform-campaign',
      'GET /sites/:siteId/traffic/paid/page-type-campaign-device',
      'GET /sites/:siteId/traffic/paid/page-type-device',
      'GET /sites/:siteId/traffic/paid/page-type-campaign',
      'GET /sites/:siteId/traffic/paid/page-type-platform',
      'GET /sites/:siteId/traffic/paid/page-type-platform-device',
      'GET /sites/:siteId/traffic/paid/url-page-type-platform-campaign-device',
      'GET /sites/:siteId/traffic/paid/page-type-platform-campaign-device',
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign-device',
      'GET /sites/:siteId/traffic/paid/url-page-type-device',
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign',
      'GET /sites/:siteId/traffic/paid/url-page-type-platform',
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign-platform',
      'GET /sites/:siteId/traffic/paid/url-page-type-platform-device',
      'GET /tools/scrape/jobs/:jobId',
      'GET /tools/scrape/jobs/:jobId/results',
      'GET /tools/scrape/jobs/by-date-range/:startDate/:endDate/all-jobs',
      'GET /tools/scrape/jobs/by-base-url/:baseURL',
      'GET /tools/scrape/jobs/by-base-url/:baseURL/by-processingtype/:processingType',
      'PATCH /sites/:siteId/config/cdn-logs',
      'GET /sites/:siteId/llmo/sheet-data/:dataSource',
      'GET /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource',
      'GET /sites/:siteId/llmo/config',
      'GET /sites/:siteId/llmo/questions',
      'POST /sites/:siteId/llmo/questions',
      'DELETE /sites/:siteId/llmo/questions/:questionKey',
      'PATCH /sites/:siteId/llmo/questions/:questionKey',
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
    expect(dynamicRoutes['GET /sites/:siteId/experiments'].handler).to.equal(mockExperimentsController.getExperiments);
    expect(dynamicRoutes['DELETE /tools/api-keys/:id'].handler).to.equal(mockApiKeyController.deleteApiKey);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities'].handler).to.equal(mockOpportunitiesController.getAllForSite);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities'].paramNames).to.deep.equal(['siteId']);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities/by-status/:status'].handler).to.equal(mockOpportunitiesController.getByStatus);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities/by-status/:status'].paramNames).to.deep.equal(['siteId', 'status']);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities/:opportunityId'].handler).to.equal(mockOpportunitiesController.getByID);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities/:opportunityId'].paramNames).to.deep.equal(['siteId', 'opportunityId']);
    expect(dynamicRoutes['POST /sites/:siteId/opportunities'].handler).to.equal(mockOpportunitiesController.createOpportunity);
    expect(dynamicRoutes['POST /sites/:siteId/opportunities'].paramNames).to.deep.equal(['siteId']);
    expect(dynamicRoutes['PATCH /sites/:siteId/opportunities/:opportunityId'].handler).to.equal(mockOpportunitiesController.patchOpportunity);
    expect(dynamicRoutes['PATCH /sites/:siteId/opportunities/:opportunityId'].paramNames).to.deep.equal(['siteId', 'opportunityId']);
    expect(dynamicRoutes['DELETE /sites/:siteId/opportunities/:opportunityId'].handler).to.equal(mockOpportunitiesController.removeOpportunity);
    expect(dynamicRoutes['DELETE /sites/:siteId/opportunities/:opportunityId'].paramNames).to.deep.equal(['siteId', 'opportunityId']);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities/:opportunityId/suggestions'].handler).to.equal(mockSuggestionsController.getAllForOpportunity);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities/:opportunityId/suggestions'].paramNames).to.deep.equal(['siteId', 'opportunityId']);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status'].handler).to.equal(mockSuggestionsController.getByStatus);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status'].paramNames).to.deep.equal(['siteId', 'opportunityId', 'status']);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId'].handler).to.equal(mockSuggestionsController.getByID);
    expect(dynamicRoutes['GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId'].paramNames).to.deep.equal(['siteId', 'opportunityId', 'suggestionId']);
    expect(dynamicRoutes['POST /sites/:siteId/opportunities/:opportunityId/suggestions'].handler).to.equal(mockSuggestionsController.createSuggestions);
    expect(dynamicRoutes['PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId'].handler).to.equal(mockSuggestionsController.patchSuggestion);
    expect(dynamicRoutes['PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId'].paramNames).to.deep.equal(['siteId', 'opportunityId', 'suggestionId']);
    expect(dynamicRoutes['DELETE /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId'].handler).to.equal(mockSuggestionsController.removeSuggestion);
    expect(dynamicRoutes['DELETE /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId'].paramNames).to.deep.equal(['siteId', 'opportunityId', 'suggestionId']);
    expect(dynamicRoutes['PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/status'].handler).to.equal(mockSuggestionsController.patchSuggestionsStatus);
    expect(dynamicRoutes['PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/status'].paramNames).to.deep.equal(['siteId', 'opportunityId']);
    expect(dynamicRoutes['GET /sites/:siteId/scraped-content/:type'].handler).to.equal(mockScrapeController.listScrapedContentFiles);
    expect(dynamicRoutes['GET /sites/:siteId/scraped-content/:type'].paramNames).to.deep.equal(['siteId', 'type']);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid'].handler).to.equal(mockPaidController.getTopPaidPages);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid'].paramNames).to.deep.equal(['siteId']);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/page-type-platform-campaign'].handler).to.equal(mockTrafficController.getPaidTrafficByPageTypePlatformCampaign);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/url-page-type-campaign-device'].handler).to.equal(mockTrafficController.getPaidTrafficByUrlPageTypeCampaignDevice);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/url-page-type-device'].handler).to.equal(mockTrafficController.getPaidTrafficByUrlPageTypeDevice);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/url-page-type-campaign'].handler).to.equal(mockTrafficController.getPaidTrafficByUrlPageTypeCampaign);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/url-page-type-platform'].handler).to.equal(mockTrafficController.getPaidTrafficByUrlPageTypePlatform);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/url-page-type-campaign-platform'].handler).to.equal(mockTrafficController.getPaidTrafficByUrlPageTypeCampaignPlatform);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/url-page-type-platform-device'].handler).to.equal(mockTrafficController.getPaidTrafficByUrlPageTypePlatformDevice);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/page-type-campaign-device'].handler).to.equal(mockTrafficController.getPaidTrafficByPageTypeCampaignDevice);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/page-type-device'].handler).to.equal(mockTrafficController.getPaidTrafficByPageTypeDevice);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/page-type-campaign'].handler).to.equal(mockTrafficController.getPaidTrafficByPageTypeCampaign);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/page-type-platform'].handler).to.equal(mockTrafficController.getPaidTrafficByPageTypePlatform);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/page-type-platform-device'].handler).to.equal(mockTrafficController.getPaidTrafficByPageTypePlatformDevice);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/type'].handler).to.equal(mockTrafficController.getPaidTrafficByType);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/type-campaign'].handler).to.equal(mockTrafficController.getPaidTrafficByTypeCampaign);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/type-channel'].handler).to.equal(mockTrafficController.getPaidTrafficByTypeChannel);
    expect(dynamicRoutes['GET /sites/:siteId/traffic/paid/type-channel-campaign'].handler).to.equal(mockTrafficController.getPaidTrafficByTypeChannelCampaign);
    expect(dynamicRoutes['GET /sites/:siteId/files'].handler).to.equal(mockScrapeController.getFileByKey);
    expect(dynamicRoutes['GET /sites/:siteId/files'].paramNames).to.deep.equal(['siteId']);
    expect(dynamicRoutes['GET /tools/scrape/jobs/:jobId'].handler).to.equal(mockScrapeJobController.getScrapeJobStatus);
    expect(dynamicRoutes['GET /tools/scrape/jobs/:jobId'].paramNames).to.deep.equal(['jobId']);
    expect(dynamicRoutes['GET /tools/scrape/jobs/:jobId/results'].handler).to.equal(mockScrapeJobController.getScrapeJobUrlResults);
    expect(dynamicRoutes['GET /tools/scrape/jobs/:jobId/results'].paramNames).to.deep.equal(['jobId']);
    expect(dynamicRoutes['GET /tools/scrape/jobs/by-base-url/:baseURL'].handler).to.equal(mockScrapeJobController.getScrapeJobsByBaseURL);
    expect(dynamicRoutes['GET /tools/scrape/jobs/by-base-url/:baseURL'].paramNames).to.deep.equal(['baseURL']);
    expect(dynamicRoutes['GET /tools/scrape/jobs/by-base-url/:baseURL/by-processingtype/:processingType'].handler).to.equal(mockScrapeJobController.getScrapeJobsByBaseURL);
    expect(dynamicRoutes['GET /tools/scrape/jobs/by-base-url/:baseURL/by-processingtype/:processingType'].paramNames).to.deep.equal(['baseURL', 'processingType']);
    expect(dynamicRoutes['PATCH /sites/:siteId/config/cdn-logs'].handler).to.equal(mockSitesController.updateCdnLogsConfig);
    expect(dynamicRoutes['PATCH /sites/:siteId/config/cdn-logs'].paramNames).to.deep.equal(['siteId']);
    expect(dynamicRoutes['GET /sites/:siteId/llmo/sheet-data/:dataSource'].handler).to.equal(mockLlmoController.getLlmoSheetData);
    expect(dynamicRoutes['GET /sites/:siteId/llmo/sheet-data/:dataSource'].paramNames).to.deep.equal(['siteId', 'dataSource']);
    expect(dynamicRoutes['GET /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource'].handler).to.equal(mockLlmoController.getLlmoSheetData);
    expect(dynamicRoutes['GET /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource'].paramNames).to.deep.equal(['siteId', 'sheetType', 'dataSource']);
    expect(dynamicRoutes['GET /sites/:siteId/llmo/config'].handler).to.equal(mockLlmoController.getLlmoConfig);
    expect(dynamicRoutes['GET /sites/:siteId/llmo/config'].paramNames).to.deep.equal(['siteId']);
    expect(dynamicRoutes['GET /sites/:siteId/llmo/questions'].handler).to.equal(mockLlmoController.getLlmoQuestions);
    expect(dynamicRoutes['GET /sites/:siteId/llmo/questions'].paramNames).to.deep.equal(['siteId']);
    expect(dynamicRoutes['POST /sites/:siteId/llmo/questions'].handler).to.equal(mockLlmoController.addLlmoQuestion);
    expect(dynamicRoutes['POST /sites/:siteId/llmo/questions'].paramNames).to.deep.equal(['siteId']);
    expect(dynamicRoutes['DELETE /sites/:siteId/llmo/questions/:questionKey'].handler).to.equal(mockLlmoController.removeLlmoQuestion);
    expect(dynamicRoutes['DELETE /sites/:siteId/llmo/questions/:questionKey'].paramNames).to.deep.equal(['siteId', 'questionKey']);
    expect(dynamicRoutes['PATCH /sites/:siteId/llmo/questions/:questionKey'].handler).to.equal(mockLlmoController.patchLlmoQuestion);
    expect(dynamicRoutes['PATCH /sites/:siteId/llmo/questions/:questionKey'].paramNames).to.deep.equal(['siteId', 'questionKey']);
  });
});
