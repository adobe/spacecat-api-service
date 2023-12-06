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

function extractParamNames(routePattern) {
  return routePattern.split('/').filter((segment) => segment.startsWith(':')).map((param) => param.slice(1));
}

function isStaticRoute(routePattern) {
  return !routePattern.split('/').some((segment) => segment.startsWith(':'));
}

export default function getRouteHandlers(sitesController, triggerHandler) {
  const staticRoutes = {};
  const dynamicRoutes = {};

  const routeDefinitions = {
    'GET /sites': sitesController.getAll,
    'GET /sites.csv': sitesController.getAllAsCsv,
    'GET /sites.xlsx': sitesController.getAllAsExcel,
    'GET /sites/:siteId': sitesController.getSiteById,
    'POST /sites': sitesController.createSite,
    'GET /trigger': triggerHandler,
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
