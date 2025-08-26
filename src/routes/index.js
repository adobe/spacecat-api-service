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
 * @param {Object} trafficController - The traffic controller.
 * @param {FixesController} fixesController - The fixes controller.
 * @param {Object} llmoController - The LLMO controller.
 * @param {Object} organizationIdentityProviderController - The organization identity
 * provider controller.
 * @param {Object} userActivityController - The user activity controller.
 * @param {Object} siteEnrollmentController - The site enrollment controller.
 * @param {Object} trialUserController - The trial user controller.
 * @param {Object} entitlementController - The entitlement controller.
 * @return {{staticRoutes: {}, dynamicRoutes: {}}} - An object with static and dynamic routes.
 */
export default function getRouteHandlers(
  auditsController,
  configurationController,
  hooksController,
  organizationsController,
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
  mcpController,
  paidController,
  trafficController,
  fixesController,
  llmoController,
  organizationIdentityProviderController,
  userActivityController,
  siteEnrollmentController,
  trialUserController,
  entitlementController,
) {
  const staticRoutes = {};
  const dynamicRoutes = {};

  const routeDefinitions = {
    'GET /audits/latest/:auditType': auditsController.getAllLatest,
    'GET /configurations': configurationController.getAll,
    'GET /configurations/latest': configurationController.getLatest,
    'PUT /configurations/latest': configurationController.updateConfiguration,
    'GET /configurations/:version': configurationController.getByVersion,
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
    'GET /sites/:siteId/opportunities/by-status/:status': opportunitiesController.getByStatus,
    'GET /sites/:siteId/opportunities/:opportunityId': opportunitiesController.getByID,
    'POST /sites/:siteId/opportunities': opportunitiesController.createOpportunity,
    'PATCH /sites/:siteId/opportunities/:opportunityId': opportunitiesController.patchOpportunity,
    'DELETE /sites/:siteId/opportunities/:opportunityId': opportunitiesController.removeOpportunity,
    'GET /sites/:siteId/opportunities/:opportunityId/suggestions': suggestionsController.getAllForOpportunity,
    'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/auto-fix': suggestionsController.autofixSuggestions,
    'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status': suggestionsController.getByStatus,
    'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': suggestionsController.getByID,
    'POST /sites/:siteId/opportunities/:opportunityId/suggestions': suggestionsController.createSuggestions,
    'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/status': suggestionsController.patchSuggestionsStatus,
    'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': suggestionsController.patchSuggestion,
    'DELETE /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': suggestionsController.removeSuggestion,
    'GET /sites/:siteId/traffic/paid': paidController.getTopPaidPages,
    'GET /sites/:siteId/traffic/paid/page-type-platform-campaign': trafficController.getPaidTrafficByPageTypePlatformCampaign,
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
    'GET /sites/:siteId/brand-guidelines': brandsController.getBrandGuidelinesForSite,
    'GET /sites/:siteId/top-pages': sitesController.getTopPages,
    'GET /sites/:siteId/top-pages/:source': sitesController.getTopPages,
    'GET /sites/:siteId/top-pages/:source/:geo': sitesController.getTopPages,
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
    'GET /mcp': mcpController.handleSseRequest,
    'POST /mcp': mcpController.handleRpc,

    // Scrape Jobs
    'POST /tools/scrape/jobs': scrapeJobController.createScrapeJob,
    'GET /tools/scrape/jobs/:jobId': scrapeJobController.getScrapeJobStatus,
    'GET /tools/scrape/jobs/:jobId/results': scrapeJobController.getScrapeJobUrlResults,
    'GET /tools/scrape/jobs/by-date-range/:startDate/:endDate/all-jobs': scrapeJobController.getScrapeJobsByDateRange,
    'GET /tools/scrape/jobs/by-base-url/:baseURL': scrapeJobController.getScrapeJobsByBaseURL,
    'GET /tools/scrape/jobs/by-base-url/:baseURL/by-processingtype/:processingType': scrapeJobController.getScrapeJobsByBaseURL,

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
    'GET /sites/:siteId/llmo/config': llmoController.getLlmoConfig,
    'GET /sites/:siteId/llmo/questions': llmoController.getLlmoQuestions,
    'POST /sites/:siteId/llmo/questions': llmoController.addLlmoQuestion,
    'DELETE /sites/:siteId/llmo/questions/:questionKey': llmoController.removeLlmoQuestion,
    'PATCH /sites/:siteId/llmo/questions/:questionKey': llmoController.patchLlmoQuestion,
    'GET /sites/:siteId/llmo/customer-intent': llmoController.getLlmoCustomerIntent,
    'POST /sites/:siteId/llmo/customer-intent': llmoController.addLlmoCustomerIntent,
    'DELETE /sites/:siteId/llmo/customer-intent/:intentKey': llmoController.removeLlmoCustomerIntent,
    'PATCH /sites/:siteId/llmo/customer-intent/:intentKey': llmoController.patchLlmoCustomerIntent,
    'PATCH /sites/:siteId/llmo/cdn-logs-filter': llmoController.patchLlmoCdnLogsFilter,

    // Organization Identity Provider Routes
    'GET /organizations/:organizationId/organization-identity-provider': organizationIdentityProviderController.getByOrganizationID,

    // User Activity Routes
    'GET /sites/:siteId/user-activities': userActivityController.getBySiteID,
    'POST /sites/:siteId/user-activities/': userActivityController.createTrialUserActivity,

    // Site Enrollment Routes
    'GET /sites/:siteId/site-enrollments': siteEnrollmentController.getBySiteID,

    // Trial User Routes
    'GET /organizations/:organizationId/trial-users': trialUserController.getByOrganizationID,
    'POST /organizations/:organizationId/trial-user-invite': trialUserController.createTrialUserInvite,

    // Entitlement Routes
    'GET /organizations/:organizationId/entitlements': entitlementController.getByOrganizationID,
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
