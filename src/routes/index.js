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
 * @param {Object} slackController - The slack controller.
 * @param {Function} triggerHandler - The trigger handler function.
 * @param {Object} fulfillmentController - The fulfillment controller.
 * @param {Object} importController - The import controller.
 * @return {{staticRoutes: {}, dynamicRoutes: {}}} - An object with static and dynamic routes.
 */
export default function getRouteHandlers(
  auditsController,
  configurationController,
  hooksController,
  organizationsController,
  sitesController,
  slackController,
  triggerHandler,
  fulfillmentController,
  importController,
) {
  const staticRoutes = {};
  const dynamicRoutes = {};

  const routeDefinitions = {
    'GET /audits/latest/:auditType': auditsController.getAllLatest,
    'GET /configurations': configurationController.getAll,
    'GET /configurations/latest': configurationController.getLatest,
    'PUT /configurations/latest': configurationController.updateConfiguration,
    'GET /configurations/:version': configurationController.getByVersion,
    'POST /event/fulfillment': fulfillmentController.processFulfillmentEvents,
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
    'GET /sites': sitesController.getAll,
    'POST /sites': sitesController.createSite,
    'GET /sites.csv': sitesController.getAllAsCsv,
    'GET /sites.xlsx': sitesController.getAllAsExcel,
    'GET /sites/:siteId': sitesController.getByID,
    'PATCH /sites/:siteId': sitesController.updateSite,
    'DELETE /sites/:siteId': sitesController.removeSite,
    'GET /sites/:siteId/audits': auditsController.getAllForSite,
    'GET /sites/:siteId/audits/:auditType': auditsController.getAllForSite,
    'GET /sites/:siteId/audits/:auditType/:auditedAt': sitesController.getAuditForSite,
    'PATCH /sites/:siteId/:auditType': auditsController.patchAuditForSite,
    'GET /sites/:siteId/audits/latest': auditsController.getAllLatestForSite,
    'GET /sites/:siteId/latest-audit/:auditType': auditsController.getLatestForSite,
    'GET /sites/:siteId/key-events': sitesController.getKeyEventsBySiteID,
    'POST /sites/:siteId/key-events': sitesController.createKeyEvent,
    'DELETE /sites/:siteId/key-events/:keyEventId': sitesController.removeKeyEvent,
    'GET /sites/:siteId/metrics/:metric/:source': sitesController.getSiteMetricsBySource,
    'GET /sites/by-base-url/:baseURL': sitesController.getByBaseURL,
    'GET /sites/by-delivery-type/:deliveryType': sitesController.getAllByDeliveryType,
    'GET /sites/with-latest-audit/:auditType': sitesController.getAllWithLatestAudit,
    'GET /slack/events': slackController.handleEvent,
    'POST /slack/events': slackController.handleEvent,
    'POST /slack/channels/invite-by-user-id': slackController.inviteUserToChannel,
    'GET /trigger': triggerHandler,
    'POST /tools/import': importController.createImportJob,
    'GET /tools/import/:jobId': importController.getImportJobStatus,
    'GET /tools/import/:jobId/import-result.zip': importController.getImportJobResult,
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
