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

/**
 * @import type { FixesController } from "../controllers/fixes.js"
 */

/**
 * Extracts parameter names from a route pattern. For example, for the route pattern
 * /sites/:siteId/audits/:auditType, the parameter names are siteId and auditType.
 * The parameter names are prefixed with a colon (:).
 *
 * @param routePattern - The route pattern.
 * @return {string[]} - An array of parameter names.
 */
function extractParamNames(routePattern) {
  return routePattern.split('/').filter((segment) => segment.startsWith(':')).map((param) => param.slice(1));
}

/**
 * Checks if a given route pattern is static. A static route pattern is a route pattern
 * that does not contain any parameters. For example, /sites is a static route pattern
 * while /sites/:siteId is not.
 *
 * @param routePattern - The route pattern.
 * @return {boolean} - True if the route pattern is static, false otherwise.
 */
function isStaticRoute(routePattern) {
  return !routePattern.split('/').some((segment) => segment.startsWith(':'));
}

/**
 * Returns an object with static and dynamic routes. The static routes are defined as
 * key-value pairs where the key is the route pattern and the value is the route handler
 * function. The dynamic routes are defined as key-value pairs where the key is the route
 * pattern and the value is an object with the following properties:
 * - handler: the route handler function
 * - paramNames: an array of parameter names extracted from the route pattern
 *
 * @param {Object} auditsController - The audits controller.
 * @param {Object} configurationController - The configuration controller.
 * @param {Object} hooksController - The hooks controller.
 * @param {Object} organizationsController - The organizations controller.
 * @param {Object} projectsController - The projects controller.
 * @param {Object} sitesController - The sites controller.
 * @param {Object} experimentsController - The experiments controller.
 * @param {Object} slackController - The slack controller.
 * @param {Function} triggerHandler - The trigger handler function.
 * @param {Object} fulfillmentController - The fulfillment controller.
 * @param {Object} importController - The import controller.
 * @param {Object} apiKeyController - The API key controller.
 * @param {Object} sitesAuditsToggleController - The sites audits controller.
 * @param {Object} opportunitiesController - The opportunities controller.
 * @param {Object} suggestionsController - The suggestions controller.
 * @param {Object} brandsController - The brands controller.
 * @param {Object} preflightController - The preflight controller.
 * @param {Object} demoController - The demo controller.
 * @param {Object} consentBannerController - The consent banner controller.
 * @param {Object} scrapeController - The scrape controller.
 * @param {Object} scrapeJobController - The scrape job controller.
 * @param {Object} mcpController - The MCP controller.
 * @param {Object} paidController - The paid controller.
 * @param {Object} topPaidOpportunitiesController - The top paid opportunities controller.
 * @param {Object} trafficController - The traffic controller.
 * @param {FixesController} fixesController - The fixes controller.
 * @param {Object} llmoController - The LLMO controller.
 * @param {Object} userActivityController - The user activity controller.
 * @param {Object} siteEnrollmentController - The site enrollment controller.
 * @param {Object} trialUserController - The trial user controller.
 * @param {Object} userDetailsController - The user details controller.
 * @param {Object} entitlementController - The entitlement controller.
 * @param {Object} sandboxAuditController - The sandbox audit controller.
 * @param {Object} reportsController - The reports controller.
 * @param {Object} urlStoreController - The URL store controller.
 * @param {Object} pta2Controller - The PTA2 controller.
 * @return {{staticRoutes: {}, dynamicRoutes: {}}} - An object with static and dynamic routes.
 */
export default function getRouteHandlers(
  auditsController,
  configurationController,
  hooksController,
  organizationsController,
  projectsController,
  sitesController,
  experimentsController,
  slackController,
  triggerHandler,
  fulfillmentController,
  importController,
  apiKeyController,
  sitesAuditsToggleController,
  opportunitiesController,
  suggestionsController,
  brandsController,
  preflightController,
  demoController,
  consentBannerController,
  scrapeController,
  scrapeJobController,
  paidController,
  topPaidOpportunitiesController,
  trafficController,
  fixesController,
  llmoController,
  userActivityController,
  siteEnrollmentController,
  trialUserController,
  userDetailsController,
  entitlementController,
  sandboxAuditController,
  reportsController,
  urlStoreController,
  pta2Controller,
) {
  const staticRoutes = {};
  const dynamicRoutes = {};

  const routeDefinitions = {
    'GET /audits/latest/:auditType': auditsController.getAllLatest,
    'GET /configurations/latest': configurationController.getLatest,
    'PATCH /configurations/latest': configurationController.updateConfiguration,
    'POST /configurations/:version/restore': configurationController.restoreVersion,
    'GET /configurations/:version': configurationController.getByVersion,
    'POST /configurations/audits': configurationController.registerAudit,
    'DELETE /configurations/audits/:auditType': configurationController.unregisterAudit,
    'PUT /configurations/latest/queues': configurationController.updateQueues,
    'PATCH /configurations/latest/jobs/:jobType': configurationController.updateJob,
    'PATCH /configurations/latest/handlers/:handlerType': configurationController.updateHandler,
    'PATCH /configurations/sites/audits': sitesAuditsToggleController.execute,
    'POST /event/fulfillment': fulfillmentController.processFulfillmentEvents,
    'POST /event/fulfillment/:eventType': fulfillmentController.processFulfillmentEvents,
    'POST /hooks/site-detection/cdn/:hookSecret': hooksController.processCDNHook,
    'POST /hooks/site-detection/rum/:hookSecret': hooksController.processRUMHook,
    'GET /organizations': organizationsController.getAll,
    'POST /organizations': organizationsController.createOrganization,
    'GET /organizations/:organizationId': organizationsController.getByID,
    'GET /organizations/by-ims-org-id/:imsOrgId': organizationsController.getByImsOrgID,
    'GET /organizations/by-ims-org-id/:imsOrgId/slack-config': organizationsController.getSlackConfigByImsOrgID,
    'PATCH /organizations/:organizationId': organizationsController.updateOrganization,
    'DELETE /organizations/:organizationId': organizationsController.removeOrganization,
    'GET /organizations/:organizationId/sites': organizationsController.getSitesForOrganization,
    'GET /organizations/:organizationId/brands': brandsController.getBrandsForOrganization,
    'GET /organizations/:organizationId/projects': organizationsController.getProjectsByOrganizationId,
    'GET /organizations/:organizationId/projects/:projectId/sites': organizationsController.getSitesByProjectIdAndOrganizationId,
    'GET /organizations/:organizationId/by-project-name/:projectName/sites': organizationsController.getSitesByProjectNameAndOrganizationId,
    'GET /projects': projectsController.getAll,
    'POST /projects': projectsController.createProject,
    'GET /projects/:projectId': projectsController.getByID,
    'PATCH /projects/:projectId': projectsController.updateProject,
    'DELETE /projects/:projectId': projectsController.removeProject,
    'GET /projects/:projectId/sites/primary-locale': projectsController.getPrimaryLocaleSites,
    'GET /projects/:projectId/sites': projectsController.getSitesByProjectId,
    'GET /projects/by-project-name/:projectName/sites': projectsController.getSitesByProjectName,
    'POST /preflight/jobs': preflightController.createPreflightJob,
    'GET /preflight/jobs/:jobId': preflightController.getPreflightJobStatusAndResult,
    'GET /sites': sitesController.getAll,
    'POST /sites': sitesController.createSite,
    'GET /sites.csv': sitesController.getAllAsCsv,
    'GET /sites.xlsx': sitesController.getAllAsExcel,
    'GET /sites/:siteId': sitesController.getByID,
    'PATCH /sites/:siteId': sitesController.updateSite,
    'PATCH /sites/:siteId/config/cdn-logs': sitesController.updateCdnLogsConfig,
    'DELETE /sites/:siteId': sitesController.removeSite,
    'GET /sites/:siteId/audits': auditsController.getAllForSite,
    'GET /sites/:siteId/audits/latest': auditsController.getAllLatestForSite,
    'GET /sites/:siteId/audits/:auditType': auditsController.getAllForSite,
    'GET /sites/:siteId/audits/:auditType/:auditedAt': sitesController.getAuditForSite,
    'PATCH /sites/:siteId/:auditType': auditsController.patchAuditForSite,
    'GET /sites/:siteId/latest-audit/:auditType': auditsController.getLatestForSite,
    'GET /sites/:siteId/experiments': experimentsController.getExperiments,
    'GET /sites/:siteId/key-events': sitesController.getKeyEventsBySiteID,
    'POST /sites/:siteId/key-events': sitesController.createKeyEvent,
    'DELETE /sites/:siteId/key-events/:keyEventId': sitesController.removeKeyEvent,
    'GET /sites/:siteId/metrics/:metric/:source': sitesController.getSiteMetricsBySource,
    'GET /sites/:siteId/metrics/:metric/:source/by-url/:base64PageUrl': sitesController.getPageMetricsBySource,
    'GET /sites/:siteId/latest-metrics': sitesController.getLatestSiteMetrics,
    'GET /sites/by-base-url/:baseURL': sitesController.getByBaseURL,
    'GET /sites/by-delivery-type/:deliveryType': sitesController.getAllByDeliveryType,
    'GET /sites/with-latest-audit/:auditType': sitesController.getAllWithLatestAudit,
    'GET /sites/:siteId/opportunities': opportunitiesController.getAllForSite,
    'GET /sites/:siteId/opportunities/top-paid': topPaidOpportunitiesController.getTopPaidOpportunities,
    'GET /sites/:siteId/opportunities/by-status/:status': opportunitiesController.getByStatus,
    'GET /sites/:siteId/opportunities/:opportunityId': opportunitiesController.getByID,
    'POST /sites/:siteId/opportunities': opportunitiesController.createOpportunity,
    'PATCH /sites/:siteId/opportunities/:opportunityId': opportunitiesController.patchOpportunity,
    'DELETE /sites/:siteId/opportunities/:opportunityId': opportunitiesController.removeOpportunity,
    'GET /sites/:siteId/opportunities/:opportunityId/suggestions': suggestionsController.getAllForOpportunity,
    'GET /sites/:siteId/opportunities/:opportunityId/suggestions/paged/:limit/:cursor': suggestionsController.getAllForOpportunityPaged,
    'GET /sites/:siteId/opportunities/:opportunityId/suggestions/paged/:limit': suggestionsController.getAllForOpportunityPaged,
    'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/auto-fix': suggestionsController.autofixSuggestions,
    'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-deploy': suggestionsController.deploySuggestionToEdge,
    'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-rollback': suggestionsController.rollbackSuggestionFromEdge,
    'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-preview': suggestionsController.previewSuggestions,
    'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-live-preview': suggestionsController.fetchFromEdge,
    'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status': suggestionsController.getByStatus,
    'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status/paged/:limit/:cursor': suggestionsController.getByStatusPaged,
    'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status/paged/:limit': suggestionsController.getByStatusPaged,
    'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': suggestionsController.getByID,
    'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId/fixes': suggestionsController.getSuggestionFixes,
    'POST /sites/:siteId/opportunities/:opportunityId/suggestions': suggestionsController.createSuggestions,
    'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/status': suggestionsController.patchSuggestionsStatus,
    'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': suggestionsController.patchSuggestion,
    'DELETE /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': suggestionsController.removeSuggestion,
    'GET /sites/:siteId/traffic/paid': paidController.getTopPaidPages,
    'GET /sites/:siteId/traffic/paid/page-type-platform-campaign': trafficController.getPaidTrafficByPageTypePlatformCampaign,
    'GET /sites/:siteId/traffic/paid/url-page-type': trafficController.getPaidTrafficByUrlPageType,
    'GET /sites/:siteId/traffic/paid/url-page-type-platform-campaign-device': trafficController.getPaidTrafficByUrlPageTypePlatformCampaignDevice,
    'GET /sites/:siteId/traffic/paid/page-type-platform-campaign-device': trafficController.getPaidTrafficByPageTypePlatformCampaignDevice,
    'GET /sites/:siteId/traffic/paid/url-page-type-campaign-device': trafficController.getPaidTrafficByUrlPageTypeCampaignDevice,
    'GET /sites/:siteId/traffic/paid/url-page-type-device': trafficController.getPaidTrafficByUrlPageTypeDevice,
    'GET /sites/:siteId/traffic/paid/url-page-type-campaign': trafficController.getPaidTrafficByUrlPageTypeCampaign,
    'GET /sites/:siteId/traffic/paid/url-page-type-platform': trafficController.getPaidTrafficByUrlPageTypePlatform,
    'GET /sites/:siteId/traffic/paid/url-page-type-campaign-platform': trafficController.getPaidTrafficByUrlPageTypeCampaignPlatform,
    'GET /sites/:siteId/traffic/paid/url-page-type-platform-device': trafficController.getPaidTrafficByUrlPageTypePlatformDevice,
    'GET /sites/:siteId/traffic/paid/page-type': trafficController.getPaidTrafficByPageType,
    'GET /sites/:siteId/traffic/paid/page-type-campaign-device': trafficController.getPaidTrafficByPageTypeCampaignDevice,
    'GET /sites/:siteId/traffic/paid/page-type-device': trafficController.getPaidTrafficByPageTypeDevice,
    'GET /sites/:siteId/traffic/paid/page-type-campaign': trafficController.getPaidTrafficByPageTypeCampaign,
    'GET /sites/:siteId/traffic/paid/page-type-platform': trafficController.getPaidTrafficByPageTypePlatform,
    'GET /sites/:siteId/traffic/paid/page-type-platform-device': trafficController.getPaidTrafficByPageTypePlatformDevice,
    'GET /sites/:siteId/traffic/paid/campaign-url-device': trafficController.getPaidTrafficByCampaignUrlDevice,
    'GET /sites/:siteId/traffic/paid/campaign-device': trafficController.getPaidTrafficByCampaignDevice,
    'GET /sites/:siteId/traffic/paid/campaign-url': trafficController.getPaidTrafficByCampaignUrl,
    'GET /sites/:siteId/traffic/paid/campaign': trafficController.getPaidTrafficByCampaign,
    'GET /sites/:siteId/traffic/paid/type-channel-campaign': trafficController.getPaidTrafficByTypeChannelCampaign,
    'GET /sites/:siteId/traffic/paid/type-channel': trafficController.getPaidTrafficByTypeChannel,
    'GET /sites/:siteId/traffic/paid/type-campaign': trafficController.getPaidTrafficByTypeCampaign,
    'GET /sites/:siteId/traffic/paid/type': trafficController.getPaidTrafficByType,
    'GET /sites/:siteId/traffic/paid/pta2/weekly-summary': pta2Controller.getPTAWeeklySummary,
    'GET /sites/:siteId/traffic/paid/type-device': trafficController.getPaidTrafficByTypeDevice,
    'GET /sites/:siteId/traffic/paid/type-device-channel': trafficController.getPaidTrafficByTypeDeviceChannel,
    'GET /sites/:siteId/traffic/paid/channel': trafficController.getPaidTrafficByChannel,
    'GET /sites/:siteId/traffic/paid/channel-device': trafficController.getPaidTrafficByChannelDevice,
    'GET /sites/:siteId/traffic/paid/channel-platform-device': trafficController.getPaidTrafficByChannelPlatformDevice,
    'GET /sites/:siteId/traffic/paid/social-platform': trafficController.getPaidTrafficBySocialPlatform,
    'GET /sites/:siteId/traffic/paid/social-platform-device': trafficController.getPaidTrafficBySocialPlatformDevice,
    'GET /sites/:siteId/traffic/paid/search-platform': trafficController.getPaidTrafficBySearchPlatform,
    'GET /sites/:siteId/traffic/paid/search-platform-device': trafficController.getPaidTrafficBySearchPlatformDevice,
    'GET /sites/:siteId/traffic/paid/display-platform': trafficController.getPaidTrafficByDisplayPlatform,
    'GET /sites/:siteId/traffic/paid/display-platform-device': trafficController.getPaidTrafficByDisplayPlatformDevice,
    'GET /sites/:siteId/traffic/paid/video-platform': trafficController.getPaidTrafficByVideoPlatform,
    'GET /sites/:siteId/traffic/paid/video-platform-device': trafficController.getPaidTrafficByVideoPlatformDevice,
    'GET /sites/:siteId/traffic/paid/url': trafficController.getPaidTrafficByUrl,
    'GET /sites/:siteId/traffic/paid/url-channel': trafficController.getPaidTrafficByUrlChannel,
    'GET /sites/:siteId/traffic/paid/url-channel-device': trafficController.getPaidTrafficByUrlChannelDevice,
    'GET /sites/:siteId/traffic/paid/url-channel-platform-device': trafficController.getPaidTrafficByUrlChannelPlatformDevice,
    'GET /sites/:siteId/traffic/paid/campaign-channel-device': trafficController.getPaidTrafficByCampaignChannelDevice,
    'GET /sites/:siteId/traffic/paid/campaign-channel-platform': trafficController.getPaidTrafficByCampaignChannelPlatform,
    'GET /sites/:siteId/traffic/paid/campaign-channel-platform-device': trafficController.getPaidTrafficByCampaignChannelPlatformDevice,
    'GET /sites/:siteId/traffic/paid/temporal-series': trafficController.getPaidTrafficTemporalSeries,
    'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign': trafficController.getPaidTrafficTemporalSeriesByCampaign,
    'GET /sites/:siteId/traffic/paid/temporal-series-by-channel': trafficController.getPaidTrafficTemporalSeriesByChannel,
    'GET /sites/:siteId/traffic/paid/temporal-series-by-platform': trafficController.getPaidTrafficTemporalSeriesByPlatform,
    'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-channel': trafficController.getPaidTrafficTemporalSeriesByCampaignChannel,
    'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-platform': trafficController.getPaidTrafficTemporalSeriesByCampaignPlatform,
    'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-channel-platform': trafficController.getPaidTrafficTemporalSeriesByCampaignChannelPlatform,
    'GET /sites/:siteId/traffic/paid/temporal-series-by-channel-platform': trafficController.getPaidTrafficTemporalSeriesByChannelPlatform,
    'GET /sites/:siteId/traffic/paid/temporal-series-by-url': trafficController.getPaidTrafficTemporalSeriesByUrl,
    'GET /sites/:siteId/traffic/paid/temporal-series-by-url-channel': trafficController.getPaidTrafficTemporalSeriesByUrlChannel,
    'GET /sites/:siteId/traffic/paid/temporal-series-by-url-platform': trafficController.getPaidTrafficTemporalSeriesByUrlPlatform,
    'GET /sites/:siteId/traffic/paid/temporal-series-by-url-channel-platform': trafficController.getPaidTrafficTemporalSeriesByUrlChannelPlatform,
    'GET /sites/:siteId/traffic/paid/impact-by-page': trafficController.getImpactByPage,
    'GET /sites/:siteId/traffic/paid/impact-by-page-device': trafficController.getImpactByPageDevice,
    'GET /sites/:siteId/traffic/paid/impact-by-page-traffic-type': trafficController.getImpactByPageTrafficType,
    'GET /sites/:siteId/traffic/paid/impact-by-page-traffic-type-device': trafficController.getImpactByPageTrafficTypeDevice,
    'GET /sites/:siteId/traffic/paid/traffic-loss-by-devices': trafficController.getTrafficLossByDevices,
    'GET /sites/:siteId/brand-guidelines': brandsController.getBrandGuidelinesForSite,
    'GET /sites/:siteId/brand-profile': sitesController.getBrandProfile,
    'POST /sites/:siteId/brand-profile': sitesController.triggerBrandProfile,
    'GET /sites/:siteId/top-pages': sitesController.getTopPages,
    'GET /sites/:siteId/top-pages/:source': sitesController.getTopPages,
    'GET /sites/:siteId/top-pages/:source/:geo': sitesController.getTopPages,
    'POST /sites/:siteId/graph': sitesController.getGraph,

    // URL Store endpoints
    'GET /sites/:siteId/url-store': urlStoreController.listUrls,
    'GET /sites/:siteId/url-store/by-audit/:auditType': urlStoreController.listUrlsByAuditType,
    'GET /sites/:siteId/url-store/:base64Url': urlStoreController.getUrl,
    'POST /sites/:siteId/url-store': urlStoreController.addUrls,
    'PATCH /sites/:siteId/url-store': urlStoreController.updateUrls,
    'DELETE /sites/:siteId/url-store': urlStoreController.deleteUrls,
    'GET /slack/events': slackController.handleEvent,
    'POST /slack/events': slackController.handleEvent,
    'POST /slack/channels/invite-by-user-id': slackController.inviteUserToChannel,
    'GET /trigger': triggerHandler,
    'POST /tools/api-keys': apiKeyController.createApiKey,
    'DELETE /tools/api-keys/:id': apiKeyController.deleteApiKey,
    'GET /tools/api-keys': apiKeyController.getApiKeys,
    'POST /tools/import/jobs': importController.createImportJob,
    'GET /tools/import/jobs/:jobId': importController.getImportJobStatus,
    'DELETE /tools/import/jobs/:jobId': importController.deleteImportJob,
    'PATCH /tools/import/jobs/:jobId': importController.stopImportJob,
    'GET /tools/import/jobs/:jobId/progress': importController.getImportJobProgress,
    'POST /tools/import/jobs/:jobId/result': importController.getImportJobResult,
    'GET /tools/import/jobs/by-date-range/:startDate/:endDate/all-jobs': importController.getImportJobsByDateRange,
    'POST /consent-banner': consentBannerController.takeScreenshots,
    'GET /consent-banner/:jobId': consentBannerController.getScreenshots,
    'GET /sites/:siteId/scraped-content/:type': scrapeController.listScrapedContentFiles,
    'GET /sites/:siteId/files': scrapeController.getFileByKey,

    // Scrape Jobs
    'POST /tools/scrape/jobs': scrapeJobController.createScrapeJob,
    'GET /tools/scrape/jobs/:jobId': scrapeJobController.getScrapeJobStatus,
    'GET /tools/scrape/jobs/:jobId/results': scrapeJobController.getScrapeJobUrlResults,
    'GET /tools/scrape/jobs/by-date-range/:startDate/:endDate/all-jobs': scrapeJobController.getScrapeJobsByDateRange,
    'GET /tools/scrape/jobs/by-base-url/:baseURL': scrapeJobController.getScrapeJobsByBaseURL,
    'GET /tools/scrape/jobs/by-base-url/:baseURL/by-processingtype/:processingType': scrapeJobController.getScrapeJobsByBaseURL,
    'GET /tools/scrape/jobs/by-url/:url/:processingType': scrapeJobController.getScrapeUrlByProcessingType,
    'GET /tools/scrape/jobs/by-url/:url': scrapeJobController.getScrapeUrlByProcessingType,

    // Fixes
    'GET /sites/:siteId/opportunities/:opportunityId/fixes': (c) => fixesController.getAllForOpportunity(c),
    'GET /sites/:siteId/opportunities/:opportunityId/fixes/by-status/:status': (c) => fixesController.getByStatus(c),
    'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': (c) => fixesController.getByID(c),
    'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId/suggestions': (c) => fixesController.getAllSuggestionsForFix(c),
    'POST /sites/:siteId/opportunities/:opportunityId/fixes': (c) => fixesController.createFixes(c),
    'PATCH /sites/:siteId/opportunities/:opportunityId/status': (c) => fixesController.patchFixesStatus(c),
    'PATCH /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': (c) => fixesController.patchFix(c),
    'DELETE /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': (c) => fixesController.removeFix(c),

    // LLMO Specific Routes
    'GET /sites/:siteId/llmo/sheet-data/:dataSource': llmoController.getLlmoSheetData,
    'GET /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource': llmoController.getLlmoSheetData,
    'GET /sites/:siteId/llmo/sheet-data/:sheetType/:week/:dataSource': llmoController.getLlmoSheetData,
    'POST /sites/:siteId/llmo/sheet-data/:dataSource': llmoController.queryLlmoSheetData,
    'POST /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource': llmoController.queryLlmoSheetData,
    'POST /sites/:siteId/llmo/sheet-data/:sheetType/:week/:dataSource': llmoController.queryLlmoSheetData,
    'GET /sites/:siteId/llmo/data': llmoController.queryFiles,
    'GET /sites/:siteId/llmo/data/:dataSource': llmoController.queryFiles,
    'GET /sites/:siteId/llmo/data/:sheetType/:dataSource': llmoController.queryFiles,
    'GET /sites/:siteId/llmo/data/:sheetType/:week/:dataSource': llmoController.queryFiles,
    'GET /sites/:siteId/llmo/config': llmoController.getLlmoConfig,
    'PATCH /sites/:siteId/llmo/config': llmoController.updateLlmoConfig,
    'POST /sites/:siteId/llmo/config': llmoController.updateLlmoConfig,
    'GET /sites/:siteId/llmo/questions': llmoController.getLlmoQuestions,
    'POST /sites/:siteId/llmo/questions': llmoController.addLlmoQuestion,
    'DELETE /sites/:siteId/llmo/questions/:questionKey': llmoController.removeLlmoQuestion,
    'PATCH /sites/:siteId/llmo/questions/:questionKey': llmoController.patchLlmoQuestion,
    'GET /sites/:siteId/llmo/customer-intent': llmoController.getLlmoCustomerIntent,
    'POST /sites/:siteId/llmo/customer-intent': llmoController.addLlmoCustomerIntent,
    'DELETE /sites/:siteId/llmo/customer-intent/:intentKey': llmoController.removeLlmoCustomerIntent,
    'PATCH /sites/:siteId/llmo/customer-intent/:intentKey': llmoController.patchLlmoCustomerIntent,
    'PATCH /sites/:siteId/llmo/cdn-logs-filter': llmoController.patchLlmoCdnLogsFilter,
    'PATCH /sites/:siteId/llmo/cdn-logs-bucket-config': llmoController.patchLlmoCdnBucketConfig,
    'GET /sites/:siteId/llmo/global-sheet-data/:configName': llmoController.getLlmoGlobalSheetData,
    'GET /sites/:siteId/llmo/rationale': llmoController.getLlmoRationale,
    'POST /llmo/onboard': llmoController.onboardCustomer,
    'POST /sites/:siteId/llmo/offboard': llmoController.offboardCustomer,
    'POST /sites/:siteId/llmo/edge-optimize-config': llmoController.createOrUpdateEdgeConfig,
    'GET /sites/:siteId/llmo/edge-optimize-config': llmoController.getEdgeConfig,

    // Tier Specific Routes
    'GET /sites/:siteId/user-activities': userActivityController.getBySiteID,
    'POST /sites/:siteId/user-activities': userActivityController.createTrialUserActivity,
    'GET /sites/:siteId/site-enrollments': siteEnrollmentController.getBySiteID,
    'GET /organizations/:organizationId/trial-users': trialUserController.getByOrganizationID,
    'GET /organizations/:organizationId/userDetails/:externalUserId': userDetailsController.getUserDetailsByExternalUserId,
    'POST /organizations/:organizationId/userDetails': userDetailsController.getUserDetailsInBulk,
    'POST /organizations/:organizationId/trial-user-invite': trialUserController.createTrialUserForEmailInvite,
    'GET /organizations/:organizationId/entitlements': entitlementController.getByOrganizationID,
    'POST /organizations/:organizationId/entitlements': entitlementController.createEntitlement,

    // Sandbox audit route
    'POST /sites/:siteId/sandbox/audit': sandboxAuditController.triggerAudit,

    // Reports
    'POST /sites/:siteId/reports': reportsController.createReport,
    'GET /sites/:siteId/reports': reportsController.getAllReportsBySiteId,
    'GET /sites/:siteId/reports/:reportId': reportsController.getReport,
    'PATCH /sites/:siteId/reports/:reportId': reportsController.patchReport,
    'DELETE /sites/:siteId/reports/:reportId': reportsController.deleteReport,

    'GET /sites-resolve': sitesController.resolveSite,
  };

  // Initialization of static and dynamic routes
  Object.keys(routeDefinitions).forEach((routePattern) => {
    if (isStaticRoute(routePattern)) { // Function to check if the route is static
      staticRoutes[routePattern] = routeDefinitions[routePattern];
    } else {
      dynamicRoutes[routePattern] = {
        handler: routeDefinitions[routePattern],
        paramNames: extractParamNames(routePattern), // Function to extract param names
      };
    }
  });

  return {
    staticRoutes,
    dynamicRoutes,
  };
}
